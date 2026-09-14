/**
 * The bid corridor's reads, for the per-target history modal (WP-28/WP-48).
 *
 * The corridor is a per-target daily series (`bid_series_daily`), synced by the
 * worker from Amazon's suggested-bid endpoints. This module turns it into the
 * `BidCorridorPoint[]` the chart plots, and combines it with target identity
 * and same-window KPI bases for the asynchronous row-level drill-down.
 *
 * Every read takes the actor's org and profile and filters by both. API callers
 * pass the query handle from their authenticated transaction, so database RLS
 * and explicit selected-agency predicates apply together.
 */
import type { TargetDailyPerformance } from '@wizard-ads/shared';
import type { QueryHandle } from '@wizard-ads/db';
import type { BaseTotals } from '@wizard-ads/ui';
import type { BidCorridorPoint } from '@wizard-ads/ui';

/** One target's corridor over the window, oldest first, as chart points. */
export async function loadCorridor(
  handle: QueryHandle,
  orgId: string,
  profileId: string,
  targetId: string,
  window: { from: string; to: string },
): Promise<BidCorridorPoint[]> {
  const rows = await handle.sql<
    {
      date: string;
      suggested_bid_low: string | number | null;
      suggested_bid_median: string | number | null;
      suggested_bid_high: string | number | null;
      bid: string | number | null;
      cpc: string | number | null;
      max_potential_cpc: string | number | null;
      modifier_components: Array<{ name: string; pct: number }> | null;
    }[]
  >`
    select date::text as date,
           suggested_bid_low,
           suggested_bid_median,
           suggested_bid_high,
           bid,
           cpc,
           max_potential_cpc,
           modifier_components
      from public.bid_series_daily
     where org_id = ${orgId}
       and profile_id = ${profileId}
       and target_id = ${targetId}
       and date between ${window.from} and ${window.to}
     order by date
  `;
  const nullableNumber = (value: string | number | null): number | null =>
    value === null ? null : Number(value);
  return rows.map((row) => ({
    date: row.date,
    low: nullableNumber(row.suggested_bid_low),
    median: nullableNumber(row.suggested_bid_median),
    high: nullableNumber(row.suggested_bid_high),
    bid: nullableNumber(row.bid),
    cpc: nullableNumber(row.cpc),
    maxCpc: nullableNumber(row.max_potential_cpc),
    components: (row.modifier_components ?? []).map((c) => ({ ...c, name: c.name.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase()) })),
  }));
}

export interface BidHistoryTarget {
  targetId: string;
  targeting: string;
  matchType: string | null;
  adProduct: string;
  targetKind: string;
  campaignId: string;
  campaignName: string;
  state?: string | null;
}

export interface BidHistoryPayload {
  target: BidHistoryTarget;
  window: { from: string; to: string };
  totals: BaseTotals;
  points: BidCorridorPoint[];
}

/** One actor-scoped payload for the asynchronous per-target modal. */
export async function loadBidHistory(
  handle: QueryHandle,
  args: {
    orgId: string;
    profileId: string;
    targetId: string;
    from: string;
    to: string;
  },
): Promise<BidHistoryPayload | null> {
  const [targets, totalsRows, points] = await Promise.all([
    handle.sql<
      {
        target_id: string;
        targeting: string;
        match_type: string | null;
        ad_product: string;
        target_kind: string;
        campaign_id: string;
        campaign_name: string;
        state: string | null;
      }[]
    >`
      with target_entity as (
        select k.amazon_id as target_id,
               coalesce(k.keyword_text, k.name, k.amazon_id) as targeting,
               k.match_type::text as match_type,
               k.ad_product::text as ad_product,
               'keyword'::text as target_kind,
               k.campaign_id, k.state::text as state
          from public.keywords k
         where k.org_id = ${args.orgId}
           and k.profile_id = ${args.profileId}
           and k.amazon_id = ${args.targetId}
        union all
        select t.amazon_id as target_id,
               coalesce(t.resolved_expression, t.name, t.amazon_id) as targeting,
               null::text as match_type,
               t.ad_product::text as ad_product,
               'product target'::text as target_kind,
               t.campaign_id, t.state::text as state
          from public.targets t
         where t.org_id = ${args.orgId}
           and t.profile_id = ${args.profileId}
           and t.amazon_id = ${args.targetId}
        union all
        select f.target_id,
               f.target_id as targeting,
               max(f.match_type::text) as match_type,
               max(f.ad_product::text) as ad_product,
               replace(max(f.target_kind::text), '_', ' ') as target_kind,
               max(f.campaign_id) as campaign_id, null::text as state
          from public.fact_sp_target_daily f
         where f.org_id = ${args.orgId}
           and f.profile_id = ${args.profileId}
           and f.target_id = ${args.targetId}
           and not exists (
             select 1 from public.keywords k
              where k.org_id = ${args.orgId}
                and k.profile_id = ${args.profileId}
                and k.amazon_id = f.target_id
           )
           and not exists (
             select 1 from public.targets t
              where t.org_id = ${args.orgId}
                and t.profile_id = ${args.profileId}
                and t.amazon_id = f.target_id
           )
         group by f.target_id
      )
      select e.target_id,
             e.targeting,
             e.match_type,
             e.ad_product,
             e.target_kind,
             e.campaign_id, e.state,
             coalesce(c.name, e.campaign_id) as campaign_name
        from target_entity e
        left join public.campaigns c
          on c.org_id = ${args.orgId}
         and c.profile_id = ${args.profileId}
         and c.amazon_id = e.campaign_id
       limit 1
    `,
    handle.sql<
      {
        impressions: string | number;
        clicks: string | number;
        spend: string | number;
        sales: string | number;
        orders: string | number;
        units: string | number;
      }[]
    >`
      select coalesce(sum(impressions), 0) as impressions,
             coalesce(sum(clicks), 0) as clicks,
             coalesce(sum(cost), 0) as spend,
             coalesce(sum(sales_7d), 0) as sales,
             coalesce(sum(purchases_7d), 0) as orders,
             coalesce(sum(units_sold_7d), 0) as units
        from public.fact_sp_target_daily
       where org_id = ${args.orgId}
         and profile_id = ${args.profileId}
         and target_id = ${args.targetId}
         and date between ${args.from} and ${args.to}
    `,
    loadCorridor(handle, args.orgId, args.profileId, args.targetId, {
      from: args.from,
      to: args.to,
    }),
  ]);

  const target = targets[0];
  if (target === undefined) return null;
  const row = totalsRows[0];
  const number = (value: string | number | undefined): number => Number(value ?? 0);
  return {
    target: {
      targetId: target.target_id,
      targeting: target.targeting,
      matchType: target.match_type,
      adProduct: target.ad_product,
      targetKind: target.target_kind,
      campaignId: target.campaign_id,
      campaignName: target.campaign_name,
      state: target.state,
    },
    window: { from: args.from, to: args.to },
    totals: {
      impressions: number(row?.impressions),
      clicks: number(row?.clicks),
      spend: number(row?.spend),
      sales: number(row?.sales),
      orders: number(row?.orders),
      units: number(row?.units),
    },
    points,
  };
}

