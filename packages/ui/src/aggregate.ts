/**
 * Group-by, and the grand total.
 *
 * The whole reason this module exists is stated in `metrics.ts`: base metrics
 * are summed, ratios are rebuilt from those sums, and there is no code path
 * that averages a ratio because a ratio is never stored anywhere to average.
 * A grouped row is a `GridRow` like any other -- same shape, same resolver, same
 * cells -- so the grid does not need a second rendering path for totals, and a
 * bug in group-by arithmetic would show up in the ungrouped grid too.
 *
 * Currency is a correctness property, not a formatting one. `assertSingleCurrency`
 * throws rather than summing across profiles: v1 has no FX layer, and a EUR
 * figure quietly added to a USD one is the kind of wrong number that survives
 * three client calls before anybody catches it.
 */
import type { BaseMetric } from './metrics.js';
import { addTotals, emptyTotals, BASE_METRICS } from './metrics.js';
import type { DimensionValue, GridRow } from './rows.js';
import { resolveField } from './rows.js';

export type AggregateWindow = 'current' | 'comparison';

/**
 * Whether a row has facts in a window: the comparison window when it carries
 * comparison sums, the selected window unless the row is marked `unreported`
 * (listed only for its comparison or catalogue entry, WP-321).
 *
 * This is the reporting-rows rule the summary strip uses, and every aggregate in
 * this module follows it: a group subtotal and the grand total sum the rows
 * that reported in a window, and only those rows can make a base unknown. A
 * member that did not report is not a member with an unknown figure; under the
 * old union rule one campaign without comparison facts blanked the comparison
 * of its whole group.
 */
export function reportedIn(row: GridRow, window: AggregateWindow): boolean {
  if (window === 'comparison') return row.comparison !== null;
  const measurement: object | undefined = row.measurement;
  return !(measurement !== undefined && 'unreported' in measurement && measurement.unreported === true);
}

/** Per-window bookkeeping for one aggregate while its rows are folded in. */
interface WindowTally {
  reported: number;
  missing: Set<BaseMetric>;
}
interface MeasurementTally {
  current: WindowTally;
  comparison: WindowTally;
}

function emptyTally(): MeasurementTally {
  return { current: { reported: 0, missing: new Set() }, comparison: { reported: 0, missing: new Set() } };
}

/**
 * Fold one row into an aggregate under the reporting-rows rule: its sums count
 * in a window only when it reported there, and so do its missing bases.
 */
function foldRow(into: Pick<GridRow, 'totals' | 'comparison'>, tally: MeasurementTally, row: GridRow): void {
  if (reportedIn(row, 'current')) {
    tally.current.reported += 1;
    for (const key of row.measurement?.missing ?? []) tally.current.missing.add(key);
    addTotals(into.totals, row.totals);
  }
  if (row.comparison !== null) {
    tally.comparison.reported += 1;
    for (const key of row.measurement?.comparisonMissing ?? []) tally.comparison.missing.add(key);
    if (into.comparison === null) into.comparison = emptyTotals();
    addTotals(into.comparison, row.comparison);
  }
}

/**
 * The aggregate's measurement. A window no member reported in has no figure at
 * all: every current base is missing (the comparison is already null). An
 * aggregate never presents an incomplete base as a complete total.
 */
function measurementOf(tally: MeasurementTally): Pick<GridRow, 'measurement'> {
  const missing = tally.current.reported === 0 ? [...BASE_METRICS] : BASE_METRICS.filter((key) => tally.current.missing.has(key));
  const comparisonMissing = BASE_METRICS.filter((key) => tally.comparison.missing.has(key));
  return missing.length === 0 && comparisonMissing.length === 0 ? {} : { measurement: { missing, comparisonMissing } };
}

function applyMeasurement(row: GridRow, tally: MeasurementTally): void {
  const { measurement } = measurementOf(tally);
  if (measurement === undefined) delete row.measurement;
  else row.measurement = measurement;
}

export class MixedCurrencyError extends Error {
  constructor(readonly currencies: readonly string[]) {
    super(
      `refusing to aggregate across currencies (${currencies.join(', ')}). ` +
        'v1 renders a single profile in its own currency; there is no conversion layer, ' +
        'and a summed total across two currencies is a wrong number that looks right.',
    );
    this.name = 'MixedCurrencyError';
  }
}

