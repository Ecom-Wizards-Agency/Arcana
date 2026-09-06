import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { issueApiKey, verifyApiKey, type IssueApiKeyInput } from './keys.js';

const available = await databaseAvailable();
const OWNER = 'c5c5c5c5-c5c5-45c5-85c5-c5c5c5c5c5c5';
const OTHER = 'd6d6d6d6-d6d6-46d6-86d6-d6d6d6d6d6d6';

describe.skipIf(!available)('MCP keys follow current agency membership', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('mcp_membership');
    const [seed] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('key-owner',${OWNER},'owner') as id`;
    orgId = seed!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} limit 1`;
    profileId = profile!.id;
    await database.sql`select app.seed_tenant_fixture('key-other',${OTHER},'owner')`;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  const input = (): IssueApiKeyInput => ({
    orgId, createdBy: OWNER, label: 'synthetic owned key', profileIds: [profileId],
    expiresAt: new Date(Date.now() + 3_600_000),
  });

  it('returns the verified issuing identity and refuses a key after its membership is removed', async () => {
    const issued = await issueApiKey(database, input());
    expect((await verifyApiKey(database, issued.token)).actor).toEqual({ orgId, userId: OWNER });
    const [before] = await database.sql`select last_used_at::text from mcp.api_keys where id=${issued.record.id}`;
    await database.sql`delete from public.org_members where org_id=${orgId} and user_id=${OWNER}`;
    try {
      await expect(verifyApiKey(database, issued.token)).rejects.toMatchObject({ status: 401 });
      const [after] = await database.sql`select last_used_at::text from mcp.api_keys where id=${issued.record.id}`;
      expect(after).toEqual(before);
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${OWNER},'owner')`;
    }
    // A later new membership is not the authority under which this key was issued.
    await expect(verifyApiKey(database, issued.token)).rejects.toMatchObject({ status: 401 });
  });

  it('refuses legacy ownerless keys without modifying their use timestamp', async () => {
    const issued = await issueApiKey(database, input());
    await database.sql`update mcp.api_keys set created_by=null where id=${issued.record.id}`;
    await expect(verifyApiKey(database, issued.token)).rejects.toMatchObject({ status: 401 });
    const [row] = await database.sql`select last_used_at from mcp.api_keys where id=${issued.record.id}`;
    expect(row!.last_used_at).toBeNull();
  });

  it('cannot issue a key for a foreign owner or an identity without management authority', async () => {
    const [before] = await database.sql<{ count: number }[]>`select count(*)::integer as count from mcp.api_keys where org_id=${orgId}`;
    await expect(issueApiKey(database, { ...input(), createdBy: OTHER })).rejects.toMatchObject({ status: 403 });
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${OTHER},'viewer')`;
    try {
      await expect(issueApiKey(database, { ...input(), createdBy: OTHER })).rejects.toMatchObject({ status: 403 });
    } finally {
      await database.sql`delete from public.org_members where org_id=${orgId} and user_id=${OTHER}`;
    }
    const [after] = await database.sql<{ count: number }[]>`select count(*)::integer as count from mcp.api_keys where org_id=${orgId}`;
    expect(after).toEqual(before);
  });

  it('does not treat omission of the issuer as operator authority', async () => {
    const { createdBy: _creator, ...missingIssuer } = input();
    await expect(issueApiKey(database, missingIssuer as IssueApiKeyInput)).rejects.toThrow();
  });
});
