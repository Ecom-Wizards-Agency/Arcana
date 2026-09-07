import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { POST } from '../app/api/mcp-keys/route';
import { POST as REVOKE } from '../app/api/mcp-keys/[keyId]/revoke/route';
import { issueMcpKey } from './data/mcp-keys';

const available = await databaseAvailable();
const USER_A = '30303030-3030-4030-8030-303030303030';
const USER_B = '40404040-4040-4040-8040-404040404040';
const BRIDGE_SECRET = 'synthetic-mcp-key-route-bridge-secret';

describe.skipIf(!available)('MCP key issue route', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';
  let profileB = '';
  const previous = {
    databaseUrl: process.env['DATABASE_URL'],
    appUrl: process.env['WIZARD_ADS_APP_URL'],
    bridgeSecret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'],
    bridgeEnabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  };

  function input(body: unknown, origin: string | null = 'http://localhost:3000') {
    return new Request('http://localhost:3000/api/mcp-keys', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(origin === null ? {} : { origin }),
          'x-wizard-ads-auth-bridge': BRIDGE_SECRET,
          'x-wizard-ads-user-id': USER_A,
          'x-wizard-ads-org-id': orgA,
        },
        body: JSON.stringify(body),
      });
  }
  const request = (body: unknown) => POST(input(body));

  beforeAll(async () => {
    database = await createTestDatabase('wp54d_mcp_keys_route');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-route-alpha', ${USER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('mcp-key-route-bravo', ${USER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [ownProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [foreignProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${b?.seed_tenant_fixture ?? ''} limit 1
    `;
    profileA = ownProfile?.id ?? '';
    profileB = foreignProfile?.id ?? '';
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_APP_URL'] = 'http://localhost:3000';
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = BRIDGE_SECRET;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  }, 60_000);

  afterAll(async () => {
    if (previous.appUrl === undefined) delete process.env['WIZARD_ADS_APP_URL'];
    else process.env['WIZARD_ADS_APP_URL'] = previous.appUrl;
    if (previous.databaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previous.databaseUrl;
    if (previous.bridgeSecret === undefined) delete process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'];
    else process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = previous.bridgeSecret;
    if (previous.bridgeEnabled === undefined) delete process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'];
    else process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = previous.bridgeEnabled;
    await database?.drop();
  });

  it('issues only a read-only, expiring key for the submitted allowlist', async () => {
    const response = await request({
      label: 'Synthetic route client',
      profileIds: [profileA],
      expiresInDays: 7,
      scope: 'write',
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    const body = (await response.json()) as {
      key: { scope: string; profileIds: string[]; expiresAt: string };
      token: string;
    };
    expect(body.key.scope).toBe('read');
    expect(body.key.profileIds).toEqual([profileA]);
    expect(new Date(body.key.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(typeof body.token).toBe('string');

    const beforeDefaultIssue = Date.now();
    const defaultExpiryResponse = await request({
      label: 'Default expiry client',
      profileIds: [profileA],
    });
    expect(defaultExpiryResponse.status).toBe(201);
    const defaultExpiryBody = (await defaultExpiryResponse.json()) as {
      key: { expiresAt: string };
    };
    const defaultLifetimeDays =
      (new Date(defaultExpiryBody.key.expiresAt).getTime() - beforeDefaultIssue) /
      (24 * 60 * 60 * 1_000);
    expect(defaultLifetimeDays).toBeGreaterThan(29.99);
    expect(defaultLifetimeDays).toBeLessThan(30.01);
  });

  it('rejects empty or foreign allowlists and an unsupported expiry without inserting', async () => {
    const [{ count: before = 0 } = {}] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from mcp.api_keys where org_id = ${orgA}
    `;
    const attempts = await Promise.all([
      request({ label: 'No profile', profileIds: [], expiresInDays: 30 }),
      request({ label: 'Foreign profile', profileIds: [profileB], expiresInDays: 30 }),
      request({ label: 'Long lived', profileIds: [profileA], expiresInDays: 365 }),
    ]);
    expect(attempts.map((response) => response.status)).toEqual([400, 400, 400]);
    const [{ count: after = 0 } = {}] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from mcp.api_keys where org_id = ${orgA}
    `;
    expect(after).toBe(before);
  });

  it('refuses missing or foreign origins for issuance and revocation without mutation', async () => {
    const [before] = await database.sql`select count(*)::int as n from mcp.api_keys where org_id=${orgA}`;
    for (const origin of [null, 'https://outside.invalid']) {
      const issued = await POST(input({ label: 'Synthetic refused key', profileIds: [profileA] }, origin));
      const revoked = await REVOKE(input({}, origin), { params: Promise.resolve({ keyId: profileA }) });
      for (const response of [issued, revoked]) {
        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
        expect(await response.json()).toEqual({ error: 'Request origin refused' });
      }
    }
    const [after] = await database.sql`select count(*)::int as n from mcp.api_keys where org_id=${orgA}`;
    expect(after).toEqual(before);
  });

  it('revokes an owned key idempotently and conceals a guessed foreign key', async () => {
    const own = await issueMcpKey(database, { orgId: orgA, createdBy: USER_A, label: 'Synthetic revoke', profileIds: [profileA] });
    const foreign = await issueMcpKey(database, { orgId: orgB, createdBy: USER_B, label: 'Synthetic foreign', profileIds: [profileB] });
    const denied = await REVOKE(input({}), { params: Promise.resolve({ keyId: foreign.record.id }) });
    expect(denied.status).toBe(404);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await REVOKE(input({}), { params: Promise.resolve({ keyId: own.record.id }) });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
      expect(await response.json()).toEqual({ revoked: true });
    }
    const [foreignRow] = await database.sql`select revoked_at from mcp.api_keys where id=${foreign.record.id}`;
    expect(foreignRow!.revoked_at).toBeNull();
    const [audit] = await database.sql`select count(*)::int as n from public.audit_log where org_id=${orgA} and target_id=${own.record.id} and action='mcp_key.revoked'`;
    expect(audit!.n).toBe(1);
  });
});