/** The one currency in play, or a throw. Empty input is null, not an error. */
export function assertSingleCurrency(rows: readonly GridRow[]): string | null {
  let seen: string | null = null;
  for (const row of rows) {
    if (seen === null) seen = row.currencyCode;
    else if (seen !== row.currencyCode) {
      const all = [...new Set(rows.map((r) => r.currencyCode))].sort();
      throw new MixedCurrencyError(all);
    }
  }
  return seen;
}

/** Remove repeated levels while preserving the operator's requested order. */
export function uniqueGroupLevels(columnIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const levels: string[] = [];
  for (const columnId of columnIds) {
    if (columnId === '' || seen.has(columnId)) continue;
    seen.add(columnId);
    levels.push(columnId);
  }
  return levels;
}

/**
 * A length-prefixed, typed key. Delimiters alone are not sufficient because a
 * customer-authored campaign name may contain any printable character (and
 * imports can contain control characters). The key is used in a Map; the URI
 * encoded form is exposed as the stable virtual-row identity.
 */
function dimensionKey(columnId: string, value: DimensionValue): string {
  const encodedValue =
    value === null
      ? 'null'
      : typeof value === 'string'
        ? `string:${value}`
        : `${typeof value}:${String(value)}`;
  return `${columnId.length}:${columnId}${encodedValue.length}:${encodedValue}`;
}

export interface GroupPathPart {
  columnId: string;
  value: DimensionValue;
}

export interface GroupedRow extends GridRow {
  /** How many source rows folded into this one. Shown in the grid. */
  groupSize: number;
  /** The columns that defined the group, in order. */
  groupBy: readonly string[];
  /** Zero-based level in the rendered hierarchy. */
  groupDepth: number;
  /** The dimension represented by this row. */
  groupColumnId: string;
  /** Ordered dimension/value path from the root to this row. */
  groupPath: readonly GroupPathPart[];
  /** Null only for a root group. */
  parentGroupId: string | null;
  /** True when this row is at the deepest requested grouping level. */
  isLeafGroup: boolean;
}

export function isGroupedRow(row: GridRow): row is GroupedRow {
  return 'groupSize' in row;
}

/**
 * Fold rows into an ordered, depth-first hierarchy.
 *
 * Dimension columns that are not part of the group key are dropped rather than
 * taking an arbitrary row's value: showing one campaign's bid on a row that
 * aggregates four hundred targets is worse than showing nothing. Only the group
 * key survives, plus tag ids, which are a union (a group is tagged with every
 * tag any member carries).
 */
export function groupRows(rows: readonly GridRow[], columnIds: readonly string[]): GroupedRow[] {
  const levels = uniqueGroupLevels(columnIds);
  if (levels.length === 0) return [];

  // The common operator path is one grouping dimension. Avoid constructing a
  // hierarchy index and path arrays for 50k source rows when every bucket is a
  // root and a leaf. Multi-level grouping keeps the general tree path below.
  if (levels.length === 1) return groupRowsSingleLevel(rows, levels[0] as string, levels);

  const buckets = new Map<string, GroupedRow>();
  const children = new Map<string, GroupedRow[]>();
  const tagSets = new Map<string, Set<string>>();
  const tallies = new Map<GroupedRow, MeasurementTally>();
  let currency: string | null = null;

  for (const row of rows) {
    if (currency === null) currency = row.currencyCode;
    else if (currency !== row.currencyCode) {
      throw new MixedCurrencyError([currency, row.currencyCode].sort());
    }
    let pathKey = '';
    let parentGroupId: string | null = null;
    const dimensions: Record<string, DimensionValue> = {};
    const groupPath: GroupPathPart[] = [];

    for (let depth = 0; depth < levels.length; depth += 1) {
      const columnId = levels[depth] as string;
      const value = resolveField(row, columnId);
      dimensions[columnId] = value;
      groupPath.push({ columnId, value });
      pathKey += dimensionKey(columnId, value);

      let bucket = buckets.get(pathKey);
      if (bucket === undefined) {
        const id = `group:${encodeURIComponent(pathKey)}`;
        bucket = {
          id,
          dimensions: { ...dimensions },
          totals: emptyTotals(),
          comparison: null,
          currencyCode: row.currencyCode,
          groupSize: 0,
          groupBy: levels,
          groupDepth: depth,
          groupColumnId: columnId,
          groupPath: [...groupPath],
          parentGroupId,
          isLeafGroup: depth === levels.length - 1,
        };
        buckets.set(pathKey, bucket);
        tagSets.set(pathKey, new Set());
        const parentKey = parentGroupId ?? '';
        const siblings = children.get(parentKey);
        if (siblings === undefined) children.set(parentKey, [bucket]);
        else siblings.push(bucket);
      }

      let tally = tallies.get(bucket);
      if (tally === undefined) {
        tally = emptyTally();
        tallies.set(bucket, tally);
      }
      foldRow(bucket, tally, row);
      bucket.groupSize += 1;
      const tags = tagSets.get(pathKey);
      if (tags !== undefined) for (const tagId of row.tagIds ?? []) tags.add(tagId);
      parentGroupId = bucket.id;
    }
  }

  for (const [key, bucket] of buckets) {
    const tags = tagSets.get(key);
    if (tags !== undefined && tags.size > 0) bucket.tagIds = [...tags].sort();
    applyMeasurement(bucket, tallies.get(bucket) ?? emptyTally());
  }

  const out: GroupedRow[] = [];
  const append = (parentGroupId: string | null): void => {
    for (const child of children.get(parentGroupId ?? '') ?? []) {
      out.push(child);
      append(child.id);
    }
  };
  append(null);
  return out;
}

