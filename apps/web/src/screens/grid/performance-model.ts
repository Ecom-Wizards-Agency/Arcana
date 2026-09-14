import { buildGridModelSafely, grandTotal, resolveField, type FilterSet, type GridModelResult, type GridQuery, type GridRow } from '@wizard-ads/ui';
import { shareOfSpend } from '@wizard-ads/core';

/** A quick chip replaces every selected verdict, retaining each non-verdict OR branch. */
export function verdictFilter(filter: FilterSet, diagnosis: string): FilterSet {
  return { groups: (filter.groups.length ? filter.groups : [{ filters: [] }]).map((group) => ({
    filters: [...group.filters.filter((item) => item.key !== 'VERDICT'), { key: 'VERDICT', conditions: [{ operator: '=' as const, values: [diagnosis] }] }],
  })) };
}

export function scopeRows(rows: readonly GridRow[], asin: string | null): readonly GridRow[] {
  return asin === null ? rows : rows.filter((row) => row.dimensions['asin'] === asin);
}

/** Shares use the measured spend of exactly the matched population, including verdict scope. */
export function buildPerformanceModel(rows: readonly GridRow[], query: GridQuery = {}): GridModelResult {
  // Share predicates are evaluated against the non-share population first;
  // the displayed shares are then rebased to the rows those predicates retain.
  const sourceCount = rows.length;
  const hasShareFilter = query.filter?.groups.some((group) => group.filters.some((filter) => filter.key === 'SPEND_SHARE'));
  if (hasShareFilter) {
    const nonShare = { groups: query.filter!.groups.map((group) => ({ filters: group.filters.filter((filter) => filter.key !== 'SPEND_SHARE') })) };
    const population = buildPerformanceModel(rows, { filter: nonShare }).model.matchedRows;
    rows = population;
  }
  const filtered = buildGridModelSafely(rows, { filter: query.filter });
  const total = grandTotal(filtered.model.matchedRows);
  const denominator = total === null ? null : resolveField(total, 'spend');
  const withShare = <T extends GridRow>(row: T): T => ({ ...row, dimensions: { ...row.dimensions,
    spend_share: shareOfSpend(resolveField(row, 'spend') as number | null, typeof denominator === 'number' ? denominator : null),
  } });
  const { filter: _filter, ...shape } = query;
  // For a measured denominator, group shares sort exactly as group spend.
  if (shape.groupBy?.length) shape.sort = shape.sort?.map((rule) => rule.columnId === 'spend_share' ? { ...rule, columnId: 'spend' } : rule);
  const result = buildGridModelSafely(filtered.model.matchedRows.map(withShare), shape);
  const shapedRows = result.model.rows.map(withShare);
  const byId = new Map(shapedRows.map((row) => [row.id, row]));
  return { filterError: filtered.filterError, model: { ...result.model, total: sourceCount,
    rows: shapedRows, exportRows: result.model.exportRows.map((row) => byId.get(row.id)!),
  } };
}
