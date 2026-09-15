import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmazonConnectionRosterInput, OrgActor, Region } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asServiceRole, asUser } from './testing/rls.js';
import { beginAmazonConnection, submitAmazonConnection } from './queries/amazon-connection-operations.js';
import { AmazonConnectionCommandError, attachAmazonConnectionGrant, claimAmazonConnection,
  failAmazonConnectionExchange, failAmazonConnectionDiscovery, readAmazonConnectionWorker, recordAmazonConnectionRegion,
  startAmazonConnectionRegion } from './queries/amazon-connection-worker.js';
import { getAdsRefreshToken, storeAdsRefreshToken } from './queries/tokens.js';

const available = await databaseAvailable();
describe.skipIf(!available)('single-use connection exchange custody', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('amazon_connection_worker'); }, 60_000);
  afterAll(async () => { await db?.drop(); });

  async function consent(submit = true) {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name)
      values (${randomUUID()}, 'Synthetic worker agency') returning id`;
    const actor: OrgActor = { orgId: org!.id, userId };
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const input = { requestId: randomUUID(), nonceHash: 'd'.repeat(64), clientId: 'synthetic-client',
      scope: 'synthetic-scope', redirectUri: 'https://example.test/callback' };
    const started = await beginAmazonConnection(db, actor, input);
    const code = ['synthetic', randomUUID(), 'consent'].join('-');
    if (submit) await submitAmazonConnection(db, actor, { operationId: started.operationId, nonceHash: input.nonceHash, code });
    return { actor, operationId: started.operationId, code };
  }
  async function settleOpen() {
    // Tests own all fixture operations. Stop earlier discovery from winning a later claim.
    await db.sql`select app.finish_amazon_connection_operation(id,'refused','authority_changed')
      from app.amazon_connection_operations where state in ('awaiting_consent','queued','exchanging','discovering')`;
  }

  it('only the worker can claim, and exactly one racing claimant consumes the code', async () => {
    const value = await consent();
    await asUser(db, value.actor.userId, async (sql) => {
      await expect(sql`select app.claim_amazon_connection(${randomUUID()})`).rejects.toMatchObject({ code: '42501' });
      await expect(sql`select app.read_amazon_connection_worker(${value.operationId})`).rejects.toMatchObject({ code: '42501' });
    });
    const leases = [randomUUID(), randomUUID()];
    const claims = await Promise.all(leases.map((lease) => claimAmazonConnection(db, lease)));
    const claimed = claims.filter((claim) => claim !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ kind: 'exchange', code: value.code,
      operation: { operationId: value.operationId, orgId: value.actor.orgId, state: 'exchanging' } });
    expect(await claimAmazonConnection(db, claimed[0]!.leaseId)).toBeNull();
    expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + value.operationId}`).toHaveLength(0);
    expect(await db.sql`select id from public.audit_log where target_id=${value.operationId} and action='amazon.connection_claimed'`).toHaveLength(1);
    await settleOpen();
  });

  it('reconciles an attached grant without rotating it after a lost response or late failure', async () => {
    const value = await consent(); const claim = (await claimAmazonConnection(db, randomUUID()))!;
    const token = ['synthetic', randomUUID(), 'grant'].join('-');
    const attached = await attachAmazonConnectionGrant(db, value.operationId, claim.leaseId, token);
    expect(attached).toMatchObject({ state: 'discovering', orgId: value.actor.orgId });
    expect(await readAmazonConnectionWorker(db, value.operationId)).toEqual(attached);
    expect(await attachAmazonConnectionGrant(db, value.operationId, claim.leaseId, 'must-not-replace')).toEqual(attached);
    expect(await failAmazonConnectionExchange(db, value.operationId, claim.leaseId, 'exchange_uncertain')).toEqual(attached);
    expect(await getAdsRefreshToken(db, attached.connectionId!)).toBe(token);
    expect(await db.sql`select credential_generation::text as generation from public.ads_connections
      where id=${attached.connectionId}`).toEqual([{ generation: '1' }]);
    expect(await db.sql`select id from public.audit_log where target_id=${value.operationId} and action='amazon.grant_attached'`).toHaveLength(1);
    const discovery = await claimAmazonConnection(db, randomUUID());
    expect(discovery).toMatchObject({ kind: 'discover', binding: { orgId: value.actor.orgId, connectionId: attached.connectionId, generation: '1' } });
    expect(discovery).not.toHaveProperty('code');
    await settleOpen();
  });

  it('lost exchange custody requires new consent rather than another exchange claim', async () => {
    const value = await consent(); const claim = (await claimAmazonConnection(db, randomUUID()))!;
    await db.sql`update app.amazon_connection_operations set lease_expires_at=clock_timestamp()-interval '1 second'
      where id=${value.operationId}`;
    expect(await claimAmazonConnection(db, randomUUID())).toBeNull();
    expect(await readAmazonConnectionWorker(db, value.operationId)).toMatchObject({ state: 'reconnect_required', reason: 'exchange_uncertain' });
    expect((await attachAmazonConnectionGrant(db, value.operationId, claim.leaseId, 'synthetic-grant')).state).toBe('reconnect_required');
    expect(await db.sql`select id from public.ads_connections where org_id=${value.actor.orgId}`).toHaveLength(0);
  });

  it('rechecks issuer membership before attachment and clears expired queued custody', async () => {
    const value = await consent(); const claim = (await claimAmazonConnection(db, randomUUID()))!;
    await db.sql`delete from public.org_members where org_id=${value.actor.orgId} and user_id=${value.actor.userId}`;
    expect((await attachAmazonConnectionGrant(db, value.operationId, claim.leaseId, 'synthetic-grant')).state).toBe('refused');
    expect(await db.sql`select id from public.ads_connections where org_id=${value.actor.orgId}`).toHaveLength(0);
    const expired = await consent();
    await db.sql`update app.amazon_connection_operations set code_expires_at=clock_timestamp()-interval '1 second'
      where id=${expired.operationId}`;
    expect(await claimAmazonConnection(db, randomUUID())).toBeNull();
    expect(await readAmazonConnectionWorker(db, expired.operationId)).toMatchObject({ state: 'reconnect_required', reason: 'code_expired' });
    expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + expired.operationId}`).toHaveLength(0);
  });

  it('resumes discovery after consent expiry but refuses a changed credential generation', async () => {
    const value = await consent(); const exchange = (await claimAmazonConnection(db, randomUUID()))!;
    const attached = await attachAmazonConnectionGrant(db, value.operationId, exchange.leaseId, 'synthetic-grant');
    const first = (await claimAmazonConnection(db, randomUUID()))!;
    await db.sql`update app.amazon_connection_operations set code_expires_at=clock_timestamp()-interval '1 hour',
      expires_at=clock_timestamp()-interval '1 hour', lease_expires_at=clock_timestamp()-interval '1 second'
      where id=${value.operationId}`;
    const resumed = await claimAmazonConnection(db, randomUUID());
    expect(resumed).toMatchObject({ kind: 'discover', operation: { state: 'discovering' } });
    expect(resumed!.leaseId).not.toBe(first.leaseId);
    await storeAdsRefreshToken(db, attached.connectionId!, 'synthetic-rotated-grant');
    await db.sql`update app.amazon_connection_operations set lease_expires_at=clock_timestamp()-interval '1 second'
      where id=${value.operationId}`;
    expect(await claimAmazonConnection(db, randomUUID())).toBeNull();
    expect(await readAmazonConnectionWorker(db, value.operationId)).toMatchObject({ state: 'refused', reason: 'authority_changed' });
  });

  it('uncompleted consent in other agencies cannot starve a queued connection', async () => {
    for (let index = 0; index < 21; index += 1) await consent(false);
    const queued = await consent();
    const claim = await asServiceRole(db, async (sql) => {
      const [row] = await sql<{ result: { operation: { operationId: string } } }[]>`
        select app.claim_amazon_connection(${randomUUID()}) as result`;
      return row!.result;
    });
    expect(claim.operation.operationId).toBe(queued.operationId);
    await settleOpen();
  });

  it('sanitizes token bindings when a wrong lease is refused', async () => {
    const value = await consent(); await claimAmazonConnection(db, randomUUID());
    const token = ['synthetic', randomUUID(), 'grant'].join('-');
    const error: unknown = await attachAmazonConnectionGrant(db, value.operationId, randomUUID(), token).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AmazonConnectionCommandError);
    expect(error).not.toHaveProperty('parameters'); expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(token);
    await settleOpen();
  });

  function roster(region: Region, ids: string[], rejected = 0): AmazonConnectionRosterInput {
    return { region, received: ids.length + rejected, rejected,
      profiles: ids.map((profileId) => ({ profileId, region, countryCode: 'DE', currencyCode: 'EUR',
        timezone: 'Europe/Berlin', accountType: 'seller', accountName: 'Synthetic advertiser',
        dailyBudget: null, amazonAccountId: null, marketplaceStringId: null })),
    };
  }
  async function discovery() {
    const value = await consent(); const exchange = (await claimAmazonConnection(db, randomUUID()))!;
    const attached = await attachAmazonConnectionGrant(db, value.operationId, exchange.leaseId, 'synthetic-grant');
    const claim = (await claimAmazonConnection(db, randomUUID()))!;
    return { ...value, connectionId: attached.connectionId!, leaseId: claim.leaseId };
  }

  it('counts new and existing profiles once across result replay, preserving tenant settings', async () => {
    const value = await discovery();
    await db.sql`insert into public.ad_profiles(org_id,connection_id,amazon_profile_id,region,country_code,currency_code,
      timezone,timezone_locked,sync_enabled,goal_lens,target_acos,preferred_sync_hour)
      values (${value.actor.orgId},${value.connectionId},'existing','EU','DE','EUR','UTC',true,true,'synthetic',0.271,8)`;
    const input = roster('EU', ['existing', 'new'], 1);
    expect((await startAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU')).regions[1]!.state).toBe('running');
    const first = await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU', input, null);
    expect(first.regions[1]).toMatchObject({ state: 'completed', received: 3, parsed: 2, rejected: 1, upserted: 2, created: 1 });
    expect(await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU', input, null)).toEqual(first);
    expect(await db.sql`select timezone,sync_enabled,goal_lens,target_acos::text,preferred_sync_hour from public.ad_profiles
      where org_id=${value.actor.orgId} and amazon_profile_id='existing'`).toEqual([
      { timezone: 'UTC', sync_enabled: true, goal_lens: 'synthetic', target_acos: '0.2710', preferred_sync_hour: 8 },
    ]);
    expect(await db.sql`select id from public.ad_profiles where org_id=${value.actor.orgId}`).toHaveLength(2);
    expect(await db.sql`select id from public.audit_log where target_id=${value.operationId} and action='amazon.discovery_recorded'`).toHaveLength(1);
    await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'NA', roster('NA', []), null);
    const final = await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'FE', null, 'access_refused');
    expect(final).toMatchObject({ state: 'partial', reason: 'discovery_incomplete' });
    expect(await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'FE', null, 'access_refused')).toEqual(final);
    await expect(recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'FE', roster('FE', ['changed']), null))
      .rejects.toBeInstanceOf(AmazonConnectionCommandError);
    await expect(recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU', roster('EU', ['changed']), null))
      .rejects.toBeInstanceOf(AmazonConnectionCommandError);
    expect(await db.sql`select id from public.ad_profiles where org_id=${value.actor.orgId}`).toHaveLength(2);
    expect(await db.sql`select id from public.audit_log where target_id=${value.operationId} and action='amazon.discovery_recorded'`).toHaveLength(3);
    expect(await claimAmazonConnection(db, randomUUID())).toBeNull();
  });

  it('only a current worker discovery lease can stop a changed installation', async () => {
    const value = await discovery();
    await asUser(db, value.actor.userId, async (sql) => {
      await expect(sql`select app.fail_amazon_connection_discovery(${value.operationId},${value.leaseId})`)
        .rejects.toMatchObject({ code: '42501' });
    });
    await expect(failAmazonConnectionDiscovery(db, value.operationId, randomUUID()))
      .rejects.toBeInstanceOf(AmazonConnectionCommandError);
    expect((await readAmazonConnectionWorker(db, value.operationId)).state).toBe('discovering');
    const stopped = await failAmazonConnectionDiscovery(db, value.operationId, value.leaseId);
    expect(stopped).toMatchObject({ state: 'reconnect_required', reason: 'installation_changed' });
    expect(await failAmazonConnectionDiscovery(db, value.operationId, value.leaseId)).toEqual(stopped);
    expect(await getAdsRefreshToken(db, value.connectionId)).toBe('synthetic-grant');
    expect(await db.sql`select id from public.ad_profiles where org_id=${value.actor.orgId}`).toHaveLength(0);
  });

  it('distinguishes complete, empty and fully refused regional cycles', async () => {
    for (const scenario of ['completed','empty','reconnect_required']) {
      const value = await discovery();
      for (const region of ['NA','EU','FE'] as const) {
        await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, region,
          scenario === 'reconnect_required' ? null : roster(region, scenario === 'completed' ? [region] : []),
          scenario === 'reconnect_required' ? 'request_failed' : null);
      }
      const result = await readAmazonConnectionWorker(db, value.operationId);
      expect(result.state).toBe(scenario);
      expect(await db.sql`select id from public.ad_profiles where org_id=${value.actor.orgId}`)
        .toHaveLength(scenario === 'completed' ? 3 : 0);
      expect(await db.sql`select id from public.audit_log where target_id=${value.operationId} and action='amazon.discovery_recorded'`).toHaveLength(3);
    }
  });

  it('refuses expired leases and resumed claims reset only unfinished regional progress', async () => {
    const value = await discovery();
    await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'NA', roster('NA', ['saved']), null);
    await startAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU');
    await db.sql`update app.amazon_connection_operations set lease_expires_at=clock_timestamp()-interval '1 second'
      where id=${value.operationId}`;
    await expect(recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU', roster('EU', ['stale']), null))
      .rejects.toBeInstanceOf(AmazonConnectionCommandError);
    const resumed = (await claimAmazonConnection(db, randomUUID()))!;
    expect(resumed.operation.regions.map((region) => region.state)).toEqual(['completed','pending','pending']);
    expect(resumed.operation.regions[0]!.upserted).toBe(1);
    expect(await db.sql`select id from public.ad_profiles where org_id=${value.actor.orgId}`).toHaveLength(1);
    await settleOpen();
  });

  it('prevents region or credential changes from redirecting an existing profile', async () => {
    const value = await discovery();
    await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'NA', roster('NA', ['stable']), null);
    await expect(recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU', roster('EU', ['stable']), null))
      .rejects.toBeInstanceOf(AmazonConnectionCommandError);
    expect(await db.sql`select region::text from public.ad_profiles where org_id=${value.actor.orgId}`).toEqual([{ region: 'NA' }]);
    await storeAdsRefreshToken(db, value.connectionId, 'synthetic-replacement-grant');
    const result = await recordAmazonConnectionRegion(db, value.operationId, value.leaseId, 'EU', roster('EU', ['new']), null);
    expect(result).toMatchObject({ state: 'refused', reason: 'authority_changed' });
    expect(await db.sql`select id from public.ad_profiles where org_id=${value.actor.orgId}`).toHaveLength(1);
  });
});
