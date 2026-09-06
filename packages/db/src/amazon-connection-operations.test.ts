import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AmazonConnectionBegin, OrgActor } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asUser } from './testing/rls.js';
import { beginAmazonConnection, cancelAmazonConnection, readAmazonConnection, submitAmazonConnection } from './queries/amazon-connection-operations.js';

const available = await databaseAvailable();
const nonceHash = 'c'.repeat(64);
const request = (): AmazonConnectionBegin => ({ requestId: randomUUID(), nonceHash,
  clientId: 'synthetic-client', redirectUri: 'https://example.test/api/amazon/oauth/callback', scope: 'synthetic-scope' });

describe.skipIf(!available)('organization consent custody', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('amazon_connection_operations'); }, 60_000);
  afterAll(async () => { await db?.drop(); });

  async function agency(role: 'owner' | 'admin' | 'viewer' = 'owner'): Promise<OrgActor> {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [row] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name)
      values (${randomUUID()},'Synthetic agency') returning id`;
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${row!.id},${userId},${role})`;
    return { orgId: row!.id, userId };
  }
  async function count(actor: OrgActor, table: 'operations' | 'connections' | 'profiles'): Promise<number> {
    const rows = table === 'operations'
      ? await db.sql<{ n: number }[]>`select count(*)::int as n from app.amazon_connection_operations where org_id=${actor.orgId}`
      : table === 'connections'
        ? await db.sql<{ n: number }[]>`select count(*)::int as n from public.ads_connections where org_id=${actor.orgId}`
        : await db.sql<{ n: number }[]>`select count(*)::int as n from public.ad_profiles where org_id=${actor.orgId}`;
    return rows[0]!.n;
  }

  it('racing identical begins persist one operation and no connection, profile or setting', async () => {
    const actor = await agency(); const input = request();
    const results = await Promise.all([beginAmazonConnection(db, actor, input), beginAmazonConnection(db, actor, input)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ orgId: actor.orgId, state: 'awaiting_consent', connectionId: null });
    expect(await count(actor, 'operations')).toBe(1);
    expect(await count(actor, 'connections')).toBe(0);
    expect(await count(actor, 'profiles')).toBe(0);
    expect(await db.sql`select id from public.profile_strategy where org_id=${actor.orgId}`).toHaveLength(0);
    expect(await db.sql`select id from public.audit_log where org_id=${actor.orgId} and action='amazon.connection_started'`).toHaveLength(1);
  });

  it('binds retry identity to installation, nonce and the initiating member', async () => {
    const actor = await agency(); const input = request();
    await beginAmazonConnection(db, actor, input);
    for (const changes of [{ clientId: 'another-client' }, { nonceHash: 'b'.repeat(64) },
      { scope: 'another-scope' }, { redirectUri: 'https://other.example.test/callback' }]) {
      await expect(beginAmazonConnection(db, actor, { ...input, ...changes })).rejects.toMatchObject({ code: '22023' });
    }
    await expect(beginAmazonConnection(db, actor, request())).rejects.toMatchObject({ code: '23505' });
    expect(await count(actor, 'operations')).toBe(1);
  });

  it('refuses viewers, foreign organizations and guessed operation identifiers', async () => {
    const actor = await agency(); const foreign = await agency(); const viewer = await agency('viewer');
    const operation = await beginAmazonConnection(db, actor, request());
    await expect(beginAmazonConnection(db, viewer, request())).rejects.toMatchObject({ code: '42501' });
    await expect(beginAmazonConnection(db, { ...foreign, orgId: actor.orgId }, request())).rejects.toThrow('Resource not found');
    expect(await readAmazonConnection(db, foreign, operation.operationId)).toBeNull();
    await expect(submitAmazonConnection(db, foreign, { operationId: operation.operationId, nonceHash, code: 'synthetic-code' }))
      .rejects.toMatchObject({ code: '42501' });
    await expect(cancelAmazonConnection(db, foreign, operation.operationId)).rejects.toMatchObject({ code: '42501' });
    await asUser(db, actor.userId, async (sql) => {
      await expect(sql`select * from app.amazon_connection_operations`).rejects.toMatchObject({ code: '42501' });
      await expect(sql`select app.reconcile_amazon_connection_operation(${operation.operationId})`).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('stores a single short-lived code across racing callback retries with no secret in status or audit', async () => {
    const actor = await agency(); const operation = await beginAmazonConnection(db, actor, request());
    const code = ['synthetic', randomUUID(), 'consent'].join('-');
    const input = { operationId: operation.operationId, nonceHash, code };
    const results = await Promise.all([submitAmazonConnection(db, actor, input), submitAmazonConnection(db, actor, input)]);
    expect(results[0]).toEqual(results[1]); expect(results[0]!.state).toBe('queued');
    const rows = await db.sql<{ code_secret_id: string; code_hash: string }[]>`select code_secret_id,code_hash
      from app.amazon_connection_operations where id=${operation.operationId}`;
    expect(rows).toHaveLength(1); expect(rows[0]!.code_hash).toHaveLength(64);
    expect(await db.sql`select id from vault.secrets where id=${rows[0]!.code_secret_id}`).toHaveLength(1);
    const status = await readAmazonConnection(db, actor, operation.operationId);
    const audit = await db.sql`select payload from public.audit_log where org_id=${actor.orgId}`;
    expect(audit).toHaveLength(2);
    for (const value of [code, nonceHash, rows[0]!.code_secret_id, rows[0]!.code_hash]) {
      expect(JSON.stringify({ status, audit })).not.toContain(value);
    }
    await expect(submitAmazonConnection(db, actor, { ...input, code: 'replacement-code' })).rejects.toMatchObject({ code: '22023' });
    expect(await count(actor, 'connections')).toBe(0);
  });

  it('refuses another manager or a mismatched nonce before encrypted submission', async () => {
    const actor = await agency(); const operation = await beginAmazonConnection(db, actor, request());
    const admin = await agency('admin');
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${admin.userId},'admin')`;
    const input = { operationId: operation.operationId, nonceHash, code: 'synthetic-code' };
    await expect(submitAmazonConnection(db, { ...admin, orgId: actor.orgId }, input)).rejects.toMatchObject({ code: '42501' });
    await expect(submitAmazonConnection(db, actor, { ...input, nonceHash: 'd'.repeat(64) })).rejects.toMatchObject({ code: '42501' });
    const [row] = await db.sql<{ code_secret_id: string | null }[]>`select code_secret_id from app.amazon_connection_operations where id=${operation.operationId}`;
    expect(row!.code_secret_id).toBeNull();
  });

  it('cancels queued custody once, deletes its code and permits a fresh connection', async () => {
    const actor = await agency(); const operation = await beginAmazonConnection(db, actor, request());
    await submitAmazonConnection(db, actor, { operationId: operation.operationId, nonceHash, code: 'synthetic-code' });
    const [row] = await db.sql<{ code_secret_id: string }[]>`select code_secret_id from app.amazon_connection_operations where id=${operation.operationId}`;
    expect((await cancelAmazonConnection(db, actor, operation.operationId)).state).toBe('cancelled');
    expect((await cancelAmazonConnection(db, actor, operation.operationId)).state).toBe('cancelled');
    expect(await db.sql`select id from vault.secrets where id=${row!.code_secret_id}`).toHaveLength(0);
    expect(await db.sql`select id from public.audit_log where org_id=${actor.orgId} and action='amazon.connection_settled'`).toHaveLength(1);
    expect((await beginAmazonConnection(db, actor, request())).state).toBe('awaiting_consent');
    expect(await count(actor, 'operations')).toBe(2);
  });

  it('settles expired consent and queued codes before releasing the per-agency slot', async () => {
    for (const submitted of [false, true]) {
      const actor = await agency(); const operation = await beginAmazonConnection(db, actor, request());
      if (submitted) await submitAmazonConnection(db, actor, { operationId: operation.operationId, nonceHash, code: 'synthetic-code' });
      await db.sql`update app.amazon_connection_operations set expires_at=clock_timestamp()-interval '1 minute',
        code_expires_at=case when code_hash is null then null else clock_timestamp()-interval '1 minute' end
        where id=${operation.operationId}`;
      await beginAmazonConnection(db, actor, request());
      expect(await readAmazonConnection(db, actor, operation.operationId)).toMatchObject({
        state: 'reconnect_required', reason: submitted ? 'code_expired' : 'consent_expired',
      });
      expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + operation.operationId}`).toHaveLength(0);
    }
  });

  it('removal and rejoin cannot revive the old grant, and another manager can release its slot', async () => {
    const actor = await agency(); const operation = await beginAmazonConnection(db, actor, request());
    await submitAmazonConnection(db, actor, { operationId: operation.operationId, nonceHash, code: 'synthetic-code' });
    const manager = await agency('admin');
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${manager.userId},'admin')`;
    await db.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    await expect(readAmazonConnection(db, actor, operation.operationId)).rejects.toThrow('Resource not found');
    await beginAmazonConnection(db, { ...manager, orgId: actor.orgId }, request());
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${actor.userId},'owner')`;
    expect(await readAmazonConnection(db, actor, operation.operationId)).toMatchObject({ state: 'refused', reason: 'authority_changed' });
    const replay = await submitAmazonConnection(db, actor, { operationId: operation.operationId, nonceHash, code: 'synthetic-code' });
    expect(replay.state).toBe('refused');
    expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + operation.operationId}`).toHaveLength(0);
  });

  it('agency deletion cleans only its queued code custody', async () => {
    const actor = await agency(); const other = await agency();
    const a = await beginAmazonConnection(db, actor, request());
    const b = await beginAmazonConnection(db, other, request());
    for (const [owner, operation] of [[actor, a], [other, b]] as const) {
      await submitAmazonConnection(db, owner, { operationId: operation.operationId, nonceHash, code: 'synthetic-code' });
    }
    await db.sql`delete from public.orgs where id=${actor.orgId}`;
    expect(await count(actor, 'operations')).toBe(0);
    expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + a.operationId}`).toHaveLength(0);
    expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + b.operationId}`).toHaveLength(1);
    expect((await readAmazonConnection(db, other, b.operationId))!.state).toBe('queued');
  });
});
