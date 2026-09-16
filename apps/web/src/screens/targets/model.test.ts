import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { withAuthenticatedActor } from '@wizard-ads/db';
import { corridorSummary } from '@wizard-ads/core';
import { PostgresBidSeriesStore, syncBidSeriesForProfile, type SuggestedBidClient } from '@wizard-ads/worker';
import { bidRecommendationTargetKey } from '@wizard-ads/shared';
import { loadTarget360 } from './model';

let db: TestDatabase;
const orgId = randomUUID(), profileId = randomUUID(), userId = randomUUID();
const args = { orgId, profileId, targetId: 'synthetic-keyword', from: '2026-09-01', to: '2026-09-04' };
beforeAll(async () => {
  db = await createTestDatabase('target_max_cpc', { applyFixture: false });
  await db.sql`insert into auth.users(id) values(${userId})`;
  await db.sql`insert into public.orgs(id,slug,name) values(${orgId},'synthetic-corridor','Synthetic corridor')`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${userId},'owner')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${profileId},${orgId},'synthetic-profile','NA','US','USD','UTC')`;
  await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,state,budget_amount,budget_type,placement_bidding) values(${orgId},${profileId},'synthetic-campaign','SP','enabled',100,'daily','{"topOfSearch":0,"restOfSearch":0,"productPages":0}')`;
  await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at) values(${orgId},${profileId},${args.targetId},'SP','enabled','synthetic-campaign','synthetic-group','Synthetic keyword','exact',5,now())`;
  const store = new PostgresBidSeriesStore(db);
  const profile = { id: profileId, orgId, amazonProfileId: 'synthetic-profile', region: 'NA' as const, currencyCode: 'USD', timezone: 'UTC' };
  const client: SuggestedBidClient = { getSpSuggestedBids: async (_profile, request) => ({
    byTarget: new Map(request.targets.map((target) => [bidRecommendationTargetKey(target), { ...target, low: 4, median: 6, high: 10 }])),
    offered: request.targets.length, eligible: request.targets.length, requested: request.targets.length,
    returned: request.targets.length, refused: 0, unmatched: 0,
  }) };
  const fixtures = [
    { date: '2026-09-01', bidding: { topOfSearch: 0, restOfSearch: 0, productPages: 0 }, observed: true },
    { date: '2026-09-02', bidding: null, observed: false },
    { date: '2026-09-03', bidding: { topOfSearch: 0, restOfSearch: null, productPages: 0 }, observed: false },
    { date: '2026-09-04', bidding: { topOfSearch: 100, restOfSearch: 0, productPages: 0 }, observed: true },
  ];
  expect(fixtures).toHaveLength(4);
  for (const fixture of fixtures) {
    await db.sql`update public.campaigns set placement_bidding=${fixture.bidding === null ? null : JSON.stringify(fixture.bidding)}::text::jsonb where org_id=${orgId} and profile_id=${profileId}`;
    const inputs = await store.listBidSeriesTargets(profile, fixture.date);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.placementModifiersObserved).toBe(fixture.observed);
    const result = await syncBidSeriesForProfile(profile, { store, client, now: () => new Date(fixture.date + 'T12:00:00Z') });
    expect(result).toMatchObject({ targets: 1, offered: 1, returned: 1, written: 1 });
  }
}, 180000);
afterAll(async () => { await db?.drop(); });
it('preserves worker zero-uplift maximum CPC and distinguishes missing modifier evidence', async () => {
  const model = await withAuthenticatedActor(db, { userId, orgId }, (sql) => loadTarget360({ sql }, args));
  expect(model?.providerEvidence).toMatchObject({ rows: [], runs: [], totalCount: 0 });
  expect(model?.payload.points).toHaveLength(4);
  const points = model!.payload.points;
  expect(points[0]).toMatchObject({ bid: 5, storedMaxCpc: 5, maxCpc: 5, placementEvidence: 'known-zero' });
  expect(points[0]!.components).toHaveLength(3);
  expect(corridorSummary(points.slice(0, 1)).maxCpc).toBe(5);
  for (const index of [1, 2]) {
    expect(points[index]).toMatchObject({ bid: 5, storedMaxCpc: 5, maxCpc: null, components: [], placementEvidence: 'missing' });
    expect(corridorSummary(points.slice(index, index + 1)).maxCpc).toBeNull();
  }
  expect(points[3]).toMatchObject({ bid: 5, maxCpc: 10, placementEvidence: 'components' });
  expect(corridorSummary(points).maxCpc).toBe(10);
});
it('persists completeness on every observed component through the actual worker and store', async () => {
  const rows = await db.sql<{ date: string; modifier_components: { name: string; pct: number; fullyObserved: boolean }[] }[]>`
    select date::text,modifier_components from public.bid_series_daily where profile_id=${profileId} order by date
  `;
  expect(rows).toHaveLength(4);
  expect(rows[0]!.modifier_components).toHaveLength(3);
  expect(rows[0]!.modifier_components.every((c) => c.fullyObserved && c.pct === 0)).toBe(true);
  expect(rows[1]!.modifier_components).toEqual([]);
  expect(rows[2]!.modifier_components).toHaveLength(2);
  expect(rows[2]!.modifier_components.every((c) => c.fullyObserved === false)).toBe(true);
  expect(rows[3]!.modifier_components).toHaveLength(3);
  expect(rows[3]!.modifier_components.every((c) => c.fullyObserved)).toBe(true);
});
it('keeps legacy markerless rows missing and does not recompute a fully observed stored maximum', async () => {
  await db.sql`update public.bid_series_daily set modifier_components='[]'::jsonb where profile_id=${profileId} and date='2026-09-01'`;
  await db.sql`update public.bid_series_daily set max_potential_cpc=12 where profile_id=${profileId} and date='2026-09-04'`;
  const model = await withAuthenticatedActor(db, { userId, orgId }, (sql) => loadTarget360({ sql }, args));
  expect(model!.payload.points[0]).toMatchObject({ storedMaxCpc: 5, maxCpc: null, placementEvidence: 'missing' });
  expect(model!.payload.points[3]).toMatchObject({ storedMaxCpc: 12, maxCpc: 12, placementEvidence: 'components' });
});
