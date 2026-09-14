import type { QueryHandle } from '@wizard-ads/db';
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
    if (row.counts_match === false) continue;
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
  const reason = held.size === 0 ? feed === 'SQP' ? 'No whole weeks measured in this range. Search-query ingestion is unavailable.' : `${feed === 'RANK' ? 'Organic rank' : 'Advertising performance'} not measured in this range.`
    : feed === 'RANK' && status === 'partial' ? `${held.size} days, ${missed.size} not scraped. Other missing days predate tracking or are not held.`
      : `${start} – ${end} · ${held.size} of ${daysRequested} days held`;
  return { feed, daysHeld: held.size, daysRequested, notScraped: missed.size, status, reason };
}

export async function readGridPerformance(handle: QueryHandle, orgId: string, profileId: string, start: string, end: string): Promise<GridPerformanceEvidence> {
  const rows = await handle.sql<CoverageRow[]>`select report_type, earliest_returned_date::text, latest_loaded_date::text,
    availability_start_date::text, missing_dates, status::text, counts_match from public.report_coverage where org_id=${orgId} and profile_id=${profileId}`;
  const unattributed = await handle.sql<{ ad_groups: number; spend: string; days: number }[]>`
    with multiple as (
      select campaign_id, ad_group_id from public.product_ads
      where org_id=${orgId} and profile_id=${profileId} and asin is not null and deleted_at is null
      group by campaign_id, ad_group_id having count(distinct asin)>1
    ), costs as (
      select f.campaign_id, f.ad_group_id, sum(f.cost) as spend
      from public.fact_sp_target_daily f join multiple m on m.campaign_id=f.campaign_id and m.ad_group_id=f.ad_group_id
      where f.org_id=${orgId} and f.profile_id=${profileId} and f.date between ${start} and ${end}
      group by f.campaign_id,f.ad_group_id having sum(f.cost)>0
    ) select count(*)::int as ad_groups, sum(spend)::text as spend, (${end}::date-${start}::date+1)::int as days from costs`;
  const banner = unattributed[0];
  return { feeds: (['PPC', 'RANK', 'SQP'] as const).map((feed) => coverageFor(feed, rows, start, end)),
    unattributed: banner && banner.ad_groups > 0 && banner.spend !== null ? { adGroups: banner.ad_groups, spend: Number(banner.spend), days: banner.days } : null,
    rankDays: {} };
}
