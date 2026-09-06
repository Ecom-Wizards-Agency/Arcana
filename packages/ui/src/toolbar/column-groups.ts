/**
 * How the column picker groups and searches the sixty-odd columns a level
 * offers. Pure; no React.
 *
 * The recon (`02-data-grid.md` §3.0) records AdLabs' filter combobox as
 * "searchable and grouped by category with sticky group headers". A flat
 * checklist of sixty entries is the alternative, and it is the reason the
 * comparison and delta columns went unused: nobody scrolls a wall of
 * checkboxes to find `ACOS (prev)`.
 */
import type { GridColumn } from '../columns.js';
import { COMPARISON_SUFFIX, DELTA_ABSOLUTE_SUFFIX, DELTA_PERCENT_SUFFIX, parseFieldId } from '../rows.js';

export interface ColumnGroup {
  id: 'dimensions' | 'metrics' | 'comparison' | 'delta_absolute' | 'delta_percent';
  label: string;
  columns: GridColumn[];
}

const GROUP_LABELS: Record<ColumnGroup['id'], string> = {
  dimensions: 'Attributes',
  metrics: 'Metrics, selected period',
  comparison: 'Metrics, comparison period',
  delta_absolute: 'Change (Δ)',
  delta_percent: 'Change (Δ%)',
};

const ORDER: readonly ColumnGroup['id'][] = [
  'dimensions',
  'metrics',
  'comparison',
  'delta_absolute',
  'delta_percent',
];

function groupIdFor(column: GridColumn): ColumnGroup['id'] {
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
