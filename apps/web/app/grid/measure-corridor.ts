/** Disposable synthetic measurement. Run with tsx from the repository root. */
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../../../../packages/db/src/testing/harness.js';
import { withAuthenticatedReadSnapshot } from '@wizard-ads/db';

const db = await createTestDatabase('wp250_corridor');
try {
  const userId = randomUUID();
  const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('corridor-synthetic', ${userId}, 'owner') as id`;
  const orgId = org!.id;
  const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  const profileId = profile!.id;
  await db.sql`insert into public.bid_series_daily
    (org_id,profile_id,date,campaign_id,ad_group_id,target_id,is_keyword,bid,cpc,suggested_bid_low,suggested_bid_median,suggested_bid_high,max_potential_cpc)
    select ${orgId},${profileId},'2026-08-01'::date + day, 'synthetic-campaign','synthetic-group','synthetic-' || target,true,2,1,1,2,3,4
      from generate_series(1,6000) target cross join generate_series(0,29) day`;
  const [count] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.bid_series_daily where org_id=${orgId} and target_id like 'synthetic-%'`;
  if (count?.count !== 180000) throw new Error('Synthetic fixture count mismatch');
  await db.sql`drop index public.bid_series_daily_org_profile_target_latest`;
  await db.sql`analyze public.bid_series_daily`;
  const explain = () => withAuthenticatedReadSnapshot(db, { orgId, userId }, async (snapshot) => {
    const rows = await snapshot.sql<{ 'QUERY PLAN': string }[]>`explain (analyze, buffers, format text)
      select date::text as date, suggested_bid_low, suggested_bid_median, suggested_bid_high,
             bid, cpc, max_potential_cpc, modifier_components
        from public.bid_series_daily
       where org_id=${orgId} and profile_id=${profileId} and target_id='synthetic-1'
         and date between '2026-08-01' and '2026-08-30' order by date`;
    return rows.map((row) => row['QUERY PLAN']).join('\n').replaceAll(orgId, '<synthetic-org>').replaceAll(profileId, '<synthetic-profile>').replaceAll(userId, '<synthetic-user>');
  });
  const before = await explain();
  await db.sql`create index bid_series_daily_org_profile_target_latest on public.bid_series_daily (org_id,profile_id,target_id,date desc,loaded_at desc)`;
  await db.sql`analyze public.bid_series_daily`;
  const after = await explain();
  if (!before.includes('rows=30') || !after.includes('rows=30')) throw new Error('Corridor output count mismatch');
  console.log(JSON.stringify({ fixtureRows: count.count, corridorRows: 30, before, after }, null, 2));
} finally { await db.drop(); }
