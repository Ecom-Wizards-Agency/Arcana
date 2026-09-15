import type { QueryHandle } from '../client.js';
import { readCoreReportEvidence } from './report-families.js';
import type { GridFeedCoverage, GridPerformanceEvidence } from '@wizard-ads/shared';

export interface CoverageRow {
  report_type: string; earliest_returned_date: string | null; latest_loaded_date: string | null;
  availability_start_date: string | null; missing_dates: string[]; status: string; counts_match?: boolean | null;
}
const dayCount = (start: string, end: string) => Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000) + 1);
export function coverageFor(feed: GridFeedCoverage['feed'], rows: readonly CoverageRow[], start: string, end: string): GridFeedCoverage {
  const selected = rows.filter((row) => feed === 'PPC' ? row.report_type === 'spTargeting' : feed === 'RANK' ? row.report_type === 'rank_observations' : row.report_type === 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT');
  const held = new Set<string>();
  const missed = new Set<string>();
  for (const row of selected) {
    if (row.counts_match === false || (feed === 'SQP' && (row.counts_match !== true || row.status !== 'complete'))) continue;
    if (row.earliest_returned_date === null || row.latest_loaded_date === null) continue;
    const from = [start, row.earliest_returned_date, row.availability_start_date ?? start].sort().at(-1)!;
    const to = end < row.latest_loaded_date ? end : row.latest_loaded_date;
    const missing = new Set(row.missing_dates);
    for (let time = Date.parse(from); time <= Date.parse(to); time += 86_400_000) {
      if (feed === 'SQP') {
        const weekStart = time - new Date(time).getUTCDay() * 86_400_000;
        if (weekStart < Date.parse(start) || weekStart + 6 * 86_400_000 > Date.parse(end)) continue;
      }
      const date = new Date(time).toISOString().slice(0, 10);
      if (missing.has(date)) missed.add(date); else held.add(date);
    }
  }
  for (const date of held) missed.delete(date);
  const daysRequested = dayCount(start, end);
  const status = held.size === 0 ? 'not-measured' : held.size === daysRequested ? 'complete' : 'partial';
  const reason = held.size === 0 ? feed === 'SQP' ? 'No complete, counted SQP weeks measured in this range.' : `${feed === 'RANK' ? 'Organic rank' : 'Advertising performance'} not measured in this range.`
    : feed === 'RANK' && status === 'partial' ? `${held.size} days, ${missed.size} not scraped. Other missing days predate tracking or are not held.`
      : `${start} – ${end} · ${held.size} of ${daysRequested} days held`;
  return { feed, daysHeld: held.size, daysRequested, notScraped: missed.size, status, reason };
}

export async function readGridPerformance(handle: QueryHandle, orgId: string, profileId: string, start: string, end: string, level = 'targets'): Promise<GridPerformanceEvidence> {
  const rows = await handle.sql<CoverageRow[]>`select report_type, earliest_returned_date::text, latest_loaded_date::text,
    availability_start_date::text, missing_dates, status::text, counts_match from public.report_coverage where org_id=${orgId} and profile_id=${profileId}`;
  if (level !== 'products') {
    const [banner] = await handle.sql<{ ad_groups: number; spend: string; days: number }[]>`
      with multiple as (
        select campaign_id,ad_group_id from public.product_ads where org_id=${orgId} and profile_id=${profileId} and asin is not null and deleted_at is null
        group by campaign_id,ad_group_id having count(distinct asin)>1
      ), costs as (
        select f.campaign_id,f.ad_group_id,sum(f.cost) as spend from public.fact_sp_target_daily f
        join multiple m on m.campaign_id=f.campaign_id and m.ad_group_id=f.ad_group_id
        where f.org_id=${orgId} and f.profile_id=${profileId} and f.date between ${start} and ${end}
        group by f.campaign_id,f.ad_group_id having sum(f.cost)>0
      ) select count(*)::int as ad_groups,sum(spend)::text as spend,(${end}::date-${start}::date+1)::int as days from costs`;
    return { feeds: (['PPC', 'RANK', 'SQP'] as const).map((feed) => coverageFor(feed, rows, start, end)),
      unattributed: banner && banner.ad_groups > 0 && banner.spend !== null ? { adGroups: banner.ad_groups, spend: Number(banner.spend), days: banner.days } : null, rankDays: {} };
  }
  const [sd] = await handle.sql<{ present: boolean }[]>`select exists(
    select 1 from public.product_ads where org_id=${orgId} and profile_id=${profileId} and ad_product='SD' and deleted_at is null
    union all select 1 from public.fact_ad_group_daily where org_id=${orgId} and profile_id=${profileId}
      and family='sdAdGroup' and date between ${start} and ${end}
  ) as present`;
  const evidence = (await readCoreReportEvidence(handle, { orgId, profileId, families: ['spAdvertisedProduct', 'sdAdvertisedProduct'], startDate: start, endDate: end, limit: 50_000 }))
    .filter((item) => item.variant === 'DAILY:legacy:v1' && (item.family === 'spAdvertisedProduct' || sd?.present || item.status !== 'unmeasured'));
  const requiredFamilies: Array<'spAdvertisedProduct' | 'sdAdvertisedProduct'> = ['spAdvertisedProduct'];
  if (sd?.present) requiredFamilies.push('sdAdvertisedProduct');
  for (const family of requiredFamilies) {
    if (!evidence.some((item) => item.family === family)) evidence.push({ family, grain: 'advertised_product', variant: 'DAILY:legacy:v1', status: 'unmeasured', rows: [], rowCount: 0, truncated: false, observedAt: null });
  }
  const periods = await handle.sql<{ family: string; date: string }[]>`
    select w.family,w.period_start::text as date from public.report_family_watermarks w
    join public.report_coverage c on c.org_id=w.org_id and c.profile_id=w.profile_id and c.report_type=w.family
      and c.grain='advertised_product:'||w.variant and c.source='amazon_reporting_v3'
    where w.org_id=${orgId} and w.profile_id=${profileId} and w.family=any(${evidence.map((item) => item.family)})
      and w.variant='DAILY:legacy:v1' and w.period_start=w.period_end
      and w.period_start between ${start} and ${end} and c.status='complete' and c.counts_match=true`;
  const days = new Map<string, Set<string>>();
  for (const period of periods) {
    const families = days.get(period.date) ?? new Set<string>();
    families.add(period.family); days.set(period.date, families);
  }
  const daysHeld = [...days.values()].filter((families) => evidence.every((item) => families.has(item.family))).length;
  const daysRequested = dayCount(start, end);
  const partlyMeasured = periods.length > 0;
  const complete = daysHeld === daysRequested && evidence.every((item) => item.status === 'measured');
  const ppc: GridFeedCoverage = { feed: 'PPC', daysHeld, daysRequested, notScraped: 0,
    status: complete ? 'complete' : partlyMeasured ? 'partial' : 'not-measured',
    reason: complete ? `${start} – ${end} · ${daysHeld} of ${daysRequested} days held`
      : `Advertised-product performance ${partlyMeasured ? 'partially measured' : 'not measured'} in this range.` };
  const unattributed = await handle.sql<{ ad_groups: number; spend: string; days: number }[]>`
    with costs as (
      select ad_product::text as product,campaign_id,ad_group_id,date,sum(cost) as spend
      from public.fact_sp_target_daily where org_id=${orgId} and profile_id=${profileId} and date between ${start} and ${end}
      group by ad_product,campaign_id,ad_group_id,date
      union all
      select 'SD',dimensions->>'campaignId',dimensions->>'adGroupId',date,sum((row_data->'metrics'->>'cost')::numeric)
      from public.fact_ad_group_daily where org_id=${orgId} and profile_id=${profileId}
        and family='sdAdGroup' and variant='DAILY:legacy:v1' and date between ${start} and ${end}
      group by dimensions->>'campaignId',dimensions->>'adGroupId',date
    ), products as (
      select f.ad_product as product,f.dimensions->>'campaignId' as campaign_id,f.dimensions->>'adGroupId' as ad_group_id,f.date,
        case when bool_or(f.row_data->'metrics'->>'cost' is null) then null else sum((f.row_data->'metrics'->>'cost')::numeric) end as spend
      from public.fact_advertised_product_daily f
      join public.report_family_watermarks w on w.org_id=f.org_id and w.profile_id=f.profile_id and w.family=f.family and w.variant=f.variant and w.period_start=f.date and w.period_end=f.date
      where f.org_id=${orgId} and f.profile_id=${profileId} and f.family in ('spAdvertisedProduct','sdAdvertisedProduct')
        and f.variant='DAILY:legacy:v1' and f.date between ${start} and ${end}
      group by f.ad_product,f.dimensions->>'campaignId',f.dimensions->>'adGroupId',f.date
    ), residual as (
      select c.product,c.campaign_id,c.ad_group_id,sum(greatest(c.spend-coalesce(p.spend,0),0)) as spend
      from costs c left join products p using(product,campaign_id,ad_group_id,date)
      group by c.product,c.campaign_id,c.ad_group_id having sum(greatest(c.spend-coalesce(p.spend,0),0))>0
    ) select count(*)::int as ad_groups,sum(spend)::text as spend,(${end}::date-${start}::date+1)::int as days from residual`;
  const banner = unattributed[0];
  return { feeds: [ppc, ...(['RANK', 'SQP'] as const).map((feed) => coverageFor(feed, rows, start, end))],
    unattributed: banner && banner.ad_groups > 0 && banner.spend !== null ? { adGroups: banner.ad_groups, spend: Number(banner.spend), days: banner.days } : null,
    rankDays: {} };
}
