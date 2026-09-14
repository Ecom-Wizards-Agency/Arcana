/**
 * Column sets, one per entity level.
 *
 * Built against `https://github.com/Ecom-Wizards-Agency/openspell/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §2, which is exact: those column
 * names were read off live `get_entity_data` responses, not transcribed from
 * documentation. Where our fact tables cannot source a recon column it is
 * absent and the reason is written down, rather than shipped as a plausible
 * zero. A grid that shows `top_of_search_impression_share = 0` because nothing
 * populated it is worse than one that does not show the column.
 *
 * Two of the recon's "beat" items are implemented here rather than deferred:
 *
 *  - **One casing, one name.** No `match_types` on one entity and `match_type`
 *    on another; no `profile_id` meaning two different numbers. The column id
 *    is lowercase snake_case, the filter key is its uppercase twin, and that is
 *    the entire mapping (`filter.ts`).
 *  - **Archived is not optional.** `state` is a real column with a real filter
 *    on every level, and the default view (enabled-only, matching AdLabs) is a
 *    *stated* filter chip the operator can see and remove -- not an invisible
 *    server-side exclusion that quietly drops archived spend out of a month
 *    total.
 */
import type { MetricScale } from './metrics.js';
import { METRIC_SPECS, metricSpec } from './metrics.js';
import {
  COMPARISON_SUFFIX,
  DELTA_ABSOLUTE_SUFFIX,
  DELTA_PERCENT_SUFFIX,
} from './rows.js';

import { GridEntity } from '@wizard-ads/shared';

export type EntityLevel = (typeof GridEntity.options)[number];
export const ENTITY_LEVELS: readonly EntityLevel[] = GridEntity.options;
export const ENTITY_LABELS: Record<EntityLevel, string> = { campaigns: 'Campaigns', ad_groups: 'Ad groups', targets: 'Targets', search_terms: 'Search terms', products: 'Products', placements: 'Placements' };

/**
 * What a column *is*, which decides what may be done to it.
 *
 * `control` is the third kind because a selection checkbox and a row action are
 * columns on screen and nothing at all in the data: they have no value to sort
 * by, group on, total or export. Making that a kind rather than a flag is what
 * stops a selection header from ever advertising `aria-sort` -- the header
 * cannot offer an ordering it has no accessor for.
 */
export type ColumnKind = 'dimension' | 'metric' | 'control';
export type FilterKind = 'numeric' | 'text' | 'categorical';

/**
 * Whether a header may sort. Control columns carry no value, so they never do;
 * every other column does.
 */
export function isSortableColumn(column: GridColumn): boolean {
  return column.kind !== 'control';
}

export type GridCellKind = 'suggested_bid' | 'text' | 'numeric' | 'status';

export const NUMERIC_MIN_WIDTH = 96;
export function minimumColumnWidth(column: GridColumn): number {
  if (column.subject !== undefined && column.minWidth !== undefined) return column.minWidth;
  return column.scale !== 'text' || column.cell === 'numeric'
    ? Math.max(NUMERIC_MIN_WIDTH, column.minWidth ?? 0) : column.minWidth ?? 20;
}

export type ColumnSubject = 'Identity' | 'RANK & ORGANIC' | 'SPONSORED PRODUCTS' | 'SQP' | 'BRAND ANALYTICS';

export interface GridColumn {
  subject?: ColumnSubject;
  /** Position in the complete performance preset; absent on supplementary columns. */
  referenceOrder?: number;
  id: string;
  header: string;
  kind: ColumnKind;
  scale: MetricScale | 'text';
  align: 'left' | 'right';
  /** Starting width in pixels; the operator drags from here. */
  width: number;
  minWidth?: number;
  /** Pinned columns sit left of the pin line and do not scroll horizontally. */
  pinned?: boolean;
  /** Shown in the column picker, so a name never has to be self-explanatory. */
  description?: string;
  /** The rare cell whose visual hierarchy carries more than its sort value. */
  cell?: GridCellKind;
  /**
   * How an operator filters this field. Omitted values resolve to numeric for
   * metrics/money/percent/integer columns and free text otherwise.
   */
  filterKind?: FilterKind;
}

