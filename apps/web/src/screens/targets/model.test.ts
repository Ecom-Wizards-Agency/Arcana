import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { withAuthenticatedActor } from '@wizard-ads/db';
import { maxPotentialCpc, corridorSummary } from '@wizard-ads/core';
import { loadTarget360 } from './model';

let db: TestDatabase;
const orgId = randomUUID(), profileId = randomUUID(), userId = randomUUID();
const args = { orgId, profileId, targetId: 'synthetic-keyword', from: '2026-09-01', to: '2026-09-03' };
beforeAll(async () => {
  db = await createTestDatabase('target_max_cpc', { applyFixture: false });
  await db.sql`insert into auth.users(id) values(${userId})`;
  await db.sql`insert into public.orgs(id,slug,name) values(${orgId},'synthetic-corridor','Synthetic corridor')`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${userId},'owner')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${profileId},${orgId},'synthetic-profile','NA','US','USD','UTC')`;
  await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,state,budget_amount,budget_type,placement_bidding) values(${orgId},${profileId},'synthetic-campaign','SP','enabled',100,'daily','{"topOfSearch":0,"restOfSearch":0,"productPages":0}')`;
  await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at) values(${orgId},${profileId},${args.targetId},'SP','enabled','synthetic-campaign','synthetic-group','Synthetic keyword','exact',5,now())`;
  // placementModifiersOf in the worker omits zero percentages before composition.
  // Use its resulting input, actual compositor and exact persisted output fields.
  const composed = maxPotentialCpc({ baseBid: 5, placementModifiers: [] });
  expect(composed.value).toBe(5);
  expect(composed.components).toEqual([]);
  const points = [
    { date: '2026-09-01', maxCpc: composed.value, components: composed.components },
    { date: '2026-09-02', maxCpc: null, components: [] },
    { date: '2026-09-03', maxCpc: 12, components: [{ name: 'top_of_search', pct: 100 }] },
  ];
  for (const point of points) {
    await db.sql`insert into public.bid_series_daily(org_id,profile_id,target_id,campaign_id,ad_group_id,is_keyword,date,bid,max_potential_cpc,modifier_components)
      values(${orgId},${profileId},${args.targetId},'synthetic-campaign','synthetic-group',true,${point.date},5,${point.maxCpc},${JSON.stringify(point.components)}::text::jsonb)`;
  }
}, 180000);
afterAll(async () => { await db?.drop(); });
it('preserves worker zero-uplift maximum CPC and distinguishes missing modifier evidence', async () => {
  const model = await withAuthenticatedActor(db, { userId, orgId }, (sql) => loadTarget360({ sql }, args));
  expect(model?.payload.points).toHaveLength(3);
  const points = model!.payload.points;
  expect(points[0]).toMatchObject({ bid: 5, maxCpc: 5, components: [], placementEvidence: 'known-zero' });
  expect(corridorSummary(points.slice(0, 1)).maxCpc).toBe(5);
  expect(points[1]).toMatchObject({ bid: 5, maxCpc: null, components: [], placementEvidence: 'missing' });
  expect(points[2]).toMatchObject({ bid: 5, maxCpc: 12, placementEvidence: 'components' });
  expect(corridorSummary(points).maxCpc).toBe(12);
});
