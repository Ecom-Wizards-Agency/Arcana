/**
 * Tenant/profile-scoped dashboard data adapters. Page freshness now uses the
 * server load-freshness helper; loadReportLedger remains a transition adapter.
 * Fact timestamps cannot prove freshness because reports can contain no rows.
 */
import type { QueryHandle } from '@wizard-ads/db';
import { operatorFailureLabel } from '../../src/security/operator-failure';
import type { DailyRow } from '@wizard-ads/core';
import type { ReportLedgerEntry } from '@wizard-ads/ui';
import type { Period } from './periods.js';

/**
 * Ledger rows for one profile, newest first.
 *
 * Deliberately not filtered to completed rows: a failed newest attempt over a
 * successful older one is exactly the state an operator needs to see, and
 * filtering it out here would make the banner unable to say "loaded 3 days ago,
 * newest attempt failed".
 */
export async function loadReportLedger(
  handle: QueryHandle,
  orgId: string,
  profileId: string,
  limit = 40,
): Promise<ReportLedgerEntry[]> {
  const rows = await handle.sql<{
    reportType: ReportLedgerEntry['reportType']; status: ReportLedgerEntry['status'];
    endDate: string; requestedAt: Date | string; completedAt: Date | string | null;
    rowsParsed: number | string | null; rowsLoaded: number | string | null;
    countsMatch: boolean | null; error: string | null;
  }[]>`
    select report_type as "reportType", status, end_date::text as "endDate",
           requested_at as "requestedAt", completed_at as "completedAt",
           rows_parsed as "rowsParsed", rows_loaded as "rowsLoaded",
           counts_match as "countsMatch", error
      from public.report_requests
     where org_id = ${orgId} and profile_id = ${profileId}
     order by requested_at desc
     limit ${limit}
  `;

  return rows.map((row) => ({
    reportType: row.reportType,
    status: row.status,
    endDate: row.endDate,
    requestedAt: new Date(row.requestedAt).toISOString(),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
    rowsParsed: row.rowsParsed === null ? null : Number(row.rowsParsed),
    rowsLoaded: row.rowsLoaded === null ? null : Number(row.rowsLoaded),
    countsMatch: row.countsMatch,
    error: operatorFailureLabel(row.error),
  }));
}

/**
 * Profile-grain daily rows, mapped onto the doctrine engine's `DailyRow`.
 *
 * The mapping happens here, at the edge, exactly as `packages/core` documents:
 * the engine speaks its own vocabulary so the Python parity goldens can be
 * replayed against it, and the web tier is the thing that translates.
 */
export async function loadProfileDailyRows(
  handle: QueryHandle,
  orgId: string,
  profileId: string,
  account: string,
  window: Period,
): Promise<DailyRow[]> {
  const rows = await handle.sql<{
    date: string; impressions: string | number; clicks: string | number;
    cost: string | number; sales7d: string | number; purchases7d: string | number;
  }[]>`
    select date::text, impressions, clicks, cost, sales_7d as "sales7d", purchases_7d as "purchases7d"
      from public.fact_profile_daily
     where org_id = ${orgId} and profile_id = ${profileId}
       and date between ${window.start} and ${window.end}
     order by date
  `;

  return rows.map((row) => ({
    account,
    date: row.date,
    level: 'account' as const,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.cost),
    sales: Number(row.sales7d),
    orders: Number(row.purchases7d),
  }));
}

/** Which of those days Amazon is still attributing. The dashboard must say so. */
export async function loadProvisionalDates(
  handle: QueryHandle,
  orgId: string,
  profileId: string,
  window: Period,
): Promise<string[]> {
  const rows = await handle.sql<{ date: string }[]>`
    select date::text
      from public.fact_profile_daily
     where org_id = ${orgId} and profile_id = ${profileId}
       and date between ${window.start} and ${window.end} and provisional
     order by date
  `;
  return rows.map((row) => row.date);
}

