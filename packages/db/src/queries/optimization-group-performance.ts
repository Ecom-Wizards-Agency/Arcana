import { OptimizationGroupPerformance, type OptimizationGroupPerformanceMetrics } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';

const missing = (): OptimizationGroupPerformanceMetrics => ({ spend: null, sales: null, orders: null, acos: null });
interface FactRow { date: string; spend: string | number; sales: string | number; orders: string | number; reporting_rows: string | number }
function aggregate(rows: readonly FactRow[]): OptimizationGroupPerformanceMetrics {
  if (rows.length === 0) return missing();
  const spend = rows.reduce((total, row) => total + Number(row.spend), 0);
  const sales = rows.reduce((total, row) => total + Number(row.sales), 0);
  return { spend, sales, orders: rows.reduce((total, row) => total + Number(row.orders), 0), acos: sales > 0 ? spend / sales : null };
}

/** Aggregate only today's assigned members, retaining the selected and comparison evidence separately. */
export async function readOptimizationGroupPerformance(handle: QueryHandle, input: {
  orgId: string; profileId: string; groupId: string;
  current: { start: string; end: string }; previous: { start: string; end: string };
}): Promise<OptimizationGroupPerformance | null> {
  const groups = await handle.sql<{ id: string }[]>`select id from public.optimization_groups where org_id = ${input.orgId} and profile_id = ${input.profileId} and id = ${input.groupId}`;
  if (groups.length !== 1) return null;
  const members = await handle.sql<{ campaign_id: string }[]>`select campaign_id from public.campaign_optimization_assignments where org_id = ${input.orgId} and profile_id = ${input.profileId} and group_id = ${input.groupId} order by campaign_id`;
  const campaignIds = members.map((row) => row.campaign_id);
  if (new Set(campaignIds).size !== campaignIds.length) throw new Error('Optimization group contains duplicate campaign identities');
  const firstDate = input.current.start < input.previous.start ? input.current.start : input.previous.start;
  const lastDate = input.current.end > input.previous.end ? input.current.end : input.previous.end;
  const rows = campaignIds.length === 0 ? [] : await handle.sql<FactRow[]>`
    with campaign_facts as (
      select date, cost, sales_7d, purchases_7d from public.fact_sp_target_daily
       where org_id = ${input.orgId} and profile_id = ${input.profileId} and campaign_id = any(${campaignIds}::text[]) and date between ${firstDate}::date and ${lastDate}::date
      union all
      select date, cost, sales_7d, purchases_7d from public.fact_sb_daily
       where org_id = ${input.orgId} and profile_id = ${input.profileId} and campaign_id = any(${campaignIds}::text[]) and date between ${firstDate}::date and ${lastDate}::date
      union all
      select date, cost, sales_7d, purchases_7d from public.fact_sd_daily
       where org_id = ${input.orgId} and profile_id = ${input.profileId} and campaign_id = any(${campaignIds}::text[]) and date between ${firstDate}::date and ${lastDate}::date
    ) select date::text, sum(cost) as spend, sum(sales_7d) as sales, sum(purchases_7d) as orders, count(*) as reporting_rows from campaign_facts group by date order by date`;
  const currentRows = rows.filter((row) => row.date >= input.current.start && row.date <= input.current.end);
  const previousRows = rows.filter((row) => row.date >= input.previous.start && row.date <= input.previous.end);
  return OptimizationGroupPerformance.parse({ groupId: input.groupId, campaignIds,
    current: { ...input.current, metrics: aggregate(currentRows) }, previous: { ...input.previous, metrics: aggregate(previousRows) },
    days: currentRows.map((row) => ({ date: row.date, ...aggregate([row]) })),
    reportingRows: currentRows.reduce((count, row) => count + Number(row.reporting_rows), 0),
    previousReportingRows: previousRows.reduce((count, row) => count + Number(row.reporting_rows), 0),
  });
}