/** One authoritative filter-control decision for every Grid consumer. */
export function filterKindForColumn(column: GridColumn): FilterKind {
  if (column.filterKind !== undefined) return column.filterKind;
  if (column.kind === 'metric' || column.scale !== 'text') return 'numeric';
  return 'text';
}

const dimension = (
  id: string,
  header: string,
  options: Partial<GridColumn> = {},
): GridColumn => ({
  id,
  header,
  kind: 'dimension',
  scale: 'text',
  align: 'left',
  width: 180,
  ...options,
});

/** Expand one metric into the recon's four columns. */
export function metricColumns(key: string): GridColumn[] {
  const spec = metricSpec(key);
  if (spec === undefined) return [];
  const base: Omit<GridColumn, 'id' | 'header'> = {
    kind: 'metric',
    scale: spec.scale,
    align: 'right',
    width: 104,
  };
  return [
    { ...base, id: key, header: spec.label },
    { ...base, id: `${key}${COMPARISON_SUFFIX}`, header: `${spec.label} (prev)` },
    {
      ...base,
      id: `${key}${DELTA_ABSOLUTE_SUFFIX}`,
      header: `${spec.label} Δ`,
      description: 'Difference against the comparison period, in the metric’s own unit.',
    },
    {
      ...base,
      id: `${key}${DELTA_PERCENT_SUFFIX}`,
      header: `${spec.label} Δ%`,
      scale: 'percent',
      description: 'Relative change against the comparison period. Always a fraction, on every entity.',
    },
  ];
}

/** Every metric, four columns each, in registry order. */
export function allMetricColumns(): GridColumn[] {
  return METRIC_SPECS.flatMap((spec) => metricColumns(spec.key));
}

/**
 * Non-metric columns per level.
 *
 * Absent from `campaigns` against the recon, and why: `campaign_global_id`,
 * `cost_type`, `creative_type`, `goal`, `audience_name`, `site_restrictions`
 * and the dayparting trio have no source in our entity mirror yet (the mirror
 * carries what the sync writes -- see `packages/db` schema); `has_opt_rule`,
 * `last_optimized_at` and `last_optimized_note` arrive with the optimizer
 * (WP-05/WP-12) and are a handoff, not a gap.
 */
