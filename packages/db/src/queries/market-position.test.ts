import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { listMarketPositionLinks, listMarketPositionProducts, readMarketPositionSettings, readMarketRankSeries, saveMarketPositionSettings } from './market-position.js';

let database: TestDatabase;
const owner = '00000000-0000-4000-8000-000000000011';
const other = '00000000-0000-4000-8000-000000000012';
const viewer = '00000000-0000-4000-8000-000000000013';
let orgId: string;
let otherOrgId: string;
let profileId: string;
let foreignProfileId: string;
beforeAll(async () => {
  database = await createTestDatabase('wp268_market');
  const [a] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-market-a', ${owner}, 'owner') as id`;
  const [b] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-market-b', ${other}, 'owner') as id`;
  orgId = a!.id; otherOrgId = b!.id;
  const profiles = await database.sql<{ id: string; org_id: string }[]>`select id, org_id from public.ad_profiles where org_id in (${orgId}, ${otherOrgId})`;
  profileId = profiles.find((row) => row.org_id === orgId)!.id;
  foreignProfileId = profiles.find((row) => row.org_id === otherOrgId)!.id;
  await database.sql`delete from public.market_position_settings where profile_id=${profileId}`;
  await database.sql`insert into public.market_position_settings(org_id,profile_id) values (${otherOrgId},${foreignProfileId}) on conflict do nothing`;
  await database.sql`select public.auth_user_stub(${viewer})`;
  await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${viewer},'viewer')`;
}, 60_000);
afterAll(async () => { await database?.drop(); });

it('defaults to 15 and persists zero and decimal thresholds in one row', async () => {
  expect((await readMarketPositionSettings(database, orgId, profileId)).thresholdPercent).toBe(15);
  for (const thresholdPercent of [0, 12.5]) {
    const saved = await withAuthenticatedOrgEditor(database, { userId: owner, orgId }, (context) => saveMarketPositionSettings(context, { profileId, thresholdPercent }));
    expect(saved.thresholdPercent).toBe(thresholdPercent);
    expect(saved.updatedAt).not.toBeNull();
    expect((await readMarketPositionSettings(database, orgId, profileId)).thresholdPercent).toBe(thresholdPercent);
  }
  expect(await database.sql`select profile_id from public.market_position_settings where profile_id=${profileId}`).toHaveLength(1);
});

it('refuses foreign profiles, forged agency authority, viewers and direct cross-agency writes', async () => {
  await expect(withAuthenticatedOrgEditor(database, { userId: owner, orgId }, (context) => saveMarketPositionSettings(context, { profileId: foreignProfileId, thresholdPercent: 9 }))).rejects.toThrow('Profile not found');
  await expect(withAuthenticatedOrgEditor(database, { userId: owner, orgId: otherOrgId }, (context) => saveMarketPositionSettings(context, { profileId: foreignProfileId, thresholdPercent: 9 }))).rejects.toThrow();
  await expect(withAuthenticatedOrgEditor(database, { userId: viewer, orgId }, (context) => saveMarketPositionSettings(context, { profileId, thresholdPercent: 9 }))).rejects.toThrow();
  await expect(asUser(database, owner, (sql) => sql`insert into public.market_position_settings(org_id,profile_id,threshold_percent) values (${otherOrgId},${foreignProfileId},9)`)).rejects.toThrow();
  await expect(database.sql`insert into public.market_position_settings(org_id,profile_id,threshold_percent) values (${orgId},${foreignProfileId},9)`).rejects.toThrow();
  expect(await database.sql`select threshold_percent from public.market_position_settings where profile_id=${foreignProfileId}`).toEqual([{ threshold_percent: 15 }]);
});

it('keeps category and day identity, picks the latest sample and never replaces a null rank', async () => {
  await database.sql`insert into public.keepa_bsr_observations(org_id,asin,category,observed_at,bsr) values
    (${orgId},'B000000001','Synthetic category','2026-06-01T01:00:00Z',1000),
    (${orgId},'B000000001','Synthetic category','2026-06-01T12:00:00Z',null),
    (${orgId},'B000000001','Synthetic category','2026-06-03T12:00:00Z',900),
    (${orgId},'B000000001','Other category','2026-06-03T12:00:00Z',10),
    (${otherOrgId},'B000000001','Synthetic category','2026-06-03T14:00:00Z',1)`;
  const series = await asUser(database, owner, (sql) => readMarketRankSeries({ sql }, orgId, ['B000000001'], '2026-06-01', '2026-06-03'));
  expect(series).toHaveLength(2);
  expect(series.reduce((sum, entry) => sum + entry.points.length, 0)).toBe(3);
  expect(series.find((entry) => entry.category === 'Synthetic category')?.points).toEqual([{ date: '2026-06-01', observedAt: '2026-06-01T12:00:00.000Z', bsr: null }, { date: '2026-06-03', observedAt: '2026-06-03T12:00:00.000Z', bsr: 900 }]);
  expect(await asUser(database, owner, (sql) => readMarketRankSeries({ sql }, otherOrgId, ['B000000001'], '2026-06-01', '2026-06-03'))).toEqual([]);
});

it('limits products and enabled links to the selected agency and profile', async () => {
  const products = await listMarketPositionProducts(database, orgId, profileId);
  const expected = await database.sql`select distinct asin from public.product_ads where org_id=${orgId} and profile_id=${profileId} and asin is not null and asin <> ''`;
  expect(products).toHaveLength(expected.length);
  await database.sql`insert into public.competitor_links(org_id, profile_id, our_asin, competitor_asin, enabled) values
    (${orgId},${profileId},'B000000001','B000000002',true),
    (${orgId},${profileId},'B000000001','B000000003',false),
    (${otherOrgId},${foreignProfileId},'B000000001','B000000004',true)`;
  const links = await listMarketPositionLinks(database, orgId, profileId);
  expect(links.filter((link) => link.ownAsin === 'B000000001')).toEqual([{ ownAsin: 'B000000001', competitorAsin: 'B000000002', category: null }]);
});