/**
 * Campaign-grain daily rows for the flag engine.
 *
 * Built from the target grain because that is the grain we hold: summing
 * targets to a campaign is the same arithmetic the grid does, and doing it in
 * SQL keeps a month of target rows out of the web tier's memory.
 */
export async function loadCampaignDailyRows(
  handle: QueryHandle,
  orgId: string,
  profileId: string,
  account: string,
  window: Period,
): Promise<DailyRow[]> {
  const rows = await handle.sql<
    {
      date: string;
      campaign_id: string;
      campaign_name: string | null;
      impressions: string | number;
      clicks: string | number;
      spend: string | number;
      sales: string | number;
      orders: string | number;
    }[]
  >`
    select f.date::text as date,
           f.campaign_id,
           c.name as campaign_name,
           sum(f.impressions) as impressions,
           sum(f.clicks) as clicks,
           sum(f.cost) as spend,
           sum(f.sales_7d) as sales,
           sum(f.purchases_7d) as orders
      from public.fact_sp_target_daily f
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     where f.org_id = ${orgId}
       and f.profile_id = ${profileId}
       and f.date between ${window.start} and ${window.end}
     group by f.date, f.campaign_id, c.name
     order by f.date
  `;

  return rows.map((row) => ({
    account,
    date: row.date,
    level: 'campaign' as const,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name ?? row.campaign_id,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    spend: Number(row.spend),
    sales: Number(row.sales),
    orders: Number(row.orders),
  }));
}

/** Latest reading in each of two completed seven-day windows, per keyword/product. */
export async function loadHomeRankWatch(
  handle: QueryHandle, orgId: string, profileId: string, asOf: string,
) {
  const rows = await handle.sql<{
    asin: string; keyword: string; currentRank: number | null; previousRank: number | null;
    currentDate: string; previousDate: string | null; movement: number | null; productTitle: string | null;
  }[]>`
    with current_week as (
      select distinct on (asin, keyword) asin, keyword, organic_rank, observed_on
      from public.rank_observations
      where org_id = ${orgId} and profile_id = ${profileId}
        and observed_on between ${asOf}::date - 6 and ${asOf}::date
      order by asin, keyword, observed_on desc, id desc
    ), previous_week as (
      select distinct on (asin, keyword) asin, keyword, organic_rank, observed_on
      from public.rank_observations
      where org_id = ${orgId} and profile_id = ${profileId}
        and observed_on between ${asOf}::date - 13 and ${asOf}::date - 7
      order by asin, keyword, observed_on desc, id desc
    )
    select c.asin, c.keyword, c.organic_rank as "currentRank", p.organic_rank as "previousRank",
      c.observed_on::text as "currentDate", p.observed_on::text as "previousDate",
      p.organic_rank - c.organic_rank as movement, product.title as "productTitle"
    from current_week c left join previous_week p using (asin, keyword)
    -- The newest returned catalogue title for the ASIN, read under the same
    -- completed-acquisition rule as the grid's products preset. No title
    -- leaves the row on its ASIN.
    left join lateral (
      select m.snapshot->'title'->>'value' as title
        from public.ads_product_metadata_snapshots m
        join public.ads_catalogue_source_receipts r on r.id = m.receipt_id
        left join public.ads_catalogue_pages page on page.receipt_id = r.id
        left join public.ads_catalogue_acquisitions a
          on a.org_id = page.org_id and a.profile_id = page.profile_id and a.id = page.acquisition_id
       where m.org_id = ${orgId} and m.profile_id = ${profileId} and m.asin = c.asin
         and m.snapshot->'title'->>'state' = 'returned'
         and length(btrim(m.snapshot->'title'->>'value')) > 0
         and (r.selector_key not like 'acquisition:%' or a.final_receipt_id is not null)
       order by m.acquired_at desc, m.retrieved_at desc
       limit 1
    ) product on true
    order by abs(p.organic_rank - c.organic_rank) desc nulls last, c.asin, c.keyword
  `;
  return [...rows];
}