const DIMENSIONS: Record<EntityLevel, GridColumn[]> = {
  campaigns: [
    dimension('campaign_name', 'Campaign', { width: 320, pinned: true }),
    dimension('campaign_state', 'State', { width: 96, filterKind: 'categorical' }),
    dimension('ad_product', 'Ad type', { width: 88, filterKind: 'categorical' }),
    dimension('targeting_type', 'Targeting', { width: 104, filterKind: 'categorical' }),
    dimension('bidding_strategy', 'Bid strategy', { width: 150, filterKind: 'categorical' }),
    dimension('budget_amount', 'Budget', { scale: 'money', align: 'right', width: 104 }),
    dimension('budget_type', 'Budget type', { width: 104, filterKind: 'categorical' }),
    dimension('portfolio_name', 'Portfolio', { width: 180, filterKind: 'categorical' }),
    dimension('start_date', 'Start', { width: 104 }),
    dimension('end_date', 'End', { width: 104 }),
    dimension('is_ended', 'Ended', {
      width: 80,
      filterKind: 'categorical',
      description:
        'End date strictly before today in the profile timezone. An ended campaign cannot take ' +
        'budget or bid updates even while its state reads Enabled.',
    }),
    dimension('campaign_id', 'Campaign ID', { width: 160 }),
  ],
  ad_groups: [
    dimension('ad_group_name', 'Ad group', { width: 280, pinned: true }),
    dimension('ad_group_state', 'State', { width: 96, filterKind: 'categorical' }),
    dimension('campaign_name', 'Campaign', { width: 280, filterKind: 'categorical' }),
    dimension('default_bid', 'Default bid', { scale: 'money', align: 'right', width: 104 }),
    dimension('ad_product', 'Ad type', { width: 88, filterKind: 'categorical' }),
    dimension('ad_group_id', 'Ad group ID', { width: 160 }),
    dimension('campaign_id', 'Campaign ID', { width: 160 }),
  ],
  targets: [
    dimension('targeting', 'Target', { width: 280, pinned: true }),
    dimension('target_state', 'State', { width: 96, filterKind: 'categorical' }),
    dimension('target_kind', 'Kind', {
      width: 96,
      filterKind: 'categorical',
      description: 'Keyword or product target. One name, on every entity level.',
    }),
    dimension('match_type', 'Match', {
      width: 96,
      filterKind: 'categorical',
      description:
        'Singular everywhere. AdLabs spells this `match_types` on targets and `match_type` on ' +
        'negatives; one concept gets one name here.',
    }),
    dimension('bid', 'Bid', { scale: 'money', align: 'right', width: 96 }),
    dimension('suggested_bid', 'Sugg. bid', {
      scale: 'money',
      align: 'right',
      width: 128,
      cell: 'suggested_bid',
      description: 'Latest Amazon suggested-bid median, with the low–high corridor beneath it.',
    }),
    dimension('bid_corridor_position', 'Corridor position', {
      width: 128,
      filterKind: 'categorical',
      description: 'Whether the current bid sits below, within, or above Amazon’s latest suggested-bid corridor.',
    }),
    dimension('max_potential_cpc', 'Max potential CPC', {
      scale: 'money',
      align: 'right',
      width: 136,
      description: 'Latest base bid after placement, audience, and dayparting modifiers.',
    }),
    dimension('diff_from_suggested_bid', 'Bid − suggested', {
      scale: 'money',
      align: 'right',
      width: 128,
      description: 'Current bid minus the latest Amazon suggested-bid median.',
    }),
    // The id stays `rpc_category` (the recon's name, and what saved views and
    // filters already carry); the operator reads it as the campaign's role.
    dimension('rpc_category', 'Campaign role', {
      width: 120,
      filterKind: 'categorical',
      description:
        'The role the campaign name declares (rank, discovery, profit). A filter, not an optimizer run.',
    }),
    dimension('ad_group_name', 'Ad group', { width: 220, filterKind: 'categorical' }),
    dimension('campaign_name', 'Campaign', { width: 280, filterKind: 'categorical' }),
    dimension('ad_product', 'Ad type', { width: 88, filterKind: 'categorical' }),
    dimension('target_id', 'Target ID', { width: 160 }),
  ],
  search_terms: [
    dimension('search_term', 'Search term', { width: 320, pinned: true }),
    dimension('targeting', 'Matched target', { width: 240 }),
    dimension('match_type', 'Match', { width: 96, filterKind: 'categorical' }),
    dimension('ad_group_name', 'Ad group', { width: 220, filterKind: 'categorical' }),
    dimension('campaign_name', 'Campaign', { width: 280, filterKind: 'categorical' }),
    dimension('harvested', 'Harvested', {
      width: 104,
      filterKind: 'categorical',
      description:
        'Whether this term already exists as a target somewhere in the profile. Without it an ' +
        'operator re-harvests the same winners every week.',
    }),
    dimension('ad_product', 'Ad type', { width: 88, filterKind: 'categorical' }),
  ],
  products: [dimension('asin', 'Product', { pinned: true, width: 220 }), dimension('product_name', 'Product name'), dimension('gap', 'Gap', { scale: 'integer', align: 'right', description: 'Signed distance to the best-ranked tracked competitor on this day; not measured when comparable ranks are missing.' })],
  placements: [
    dimension('placement', 'Placement', { width: 200, pinned: true, filterKind: 'categorical' }),
    dimension('campaign_name', 'Campaign', { width: 320, filterKind: 'categorical' }),
    dimension('placement_modifier', 'Current modifier', {
      scale: 'percent',
      align: 'right',
      width: 140,
    }),
    dimension('ad_product', 'Ad type', { width: 88, filterKind: 'categorical' }),
    dimension('campaign_id', 'Campaign ID', { width: 160 }),
  ],
};

