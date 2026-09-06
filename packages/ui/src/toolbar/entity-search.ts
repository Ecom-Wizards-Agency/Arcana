/**
 * The entity search box, as filter arithmetic. Pure; no React.
 *
 * AdLabs puts a free-text box at the left of every grid toolbar. Ours is not a
 * second filter mechanism: the text compiles to an ordinary `LIKE` filter on
 * the level's identity column (the pinned dimension -- campaign name, search
 * term, target), so it shows up as a chip, saves with the view and round-trips
 * through a deep link like every other filter. The box merely reads that one
 * filter back out so what it displays is what is applied.
 */
import type { GridColumn } from '../columns.js';
import type { Filter } from '../filter.js';
import { columnIdToFilterKey } from '../filter.js';

/** The column free text searches: the pinned dimension, else the first dimension. */
export function entitySearchColumn(available: readonly GridColumn[]): GridColumn | null {
  const dimensions = available.filter((column) => column.kind === 'dimension');
  return dimensions.find((column) => column.pinned === true) ?? dimensions[0] ?? null;
}

function isSearchFilter(filter: Filter, key: string): boolean {
  if (filter.key !== key || filter.conditions.length !== 1) return false;
  const condition = filter.conditions[0];
  return condition !== undefined && condition.operator === 'LIKE' && condition.values.length === 1;
}

/** The text the box should show for these filters, or '' when none applies. */
export function readEntitySearch(filters: readonly Filter[], column: GridColumn | null): string {
  if (column === null) return '';
  const key = columnIdToFilterKey(column.id);
  const match = filters.find((filter) => isSearchFilter(filter, key));
  return match?.conditions[0]?.values[0] ?? '';
}

/**
 * The filters with the search text applied: the existing search filter is
 * replaced in place (so its chip does not jump), removed when the text is
 * blank, or appended when there was none.
 */
export function writeEntitySearch(
  filters: readonly Filter[],
  column: GridColumn | null,
  text: string,
): Filter[] {
  if (column === null) return [...filters];
  const key = columnIdToFilterKey(column.id);
  const trimmed = text.trim();
  const index = filters.findIndex((filter) => isSearchFilter(filter, key));
  const next = filters.filter((filter, position) => position !== index || filter.key !== key);
  if (trimmed === '') return next;
  const replacement: Filter = { key, conditions: [{ operator: 'LIKE', values: [trimmed] }] };
  if (index < 0) return [...next, replacement];
  next.splice(index, 0, replacement);
  return next;
}
