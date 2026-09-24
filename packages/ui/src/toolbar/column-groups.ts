/**
 * How the column picker groups and searches the sixty-odd columns a level
 * offers. Pure; no React.
 *
 * The recon (`https://github.com/Ecom-Wizards-Agency/openspell/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §3.0) records AdLabs' filter combobox as
 * "searchable and grouped by category with sticky group headers". A flat
 * checklist of sixty entries is the alternative, and it is the reason the
 * comparison and delta columns went unused: nobody scrolls a wall of
 * checkboxes to find `ACOS (prev)`.
 */
import type { ColumnSubject, GridColumn } from '../columns.js';
import { COMPARISON_SUFFIX, DELTA_ABSOLUTE_SUFFIX, DELTA_PERCENT_SUFFIX, parseFieldId } from '../rows.js';

export interface ColumnGroup {
  id: ColumnSubject | 'dimensions' | 'metrics' | 'comparison' | 'delta_absolute' | 'delta_percent';
  label: string;
  columns: GridColumn[];
}

const GROUP_LABELS: Record<ColumnGroup['id'], string> = {
  Identity: 'Identity', 'RANK & ORGANIC': 'RANK & ORGANIC', 'SPONSORED PRODUCTS': 'SPONSORED PRODUCTS', SQP: 'SQP', 'BRAND ANALYTICS': 'BRAND ANALYTICS',
  dimensions: 'Attributes',
  metrics: 'Metrics, selected period',
  comparison: 'Metrics, comparison period',
  delta_absolute: 'Change (Δ)',
  delta_percent: 'Change (Δ%)',
};

const ORDER: readonly ColumnGroup['id'][] = [
  'Identity', 'RANK & ORGANIC', 'SPONSORED PRODUCTS', 'SQP', 'BRAND ANALYTICS',
  'dimensions',
  'metrics',
  'comparison',
  'delta_absolute',
  'delta_percent',
];

function groupIdFor(column: GridColumn): ColumnGroup['id'] {
  if (column.subject !== undefined) return column.subject;
  if (column.kind === 'dimension' || parseFieldId(column.id) === null) return 'dimensions';
  if (column.id.endsWith(COMPARISON_SUFFIX)) return 'comparison';
  if (column.id.endsWith(DELTA_ABSOLUTE_SUFFIX)) return 'delta_absolute';
  if (column.id.endsWith(DELTA_PERCENT_SUFFIX)) return 'delta_percent';
  return 'metrics';
}

/** Non-empty groups in a fixed order; columns keep their incoming order within a group. */
export function groupColumns(available: readonly GridColumn[]): ColumnGroup[] {
  const buckets = new Map<ColumnGroup['id'], GridColumn[]>();
  for (const column of available) {
    const id = groupIdFor(column);
    const bucket = buckets.get(id);
    if (bucket === undefined) buckets.set(id, [column]);
    else bucket.push(column);
  }
  return ORDER.flatMap((id) => {
    const columns = buckets.get(id);
    return columns === undefined || columns.length === 0
      ? []
      : [{ id, label: GROUP_LABELS[id], columns }];
  });
}

/**
 * Case-insensitive match on header, id and description. Every word of the
 * query has to appear somewhere, so "acos prev" finds `ACOS (prev)` and not
 * every metric with a comparison column.
 */