/** Every column available at a level: dimensions first, then all four metric columns. */
const REFERENCE_WIDTHS: Readonly<Record<string, number>> = { targeting: 196, signals: 140, bid: 58, suggested_bid: 76, top_of_search_share: 84, organic_rank: 72, sqp_impression_share: 72, sqp_purchase_share: 74, spend: 76, acos: 56, clicks: 60, verdict: 160 };

export function columnsFor(level: EntityLevel): GridColumn[] {
  return [...(DIMENSIONS[level] ?? []), ...allMetricColumns(), ...(level === 'targets' ? TARGET_PERFORMANCE_COLUMNS : [])].map((column) => ({ ...column,
    ...(level === 'targets' && TARGET_FULL_COLUMNS.some((id) => id === column.id) ? { referenceOrder: TARGET_FULL_COLUMNS.findIndex((id) => id === column.id) } : {}),
    ...(level === 'targets' && REFERENCE_WIDTHS[column.id] !== undefined ? { width: REFERENCE_WIDTHS[column.id]!, minWidth: Math.min(40, REFERENCE_WIDTHS[column.id]!) } : {}),
    subject: column.subject ?? (column.kind === 'metric' || ['bid', 'suggested_bid', 'max_potential_cpc', 'diff_from_suggested_bid', 'bid_corridor_position'].includes(column.id) ? 'SPONSORED PRODUCTS' : 'Identity'),
  }));
}

const TARGET_PERFORMANCE_COLUMNS: GridColumn[] = [
  dimension('signals', 'SIGNALS', { width: 124, subject: 'Identity', description: 'R: organic rank; T: top-of-search impression share; I: SQP impression share; P: SQP purchase share. Dashed means not measured.' }),
  dimension('organic_rank', 'RANK', { scale: 'integer', align: 'right', subject: 'RANK & ORGANIC' }),
  dimension('rank_change', 'CHG', { scale: 'integer', align: 'right', subject: 'RANK & ORGANIC', description: 'Comparison rank minus current rank. Positive means improvement.' }),
  dimension('rank_grid', 'LAST 14 DAYS', { width: 252, subject: 'RANK & ORGANIC' }),
  dimension('break_even_bid', 'B/E BID', { scale: 'money', align: 'right', subject: 'SPONSORED PRODUCTS', description: 'Gross break-even bid = CPC ÷ ACOS. Does not account for margin, fees or tax.' }),
  dimension('top_of_search_share', 'TOS IS', { scale: 'percent', align: 'right', subject: 'SPONSORED PRODUCTS' }),
  dimension('top_of_search_range', 'LOW – HIGH', { width: 120, subject: 'SPONSORED PRODUCTS', description: 'Lowest and highest measured daily top-of-search impression share in the selected window.' }),
  dimension('spend_share', '% SPEND', { scale: 'percent', align: 'right', subject: 'SPONSORED PRODUCTS' }),
  dimension('acos_vs_target', 'ACOS vs TGT', { scale: 'integer', align: 'right', subject: 'SPONSORED PRODUCTS', description: 'ACOS minus resolved target, in percentage points.' }),
  dimension('sqp_impression_share', 'IMP SH', { scale: 'percent', align: 'right', subject: 'SQP' }),
  dimension('sqp_purchase_share', 'PURCH SH', { scale: 'percent', align: 'right', subject: 'SQP' }),
  dimension('market_cvr', 'MKT CVR', { scale: 'percent', align: 'right', subject: 'SQP' }),
  dimension('asin_cvr', 'ASIN CVR', { scale: 'percent', align: 'right', subject: 'SQP' }),
  dimension('conversion_points', 'CONV PTS', { scale: 'integer', align: 'right', subject: 'SQP', description: 'ASIN conversion rate minus market conversion rate, in percentage points.' }),
  dimension('search_frequency_rank', 'SFR', { scale: 'integer', align: 'right', subject: 'BRAND ANALYTICS' }),
  dimension('aba_rank', 'ABA RANK', { scale: 'integer', align: 'right', subject: 'BRAND ANALYTICS' }),
  dimension('aba_click_share', 'CLICK SH', { scale: 'percent', align: 'right', subject: 'BRAND ANALYTICS' }),
  dimension('aba_conversion_share', 'CONV SH', { scale: 'percent', align: 'right', subject: 'BRAND ANALYTICS' }),
  dimension('verdict', 'VERDICT', { width: 200, subject: 'Identity' }),
  dimension('translation', 'Translation', { width: 220, subject: 'Identity', description: 'Hidden by default. Original wording remains visible; use it when editing a target.' }),
];

