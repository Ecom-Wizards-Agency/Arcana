/**
 * Grid rows, per entity level, straight out of the fact tables.
 *
 * Three things this module does deliberately:
 *
 * 1. **Selected period and comparison period in one query.** `filter (where
 *    date between ...)` aggregates both windows in a single pass over a single
 *    index range, so a grid with deltas costs one round trip rather than two,
 *    and the two windows can never be read from different snapshots.
 *
 * 2. **It sums bases and nothing else.** No `avg(acos)` appears anywhere in this
 *    file, and there is nowhere for one to hide: the SQL returns
 *    impressions/clicks/spend/sales/orders/units and the ratios are computed in
 *    `@wizard-ads/ui` from those sums, at whatever level is being displayed.
 *    This is the same rule the recon says to clone (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §4), held
 *    at the query layer as well as the render layer.
 *
 * 3. **`c_days = 0` means no comparison row, not a zero one.** An entity that
 *    did not serve last month did not spend nothing; it has no figure. The
 *    difference is what makes a delta honest, and it survives all the way to
 *    the cell, which renders `—`.
 *
 * Read-only. Every write in this product happens in the worker.
 */
import { classifyCampaignCategory, classifyPerformanceVerdict, grossBreakEvenBid, rankChange, acosVsTarget, conversionPoints, marketPositionGap, retailEvidence, abaEvidence } from '@wizard-ads/core';
import { readLatestBidSeriesByTargetIds, listMarketPositionLinks, readMarketRankSeries, readSpReportEvidence } from '@wizard-ads/db';
import { TenantStrategy, type GridMeasurement, type GridPerformanceEvidence } from '@wizard-ads/shared';
import { parseCampaignName } from '@wizard-ads/campaigns';
import { targetReadTimer } from '../../src/screens/grid/target-read-timing';
import { loadCoreGridEvidence, coreEvidenceGridRows } from '../../src/screens/grid/core-report-rows';
import { readGridPerformance } from '../../src/screens/grid/data-evidence';
import type { QueryHandle } from '@wizard-ads/db';
import type { EntityLevel, GridRow } from '@wizard-ads/ui';
import type { Period } from './periods.js';
import { withServerTiming } from './server-timing.js';

interface AggregateRow {
  impressions: string | number | null;
  clicks: string | number | null;
  spend: string | number | null;
  sales: string | number | null;
  orders: string | number | null;
  units: string | number | null;
  c_days: string | number | null;
  c_impressions: string | number | null;
  c_clicks: string | number | null;
  c_spend: string | number | null;
  c_sales: string | number | null;
  c_orders: string | number | null;
  c_units: string | number | null;
}

/** Postgres returns numeric and bigint as strings. One conversion, one place. */
const num = (value: string | number | null | undefined): number => {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number(value);
};

/** Keep absent facts distinct from a measured zero through grouping and CSV. */
function measurementOf(row: AggregateRow): { measurement?: GridMeasurement } {
  const keys = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] as const;
  const missing = keys.filter((key) => row[key] === null || row[key] === undefined);
  const comparisonMissing = num(row.c_days) === 0 ? [] : keys.filter((key) => row[`c_${key}`] === null || row[`c_${key}`] === undefined);
  return missing.length || comparisonMissing.length ? { measurement: { missing, comparisonMissing } } : {};
}

function totalsOf(row: AggregateRow): GridRow['totals'] {
  return {
    impressions: num(row.impressions),
    clicks: num(row.clicks),
    spend: num(row.spend),
    sales: num(row.sales),
    orders: num(row.orders),
    units: num(row.units),
  };
}

function comparisonOf(row: AggregateRow): GridRow['comparison'] {
  if (num(row.c_days) === 0) return null;
  return {
    impressions: num(row.c_impressions),
    clicks: num(row.c_clicks),
    spend: num(row.c_spend),
    sales: num(row.c_sales),
    orders: num(row.c_orders),
    units: num(row.c_units),
  };
}

export interface LoadGridOptions {
  /**
   * The actor's org. Required, and in the predicate of every statement below:
   * the web tier connects as the service role, so a query scoped only by a
   * profile id is scoped only by a uuid nobody checked.
   */
  orgId: string;
  profileId: string;
  currencyCode: string;
  period: Period;
  comparison: Period;
  /**
   * Hard cap on rows returned. The grid holds the whole set in memory with no
   * pagination, which is the point (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §6) -- but "no pagination"
   * has to mean "50k rows", not "however many the account has". Past the cap the
   * page says so rather than silently truncating.
   */
  limit?: number;
}

export const ROW_CAP = 50_000;

export interface GridPayload {
  performance?: GridPerformanceEvidence;
  rows: GridRow[];
  /** Transport assertion: every consumer must receive exactly this many rows. */
  rowCount: number;
  /** True when an upstream or transport cap makes the returned set incomplete. */
  truncated: boolean;
}

/** The grid query needs no Drizzle client or connection lifecycle capability. */
type GridDataHandle = QueryHandle;

