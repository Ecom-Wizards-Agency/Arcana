/**
 * Which filter operators a column accepts, how they read, and how a filter
 * describes itself on a chip. Pure; no React.
 */
import type { GridColumn } from '../columns.js';
import { filterKindForColumn } from '../columns.js';
import type { Filter, FilterOperator } from '../filter.js';
import { filterKeyToColumnId } from '../filter.js';
import { metricSpec } from '../metrics.js';
import { parseFieldId } from '../rows.js';

const NUMERIC_OPERATORS: readonly FilterOperator[] = ['>', '>=', '<', '<=', '=', '<>'];
const TEXT_OPERATORS: readonly FilterOperator[] = ['LIKE', 'NOT_LIKE', '=', '<>'];
const CATEGORICAL_OPERATORS: readonly FilterOperator[] = ['IN', 'NOT_IN'];

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  LIKE: 'contains',
  NOT_LIKE: 'does not contain',
  '=': 'equals',
  '<>': 'does not equal',
  IN: 'is one of',
  NOT_IN: 'is not one of',
  '>': 'greater than',
  '>=': 'at least',
  '<': 'less than',
  '<=': 'at most',
  IS_NULL: 'is empty',
  IS_NOT_NULL: 'is not empty',
};

/**
 * Which operators a column accepts.
 *
 * Numeric and text columns take disjoint operator sets, so the operator control
 * has to be re-derived when the column changes -- and the draft operator has to
 * be *coerced* into the new set, not merely re-rendered. A `<select>` whose
 * `value` is absent from its options renders the first option while the state
 * behind it still holds the old one, so the toolbar silently submits `SEARCH_TERM > x`
 * while showing `LIKE`. Found by driving the real UI; it threw a `FilterError`
 * from inside render and blanked the page.
 */
export function operatorsFor(column: GridColumn | undefined): readonly FilterOperator[] {
  if (column === undefined) return TEXT_OPERATORS;
  const kind = filterKindForColumn(column);
  if (kind === 'numeric') return NUMERIC_OPERATORS;
  if (kind === 'categorical') return CATEGORICAL_OPERATORS;
  return TEXT_OPERATORS;
}

/** Human-readable chip text. Percent metrics read as percents, as typed. */
export function describeFilter(filter: Filter, columns: readonly GridColumn[] = []): string {
  const columnId = filterKeyToColumnId(filter.key);
  const column = columns.find((candidate) => candidate.id === columnId);
  const ref = parseFieldId(columnId);
  const spec = ref === null ? undefined : metricSpec(ref.metric);
  const unit = spec?.scale === 'percent' || ref?.part === 'delta_percent' ? '%' : '';
  const joiner = ` ${(filter.logical_operator ?? 'AND').toLowerCase()} `;
  const parts = filter.conditions.map((condition) => {
    const shown = condition.values.slice(0, 3).join(', ');
    const remaining = Math.max(0, condition.values.length - 3);
    const summary = `${shown}${remaining === 0 ? '' : ` +${remaining} more`}`;
    return `${OPERATOR_LABELS[condition.operator ?? '=']} ${summary}${unit}`;
  });
  return `${column?.header ?? filter.key} ${parts.join(joiner)}`;
}
