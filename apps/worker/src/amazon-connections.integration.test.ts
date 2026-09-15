import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginAmazonConnection, submitAmazonConnection, storeAdsRefreshToken } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { AdsAuthorizationCodeError } from '@wizard-ads/ads-api';
import type { AdsProfileDiscoveryResult, OrgActor, Region } from '@wizard-ads/shared';
import { createAmazonConnectionProvider, createAmazonConnectionStore } from './amazon-connection-adapters.js';
import { runAmazonConnectionPass, type AmazonConnectionProvider } from './amazon-connections.js';

const available = await databaseAvailable();
const installation = { clientId: 'synthetic-client', scope: 'advertising::campaign_management',
  redirectUri: 'https://example.test/api/amazon/oauth/callback' };
function profile(region: Region, id: string) {
  return { profileId: id, region, countryCode: 'DE', currencyCode: 'EUR', timezone: 'Europe/Berlin',
    accountName: 'Synthetic agency', accountType: 'seller' as const, dailyBudget: null,
    amazonAccountId: null, marketplaceStringId: null };
}
function discovered(region: Region): AdsProfileDiscoveryResult {
  return { region, received: 1, profiles: [profile(region, region)], rejected: [] };
}

describe.skipIf(!available)('worker connection orchestration with actual persistence', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('amazon_connection_runtime'); }, 60_000);
  afterAll(async () => { await db?.drop(); });
  beforeEach(async () => {
    await db.sql`select app.finish_amazon_connection_operation(id,'refused','authority_changed')
      from app.amazon_connection_operations where state in ('awaiting_consent','queued','exchanging','discovering')`;
  });
  async function fixture() {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name)
      values (${randomUUID()},'Synthetic runtime agency') returning id`;
    const actor: OrgActor = { orgId: org!.id, userId };
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const nonceHash = 'e'.repeat(64);
    const started = await beginAmazonConnection(db, actor, { ...installation, nonceHash, requestId: randomUUID() });
    const code = ['synthetic', randomUUID(), 'code'].join('-');
    await submitAmazonConnection(db, actor, { operationId: started.operationId, nonceHash, code });
    const token = ['synthetic', randomUUID(), 'grant'].join('-');
    const store = createAmazonConnectionStore(db);
    const provider = {
      accepts: vi.fn(() => true),
      exchange: vi.fn<AmazonConnectionProvider['exchange']>(async () => token),
      discover: vi.fn<AmazonConnectionProvider['discover']>(async (_binding, region) => discovered(region)),
    };
    const signal = new AbortController().signal;
    return { actor, operationId: started.operationId, code, token, store, provider, signal };
  }

  it('exchanges once, discovers all regions and counts every unusable row', async () => {
    const f = await fixture();
    f.provider.discover.mockImplementation(async (_binding, region) => ({ region, received: 4,
      profiles: [profile(region, region), { ...profile(region, region + '-missing'), countryCode: null },
        { ...profile(region, region + '-zone'), timezone: 'Invalid/Timezone' }],
      rejected: [{ index: 3, reason: 'invalid_row' }],
    }));
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'discovering' },
    });
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'partial', reason: 'discovery_incomplete' },
    });
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toEqual({ outcome: 'idle', operation: null });
    expect(f.provider.exchange).toHaveBeenCalledExactlyOnceWith(installation, f.code, expect.any(AbortSignal));
    expect(f.provider.discover).toHaveBeenCalledTimes(3);
    const result = await f.store.read(f.operationId);
    expect(result.regions.map((r) => [r.received, r.parsed, r.rejected, r.upserted, r.created]))
      .toEqual([[4,1,3,1,1],[4,1,3,1,1],[4,1,3,1,1]]);
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId}`).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(f.code); expect(JSON.stringify(result)).not.toContain(f.token);
    expect(await db.sql`select payload from public.audit_log where org_id=${f.actor.orgId}`)
      .toHaveLength(8);
  });

  it('never retries a consumed exchange after an uncertain provider response', async () => {
    const f = await fixture();
    f.provider.exchange.mockRejectedValue(new AdsAuthorizationCodeError('exchange_uncertain', 0));
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'reconnect_required', reason: 'exchange_uncertain' },
    });
    await runAmazonConnectionPass(f.store, f.provider, f.signal);
    expect(f.provider.exchange).toHaveBeenCalledTimes(1);
    expect(f.provider.discover).not.toHaveBeenCalled();
    expect(await db.sql`select id from public.ads_connections where org_id=${f.actor.orgId}`).toHaveLength(0);
  });

  it('reconciles a lost attachment acknowledgment without re-exchange or token rotation', async () => {
    const f = await fixture();
    const attach = vi.fn(async (...args: Parameters<typeof f.store.attach>) => {
      await f.store.attach(...args); throw new Error('Synthetic lost acknowledgment');
    });
    expect(await runAmazonConnectionPass({ ...f.store, attach }, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'discovering' },
    });
    await runAmazonConnectionPass(f.store, f.provider, f.signal);
    expect(f.provider.exchange).toHaveBeenCalledTimes(1); expect(attach).toHaveBeenCalledTimes(1);
    expect(await db.sql`select credential_generation::text as generation from public.ads_connections
      where org_id=${f.actor.orgId}`).toEqual([{ generation: '1' }]);
    expect(await db.sql`select id from public.audit_log where org_id=${f.actor.orgId} and action='amazon.grant_attached'`)
      .toHaveLength(1);
  });

  it('reconciles a lost regional commit without fetching or inserting it twice', async () => {
    const f = await fixture(); await runAmazonConnectionPass(f.store, f.provider, f.signal);
    let lost = false;
    const recordRegion = vi.fn(async (...args: Parameters<typeof f.store.recordRegion>) => {
      const saved = await f.store.recordRegion(...args);
      if (!lost) { lost = true; throw new Error('Synthetic lost regional acknowledgment'); }
      return saved;
    });
    expect(await runAmazonConnectionPass({ ...f.store, recordRegion }, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'completed' },
    });
    expect(recordRegion).toHaveBeenCalledTimes(3); expect(f.provider.discover).toHaveBeenCalledTimes(3);
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId}`).toHaveLength(3);
    expect(await db.sql`select id from public.audit_log where org_id=${f.actor.orgId} and action='amazon.discovery_recorded'`)
      .toHaveLength(3);
  });

  it('records an uncommitted roster refusal with known counts and no accepted rows', async () => {
    const f = await fixture(); await runAmazonConnectionPass(f.store, f.provider, f.signal);
    const recordRegion = vi.fn(f.store.recordRegion).mockRejectedValueOnce(new Error('Synthetic transaction refused'));
    expect(await runAmazonConnectionPass({ ...f.store, recordRegion }, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'partial' },
    });
    expect((await f.store.read(f.operationId)).regions[0]).toMatchObject({ state: 'failed',
      received: 1, parsed: 1, rejected: 0, upserted: 0, created: 0, reason: 'persistence_failed' });
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId}`).toHaveLength(2);
  });

  it.each(['membership', 'generation'] as const)('refuses changed %s after provider response before persistence', async (changed) => {
    const f = await fixture(); await runAmazonConnectionPass(f.store, f.provider, f.signal);
    f.provider.discover.mockImplementationOnce(async (binding, region) => {
      if (changed === 'membership') await db.sql`delete from public.org_members
        where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
      else await storeAdsRefreshToken(db, binding.connectionId, 'synthetic-rotated-grant');
      return discovered(region);
    });
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'refused', reason: 'authority_changed' },
    });
    expect(f.provider.discover).toHaveBeenCalledTimes(1);
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId}`).toHaveLength(0);
  });

  it('leaves an interrupted discovery resumable and skips already committed regions', async () => {
    const f = await fixture(); await runAmazonConnectionPass(f.store, f.provider, f.signal);
    const controller = new AbortController();
    f.provider.discover.mockImplementationOnce(async (_binding, region) => discovered(region))
      .mockImplementationOnce(async () => { controller.abort(); throw new Error('Synthetic stop'); });
    expect(await runAmazonConnectionPass(f.store, f.provider, controller.signal)).toEqual({ outcome: 'uncertain', operation: null });
    expect((await f.store.read(f.operationId)).regions.map((r) => r.state)).toEqual(['completed','running','pending']);
    await db.sql`update app.amazon_connection_operations set lease_expires_at=clock_timestamp()-interval '1 second'
      where id=${f.operationId}`;
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toMatchObject({
      outcome: 'observed', operation: { state: 'completed' },
    });
    expect(f.provider.exchange).toHaveBeenCalledTimes(1);
    expect(f.provider.discover.mock.calls.map((args) => args[1])).toEqual(['NA','EU','EU','FE']);
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId}`).toHaveLength(3);
  });

  it('does not request another code after a lost claim acknowledgment', async () => {
    const f = await fixture();
    const claim = vi.fn(async (lease: string) => { await f.store.claim(lease); throw new Error('Synthetic lost claim'); });
    expect(await runAmazonConnectionPass({ ...f.store, claim }, f.provider, f.signal)).toEqual({ outcome: 'unavailable', operation: null });
    expect(claim).toHaveBeenCalledTimes(1); expect(f.provider.exchange).not.toHaveBeenCalled();
    await db.sql`update app.amazon_connection_operations set lease_expires_at=clock_timestamp()-interval '1 second'
      where id=${f.operationId}`;
    await runAmazonConnectionPass(f.store, f.provider, f.signal);
    expect((await f.store.read(f.operationId)).reason).toBe('exchange_uncertain');
    expect(f.provider.exchange).not.toHaveBeenCalled();
  });

  it.each(['exchange','discovery'] as const)('stops changed installation during %s without a provider call', async (stage) => {
    const f = await fixture();
    if (stage === 'discovery') await runAmazonConnectionPass(f.store, f.provider, f.signal);
    f.provider.accepts.mockReturnValue(false);
    expect(await runAmazonConnectionPass(f.store, f.provider, f.signal)).toMatchObject({ outcome: 'observed',
      operation: { state: 'reconnect_required', reason: 'installation_changed' } });
    expect(f.provider.exchange).toHaveBeenCalledTimes(stage === 'exchange' ? 0 : 1);
    expect(f.provider.discover).not.toHaveBeenCalled();
  });

  it('uses only worker provider hosts and denies foreign or rotated bindings before refresh HTTP', async () => {
    const f = await fixture(); await runAmazonConnectionPass(f.store, f.provider, f.signal);
    const claim = (await f.store.claim(randomUUID()))!;
    if (claim.kind !== 'discover') throw new Error('Expected discovery');
    const requests: string[] = [];
    const access = ['synthetic', 'access'].join('-');
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input); requests.push(url);
      return url.includes('/auth/o2/token') ? Response.json({ access_token: access, expires_in: 3600 })
        : Response.json([{ profileId: '123', countryCode: 'DE', currencyCode: 'EUR', timezone: 'Europe/Berlin',
          accountInfo: { type: 'seller', name: 'Synthetic advertiser' } }]);
    });
    const provider = createAmazonConnectionProvider(db, { LWA_CLIENT_ID: installation.clientId,
      LWA_CLIENT_SECRET: 'synthetic-application-key', AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: installation.redirectUri },
    { fetch: fetcher });
    expect(provider.accepts(installation)).toBe(true);
    expect(provider.accepts({ ...installation, redirectUri: 'https://foreign.test/callback' })).toBe(false);
    expect(await provider.discover(claim.binding, 'EU', f.signal)).toMatchObject({ received: 1, rejected: [] });
    expect(requests).toEqual(['https://api.amazon.com/auth/o2/token','https://advertising-api-eu.amazon.com/v2/profiles']);
    await expect(provider.discover({ ...claim.binding, orgId: randomUUID() }, 'EU', f.signal)).rejects.toThrow('authority changed');
    await storeAdsRefreshToken(db, claim.binding.connectionId, 'synthetic-new-grant');
    await expect(provider.discover(claim.binding, 'EU', f.signal)).rejects.toThrow('authority changed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
