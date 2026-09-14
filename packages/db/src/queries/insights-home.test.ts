import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { listHomeInsights } from './keepa.js';
import { listHomeMarketGaps } from './keepa.js';

let database: TestDatabase;
let orgId: string;
let profileId: string;
let otherProfileId: string;
beforeAll(async () => {
  database = await createTestDatabase('home_reads');
  const [org] = await database.sql`insert into public.orgs(slug, name) values ('home-test', 'Home test') returning id`;
  orgId = String(org!.id);
  const [connection] = await database.sql`insert into public.ads_connections(org_id, label) values (${orgId}, 'Synthetic connection') returning id`;
  const profiles = await database.sql`insert into public.ad_profiles(org_id, connection_id, amazon_profile_id, region, country_code, currency_code, timezone)
    values (${orgId}, ${connection!.id}, 'synthetic-home', 'NA', 'US', 'USD', 'UTC'),
           (${orgId}, ${connection!.id}, 'synthetic-other', 'NA', 'US', 'USD', 'UTC') returning id`;
  expect(profiles).toHaveLength(2);
  profileId = String(profiles[0]!.id); otherProfileId = String(profiles[1]!.id);
}, 60_000);
afterAll(async () => database?.drop());

it('conserves both insight writers and excludes another profile and out-of-window events', async () => {
  const inserted = await database.sql`insert into public.insights(org_id, profile_id, date, kind, title, body, source)
    values (${orgId}, ${profileId}, '2026-06-14', 'competitor_deal', 'Synthetic deal', 'Deal body', 'keepa'),
      (${orgId}, ${profileId}, '2026-06-13', 'analysis', 'Synthetic analysis', 'Analysis body', 'headless_analyst'),
      (${orgId}, ${otherProfileId}, '2026-06-14', 'analysis', 'Other profile', 'Body', 'headless_analyst'),
      (${orgId}, ${profileId}, '2026-06-01', 'analysis', 'Older event', 'Body', 'headless_analyst') returning id`;
  expect(inserted).toHaveLength(4);
  const rows = await listHomeInsights(database, { orgId, profileId, start: '2026-06-08', end: '2026-06-14' });
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.source)).toEqual(['keepa', 'headless_analyst']);
  expect(rows.map((row) => row.title)).toEqual(['Synthetic deal', 'Synthetic analysis']);
  expect(await listHomeInsights(database, { orgId: '11111111-1111-4111-8111-111111111111', profileId, start: '2026-06-08', end: '2026-06-14' })).toHaveLength(0);
});
it('finds the nearest linked rival within a comparable category and day', async () => {
  await database.sql`insert into public.competitor_links(org_id, profile_id, our_asin, competitor_asin, enabled)
    values (${orgId}, ${profileId}, 'B0TEST0001', 'B0TEST0002', true),
      (${orgId}, ${profileId}, 'B0TEST0001', 'B0TEST0003', true),
      (${orgId}, ${otherProfileId}, 'B0TEST0001', 'B0TEST0004', true)`;
  const inserted = await database.sql`insert into public.keepa_bsr_observations(org_id, asin, category, observed_at, bsr)
    values (${orgId}, 'B0TEST0001', 'category-a', '2026-06-14T12:00:00Z', 240),
      (${orgId}, 'B0TEST0002', 'category-a', '2026-06-14T12:00:00Z', 210),
      (${orgId}, 'B0TEST0003', 'category-a', '2026-06-14T12:00:00Z', 180),
      (${orgId}, 'B0TEST0004', 'category-a', '2026-06-14T12:00:00Z', 239),
      (${orgId}, 'B0TEST0003', 'category-b', '2026-06-14T12:00:00Z', 240),
      (${orgId}, 'B0TEST0003', 'category-a', '2026-06-15T12:00:00Z', 239) returning id`;
  expect(inserted).toHaveLength(6);
  const rows = await listHomeMarketGaps(database, { orgId, profileId, asOf: '2026-06-14' });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ competitorAsin: 'B0TEST0002', category: 'category-a', gap: 30, ourRank: 240, competitorRank: 210, observedOn: '2026-06-14' });
  await database.sql`insert into public.keepa_bsr_observations(org_id, asin, category, observed_at, bsr)
    values (${orgId}, 'B0TEST0002', 'category-a', '2026-06-14T18:00:00Z', null)`;
  expect((await listHomeMarketGaps(database, { orgId, profileId, asOf: '2026-06-14' }))[0]?.competitorAsin).toBe('B0TEST0003');
});