export const TARGET_FULL_COLUMNS = ['targeting', 'match_type', 'signals', 'organic_rank', 'rank_change', 'rank_grid', 'bid', 'suggested_bid', 'break_even_bid', 'top_of_search_share', 'top_of_search_range', 'spend', 'spend_share', 'sales', 'cpc', 'acos', 'acos_vs_target', 'sqp_impression_share', 'sqp_purchase_share', 'market_cvr', 'asin_cvr', 'conversion_points', 'search_frequency_rank', 'aba_rank', 'aba_click_share', 'aba_conversion_share'] as const;

/**
 * What is visible before the operator touches anything.
 *
 * Value plus Δ% for the metrics that drive a decision, and no comparison or
 * absolute-delta columns: they exist, they are one click away in the column
 * picker, and putting all sixty on screen by default would make the grid
 * useless on the day it shipped.
 */
const DEFAULT_METRICS = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'ctr', 'cvr', 'cpc', 'acos', 'roas'];

export function defaultVisibleColumns(level: EntityLevel): string[] {
  if (level === 'targets') return ['targeting', 'signals', 'bid', 'suggested_bid', 'top_of_search_share', 'organic_rank', 'sqp_impression_share', 'sqp_purchase_share', 'spend', 'acos', 'clicks', 'verdict'];
  const dims = (DIMENSIONS[level] ?? []).filter((column) => column.pinned || isKeyDimension(level, column.id));
  const metrics = DEFAULT_METRICS.flatMap((key) => [key, `${key}${DELTA_PERCENT_SUFFIX}`]);
  return [...dims.map((column) => column.id), ...metrics];
}

function isKeyDimension(level: EntityLevel, id: string): boolean {
  const keys: Record<EntityLevel, readonly string[]> = {
    campaigns: ['campaign_state', 'ad_product', 'budget_amount'],
    ad_groups: ['ad_group_state', 'campaign_name', 'default_bid'],
    targets: [
      'target_state',
      'match_type',
      'bid',
      'suggested_bid',
      'bid_corridor_position',
      'max_potential_cpc',
      'diff_from_suggested_bid',
      'rpc_category',
      'campaign_name',
    ],
    search_terms: ['match_type', 'campaign_name', 'harvested'],
    products: ['product_name', 'gap'],
    placements: ['campaign_name', 'placement_modifier'],
  };
  return (keys[level] ?? []).includes(id);
}

/**
 * The state column each level filters on. Used to build the default
 * enabled-only view as a visible chip rather than a hidden exclusion.
 */
export const STATE_COLUMN: Partial<Record<EntityLevel, string>> = {
  campaigns: 'campaign_state',
  ad_groups: 'ad_group_state',
  targets: 'target_state',
};