/** Profile-scoped keyword observations; do not infer keyword ranks for product targets. */
export async function loadTargetRanks(handle: QueryHandle, orgId: string, profileId: string, payload: BidHistoryPayload) {
  if (payload.target.targetKind !== 'keyword') return [];
  const rows = await handle.sql<{ date: string; asin: string; organic_rank: number | null; sponsored_rank: number | null }[]>`
    select observed_on::text as date, asin, organic_rank, sponsored_rank
      from public.rank_observations
     where org_id = ${orgId} and profile_id = ${profileId}
       and keyword = ${payload.target.targeting}
       and observed_on between ${payload.window.from}::date and ${payload.window.to}::date
     order by observed_on, asin, id
  `;
  return rows.map((row) => ({ date: row.date, asin: row.asin, organicRank: row.organic_rank, sponsoredRank: row.sponsored_rank }));
}

/** Target-grain facts; shares are never summed or inferred from missing rows. */
export async function loadTargetPerformance(handle: QueryHandle, orgId: string, profileId: string, targetId: string, window: { from: string; to: string }): Promise<TargetDailyPerformance[]> {
  const rows = await handle.sql<{ date: string; impressions: number | null; clicks: number | null; spend: number | null; sales: number | null; orders: number | null; topOfSearchShare: number | null }[]>`
    select date::text, sum(impressions)::float8 as impressions, sum(clicks)::float8 as clicks,
      sum(cost)::float8 as spend, sum(sales_7d)::float8 as sales, sum(purchases_7d)::float8 as orders,
      (case when count(*)=1 then max(top_of_search_impression_share) else null end)::float8 as "topOfSearchShare"
    from public.fact_sp_target_daily where org_id=${orgId} and profile_id=${profileId} and target_id=${targetId}
      and date between ${window.from} and ${window.to} group by date order by date
  `;
  return rows.map((r) => ({ ...r, acos: r.spend === null || r.sales === null || r.sales <= 0 ? null : r.spend / r.sales,
    cpc: r.spend === null || r.clicks === null || r.clicks <= 0 ? null : r.spend / r.clicks }));
}
export async function loadTargetChanges(handle: QueryHandle, orgId: string, profileId: string, targetId: string, window: { from: string; to: string }) {
  const rows = await handle.sql<{ id: string; date: string; field: string; old_value: unknown; new_value: unknown; source: string }[]>`
    select id::text, observed_at::text as date, field, old_value, new_value, source::text
    from public.entity_changes where org_id=${orgId} and profile_id=${profileId} and amazon_id=${targetId}
      and entity_type in ('keyword','target') and observed_at>=${window.from}::date and observed_at<${window.to}::date+interval '1 day'
    order by observed_at,id
  `;
  return rows.map((r) => ({ id: r.id, date: r.date, field: r.field,
    oldValue: r.old_value === null ? null : JSON.stringify(r.old_value), newValue: r.new_value === null ? null : JSON.stringify(r.new_value), source: r.source }));
}
