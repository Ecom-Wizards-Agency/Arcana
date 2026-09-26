/**
 * Stored codes to words, for the columns whose values are Amazon's vocabulary.
 *
 * The grid keeps the code as the value: filters, saved views, grouping keys
 * and sorting all carry `close_match`, because that is what the data and a
 * shared link say. Only what is drawn or exported to CSV goes through here, and the words come from
 * the one mapping in `@wizard-ads/shared`, so a cell, a group header, a filter
 * option and a filter chip can never name the same value differently.
 */
import { describeTargeting, matchTypeLabel, placementLabel, targetKindLabel } from '@wizard-ads/shared';
import type { GridColumn } from './columns.js';
import type { DimensionValue, GridRow } from './rows.js';

/** Which shared vocabulary a column's stored values belong to. */
export type ValueVocabulary = 'match_type' | 'placement' | 'target_kind' | 'targeting';

/**
 * The value as the operator should read it. Non-text values and columns
 * without a vocabulary pass through unchanged; `row` supplies the target kind
 * that decides whether a target's text is a keyword or an expression.
 */
export function displayValue(
  column: Pick<GridColumn, 'labels'> | undefined,
  value: DimensionValue,
  row?: Pick<GridRow, 'dimensions'>,
): DimensionValue {
  if (column?.labels === undefined || typeof value !== 'string' || value.trim() === '') return value;
  const kind = row?.dimensions['target_kind'];
  switch (column.labels) {
    case 'match_type':
      return matchTypeLabel(value);
    case 'placement':
      return placementLabel(value);
    case 'target_kind': {
      const targeting = row?.dimensions['targeting'];
      return targetKindLabel(value, typeof targeting === 'string' ? targeting : null);
    }
    case 'targeting':
      return describeTargeting({ targeting: value, targetKind: typeof kind === 'string' ? kind : null }).label;
  }
}

/** A labeller for option lists and chips, or undefined when the column has no vocabulary. */
export function valueLabeller(column: Pick<GridColumn, 'labels'> | undefined): ((value: string) => string) | undefined {
  if (column?.labels === undefined) return undefined;
  return (value) => {
    const shown = displayValue(column, value);
    return typeof shown === 'string' ? shown : value;
  };
}