function groupRowsSingleLevel(
  rows: readonly GridRow[],
  columnId: string,
  groupBy: readonly string[],
): GroupedRow[] {
  const buckets = new Map<string, GroupedRow>();
  const tagSets = new Map<string, Set<string>>();
  const tallies = new Map<GroupedRow, MeasurementTally>();
  let currency: string | null = null;

  for (const row of rows) {
    if (currency === null) currency = row.currencyCode;
    else if (currency !== row.currencyCode) {
      throw new MixedCurrencyError([currency, row.currencyCode].sort());
    }

    const value = resolveField(row, columnId);
    const key = dimensionKey(columnId, value);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = {
        id: `group:${encodeURIComponent(key)}`,
        dimensions: { [columnId]: value },
        totals: emptyTotals(),
        comparison: null,
        currencyCode: row.currencyCode,
        groupSize: 0,
        groupBy,
        groupDepth: 0,
        groupColumnId: columnId,
        groupPath: [{ columnId, value }],
        parentGroupId: null,
        isLeafGroup: true,
      };
      buckets.set(key, bucket);
    }

    let tally = tallies.get(bucket);
    if (tally === undefined) {
      tally = emptyTally();
      tallies.set(bucket, tally);
    }
    foldRow(bucket, tally, row);
    bucket.groupSize += 1;
    if ((row.tagIds?.length ?? 0) > 0) {
      let tags = tagSets.get(key);
      if (tags === undefined) {
        tags = new Set<string>();
        tagSets.set(key, tags);
      }
      for (const tagId of row.tagIds ?? []) tags.add(tagId);
    }
  }

  const result = [...buckets.values()];
  for (const bucket of result) {
    const key = dimensionKey(columnId, bucket.groupPath[0]?.value ?? null);
    const tags = tagSets.get(key);
    if (tags !== undefined) bucket.tagIds = [...tags].sort();
    applyMeasurement(bucket, tallies.get(bucket) ?? emptyTally());
  }
  return result;
}

/**
 * One row summing everything shown. The grid pins it above the body, so the
 * number an operator quotes is the number the filter produced -- not a total of
 * a page they happen to be scrolled to. It follows the same reporting-rows rule
 * as the group subtotals, so a total always equals the sum of its groups.
 */
export function grandTotal(rows: readonly GridRow[], label = 'Total'): GroupedRow | null {
  if (rows.length === 0) return null;
  const sums: Pick<GridRow, 'totals' | 'comparison'> = { totals: emptyTotals(), comparison: null };
  const tally = emptyTally();
  let currency: string | null = null;

  for (const row of rows) {
    if (currency === null) currency = row.currencyCode;
    else if (currency !== row.currencyCode) {
      throw new MixedCurrencyError([currency, row.currencyCode].sort());
    }
    foldRow(sums, tally, row);
  }

  return {
    id: 'grand-total',
    ...measurementOf(tally),
    dimensions: { __total__: label },
    totals: sums.totals,
    comparison: sums.comparison,
    currencyCode: currency ?? '',
    groupSize: rows.length,
    groupBy: [],
    groupDepth: -1,
    groupColumnId: '__total__',
    groupPath: [],
    parentGroupId: null,
    isLeafGroup: true,
  };
}
