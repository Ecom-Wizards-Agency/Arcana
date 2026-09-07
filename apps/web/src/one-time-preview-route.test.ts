import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { POST } from '../app/api/optimizer/runs/one-time/route';
import { GET } from '../app/api/optimizer/runs/[batchId]/route';

const available = await databaseAvailable();
const owner = 'abababab-abab-4bab-8bab-abababababab';
const outsider = 'bcbcbcbc-bcbc-4cbc-8cbc-bcbcbcbcbcbc';
const viewer = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
const revision = 'c'.repeat(40);
const secret = ['synthetic', 'one-time', 'preview', 'bridge'].join('-');
let database: TestDatabase;
let orgId: string;
let profileId: string;
let foreignOrg: string;
let foreignProfile: string;
let foreignBatch: string;
const previous = new Map<string, string | undefined>();
const keys = ['DATABASE_URL', 'WIZARD_ADS_E2E_AUTH_BRIDGE', 'WIZARD_ADS_AUTH_BRIDGE_SECRET', 'OPENSPELL_RECOMMENDATION_LANE_READY', 'OPENSPELL_RECOMMENDATION_LANE_REVISION'];
const configuration = { version: 1, method: 'rpc', targetAcos: 0.37, bidFloor: 0.11, bidCeiling: 4.3,
  bidIncreaseCap: 0.23, bidDecreaseCap: 0.41, window: { start: '2026-08-01', end: '2026-08-26' } };
const headers = (userId = owner, organization = orgId) => ({ 'content-type': 'application/json',
  'x-wizard-ads-user-id': userId, 'x-wizard-ads-org-id': organization, 'x-wizard-ads-auth-bridge': secret });
const body = () => ({ version: 1, profileId, clientRequestId: randomUUID(), scope: { mode: 'selected', campaignIds: ['c-1'] }, configuration });
const post = (input: unknown, userId = owner, organization = orgId) => POST(new Request('http://localhost/api/optimizer/runs/one-time', {
  method: 'POST', headers: headers(userId, organization), body: JSON.stringify(input),
}));

beforeAll(async () => {
  if (!available) return;
  database = await createTestDatabase('one_time_http');
  for (const key of keys) previous.set(key, process.env[key]);
  process.env['DATABASE_URL'] = database.connectionString;
  process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = secret;
  process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
  process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'] = revision;
  const seeded = await database.sql<{ org_id: string }[]>`
    select app.seed_tenant_fixture('one-time-http-alpha', ${owner}::uuid, 'owner') as org_id
    union all select app.seed_tenant_fixture('one-time-http-bravo', ${outsider}::uuid, 'owner') as org_id
  `;
  [orgId, foreignOrg] = seeded.map((row) => row.org_id) as [string, string];
  const profiles = await database.sql<{ id: string; org_id: string }[]>`select id, org_id from public.ad_profiles`;
  profileId = profiles.find((row) => row.org_id === orgId)!.id;
  foreignProfile = profiles.find((row) => row.org_id === foreignOrg)!.id;
  const [batch] = await database.sql<{ id: string }[]>`select id from public.recommendation_preview_batches where org_id = ${foreignOrg}::uuid`;
  foreignBatch = batch!.id;
  await database.sql`select public.auth_user_stub(${viewer}::uuid)`;
  await database.sql`insert into public.org_members (org_id, user_id, role) values (${orgId}::uuid, ${viewer}::uuid, 'viewer')`;
  await database.sql`update app.recommendation_claim_authority set protocol = 'fenced', admission = 'scoped', authorized_revision = ${revision}, epoch = epoch + 1 where singleton`;
  const session = await database.sql.reserve();
  try {
    await session.unsafe('set session authorization openspell_recommendation_worker');
    await session`select public.report_recommendation_runtime('one-time-http-worker', ${revision}, array[1,2], true)`;
  } finally { await session.unsafe('reset session authorization'); session.release(); }
}, 60_000);
afterAll(async () => {
  for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await database?.drop();
});

it.skipIf(!available)('reconciles an interrupted receipt after worker loss without admitting different settings', async () => {
  const input = body();
  const first = await post(input);
  expect(first.status).toBe(202);
  const accepted = await first.json() as { batchId: string; scope: { campaignCount: number }; childCount: number };
  expect(accepted).toMatchObject({ scope: { campaignCount: 1 }, childCount: 1 });
  await database.sql`update app.recommendation_runtime_state set ready = false where singleton`;
  try {
    const retry = await post(input);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(accepted);
    const changed = await post({ ...input, configuration: { ...configuration, targetAcos: 0.39 } });
    expect(changed.status).toBe(409);
    const fresh = await post(body());
    expect(fresh.status).toBe(503);
    expect(await fresh.json()).toMatchObject({ reason: 'worker_unavailable' });
    const status = await GET(new Request(`http://localhost/api/optimizer/runs/${accepted.batchId}?profileId=${profileId}`, { headers: headers() }),
      { params: Promise.resolve({ batchId: accepted.batchId }) });
    expect(status.status).toBe(200);
    expect(status.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(await status.json()).toMatchObject({ status: 'queued', executionSnapshot: { configuration }, availability: { ready: false, reason: 'worker_unavailable' } });
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.recommendation_preview_batches where client_request_id = ${input.clientRequestId}::uuid
    `;
    expect(count?.count).toBe(1);
  } finally { await database.sql`update app.recommendation_runtime_state set ready = true where singleton`; }
});

it.skipIf(!available)('denies guessed tenant/profile/batch identities and lower-privilege requests', async () => {
  expect((await post(body(), viewer)).status).toBe(403);
  expect((await post(body(), outsider)).status).toBe(403);
  expect((await post(body(), owner, foreignOrg)).status).toBe(403);
  expect((await post({ ...body(), profileId: foreignProfile })).status).toBe(400);
  expect((await post({ ...body(), scope: { mode: 'selected', campaignIds: ['foreign-campaign'] } })).status).toBe(409);
  const foreign = await GET(new Request(`http://localhost/api/optimizer/runs/${foreignBatch}?profileId=${foreignProfile}`, { headers: headers() }),
    { params: Promise.resolve({ batchId: foreignBatch }) });
  expect(foreign.status).toBe(404);
});

it.skipIf(!available)('refuses unsupported versions and missing or contradictory settings before admission', async () => {
  for (const input of [
    { ...body(), version: 2 },
    { ...body(), configuration: { ...configuration, bidFloor: 5 } },
    { ...body(), configuration: { ...configuration, targetAcos: undefined } },
    { ...body(), lookbackDays: 7 },
  ]) expect((await post(input)).status).toBe(400);
});
