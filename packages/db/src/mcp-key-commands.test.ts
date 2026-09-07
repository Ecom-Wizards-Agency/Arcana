import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { McpReadKeyIssue } from '@wizard-ads/shared';
import type { QuerySql } from './client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { AgencyAccessDenied, withAuthenticatedActor } from './queries/authenticated-actor.js';
import { issueManagedMcpReadKey, McpKeyCommandError, revokeManagedMcpKey } from './queries/mcp-key-commands.js';
import { listMcpKeyMetadata } from './queries/mcp-key-metadata.js';

const available = await databaseAvailable();
const owner = randomUUID(); const admin = randomUUID(); const viewer = randomUUID(); const foreignOwner = randomUUID();

describe.skipIf(!available)('current-manager MCP key commands', () => {
  let database: TestDatabase;
  let orgId: string; let otherOrg: string; let profileId: string; let otherProfile: string;
  beforeAll(async () => {
    database = await createTestDatabase('mcp_manager_commands');
    const [orgs] = await database.sql<{ a: string; b: string }[]>`select
      app.seed_tenant_fixture(${randomUUID()},${owner},'owner') as a,
      app.seed_tenant_fixture(${randomUUID()},${foreignOwner},'owner') as b`;
    orgId = orgs!.a; otherOrg = orgs!.b;
    for (const [userId, role] of [[admin, 'admin'], [viewer, 'viewer']] as const) {
      await database.sql`select public.auth_user_stub(${userId})`;
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${userId},${role})`;
    }
    const rows = await database.sql<{ org_id: string; id: string }[]>`select org_id,id from public.ad_profiles where org_id=any(${database.sql.array([orgId,otherOrg])}::uuid[])`;
    profileId = rows.find((row) => row.org_id === orgId)!.id;
    otherProfile = rows.find((row) => row.org_id === otherOrg)!.id;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });
  const actor = (userId = admin) => ({ orgId, userId });
  const command = (changes: Partial<McpReadKeyIssue> = {}): McpReadKeyIssue => ({
    label: 'Synthetic managed key', profileIds: [profileId], expiresInDays: 30,
    keyPrefix: 'wza_' + randomBytes(6).toString('base64url'), tokenHash: randomBytes(32).toString('hex'), ...changes,
  });
  async function counts() {
    const [row] = await database.sql`select
      (select count(*)::int from mcp.api_keys where org_id=${orgId}) as keys,
      (select count(*)::int from public.audit_log where org_id=${orgId} and action like 'mcp_key.%') as audits`;
    return row!;
  }
  async function rawIssue(sql: QuerySql, input = command()) {
    return sql<{ id: string }[]>`select app.issue_mcp_read_key(${orgId}::uuid,${input.label},
      ${sql.array(input.profileIds)}::uuid[],${input.expiresInDays}::integer,${input.keyPrefix},${input.tokenHash}) as id`;
  }

  it('issues one read-only bounded key and audit without returning or auditing its digest', async () => {
    const before = await counts(); const input = command();
    const result = await issueManagedMcpReadKey(database, actor(), input);
    expect(result).toMatchObject({ scope: 'read', profileIds: [profileId], revokedAt: null });
    expect(new Date(result.expiresAt!).getTime() - new Date(result.createdAt).getTime()).toBe(30 * 86_400_000);
    const [stored] = await database.sql`select token_hash,created_by from mcp.api_keys where id=${result.id}`;
    expect(stored).toEqual({ token_hash: input.tokenHash, created_by: admin });
    const audits = await database.sql`select actor_id,action,payload from public.audit_log where org_id=${orgId} and target_id=${result.id}`;
    expect(audits).toEqual([{ actor_id: admin, action: 'mcp_key.issued', payload: { profile_count: 1, expires_in_days: 30 } }]);
    expect(JSON.stringify({ result, audits })).not.toContain(input.tokenHash);
    expect(await counts()).toEqual({ keys: Number(before.keys) + 1, audits: Number(before.audits) + 1 });
  });

  it('denies viewers, unrelated owners and mixed profiles without any key or audit', async () => {
    const before = await counts();
    for (const userId of [viewer, foreignOwner]) {
      await expect(issueManagedMcpReadKey(database, actor(userId), command())).rejects.toBeInstanceOf(AgencyAccessDenied);
      await expect(revokeManagedMcpKey(database, actor(userId), randomUUID())).rejects.toBeInstanceOf(AgencyAccessDenied);
    }
    await expect(issueManagedMcpReadKey(database, actor(), command({ profileIds: [profileId, otherProfile] })))
      .rejects.toMatchObject({ code: 'invalid' });
    expect(await counts()).toEqual(before);
  });

  it('enforces shape and bounds in SQL even when the typed command is bypassed', async () => {
    const before = await counts();
    for (const input of [
      command({ profileIds: [] }), command({ profileIds: [profileId, profileId] }),
      command({ label: ' ' }), command({ tokenHash: 'bad' }), command({ keyPrefix: 'bad' }),
    ]) {
      await expect(withAuthenticatedActor(database, actor(), (sql) => rawIssue(sql, input)))
        .rejects.toMatchObject({ code: '22023' });
    }
    await expect(withAuthenticatedActor(database, actor(), (sql) => sql`select app.issue_mcp_read_key(
      ${orgId}::uuid,'Synthetic long key',array[${profileId}::uuid],365,'wza_abcdefgh',${randomBytes(32).toString('hex')})`))
      .rejects.toMatchObject({ code: '22023' });
    expect(await counts()).toEqual(before);
  });

  it('revokes exactly once, keeps its timestamp on replay and refuses a foreign key', async () => {
    const key = await issueManagedMcpReadKey(database, actor(), command());
    const foreign = await issueManagedMcpReadKey(database, { orgId: otherOrg, userId: foreignOwner }, command({ profileIds: [otherProfile] }));
    expect(await revokeManagedMcpKey(database, actor(owner), foreign.id)).toBe(false);
    expect(await revokeManagedMcpKey(database, actor(owner), key.id)).toBe(true);
    const [before] = await database.sql`select revoked_at from mcp.api_keys where id=${key.id}`;
    expect(await revokeManagedMcpKey(database, actor(), key.id)).toBe(true);
    const [after] = await database.sql`select revoked_at from mcp.api_keys where id=${key.id}`;
    expect(after).toEqual(before);
    const audit = await database.sql`select actor_id,action from public.audit_log where target_id=${key.id} and action='mcp_key.revoked'`;
    expect(audit).toEqual([{ actor_id: owner, action: 'mcp_key.revoked' }]);
    const [other] = await database.sql`select revoked_at from mcp.api_keys where id=${foreign.id}`;
    expect(other!.revoked_at).toBeNull();
  });

  it.each(['issue', 'revoke'])('refuses %s after a downgrade committed beyond the earlier membership read', async (operation) => {
    const key = await issueManagedMcpReadKey(database, actor(), command());
    const before = await counts();
    try {
      await expect(withAuthenticatedActor(database, actor(), async (sql) => {
        await database.sql`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${admin}`;
        return operation === 'issue' ? rawIssue(sql) : sql`select app.revoke_mcp_key(${orgId}::uuid,${key.id}::uuid)`;
      })).rejects.toMatchObject({ code: '42501' });
      expect(await counts()).toEqual(before);
      const [stored] = await database.sql`select revoked_at from mcp.api_keys where id=${key.id}`;
      expect(stored!.revoked_at).toBeNull();
    } finally {
      await database.sql`update public.org_members set role='admin' where org_id=${orgId} and user_id=${admin}`;
    }
  });

  it('holds manager and selected-profile locks through key admission commit', async () => {
    await withAuthenticatedActor(database, actor(), async (sql) => {
      await rawIssue(sql);
      for (const target of ['manager', 'profile']) {
        await expect(database.sql.begin(async (other) => {
          await other`set local lock_timeout='100ms'`;
          if (target === 'manager') await other`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${admin}`;
          else await other`delete from public.ad_profiles where org_id=${orgId} and id=${profileId}`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
    });
  });

  it('reports an uncertain commit without retry, leaking its bind parameters or losing its visible record', async () => {
    const input = command(); const before = await counts(); let commits = 0;
    const ambiguous = { sql: new Proxy(database.sql, { get(target, property) {
      if (property === 'begin') return async (operation: (sql: QuerySql) => Promise<unknown>) => {
        await target.begin(operation); commits++;
        throw Object.assign(new Error(input.tokenHash), { code: '08006', parameters: [input.tokenHash] });
      };
      return Reflect.get(target, property);
    } }) };
    let failure: unknown;
    try { await issueManagedMcpReadKey(ambiguous, actor(), input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(McpKeyCommandError);
    expect(failure).toMatchObject({ code: 'unavailable' });
    expect(failure).not.toHaveProperty('cause');
    expect(failure).not.toHaveProperty('parameters');
    expect(String(failure) + JSON.stringify(failure)).not.toContain(input.tokenHash);
    expect(commits).toBe(1);
    expect(await counts()).toEqual({ keys: Number(before.keys) + 1, audits: Number(before.audits) + 1 });
    const metadata = await withAuthenticatedActor(database, actor(), (sql) => listMcpKeyMetadata({ sql }, orgId));
    const stored = metadata.filter((row) => row.keyPrefix === input.keyPrefix);
    expect(stored).toHaveLength(1);
    expect(await revokeManagedMcpKey(database, actor(), stored[0]!.id)).toBe(true);
  });
});