export function searchColumns(columns: readonly GridColumn[], query: string): GridColumn[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return [...columns];
  return columns.filter((column) => {
    const haystack = `${column.header} ${column.id} ${column.description ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/**
 * The column manager's subjects, in reading order (V20). A flat list of every
 * column was the complaint: sixty metric columns in one "Ad performance" block.
 * Metrics are grouped by what they measure, and each metric's comparison
 * variants (previous period, change, change %) nest under it rather than
 * repeating the whole catalogue three more times.
 */
export const MANAGER_SUBJECTS = ['Identity', 'Delivery', 'Spend and bids', 'Sales', 'Efficiency', 'Rank', 'SQP & Brand Analytics', 'Comparison'] as const;
export type ManagerSubject = (typeof MANAGER_SUBJECTS)[number];

const METRIC_SUBJECTS: Readonly<Record<string, ManagerSubject>> = {
  impressions: 'Delivery', clicks: 'Delivery', ctr: 'Delivery',
  spend: 'Spend and bids', cpc: 'Spend and bids', cpm: 'Spend and bids',
  sales: 'Sales', orders: 'Sales', units: 'Sales', aov: 'Sales',
  acos: 'Efficiency', roas: 'Efficiency', cvr: 'Efficiency', cpa: 'Efficiency', rpc: 'Efficiency',
};

const DIMENSION_SUBJECTS: Readonly<Record<string, ManagerSubject>> = {
  top_of_search_share: 'Delivery', top_of_search_range: 'Delivery',
  bid: 'Spend and bids', suggested_bid: 'Spend and bids', max_potential_cpc: 'Spend and bids', break_even_bid: 'Spend and bids',
  budget_amount: 'Spend and bids', default_bid: 'Spend and bids', placement_modifier: 'Spend and bids', spend_share: 'Spend and bids',
  organic_rank: 'Rank', rank_grid: 'Rank',
  rank_change: 'Comparison', acos_vs_target: 'Comparison', diff_from_suggested_bid: 'Comparison', bid_corridor_position: 'Comparison', gap: 'Comparison',
};

/** The subject a column belongs to; a metric variant belongs where its metric does. */
export function managerSubject(column: GridColumn): ManagerSubject {
  const ref = parseFieldId(column.id);
  if (column.kind === 'metric' && ref !== null) return METRIC_SUBJECTS[ref.metric] ?? 'Efficiency';
  const known = DIMENSION_SUBJECTS[column.id];
  if (known !== undefined) return known;
  if (column.subject === 'SQP' || column.subject === 'BRAND ANALYTICS') return 'SQP & Brand Analytics';
  if (column.subject === 'RANK & ORGANIC') return 'Rank';
  return 'Identity';
}

/** Non-empty subjects in reading order; columns keep their incoming order within one. */
export function managerColumnGroups(columns: readonly GridColumn[]): Array<{ id: ManagerSubject; label: string; columns: GridColumn[] }> {
  return MANAGER_SUBJECTS
    .map((subject) => ({ id: subject, label: subject, columns: columns.filter((column) => managerSubject(column) === subject) }))
    .filter((group) => group.columns.length > 0);
}

export interface NestedColumn {
  column: GridColumn;
  /** The previous-period, change and change % columns of this metric, in that order. */
  variants: GridColumn[];
}

/**
 * A subject's columns with each metric's comparison variants folded under the
 * metric. A variant whose metric is not in the list (a search for "prev") stands
 * on its own, so nothing a search matched is hidden.
 */
export function nestColumnVariants(columns: readonly GridColumn[]): NestedColumn[] {
  const entries: NestedColumn[] = [];
  const byMetric = new Map<string, NestedColumn>();
  for (const column of columns) {
    const ref = parseFieldId(column.id);
    if (column.kind === 'metric' && ref?.part === 'value') {
      const entry = { column, variants: [] };
      byMetric.set(ref.metric, entry);
      entries.push(entry);
    }
  }
  for (const column of columns) {
    const ref = parseFieldId(column.id);
    if (column.kind === 'metric' && ref !== null && ref.part !== 'value') {
      const parent = byMetric.get(ref.metric);
      if (parent !== undefined) {
        parent.variants.push(column);
        continue;
      }
    }
    if (column.kind === 'metric' && ref?.part === 'value') continue;
    entries.push({ column, variants: [] });
  }
  const order = new Map(columns.map((column, index) => [column.id, index]));
  return entries.sort((left, right) => order.get(left.column.id)! - order.get(right.column.id)!);
}

/** The short name of a comparison variant under its metric; the full header stays its accessible name. */
export function variantLabel(column: GridColumn): string {
  const ref = parseFieldId(column.id);
  return ref?.part === 'comparison' ? 'Previous' : ref?.part === 'delta_absolute' ? 'Change' : ref?.part === 'delta_percent' ? 'Change %' : column.header;
}
