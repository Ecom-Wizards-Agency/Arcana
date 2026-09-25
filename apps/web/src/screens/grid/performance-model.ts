import { buildGridModelSafely, resolveField, type FilterSet, type GridModelResult, type GridQuery, type GridRow } from '@wizard-ads/ui';
import { PerformanceVerdict, describeTargeting } from '@wizard-ads/shared';
import { shareOfSpend } from '@wizard-ads/core';
import { windowTotal } from './summary-model';

/** A quick chip replaces every selected verdict, retaining each non-verdict OR branch. */
export function verdictFilter(filter: FilterSet, diagnosis: string): FilterSet {
  const canonical = PerformanceVerdict.shape.diagnosis.options.find((value) => value.toLowerCase() === diagnosis.trim().toLowerCase());
  if (canonical === undefined) throw new Error('Unknown performance verdict');
  return { groups: (filter.groups.length ? filter.groups : [{ filters: [] }]).map((group) => ({
    filters: [...group.filters.filter((item) => item.key.trim().toUpperCase() !== 'VERDICT'), { key: 'VERDICT', conditions: [{ operator: '=' as const, values: [canonical] }] }],
  })) };
}

/**
 * The screen's working population: the ASIN scope, with the phrase each target
 * row carries for the Phrase column (WP-316, V19). The phrase is read from the
 * stored targeting text and kind through the shared targeting labels, so it
 * sorts, filters and exports like any other dimension; an automatic or product
 * target has none, and its cell stays empty rather than showing a code. Rows
 * that are not targets, or already carry a phrase, pass through untouched.
 */
export function scopeRows(rows: readonly GridRow[], asin: string | null): readonly GridRow[] {
  return withTargetPhrases(asin === null ? rows : rows.filter((row) => row.dimensions['asin'] === asin));
}

function needsPhrase(row: GridRow): boolean {
  return 'target_kind' in row.dimensions && 'targeting' in row.dimensions && !('target_phrase' in row.dimensions);
}

function withTargetPhrases(rows: readonly GridRow[]): readonly GridRow[] {
  if (!rows.some(needsPhrase)) return rows;
  return rows.map((row) => {
    if (!needsPhrase(row)) return row;
    const { targeting, target_kind: kind, match_type: matchType } = row.dimensions;
    const phrase = describeTargeting({
      targeting: typeof targeting === 'string' ? targeting : null,
      targetKind: typeof kind === 'string' ? kind : null,
      matchType: typeof matchType === 'string' ? matchType : null,
    }).phrase;
    return { ...row, dimensions: { ...row.dimensions, target_phrase: phrase } };
  });
}

function hasSpendShareFilter(filter: FilterSet | undefined): boolean {
  return filter?.groups.some((group) => group.filters.some((item) => item.key.trim().toUpperCase() === 'SPEND_SHARE')) ?? false;
}

/** Counts need no totals or row copies unless a share predicate needs a denominator. */
export function countPerformanceRows(rows: readonly GridRow[], filter: FilterSet): number {
  return hasSpendShareFilter(filter)
    ? buildPerformanceModel(rows, { filter }).model.matched
    : buildGridModelSafely(rows, { filter, totals: 'none' }).model.matched;
}

/** Shares use the measured spend of exactly the matched population, including verdict scope. */
export function buildPerformanceModel(rows: readonly GridRow[], query: GridQuery = {}): GridModelResult {
  // Share predicates are evaluated against the non-share population first;
  // the displayed shares are then rebased to the rows those predicates retain.
  const sourceCount = rows.length;
  const hasShareFilter = hasSpendShareFilter(query.filter);
  if (hasShareFilter) {
    const nonShare = { groups: query.filter!.groups.map((group) => ({ filters: group.filters.filter((filter) => filter.key.trim().toUpperCase() !== 'SPEND_SHARE') })) };
    const population = buildPerformanceModel(rows, { filter: nonShare }).model.matchedRows;
    rows = population;
  }
  const filtered = buildGridModelSafely(rows, { filter: query.filter, totals: 'none' });
  // The strip's window rule (WP-321): a row with no facts in the window adds
  // nothing, rather than making the whole denominator unknown.
  const total = windowTotal(filtered.model.matchedRows);
  const denominator = total === null ? null : resolveField(total, 'spend');
  const withShare = <T extends GridRow>(row: T): T => ({ ...row, dimensions: { ...row.dimensions,
    spend_share: shareOfSpend(resolveField(row, 'spend') as number | null, typeof denominator === 'number' ? denominator : null),
  } });
  const { filter: _filter, ...rest } = query;
  // The pinned total follows the same rule unless the caller chose its own totals.
  const shape: GridQuery = rest.totals === 'none' || rest.totals === 'custom' ? rest : { ...rest, totals: 'custom', customTotals: windowTotal };
  // For a measured denominator, group shares sort exactly as group spend.
  if (shape.groupBy?.length) shape.sort = shape.sort?.map((rule) => rule.columnId === 'spend_share' ? { ...rule, columnId: 'spend' } : rule);
  const result = buildGridModelSafely(filtered.model.matchedRows.map(withShare), shape);
  // Flat rows already have shares. Preserve their identity for the table and CSV.
  if (!result.model.grouped) return { filterError: filtered.filterError, model: { ...result.model, total: sourceCount } };
  const shapedRows = result.model.rows.map(withShare);
  const byId = new Map(shapedRows.map((row) => [row.id, row]));
  return { filterError: filtered.filterError, model: { ...result.model, total: sourceCount,
    rows: shapedRows, exportRows: result.model.exportRows.map((row) => byId.get(row.id)!),
  } };
}
