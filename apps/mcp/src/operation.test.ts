import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAuthenticatedIdentity } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { configFromEnv } from './config.js';
import { listProfiles, resolveProfile } from './data.js';
import { issueApiKey, verifyApiKey } from './keys.js';
import { withMcpOperation, type ServerContext } from './operation.js';

const available = await databaseAvailable();
const OWNER = 'b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b1b1';
const OTHER = 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2';

describe.skipIf(!available)('MCP operation authority', () => {
  let database: TestDatabase;
  let orgId: string;
  let otherOrg: string;
  let profileId: string;
  let secondProfile: string;
  let otherProfile: string;

  beforeAll(async () => {
    database = await createTestDatabase('mcp_operations');
    const [a] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('operation-a',${OWNER},'owner') as id`;
    const [b] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('operation-b',${OTHER},'owner') as id`;
    orgId = a!.id;
    otherOrg = b!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} limit 1`;
    const [foreign] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${otherOrg} limit 1`;
    profileId = profile!.id;
    otherProfile = foreign!.id;
    const [second] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles(org_id,connection_id,amazon_profile_id,region,country_code,currency_code,timezone)
      select org_id,connection_id,'synthetic-second',region,'US','USD','UTC' from public.ad_profiles where id=${profileId}
      returning id
    `;
    secondProfile = second!.id;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function context(): Promise<ServerContext> {
    const issued = await issueApiKey(database, {
      orgId, createdBy: OWNER, label: 'synthetic operation key',
      profileIds: [profileId, secondProfile], expiresAt: new Date(Date.now() + 3_600_000),
    });
    const key = await verifyApiKey(database, issued.token);
    return {
      handle: database, actor: key.actor, keyId: key.id,
      config: configFromEnv({ DATABASE_URL: database.connectionString }),
    };
  }

  it('uses real current-user RLS and leaves the pooled root role clean', async () => {
    const root = await context();
    const result = await withMcpOperation(root, async ({ handle, scope }) => {
      const [identity] = await handle.sql`select current_user, auth.uid() as uid`;
      const all = await handle.sql<{ org_id: string }[]>`select distinct org_id from public.ad_profiles`;
      return { identity, all, profiles: await listProfiles(handle, scope) };
    });
    expect(result.identity).toEqual({ current_user: 'authenticated', uid: OWNER });
    expect(result.all).toEqual([{ org_id: orgId }]);
    expect(result.profiles.map((p) => p.id).sort()).toEqual([profileId, secondProfile].sort());
    const [role] = await database.sql`select current_user`;
    expect(role!.current_user).not.toBe('authenticated');
  });

  it('keeps explicit agency and profile scope for a user belonging to two agencies', async () => {
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${otherOrg},${OWNER},'owner')`;
    try {
      await withMcpOperation(await context(), async ({ handle, scope }) => {
        expect((await listProfiles(handle, scope)).map((p) => p.id).sort()).toEqual([profileId, secondProfile].sort());
        await expect(resolveProfile(handle, scope, otherProfile)).rejects.toMatchObject({ code: 'not_found' });
      });
    } finally {
      await database.sql`delete from public.org_members where org_id=${otherOrg} and user_id=${OWNER}`;
    }
  });

  it('denies a stale verified identity before a handler can read', async () => {
    const root = await context();
    await database.sql`delete from public.org_members where org_id=${orgId} and user_id=${OWNER}`;
    let called = false;
    try {
      await expect(withMcpOperation(root, async () => { called = true; })).rejects.toMatchObject({ code: 'forbidden' });
      expect(called).toBe(false);
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${OWNER},'owner')`;
    }
  });

  it.each(['revoke', 'reduce_scope', 'expire'] as const)('refuses accumulated data after an in-flight key change: %s', async (change) => {
    const root = await context();
    await expect(withMcpOperation(root, async ({ handle, scope }) => {
      const result = await listProfiles(handle, scope);
      expect(result).toHaveLength(2);
      if (change === 'revoke') {
        await database.sql`update mcp.api_keys set revoked_at=clock_timestamp() where id=${root.keyId}`;
      } else if (change === 'reduce_scope') {
        await database.sql`update mcp.api_keys set profile_ids=array[${profileId}::uuid] where id=${root.keyId}`;
      } else {
        await database.sql`update mcp.api_keys set expires_at=clock_timestamp()-interval '1 second' where id=${root.keyId}`;
      }
      return result;
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses an accumulated response after membership removal inside a multi-query operation', async () => {
    const root = await context();
    try {
      await expect(withMcpOperation(root, async ({ handle, scope }) => {
        const result = await listProfiles(handle, scope);
        expect(result).toHaveLength(2);
        await database.sql`delete from public.org_members where org_id=${orgId} and user_id=${OWNER}`;
        expect(await listProfiles(handle, scope)).toHaveLength(0);
        return result;
      })).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${OWNER},'owner')`;
    }
  });

  it('derives current scope again and rejects forged key/org pairings', async () => {
    const root = await context();
    await database.sql`update mcp.api_keys set profile_ids=array[${profileId}::uuid] where id=${root.keyId}`;
    const profiles = await withMcpOperation(root, ({ handle, scope }) => listProfiles(handle, scope));
    expect(profiles.map((p) => p.id)).toEqual([profileId]);
    await expect(withMcpOperation({ ...root, actor: { orgId: otherOrg, userId: OTHER } }, async () => 'unexpected'))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('exposes no key secrets or cross-user metadata through the authenticated projection', async () => {
    const root = await context();
    const own = await withAuthenticatedIdentity(database, { userId: OWNER }, (sql) =>
      sql`select * from app.authorize_mcp_read_key(${root.keyId},${orgId})`);
    expect(Object.keys(own[0]!).sort()).toEqual(['org_slug', 'profile_ids']);
    const foreign = await withAuthenticatedIdentity(database, { userId: OTHER }, (sql) =>
      sql`select * from app.authorize_mcp_read_key(${root.keyId},${orgId})`);
    expect(foreign).toHaveLength(0);
    await expect(withAuthenticatedIdentity(database, { userId: OWNER }, (sql) => sql`select token_hash from mcp.api_keys`))
      .rejects.toMatchObject({ code: '42501' });
  });
});