export async function loadGridRows(
  handle: GridDataHandle,
  level: EntityLevel,
  options: LoadGridOptions,
): Promise<GridPayload> {
  const limit = options.limit ?? ROW_CAP;
  // One sentinel row distinguishes an exact-size complete result from a set
  // that really exceeded the in-memory cap. Only the requested rows cross the
  // server/client boundary.
  const queryLimit = limit + 1;
  const rankDays: GridPerformanceEvidence['rankDays'] = {};
  const performanceRead = readGridPerformance(handle, options.orgId, options.profileId, options.period.start, options.period.end, level);
  const loaders: Record<EntityLevel, () => Promise<GridRow[]>> = {
    campaigns: () => loadCampaigns(handle, options, queryLimit),
    ad_groups: () => loadAdGroups(handle, options, queryLimit),
    targets: () => loadTargets(handle, options, queryLimit, rankDays),
    products: () => loadProducts(handle, options, queryLimit),
    search_terms: () => loadSearchTerms(handle, options, queryLimit),
    placements: () => loadPlacements(handle, options, queryLimit),
  };
  const read = async () => {
      const [baseRows, performance, evidence, priorEvidence] = await Promise.all([loaders[level](), performanceRead,
        loadCoreGridEvidence(handle, level, { orgId: options.orgId, profileId: options.profileId, startDate: options.period.start, endDate: options.period.end, limit: queryLimit }),
        loadCoreGridEvidence(handle, level, { orgId: options.orgId, profileId: options.profileId, startDate: options.comparison.start, endDate: options.comparison.end, limit: queryLimit }),
      ]);
      const prior = new Map(coreEvidenceGridRows(priorEvidence, options.currencyCode).map((row) => [row.id, row]));
      const added = coreEvidenceGridRows(evidence, options.currencyCode).map((row) => ({ ...row, comparison: prior.get(row.id)?.totals ?? null, measurement: { missing: row.measurement?.missing ?? [], comparisonMissing: prior.get(row.id)?.measurement?.missing ?? [] } }));
      const loadedRows = [...baseRows, ...added];
      const rows = loadedRows.slice(0, limit);
      return {
        performance: { ...performance, rankDays: Object.fromEntries(rows.flatMap((row) => rankDays[row.id] ? [[row.id, rankDays[row.id]!]] : [])) },
        rows,
        rowCount: rows.length,
        truncated: loadedRows.length > limit || evidence.some((item) => item.truncated) || priorEvidence.some((item) => item.truncated),
      };
  };
  return level === 'products' ? read() : withServerTiming(`grid.${level}`, read, (payload) => payload.rows.length);
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

interface CampaignRow extends AggregateRow {
  campaign_id: string;
  ad_product: string;
  campaign_name: string | null;
  campaign_state: string | null;
  targeting_type: string | null;
  bidding_strategy: string | null;
  budget_amount: string | number | null;
  budget_type: string | null;
  portfolio_name: string | null;
  start_date: string | null;
  end_date: string | null;
  is_ended: boolean | null;
}

async function loadCampaigns(
  handle: GridDataHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<CampaignRow[]>`
    with facts as (
      select campaign_id, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_sp_target_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and (date between ${period.start} and ${period.end} or date between ${comparison.start} and ${comparison.end})
      group by campaign_id, ad_product
    )
    select f.*,
           c.name as campaign_name,
           c.state::text as campaign_state,
           c.targeting_type::text as targeting_type,
           c.bidding_strategy::text as bidding_strategy,
           c.budget_amount, c.budget_type::text as budget_type,
           p.name as portfolio_name,
           c.start_date::text as start_date,
           c.end_date::text as end_date,
           -- Computed, not stored: an ended campaign cannot take a budget or a
           -- bid update even while its state still reads Enabled, and the grid
           -- has to say so before somebody queues a write against it.
           (c.end_date is not null and c.end_date < (now() at time zone coalesce(pr.timezone, 'UTC'))::date) as is_ended
      from facts f
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
      left join public.portfolios p
        on p.org_id = ${orgId} and p.profile_id = ${profileId}
       and p.amazon_id = c.portfolio_amazon_id
      left join public.ad_profiles pr on pr.id = ${profileId} and pr.org_id = ${orgId}
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: `campaign:${row.campaign_id}`,
    dimensions: {
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name ?? row.campaign_id,
      campaign_state: row.campaign_state,
      ad_product: row.ad_product,
      targeting_type: row.targeting_type,
      bidding_strategy: row.bidding_strategy,
      budget_amount: row.budget_amount === null ? null : num(row.budget_amount),
      budget_type: row.budget_type,
      portfolio_name: row.portfolio_name,
      start_date: row.start_date,
      end_date: row.end_date,
      is_ended: row.is_ended ?? false,
    },
    ...measurementOf(row), totals: totalsOf(row),
    comparison: comparisonOf(row),
    currencyCode: options.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Ad groups
// ---------------------------------------------------------------------------

interface AdGroupRow extends AggregateRow {
  campaign_id: string;
  ad_group_id: string;
  ad_product: string;
  ad_group_name: string | null;
  ad_group_state: string | null;
  default_bid: string | number | null;
  campaign_name: string | null;
}

async function loadAdGroups(
  handle: GridDataHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<AdGroupRow[]>`
    with facts as (
      select campaign_id, ad_group_id, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_sp_target_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and (date between ${period.start} and ${period.end} or date between ${comparison.start} and ${comparison.end})
      group by campaign_id, ad_group_id, ad_product
    )
    select f.*,
           g.name as ad_group_name,
           g.state::text as ad_group_state,
           g.default_bid,
           c.name as campaign_name
      from facts f
      left join public.ad_groups g
        on g.org_id = ${orgId} and g.profile_id = ${profileId} and g.amazon_id = f.ad_group_id
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: `ad_group:${row.ad_group_id}`,
    dimensions: {
      ad_group_id: row.ad_group_id,
      ad_group_name: row.ad_group_name ?? row.ad_group_id,
      ad_group_state: row.ad_group_state,
      campaign_id: row.campaign_id,
      campaign_name: row.campaign_name ?? row.campaign_id,
      default_bid: row.default_bid === null ? null : num(row.default_bid),
      ad_product: row.ad_product,
    },
    ...measurementOf(row), totals: totalsOf(row),
    comparison: comparisonOf(row),
    currencyCode: options.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

interface TargetRow extends AggregateRow {
  asin: string | null;
  target_acos: string | null;
  tos_low: string | null;
  tos_high: string | null;
  tos_share: string | null;
  campaign_id: string;
  ad_group_id: string;
  target_id: string;
  target_kind: string;
  match_type: string | null;
  ad_product: string;
  targeting: string | null;
  target_state: string | null;
  bid: string | number | null;
  ad_group_name: string | null;
  campaign_name: string | null;
}

async function loadTargets(
  handle: GridDataHandle,
  options: LoadGridOptions,
  limit: number,
  rankDays: GridPerformanceEvidence['rankDays'],
): Promise<GridRow[]> {
  const stage = targetReadTimer();
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<TargetRow[]>`
    with facts as (
      select campaign_id, ad_group_id, target_id, target_kind::text as target_kind,
             max(match_type::text) as match_type, ad_product,
             ${windowSums(handle, period, comparison)},
             min(top_of_search_impression_share) filter (where date between ${period.start} and ${period.end}) as tos_low,
             max(top_of_search_impression_share) filter (where date between ${period.start} and ${period.end}) as tos_high,
             avg(top_of_search_impression_share) filter (where date between ${period.start} and ${period.end}) as tos_share
      from public.fact_sp_target_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and (date between ${period.start} and ${period.end} or date between ${comparison.start} and ${comparison.end})
      group by campaign_id, ad_group_id, target_id, target_kind, ad_product
    )
    select f.*,
           -- One column for "what is being targeted", whether it is a keyword
           -- or a product target. Two nouns three characters apart is exactly
           -- what the recon says not to ship.
           coalesce(k.keyword_text, t.resolved_expression, t.name, k.name) as targeting,
           coalesce(k.state::text, t.state::text) as target_state,
           coalesce(k.bid, t.bid) as bid,
           g.name as ad_group_name,
           c.name as campaign_name, products.asin,
           coalesce(og.target_acos,p.target_acos) as target_acos
      from facts f
      left join public.keywords k
        on k.org_id = ${orgId} and k.profile_id = ${profileId} and k.amazon_id = f.target_id
      left join public.targets t
        on t.org_id = ${orgId} and t.profile_id = ${profileId} and t.amazon_id = f.target_id
      left join public.ad_groups g
        on g.org_id = ${orgId} and g.profile_id = ${profileId} and g.amazon_id = f.ad_group_id
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
      join public.ad_profiles p on p.org_id=${orgId} and p.id=${profileId}
      left join public.campaign_optimization_assignments ca on ca.org_id=${orgId} and ca.profile_id=${profileId} and ca.campaign_id=f.campaign_id
      left join public.optimization_groups og on og.org_id=${orgId} and og.profile_id=${profileId} and og.id=ca.group_id
      -- The effective assignment, whatever its source (derived, derived parent,
      -- proposed or manual). Only an ad group the worker has not derived yet
      -- falls back to its single advertised product.
      left join public.ad_group_product_assignments assignment
        on assignment.org_id=${orgId} and assignment.profile_id=${profileId} and assignment.ad_group_id=f.ad_group_id
      left join lateral (select case when assignment.ad_group_id is not null then assignment.asin
          else (select case when count(distinct asin)=1 then min(asin) end from public.product_ads
            where org_id=${orgId} and profile_id=${profileId} and campaign_id=f.campaign_id and ad_group_id=f.ad_group_id and deleted_at is null) end as asin) products on true
     limit ${limit}
  `;

  stage('facts');
  // Strategy resolves once per profile/window, not once per target. Repeating
  // its document in the fact join also repeats transport and schema validation.
  const [strategyRow] = await handle.sql<{ doc: unknown }[]>`select doc from public.profile_strategy
    where org_id=${orgId} and (profile_id=${profileId} or profile_id is null)
    order by profile_id nulls last, updated_at desc limit 1`;
  const strategy = strategyRow?.doc == null ? null : TenantStrategy.safeParse(strategyRow.doc);
  const configured = strategy?.success ? strategy.data : null;
  const latest = await readLatestBidSeriesByTargetIds(handle, {
    orgId,
    profileId,
    targetIds: rows.map((row) => row.target_id),
  });
  stage('bids');
  const latestByTarget = new Map(latest.map((row) => [row.targetId, row]));
  const asins = [...new Set(rows.flatMap((row) => row.asin ? [row.asin] : []))];
  const rankStart = new Date(Date.parse(period.end) - 13 * 86_400_000).toISOString().slice(0, 10);
  const rankAxis = Array.from({ length: 14 }, (_, index) => new Date(Date.parse(rankStart) + index * 86_400_000).toISOString().slice(0, 10));
  const rankFrom = [period.start, comparison.start, rankStart].sort()[0]!;
  // One database row per history, rather than repeating ASIN and keyword for
  // every day. Preserve the latest observation and the complete ordered window.
  const observations = asins.length === 0 ? [] : await handle.sql<{ asin: string; keyword: string; dates: string[]; ranks: (number | null)[] }[]>`
    select asin, keyword, array_agg(date order by date) as dates, array_agg(rank order by date) as ranks
    from (
      select distinct on (asin,keyword,observed_on) asin, keyword, observed_on::text as date, organic_rank as rank
      from public.rank_observations where org_id=${orgId} and profile_id=${profileId} and asin=any(${asins}::text[])
      and observed_on between ${rankFrom} and ${comparison.end > period.end ? comparison.end : period.end}
      order by asin,keyword,observed_on,created_at desc,id desc
    ) latest group by asin,keyword order by asin,keyword`;
  stage('ranks');
  const sqp = asins.length === 0 ? [] : await handle.sql<{ asin: string; query: string; impression_share: string | null; purchase_share: string | null; market_cvr: string | null; asin_cvr: string | null }[]>`
    select asin, lower(search_query) as query,
      sum(asin_impressions)::numeric/nullif(sum(total_impressions),0) as impression_share,
      sum(asin_purchases)::numeric/nullif(sum(total_purchases),0) as purchase_share,
      sum(total_purchases)::numeric/nullif(sum(total_clicks),0) as market_cvr,
      sum(asin_purchases)::numeric/nullif(sum(asin_clicks),0) as asin_cvr
    from public.fact_sqp_weekly q where org_id=${orgId} and profile_id=${profileId} and asin=any(${asins}::text[])
      and exists (select 1 from public.spapi_profile_bindings b join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id
        join public.ad_profiles profile on profile.org_id=b.org_id and profile.id=b.profile_id
        where b.org_id=q.org_id and b.profile_id=q.profile_id and b.marketplace_id=q.marketplace_id and b.enabled and c.status='active'
          and c.vault_secret_id is not null and nullif(btrim(c.selling_partner_id),'') is not null and b.marketplace_id=any(c.marketplace_ids)
          and profile.sync_enabled and profile.region=app.spapi_region_for_marketplace(b.marketplace_id))
      and exists (select 1 from public.sqp_promotion_runs run where run.org_id=q.org_id and run.profile_id=q.profile_id
        and run.marketplace_id=q.marketplace_id and run.week_start=q.week_start and q.asin=any(run.requested_asins)
        and run.refused_rows=0 and run.source_rows=run.parsed_rows+run.refused_rows
        and run.parsed_rows>=run.deduplicated_rows and run.deduplicated_rows=run.promoted_rows and run.promoted_rows=run.canonical_rows
        and run.canonical_rows=(select count(*) from public.fact_sqp_weekly loaded where loaded.org_id=run.org_id and loaded.profile_id=run.profile_id
          and loaded.marketplace_id=run.marketplace_id and loaded.week_start=run.week_start and loaded.asin=any(run.requested_asins)))
    and week_start>=${period.start} and week_end<=${period.end} group by asin,lower(search_query)`;
  stage('sqp');
  const aba = await readSpReportEvidence(handle, { orgId, profileId, family: 'aba', start: period.start, end: period.end });
  const rankIndex = new Map(rankAxis.map((date, index) => [date, index]));
  const ranks = new Map<string, { current: number | null; previous: number | null; days?: GridPerformanceEvidence['rankDays'][string] }>();
  for (const observation of observations) {
    const key = `${observation.asin}\u0000${observation.keyword.toLowerCase()}`;
    const history: NonNullable<ReturnType<typeof ranks.get>> = ranks.get(key) ?? { current: null, previous: null };
    observation.dates.forEach((date, index) => {
      const rank = observation.ranks[index] ?? null;
      if (date >= period.start && date <= period.end) history.current = rank;
      if (date >= comparison.start && date <= comparison.end) history.previous = rank;
      const tile = rankIndex.get(date);
      if (tile !== undefined) {
        history.days ??= rankAxis.map((date) => ({ date, observed: false, rank: null }));
        history.days[tile]!.observed = true;
        history.days[tile]!.rank = rank;
      }
    });
    ranks.set(key, history);
  }
  const campaignMetadata = new Map<string | null, { purpose: string | null; category: ReturnType<typeof classifyCampaignCategory> }>();
  const campaignFor = (name: string | null) => {
    const cached = campaignMetadata.get(name);
    if (cached !== undefined) return cached;
    const naming = configured?.naming;
    const parsed = naming?.variable_order?.length && naming.delimiter && name ? parseCampaignName(name, { variableOrder: naming.variable_order, delimiter: naming.delimiter,
      suffix: naming.suffix ?? '', custom1Value: naming.custom1_value ?? '', custom2Value: naming.custom2_value ?? '' }) : null;
    const value = { purpose: parsed?.confidence === 'exact' ? parsed.slots['Goal'] ?? null : null, category: classifyCampaignCategory(name) };
    campaignMetadata.set(name, value);
    return value;
  };
  const sqpByQuery = new Map(sqp.map((row) => [`${row.asin}\u0000${row.query}`, row]));
  const measured = (value: string | number | null | undefined) => value === null || value === undefined ? null : Number(value);

  const result = rows.map((row) => {
    const series = latestByTarget.get(row.target_id);
    const bid = row.bid === null ? null : num(row.bid);
    const suggestedBid = series?.suggestedBidMedian ?? null;
    const suggestedBidLow = series?.suggestedBidLow ?? null;
    const suggestedBidHigh = series?.suggestedBidHigh ?? null;
    const literal = row.target_kind === 'keyword' && row.match_type !== 'broad';
    const key = `${row.asin ?? ''}\u0000${row.targeting?.toLowerCase() ?? ''}`;
    const history = literal ? ranks.get(key) : undefined;
    const current = history?.current ?? null;
    const previous = history?.previous ?? null;
    const query = literal ? sqpByQuery.get(key) : undefined;
    const observedAba = literal && row.asin && row.targeting ? abaEvidence(aba, { query: row.targeting, asin: row.asin, start: period.start, end: period.end }) : null;
    if (history?.days) rankDays[`target:${row.target_id}`] = history.days;
    const targetAcos = measured(row.target_acos);
    const spend = measured(row.spend);
    const clicks = measured(row.clicks);
    const sales = measured(row.sales);
    const acos = spend !== null && sales !== null && sales > 0 ? spend / sales : null;
    const cpc = spend !== null && clicks !== null && clicks > 0 ? spend / clicks : null;
    const verdict = classifyPerformanceVerdict({ spend, clicks, acos, organicRank: current, topOfSearchShare: measured(row.tos_share) }, {
      ownedRank: configured?.rank_lifecycle.graduation_rank ?? null, rankGap: configured?.rank_lifecycle.demotion_rank ?? null, targetAcos,
    });
    const campaign = campaignFor(row.campaign_name);
    return {
      id: `target:${row.target_id}`,
      dimensions: {
        asin: row.asin ?? null, not_the_query: !literal,
        campaign_id: row.campaign_id, ad_group_id: row.ad_group_id,
        campaign_purpose: campaign.purpose,
        organic_rank: current, rank_change: rankChange(current, previous),
        top_of_search_share: measured(row.tos_share),
        top_of_search_range: row.tos_low == null || row.tos_high == null ? null : `${(Number(row.tos_low) * 100).toFixed(1)}–${(Number(row.tos_high) * 100).toFixed(1)}%`,
        break_even_bid: grossBreakEvenBid(cpc, acos), acos_vs_target: acosVsTarget(acos, targetAcos),
        aba_state: observedAba?.state ?? 'not-measured', aba_frequency_rank: observedAba?.frequencyRank ?? null,
        aba_click_share: observedAba?.clickShare ?? null, aba_conversion_share: observedAba?.conversionShare ?? null, aba_slot: observedAba?.slot ?? null,
        sqp_impression_share: measured(query?.impression_share), sqp_purchase_share: measured(query?.purchase_share),
        market_cvr: measured(query?.market_cvr), asin_cvr: measured(query?.asin_cvr),
        conversion_points: conversionPoints(measured(query?.asin_cvr), measured(query?.market_cvr)),
        verdict: verdict.diagnosis, verdict_reason: verdict.reason,
        target_id: row.target_id,
        targeting: row.targeting ?? row.target_id,
        target_state: row.target_state,
        target_kind: row.target_kind,
        match_type: row.match_type,
        bid,
        suggested_bid: suggestedBid,
        suggested_bid_low: suggestedBidLow,
        suggested_bid_high: suggestedBidHigh,
        bid_corridor_position: bidCorridorPosition(bid, suggestedBidLow, suggestedBidHigh),
        max_potential_cpc: series?.maxPotentialCpc ?? null,
        diff_from_suggested_bid:
          bid === null || suggestedBid === null ? null : bid - suggestedBid,
        ad_group_name: row.ad_group_name ?? row.ad_group_id,
        campaign_name: row.campaign_name ?? row.campaign_id,
        rpc_category: campaign.category,
        ad_product: row.ad_product,
      },
      ...measurementOf(row), totals: totalsOf(row),
      comparison: comparisonOf(row),
      currencyCode: options.currencyCode,
    };
  });
  stage('derive');
  return result;
}

function bidCorridorPosition(
  bid: number | null,
  low: number | null,
  high: number | null,
): 'Below range' | 'Within range' | 'Above range' | 'Unavailable' {
  if (bid === null || low === null || high === null) return 'Unavailable';
  if (bid < low) return 'Below range';
  if (bid > high) return 'Above range';
  return 'Within range';
}

async function loadProducts(handle: GridDataHandle, options: LoadGridOptions, limit: number): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<(AggregateRow & { asin: string; product_name: string | null; catalogue_marketplace: string | null;
    catalogue_observed_at: string | null; catalogue_title: string | null; catalogue_availability: string | null;
    catalogue_price: number | null; catalogue_bsr: number | null })[]>`
    with products as (
      select asin,max(product_name) as product_name from (
        select asin,name as product_name from public.product_ads
        where org_id=${orgId} and profile_id=${profileId} and asin is not null and deleted_at is null
        union all
        -- Every live ad group's effective assignment lists its product, whatever the
        -- source, so a derived parent gets a row and a Market position gap of its own.
        select a.asin,null from public.ad_group_product_assignments a
        join public.ad_groups g on g.org_id=a.org_id and g.profile_id=a.profile_id and g.amazon_id=a.ad_group_id and g.deleted_at is null
        where a.org_id=${orgId} and a.profile_id=${profileId} and a.asin is not null
      ) listed group by asin
    ), measured as (
      select date, dimensions->>'advertisedAsin' as asin,
        (row_data->'metrics'->>'impressions')::numeric as impressions,
        (row_data->'metrics'->>'clicks')::numeric as clicks,
        (row_data->'metrics'->>'cost')::numeric as cost,
        (row_data->'metrics'->>'sales7d')::numeric as sales_7d,
        (row_data->'metrics'->>'purchases7d')::numeric as purchases_7d,
        (row_data->'metrics'->>'unitsSoldClicks7d')::numeric as units_sold_7d
      from public.fact_advertised_product_daily
      where org_id=${orgId} and profile_id=${profileId} and family='spAdvertisedProduct' and variant='DAILY:legacy:v1'
    ), facts as (
      select asin, ${windowSums(handle, period, comparison)} from measured
      where (date between ${period.start} and ${period.end} or date between ${comparison.start} and ${comparison.end}) group by asin
    ) select coalesce(p.asin,f.asin) as asin,coalesce(case when m.snapshot->'title'->>'state'='returned' then m.snapshot->'title'->>'value' end,p.product_name) as product_name,
      m.marketplace_id as catalogue_marketplace,m.acquired_at::text as catalogue_observed_at,
      case when m.snapshot->'title'->>'state'='returned' then m.snapshot->'title'->>'value' end as catalogue_title,
      case when m.snapshot->'availability'->>'state'='returned' then m.snapshot->'availability'->>'value' end as catalogue_availability,
      case when m.snapshot->'price'->>'state'='returned' then (m.snapshot#>>'{price,value,amount}')::float8 end as catalogue_price,
      case when m.snapshot->'bestSellerRank'->>'state'='returned' then (m.snapshot#>>'{bestSellerRank,value}')::float8 end as catalogue_bsr,
      f.impressions,f.clicks,f.spend,f.sales,f.orders,f.units,f.c_days,f.c_impressions,f.c_clicks,f.c_spend,f.c_sales,f.c_orders,f.c_units
      from products p full join facts f on f.asin=p.asin
      left join lateral(select marketplace_id,acquired_at,snapshot from public.ads_product_metadata_snapshots
        where org_id=${orgId} and profile_id=${profileId} and asin=coalesce(p.asin,f.asin) and ad_product='SP' and public.ads_catalogue_receipt_is_sealed(receipt_id)
          and (select count(distinct scoped.marketplace_id) from public.ads_product_metadata_snapshots scoped
            where scoped.org_id=${orgId} and scoped.profile_id=${profileId} and scoped.asin=coalesce(p.asin,f.asin) and scoped.ad_product='SP')=1
        order by acquired_at desc,retrieved_at desc,id desc limit 1)m on true
      order by coalesce(p.asin,f.asin) limit ${limit}`;
  const retail = await readSpReportEvidence(handle, { orgId, profileId, family: 'retail', start: period.start, end: period.end });
  const links = await listMarketPositionLinks(handle, orgId, profileId);
  const asins = [...new Set([...rows.map((row) => row.asin), ...links.flatMap((link) => [link.ownAsin, link.competitorAsin])])];
  const series = await readMarketRankSeries(handle, orgId, asins, period.end, period.end);
  return rows.map((row) => {
    const observedRetail = retailEvidence(retail, { start: period.start, end: period.end, asin: row.asin });
    const tracked = links.filter((link) => link.ownAsin === row.asin);
    const categories = [...new Set(tracked.flatMap((link) => link.category ? [link.category] : []))];
    const own = categories.length === 1 ? series.find((item) => item.asin === row.asin && item.category === categories[0]) : undefined;
    const competitors = series.filter((item) => tracked.some((link) => link.competitorAsin === item.asin && link.category === item.category));
    return { id: `product:${row.asin}`, dimensions: { ad_product: 'SP', asin: row.asin, product_name: row.product_name,
      retail_sales: observedRetail.sales, retail_currency: observedRetail.currency, retail_units: observedRetail.units, retail_sessions: observedRetail.sessions,
      retail_conversion: observedRetail.conversion, retail_state: observedRetail.state, retail_observed_at: observedRetail.observedAt, tacos: null,
      catalogue_marketplace: row.catalogue_marketplace, catalogue_observed_at: row.catalogue_observed_at,
      catalogue_title: row.catalogue_title, catalogue_availability: row.catalogue_availability,
      catalogue_price: row.catalogue_price, catalogue_bsr: row.catalogue_bsr,
      gap: own ? marketPositionGap(own, competitors, period.end) : null, ppc_measured: row.spend !== null },
      ...measurementOf(row), totals: totalsOf(row), comparison: comparisonOf(row), currencyCode: options.currencyCode };
  });
}

// ---------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------

interface SearchTermRow extends AggregateRow {
  search_term: string;
  campaign_id: string;
  ad_group_id: string;
  target_id: string | null;
  match_type: string | null;
  ad_product: string;
  targeting: string | null;
  ad_group_name: string | null;
  campaign_name: string | null;
  harvested: boolean;
}

async function loadSearchTerms(
  handle: GridDataHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<SearchTermRow[]>`
    with facts as (
      select search_term, campaign_id, ad_group_id, target_id,
             max(match_type::text) as match_type, ad_product,
             ${windowSums(handle, period, comparison)}
      from public.fact_search_term_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and (date between ${period.start} and ${period.end} or date between ${comparison.start} and ${comparison.end})
      group by search_term, campaign_id, ad_group_id, target_id, ad_product
    ), harvested_terms as materialized (
      -- Build the profile vocabulary once. A correlated EXISTS with
      -- lower(keyword_text) makes Postgres revisit the current keyword mirror
      -- for every aggregated search-term row; on an operator-sized account
      -- that becomes the cold route's dominant work.
      select lower(keyword_text) as normalized_term
        from public.keywords
       where org_id = ${orgId}
         and profile_id = ${profileId}
         and deleted_at is null
         and keyword_text is not null
       group by lower(keyword_text)
    )
    select f.*,
           k.keyword_text as targeting,
           g.name as ad_group_name,
           c.name as campaign_name,
           -- "Have I already acted on this row." Without it an operator
           -- re-harvests the same winners every week.
           (harvested.normalized_term is not null) as harvested
      from facts f
      left join public.keywords k
        on k.org_id = ${orgId} and k.profile_id = ${profileId} and k.amazon_id = f.target_id
      left join public.ad_groups g
        on g.org_id = ${orgId} and g.profile_id = ${profileId} and g.amazon_id = f.ad_group_id
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
      left join harvested_terms harvested
        on harvested.normalized_term = lower(f.search_term)
     limit ${limit}
  `;

  return rows.map((row) => ({
    id: `st:${row.campaign_id}:${row.ad_group_id}:${row.target_id ?? '-'}:${row.search_term}`,
    dimensions: {
      search_term: row.search_term,
      targeting: row.targeting,
      match_type: row.match_type,
      ad_group_name: row.ad_group_name ?? row.ad_group_id,
      campaign_name: row.campaign_name ?? row.campaign_id,
      harvested: row.harvested,
      ad_product: row.ad_product,
    },
    ...measurementOf(row), totals: totalsOf(row),
    comparison: comparisonOf(row),
    currencyCode: options.currencyCode,
  }));
}

// ---------------------------------------------------------------------------
// Placements
// ---------------------------------------------------------------------------

interface PlacementRow extends AggregateRow {
  campaign_id: string;
  placement: string;
  ad_product: string;
  campaign_name: string | null;
  placement_bidding: { topOfSearch: number | null; productPages: number | null; restOfSearch: number | null } | null;
}

const MODIFIER_KEY: Record<string, 'topOfSearch' | 'productPages' | 'restOfSearch'> = {
  top_of_search: 'topOfSearch',
  product_pages: 'productPages',
  rest_of_search: 'restOfSearch',
};

async function loadPlacements(
  handle: GridDataHandle,
  options: LoadGridOptions,
  limit: number,
): Promise<GridRow[]> {
  const { orgId, profileId, period, comparison } = options;
  const rows = await handle.sql<PlacementRow[]>`
    with facts as (
      select campaign_id, placement::text as placement, ad_product,
             sum(impressions) filter (where date between ${period.start} and ${period.end}) as impressions,
             sum(clicks)      filter (where date between ${period.start} and ${period.end}) as clicks,
             sum(cost)        filter (where date between ${period.start} and ${period.end}) as spend,
             sum(sales_7d)    filter (where date between ${period.start} and ${period.end}) as sales,
             sum(purchases_7d) filter (where date between ${period.start} and ${period.end}) as orders,
             null::numeric as units,
             count(*)         filter (where date between ${comparison.start} and ${comparison.end}) as c_days,
             sum(impressions) filter (where date between ${comparison.start} and ${comparison.end}) as c_impressions,
             sum(clicks)      filter (where date between ${comparison.start} and ${comparison.end}) as c_clicks,
             sum(cost)        filter (where date between ${comparison.start} and ${comparison.end}) as c_spend,
             sum(sales_7d)    filter (where date between ${comparison.start} and ${comparison.end}) as c_sales,
             sum(purchases_7d) filter (where date between ${comparison.start} and ${comparison.end}) as c_orders,
             null::numeric as c_units
      from public.fact_placement_daily
      where org_id = ${orgId} and profile_id = ${profileId}
        and (date between ${period.start} and ${period.end} or date between ${comparison.start} and ${comparison.end})
      group by campaign_id, placement, ad_product
    )
    select f.*, c.name as campaign_name, c.placement_bidding
      from facts f
      left join public.campaigns c
        on c.org_id = ${orgId} and c.profile_id = ${profileId} and c.amazon_id = f.campaign_id
     limit ${limit}
  `;

  return rows.map((row) => {
    const key = MODIFIER_KEY[row.placement];
    const modifier = key === undefined ? null : (row.placement_bidding?.[key] ?? null);
    return {
      id: `placement:${row.campaign_id}:${row.placement}`,
      dimensions: {
        placement: row.placement,
        campaign_id: row.campaign_id,
        campaign_name: row.campaign_name ?? row.campaign_id,
        // Amazon stores the modifier as a whole percent; the grid renders
        // percents from fractions, so the conversion happens once, here.
        placement_modifier: modifier === null ? null : modifier / 100,
        ad_product: row.ad_product,
      },
      ...measurementOf(row), totals: totalsOf(row),
      comparison: comparisonOf(row),
      currencyCode: options.currencyCode,
    };
  });
}

// ---------------------------------------------------------------------------

/**
 * The two-window sum block shared by every target-grain query.
 *
 * `count(*) filter (...)` on the comparison window is what distinguishes "spent
 * nothing" from "has no comparison row": zero days means no row, and the caller
 * turns that into a null comparison rather than a zeroed one.
 */
function windowSums(handle: GridDataHandle, period: Period, comparison: Period) {
  const { sql } = handle;
  return sql`
    case when bool_or(impressions is null) filter (where date between ${period.start} and ${period.end}) then null else sum(impressions) filter (where date between ${period.start} and ${period.end}) end as impressions,
    case when bool_or(clicks is null) filter (where date between ${period.start} and ${period.end}) then null else sum(clicks)      filter (where date between ${period.start} and ${period.end}) end as clicks,
    case when bool_or(cost is null) filter (where date between ${period.start} and ${period.end}) then null else sum(cost)        filter (where date between ${period.start} and ${period.end}) end as spend,
    case when bool_or(sales_7d is null) filter (where date between ${period.start} and ${period.end}) then null else sum(sales_7d)    filter (where date between ${period.start} and ${period.end}) end as sales,
    case when bool_or(purchases_7d is null) filter (where date between ${period.start} and ${period.end}) then null else sum(purchases_7d) filter (where date between ${period.start} and ${period.end}) end as orders,
    case when bool_or(units_sold_7d is null) filter (where date between ${period.start} and ${period.end}) then null else sum(units_sold_7d) filter (where date between ${period.start} and ${period.end}) end as units,
    count(*)         filter (where date between ${comparison.start} and ${comparison.end}) as c_days,
    case when bool_or(impressions is null) filter (where date between ${comparison.start} and ${comparison.end}) then null else sum(impressions) filter (where date between ${comparison.start} and ${comparison.end}) end as c_impressions,
    case when bool_or(clicks is null) filter (where date between ${comparison.start} and ${comparison.end}) then null else sum(clicks)      filter (where date between ${comparison.start} and ${comparison.end}) end as c_clicks,
    case when bool_or(cost is null) filter (where date between ${comparison.start} and ${comparison.end}) then null else sum(cost)        filter (where date between ${comparison.start} and ${comparison.end}) end as c_spend,
    case when bool_or(sales_7d is null) filter (where date between ${comparison.start} and ${comparison.end}) then null else sum(sales_7d)    filter (where date between ${comparison.start} and ${comparison.end}) end as c_sales,
    case when bool_or(purchases_7d is null) filter (where date between ${comparison.start} and ${comparison.end}) then null else sum(purchases_7d) filter (where date between ${comparison.start} and ${comparison.end}) end as c_orders,
    case when bool_or(units_sold_7d is null) filter (where date between ${comparison.start} and ${comparison.end}) then null else sum(units_sold_7d) filter (where date between ${comparison.start} and ${comparison.end}) end as c_units
  `;
}
