import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import {
  CREATOR_WRITE_PROFILES_REFUSED,
  issueMcpKey,
  listMcpKeys,
  parseMcpKeyScope,
} from './mcp-keys';
import { issueManagedMcpCreatorWriteKey, issueManagedMcpReadKey, withAuthenticatedActor } from '@wizard-ads/db';
import type * as Db from '@wizard-ads/db';
import { POST } from '../../app/api/mcp-keys/route';

// Pass-through spies: the database tests run the real commands; the unit tests below observe which one is called.
vi.mock('@wizard-ads/db', async (original) => {
  const actual = await original<typeof Db>();
  return {
    ...actual,
    issueManagedMcpReadKey: vi.fn(actual.issueManagedMcpReadKey),
    issueManagedMcpCreatorWriteKey: vi.fn(actual.issueManagedMcpCreatorWriteKey),
  };
});
import { MCP_KEY_EXPIRY_DAY_OPTIONS } from '../mcp-key-policy';

const available = await databaseAvailable();
const USER_A = '10101010-1010-4010-8010-101010101010';
const USER_B = '20202020-2020-4020-8020-202020202020';

describe.skipIf(!available)('MCP key data safety', () => {
  let database: TestDatabase;
  let orgA = '';
  let profileA = '';
  let profileB = '';

  beforeAll(async () => {
    database = await createTestDatabase('wp54d_mcp_keys_data');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-data-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-data-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    const [ownProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [foreignProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${b?.seed_tenant_fixture ?? ''} limit 1
    `;
    profileA = ownProfile?.id ?? '';
    profileB = foreignProfile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('stores a read-only allowlist and the selected bounded expiry', async () => {
    const issued = await issueMcpKey(database, {
      orgId: orgA,
      label: 'Synthetic client',
      profileIds: [profileA],
      expiresInDays: 30,
      createdBy: USER_A,
    });

    expect(issued.record.scope).toBe('read');
    expect(issued.record.profileIds).toEqual([profileA]);
    expect(new Date(issued.record.expiresAt!).getTime() - new Date(issued.record.createdAt).getTime()).toBe(30 * 86_400_000);
    const listed = await withAuthenticatedActor(database, { orgId: orgA, userId: USER_A }, (sql) => listMcpKeys({ sql }, orgA));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.profileIds).toEqual([profileA]);
  });

  it('rejects missing profiles, unbounded expiry, and a profile from another org', async () => {
    await expect(
      issueMcpKey(database, { orgId: orgA, label: 'No profiles', profileIds: [], createdBy: USER_A }),
    ).rejects.toThrow(/at least one profile/i);
    await expect(
      issueMcpKey(database, {
        orgId: orgA,
        label: 'Bad expiry',
        createdBy: USER_A,
        profileIds: [profileA],
        expiresInDays: Math.max(...MCP_KEY_EXPIRY_DAY_OPTIONS) + 1,
      }),
    ).rejects.toThrow(/expiry must be/i);

    const before = await withAuthenticatedActor(database, { orgId: orgA, userId: USER_A }, (sql) => listMcpKeys({ sql }, orgA));
    await expect(
      issueMcpKey(database, {
        orgId: orgA,
        label: 'Foreign profile',
        createdBy: USER_A,
        profileIds: [profileA, profileB],
      }),
    ).rejects.toThrow(/unavailable profile/i);
    const after = await withAuthenticatedActor(database, { orgId: orgA, userId: USER_A }, (sql) => listMcpKeys({ sql }, orgA));
    expect(after).toHaveLength(before.length);
  });
});

describe('MCP key classes the web may issue', () => {
  const ORG = '50505050-5050-4050-8050-505050505050';
  const USER = '60606060-6060-4060-8060-606060606060';
  const PROFILE = '70707070-7070-4070-8070-707070707070';
  const handle = { sql: {} } as unknown as Parameters<typeof issueMcpKey>[0];
  afterEach(() => { vi.mocked(issueManagedMcpCreatorWriteKey).mockClear(); vi.mocked(issueManagedMcpReadKey).mockClear(); });

  it('reads an absent class as read and refuses every class but read and creator:write', () => {
    const cases: [unknown, string | null][] = [
      [undefined, 'read'], ['read', 'read'], ['creator:write', 'creator:write'], ['write', null], ['admin', null], [null, null], [1, null],
      ['CREATOR:WRITE', null],
    ];
    expect(cases.map(([value]) => parseMcpKeyScope(value))).toEqual(cases.map(([, expected]) => expected));
  });

  it('issues a creator:write key through the creator command with no profiles and the same token shape', async () => {
    const record = { id: '80808080-8080-4080-8080-808080808080', label: 'Skill runner', keyPrefix: 'wza_synthetic', scope: 'creator:write' as const,
      profileIds: [], expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: '2026-09-27T00:00:00.000Z' };
    vi.mocked(issueManagedMcpCreatorWriteKey).mockResolvedValueOnce(record);
    const issued = await issueMcpKey(handle, { orgId: ORG, label: ' Skill runner ', profileIds: [], scope: 'creator:write', expiresInDays: 7, createdBy: USER });
    expect(issued.record).toBe(record);
    expect(vi.mocked(issueManagedMcpCreatorWriteKey)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(issueManagedMcpReadKey)).toHaveBeenCalledTimes(0);
    const [calledHandle, actor, command] = vi.mocked(issueManagedMcpCreatorWriteKey).mock.calls[0]!;
    expect(calledHandle).toBe(handle);
    expect(actor).toEqual({ orgId: ORG, userId: USER });
    expect(Object.keys(command).sort()).toEqual(['expiresInDays', 'keyPrefix', 'label', 'tokenHash']);
    expect(command).toMatchObject({ label: 'Skill runner', expiresInDays: 7 });
    expect(issued.token).toMatch(/^wza_[A-Za-z0-9_-]{43}$/);
    expect(command.keyPrefix).toBe(issued.token.slice(0, 12));
    expect(command.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(command.tokenHash).not.toContain(issued.token);
  });

  it('refuses profiles on a creator:write key before any command runs', async () => {
    await expect(issueMcpKey(handle, { orgId: ORG, label: 'Skill runner', profileIds: [PROFILE], scope: 'creator:write', createdBy: USER }))
      .rejects.toThrow(CREATOR_WRITE_PROFILES_REFUSED);
    await expect(issueMcpKey(handle, { orgId: ORG, label: 'Skill runner', profileIds: [], scope: 'creator:write', expiresInDays: 31, createdBy: USER }))
      .rejects.toThrow(/expiry must be/i);
    expect(vi.mocked(issueManagedMcpCreatorWriteKey)).toHaveBeenCalledTimes(0);
    expect(vi.mocked(issueManagedMcpReadKey)).toHaveBeenCalledTimes(0);
  });
});

describe.skipIf(!available)('creator:write key issuance against the database', () => {
  let database: TestDatabase;
  let orgA = '';
  let profileA = '';
  const OWNER = '90909090-9090-4090-8090-909090909090';
  const BRIDGE_SECRET = 'synthetic-mcp-creator-key-bridge-secret';
  const ENV = ['DATABASE_URL', 'WIZARD_ADS_APP_URL', 'WIZARD_ADS_AUTH_BRIDGE_SECRET', 'WIZARD_ADS_E2E_AUTH_BRIDGE'] as const;
  const previous = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  const request = (body: unknown) => POST(new Request('http://localhost:3000/api/mcp-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000', 'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
      'x-wizard-ads-user-id': OWNER, 'x-wizard-ads-org-id': orgA },
    body: JSON.stringify(body),
  }));

  beforeAll(async () => {
    database = await createTestDatabase('wp333_mcp_creator_keys');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`select app.seed_tenant_fixture('mcp-creator-key-alpha', ${OWNER}, 'owner')`;
    orgA = a?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgA} limit 1`;
    profileA = profile?.id ?? '';
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_APP_URL'] = 'http://localhost:3000';
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  }, 60_000);

  afterAll(async () => {
    for (const name of ENV) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await database?.drop();
  });

  it('routes a creator:write request to a profile-less key and refuses write, unknown classes and profiles on creator:write', async () => {
    const before = await withAuthenticatedActor(database, { orgId: orgA, userId: OWNER }, (sql) => listMcpKeys({ sql }, orgA));
    const refusals = await Promise.all([
      request({ label: 'Write key', profileIds: [profileA], scope: 'write' }),
      request({ label: 'Unknown class', profileIds: [profileA], scope: 'admin' }),
      request({ label: 'Creator with profiles', profileIds: [profileA], scope: 'creator:write' }),
      request({ label: 'Creator with a profile field', profileIds: 'none', scope: 'creator:write' }),
    ]);
    expect(refusals.map((response) => response.status)).toEqual([400, 400, 400, 400]);
    const middle = await withAuthenticatedActor(database, { orgId: orgA, userId: OWNER }, (sql) => listMcpKeys({ sql }, orgA));
    expect(middle).toHaveLength(before.length);

    const response = await request({ label: 'Synthetic skill route', scope: 'creator:write', expiresInDays: 7 });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { key: { scope: string; profileIds: string[] }; token: string };
    expect(body.key).toMatchObject({ scope: 'creator:write', profileIds: [] });
    expect(body.token).toMatch(/^wza_/);
    const emptyList = await request({ label: 'Synthetic skill empty list', scope: 'creator:write', profileIds: [] });
    expect(emptyList.status).toBe(201);
    const after = await withAuthenticatedActor(database, { orgId: orgA, userId: OWNER }, (sql) => listMcpKeys({ sql }, orgA));
    expect(after).toHaveLength(before.length + 2);
  });

  it('stores a creator:write key with no profiles beside the read keys', async () => {
    const before = await withAuthenticatedActor(database, { orgId: orgA, userId: OWNER }, (sql) => listMcpKeys({ sql }, orgA));
    const issued = await issueMcpKey(database, { orgId: orgA, label: 'Synthetic skill', profileIds: [], scope: 'creator:write', expiresInDays: 30,
      createdBy: OWNER });
    expect(issued.record.scope).toBe('creator:write');
    expect(issued.record.profileIds).toEqual([]);
    const after = await withAuthenticatedActor(database, { orgId: orgA, userId: OWNER }, (sql) => listMcpKeys({ sql }, orgA));
    expect(after).toHaveLength(before.length + 1);
    const known = new Set(before.map((key) => key.id));
    expect(after.filter((key) => !known.has(key.id)).map((key) => [key.id, key.scope, key.profileIds])).toEqual([[issued.record.id, 'creator:write', []]]);
  });
});
