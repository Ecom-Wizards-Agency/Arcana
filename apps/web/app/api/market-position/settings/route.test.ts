import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { PUT } from './route';

let database: TestDatabase;
const owner = '00000000-0000-4000-8000-000000000021';
const foreignOwner = '00000000-0000-4000-8000-000000000022';
const viewer = '00000000-0000-4000-8000-000000000023';
const bridge = 'synthetic-market-position-test-bridge';
const previous = { database: process.env['DATABASE_URL'], enabled: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'], secret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] };
let orgId: string;
let profileId: string;
let foreignProfile: string;
beforeAll(async () => {
  database = await createTestDatabase('wp268_route');
  const [a] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-market-route-a',${owner},'owner') as id`;
  const [b] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-market-route-b',${foreignOwner},'owner') as id`;
  orgId = a!.id;
  const profiles = await database.sql<{ id: string; org_id: string }[]>`select id,org_id from public.ad_profiles where org_id in (${orgId},${b!.id})`;
  profileId = profiles.find((p) => p.org_id === orgId)!.id;
  foreignProfile = profiles.find((p) => p.org_id !== orgId)!.id;
  await database.sql`insert into public.market_position_settings(org_id,profile_id) values (${b!.id},${foreignProfile}) on conflict do nothing`;
  await database.sql`select public.auth_user_stub(${viewer})`;
  await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${viewer},'viewer')`;
  process.env['DATABASE_URL'] = database.connectionString;
  process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = bridge;
}, 60_000);
afterAll(async () => {
  for (const [key, value] of Object.entries({ DATABASE_URL: previous.database, WIZARD_ADS_E2E_AUTH_BRIDGE: previous.enabled, WIZARD_ADS_AUTH_BRIDGE_SECRET: previous.secret })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await database?.drop();
});
const request = (body: unknown, userId = owner) => PUT(new Request('http://localhost/api/market-position/settings', { method: 'PUT', headers: {
  'content-type': 'application/json', 'x-wizard-ads-auth-bridge': bridge, 'x-wizard-ads-user-id': userId, 'x-wizard-ads-org-id': orgId,
}, body: JSON.stringify(body) }));

it('persists the threshold through the authenticated editor route', async () => {
  const response = await request({ profileId, thresholdPercent: 22 });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('private, no-store');
  expect(await response.json()).toMatchObject({ profileId, thresholdPercent: 22 });
  expect(await database.sql`select threshold_percent from public.market_position_settings where profile_id=${profileId}`).toEqual([{ threshold_percent: 22 }]);
});
it('refuses foreign agencies and viewer writes without changing persisted state', async () => {
  expect((await request({ profileId: foreignProfile, thresholdPercent: 30 })).status).toBe(404);
  expect((await request({ profileId, thresholdPercent: 30 }, viewer)).status).toBe(403);
  expect(await database.sql`select threshold_percent from public.market_position_settings where profile_id=${foreignProfile}`).toEqual([{ threshold_percent: 15 }]);
  expect(await database.sql`select threshold_percent from public.market_position_settings where profile_id=${profileId}`).toEqual([{ threshold_percent: 22 }]);
});
it('rejects malformed preferences and forged authority', async () => {
  for (const body of [null, { profileId, thresholdPercent: null }, { profileId, thresholdPercent: -1 }, { profileId, thresholdPercent: 101 }, { profileId, thresholdPercent: 15, orgId }]) expect((await request(body)).status).toBe(400);
});
