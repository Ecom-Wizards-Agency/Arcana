/**
 * Tables whose row key is a date open on the latest day (V18).
 *
 * The loaders read facts in date order because the charts plot left to right;
 * a table read that way starts with the oldest day, which is the one an
 * operator checking yesterday's spend looks at last. Charts keep their order;
 * only tables go through here. The sort is stable, so rows sharing a date keep
 * the loader's order.
 */
export function newestFirst<T extends { date: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => right.date.localeCompare(left.date));
}
