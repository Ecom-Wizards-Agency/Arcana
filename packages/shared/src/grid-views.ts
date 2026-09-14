import { z } from 'zod';
import { TimelineMeasure, TimelineEventKind } from './timeline-events.js';

export const TimelineViewState = z.object({
  mode: z.enum(['performance', 'organic', 'bsr']).default('performance'),
  hiddenKinds: z.array(TimelineEventKind).default([]),
  eventId: z.string().nullable().default(null),
  asin: z.string().default(''), keyword: z.string().default(''), category: z.string().default(''),
}).strict();
export type TimelineViewState = z.infer<typeof TimelineViewState>;

import { TranslationView } from './translation.js';
import { ChangeQueueSource, ChangeQueueState } from './time-machine.js';

const strings = z.array(z.string()).readonly();
/** Base-sum slots may be placeholders only when explicitly marked unmeasured. */
export const GridMeasurement = z.strictObject({
  missing: z.array(z.enum(['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'])),
  comparisonMissing: z.array(z.enum(['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'])),
});
export type GridMeasurement = z.infer<typeof GridMeasurement>;
const gridBases = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] as const;
type GridDimension = string | number | boolean | null;
const isGridDimension = (value: unknown): value is GridDimension => value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const gridDimension = z.custom<GridDimension>(isGridDimension, 'Grid dimensions must be text, finite numbers, booleans or null');

/** Validate primitive columns in one pass, without a parse context per scalar. */
function primitiveColumn<T>(accepts: (value: unknown) => value is T) {
  return z.custom<T[]>((values) => {
    if (!Array.isArray(values)) return false;
    // Index explicitly: Array.every would silently accept sparse holes.
    for (let index = 0; index < values.length; index++) if (!accepts(values[index])) return false;
    return true;
  }, 'Invalid grid column values').transform((values) => values.slice());
}
const metricColumn = primitiveColumn((value): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value)));
const gridTotals = z.strictObject({ impressions: z.number().finite(), clicks: z.number().finite(), spend: z.number().finite(), sales: z.number().finite(), orders: z.number().finite(), units: z.number().finite() });
export const GridTransportRow = z.strictObject({
  id: z.string(), currencyCode: z.string(), dimensions: z.record(z.string(), gridDimension),
  totals: gridTotals, comparison: gridTotals.nullable(), measurement: GridMeasurement.optional(), tagIds: z.array(z.string()).readonly().optional(),
});
export type GridTransportRow = z.infer<typeof GridTransportRow>;
const metricColumns = z.record(z.enum(gridBases), metricColumn);
/** Lossless columns: sparse metadata and absent dimension keys retain their row indexes. */
export const GridRowColumns = z.strictObject({
  version: z.literal(1), ids: z.array(z.string()), currency: z.union([z.string(), z.array(z.string())]),
  dimensions: z.record(z.string(), primitiveColumn(isGridDimension)), absent: z.record(z.string(), z.array(z.number().int().nonnegative())),
  totals: metricColumns, comparison: metricColumns,
  measurements: z.record(z.string(), GridMeasurement), tags: z.record(z.string(), z.array(z.string())),
}).superRefine((value, context) => {
  const count = value.ids.length;
  const error = (message: string) => context.addIssue({ code: 'custom', message });
  const arrays = [...Object.values(value.dimensions), ...Object.values(value.totals), ...Object.values(value.comparison)];
  if (arrays.some((column) => column.length !== count) || (Array.isArray(value.currency) && value.currency.length !== count)) error('Grid column lengths disagree');
  if (Object.values(value.totals).some((column) => column.some((number) => number === null))) error('Grid current base slots cannot be null');
  for (let index = 0; index < count; index++) {
    const missing = gridBases.filter((key) => value.comparison[key][index] === null).length;
    if (missing !== 0 && missing !== gridBases.length) error('Grid comparison must be present or wholly absent');
  }
  for (const [key, indexes] of Object.entries(value.absent)) {
    if (!(key in value.dimensions) || indexes.some((index) => index >= count)) error('Grid absent dimension index is invalid');
  }
  for (const key of [...Object.keys(value.measurements), ...Object.keys(value.tags)]) {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= count) error('Grid metadata index is invalid');
  }
});
export type GridRowColumns = z.infer<typeof GridRowColumns>;

export function encodeGridRowColumns(rows: readonly GridTransportRow[]): GridRowColumns {
  const keySet = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.dimensions)) keySet.add(key);
  const keys = [...keySet];
  const dimensions = Object.fromEntries(keys.map((key) => [key, [] as Array<string | number | boolean | null>]));
  const absent = Object.fromEntries(keys.map((key) => [key, [] as number[]]));
  const totals = Object.fromEntries(gridBases.map((key) => [key, [] as number[]])) as GridRowColumns['totals'];
  const comparison = Object.fromEntries(gridBases.map((key) => [key, [] as (number | null)[]])) as GridRowColumns['comparison'];
  const ids: string[] = [];
  const currencies: string[] = [];
  const measurements: GridRowColumns['measurements'] = {};
  const tags: GridRowColumns['tags'] = {};
  rows.forEach((row, index) => {
    ids.push(row.id);
    currencies.push(row.currencyCode);
    for (const key of keys) {
      dimensions[key]!.push(row.dimensions[key] ?? null);
      if (!Object.hasOwn(row.dimensions, key)) absent[key]!.push(index);
    }
    for (const key of gridBases) {
      totals[key].push(row.totals[key]);
      comparison[key].push(row.comparison?.[key] ?? null);
    }
    if (row.measurement !== undefined) measurements[String(index)] = row.measurement;
    if (row.tagIds !== undefined) tags[String(index)] = [...row.tagIds];
  });
  return {
    version: 1, ids, currency: new Set(currencies).size === 1 ? currencies[0]! : currencies,
    dimensions, absent: Object.fromEntries(Object.entries(absent).filter(([, indexes]) => indexes.length > 0)),
    totals, comparison, measurements, tags,
  };
}

export function decodeGridRowColumns(raw: unknown): GridTransportRow[] {
  const value = GridRowColumns.parse(raw);
  const absent = new Map(Object.entries(value.absent).map(([key, indexes]) => [key, new Set(indexes)]));
  const dimensionColumns = Object.entries(value.dimensions);
  const totalsAt = (columns: GridRowColumns['totals'], index: number): GridTransportRow['totals'] => ({
    impressions: columns.impressions[index]!, clicks: columns.clicks[index]!, spend: columns.spend[index]!,
    sales: columns.sales[index]!, orders: columns.orders[index]!, units: columns.units[index]!,
  });
  return value.ids.map((id, index) => {
    // Reuse the column index. Per-row entries/flatMap created several temporary
    // arrays for every dimension before the first viewport could be drawn.
    const dimensions: GridTransportRow['dimensions'] = {};
    for (const [key, values] of dimensionColumns) {
      if (absent.get(key)?.has(index)) continue;
      if (key === '__proto__') Object.defineProperty(dimensions, key, { value: values[index]!, enumerable: true, writable: true, configurable: true });
      else dimensions[key] = values[index]!;
    }
    return {
      id, currencyCode: typeof value.currency === 'string' ? value.currency : value.currency[index]!, dimensions,
      totals: totalsAt(value.totals, index),
      comparison: value.comparison.impressions[index] === null ? null : totalsAt(value.comparison, index),
      ...(value.measurements[String(index)] === undefined ? {} : { measurement: value.measurements[String(index)]! }),
      ...(value.tags[String(index)] === undefined ? {} : { tagIds: value.tags[String(index)]! }),
    };
  });
}

export const GridEntity = z.enum(['campaigns', 'ad_groups', 'targets', 'search_terms', 'products', 'placements']);
export const VerdictThresholds = z.strictObject({
  ownedRank: z.number().positive().nullable(),
  rankGap: z.number().positive().nullable(),
  targetAcos: z.number().nonnegative().nullable(),
});
export type VerdictThresholds = z.infer<typeof VerdictThresholds>;
export const VerdictEvidence = z.strictObject({
  clicks: z.number().nonnegative().nullable(), spend: z.number().nonnegative().nullable(),
  acos: z.number().nonnegative().nullable(), organicRank: z.number().positive().nullable(),
  topOfSearchShare: z.number().min(0).max(1).nullable(),
});
export type VerdictEvidence = z.infer<typeof VerdictEvidence>;
export const PerformanceVerdict = z.strictObject({
  diagnosis: z.enum(['Paying for rank we own', 'Rank gap', 'Ranked, unfunded', 'Efficient', 'Insufficient evidence']),
  reason: z.string().min(1),
});
export type PerformanceVerdict = z.infer<typeof PerformanceVerdict>;
export const GridFeedCoverage = z.strictObject({
  feed: z.enum(['PPC', 'RANK', 'SQP']), daysHeld: z.number().int().nonnegative(),
  daysRequested: z.number().int().nonnegative(), notScraped: z.number().int().nonnegative(),
  status: z.enum(['complete', 'partial', 'not-measured']), reason: z.string().min(1),
});
export type GridFeedCoverage = z.infer<typeof GridFeedCoverage>;
export const GridPerformanceEvidence = z.strictObject({
  feeds: z.array(GridFeedCoverage),
  unattributed: z.strictObject({ adGroups: z.number().int().nonnegative(), spend: z.number().nonnegative(), days: z.number().int().nonnegative() }).nullable(),
  rankDays: z.record(z.string(), z.array(z.strictObject({ date: z.string(), observed: z.boolean(), rank: z.number().int().positive().nullable() })).length(14)),
});
export type GridPerformanceEvidence = z.infer<typeof GridPerformanceEvidence>;
/** One date axis per response. null = unobserved; 0 = observed, never ranked. */
export const GridPerformanceTransport = GridPerformanceEvidence.omit({ rankDays: true }).extend({
  rankAxis: z.array(z.string()).length(14).or(z.tuple([])),
  rankValues: z.record(z.string(), primitiveColumn((value): value is number | null => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)).refine((values) => values.length === 14, 'Rank history must contain fourteen days')),
});
export type GridPerformanceTransport = z.infer<typeof GridPerformanceTransport>;

export function encodeGridPerformance(evidence: GridPerformanceEvidence): GridPerformanceTransport {
  const histories = Object.entries(evidence.rankDays).filter(([, days]) => days.some((day) => day.observed));
  const rankAxis = histories[0]?.[1].map((day) => day.date) ?? [];
  for (const [, days] of histories) {
    if (days.some((day, index) => day.date !== rankAxis[index])) throw new Error('Rank history date axes disagree');
  }
  return { feeds: evidence.feeds, unattributed: evidence.unattributed, rankAxis,
    rankValues: Object.fromEntries(histories.map(([id, days]) => [id, days.map((day) => day.observed ? day.rank ?? 0 : null)])) };
}

export function decodeGridPerformance(raw: unknown): GridPerformanceEvidence {
  // Accept domain fixtures and previously cached responses as well as compact transport.
  if (typeof raw === 'object' && raw !== null && 'rankDays' in raw) return GridPerformanceEvidence.parse(raw);
  const value = GridPerformanceTransport.parse(raw);
  if (Object.keys(value.rankValues).length && value.rankAxis.length !== 14) throw new Error('Rank history date axis is missing');
  const rankDays: GridPerformanceEvidence['rankDays'] = {};
  for (const [id, ranks] of Object.entries(value.rankValues)) {
    const store = (days: GridPerformanceEvidence['rankDays'][string]) => {
      Object.defineProperty(rankDays, id, { value: days, enumerable: true, configurable: true, writable: true });
      return days;
    };
    // Validate the complete payload above, then expand tiles on first read.
    // Scrolling to a rank column pays for its row's fourteen tiles once.
    Object.defineProperty(rankDays, id, { enumerable: true, configurable: true,
      get: () => store(ranks.map((rank, index) => ({ date: value.rankAxis[index]!, observed: rank !== null, rank: rank === 0 ? null : rank }))),
      set: store,
    });
  }
  return { feeds: value.feeds, unattributed: value.unattributed, rankDays };
}

export const GridSavedView = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  entity: GridEntity,
  columns: strings,
  pinned: strings,
  widths: z.record(z.string(), z.number().finite()).readonly(),
  density: z.enum(['compact', 'normal', 'comfortable']).optional(),
  filter: z.object({ groups: z.array(z.object({ filters: z.array(z.object({
    key: z.string(),
    logical_operator: z.enum(['AND', 'OR']).optional(),
    conditions: z.array(z.object({
      operator: z.enum(['>', '<', '>=', '<=', '=', '<>', 'IN', 'NOT_IN', 'LIKE', 'NOT_LIKE', 'IS_NULL', 'IS_NOT_NULL']).optional(),
      values: strings,
    }).strict()).readonly(),
  }).strict()).readonly() }).strict()).readonly() }).strict(),
  sort: z.array(z.object({ columnId: z.string(), direction: z.enum(['asc', 'desc']) }).strict()).readonly(),
  groupBy: strings,
  collapsedGroupIds: strings.optional(),
  dateRange: z.object({ start: z.string(), end: z.string() }).strict().nullable(),
  chartedMeasures: z.array(TimelineMeasure).min(1).max(4).refine((values) => new Set(values).size === values.length).optional(),
  timeline: TimelineViewState.optional(),
  chart: z.strictObject({ series: z.array(z.enum(['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc'])).max(4).refine((series) => new Set(series).size === series.length) }).optional(),
  translation: TranslationView.optional(),
  changeQueue: z.object({
    filters: z.object({ source: ChangeQueueSource.optional(), state: ChangeQueueState.optional(),
      type: z.string().max(200).optional(), field: z.string().max(200).optional() }).strict(),
    density: z.enum(['compact', 'normal', 'comfortable']),
  }).strict().optional(),
  /** Target detail state travels with the originating grid analysis. */
  target: z.object({
    series: z.object({
      bid: z.boolean(),
      realisedCpc: z.boolean(),
      suggestedBand: z.boolean(),
      maxCpc: z.boolean(),
      dailySpend: z.boolean(),
      acos: z.boolean(),
    }).strict(),
    maxCpcExpanded: z.boolean(),
    placementLines: z.record(z.string(), z.boolean()).optional(),
  }).strict().optional(),
  compare: z.array(z.object({
      profileId: z.uuid(),
      targetId: z.string().min(1).max(200),
    }).strict()).max(4).refine((targets) =>
      new Set(targets.map((target) => JSON.stringify([target.profileId, target.targetId]))).size === targets.length,
    'comparison targets must be unique').optional(),
  updatedAt: z.string(),
}).strict();
export type GridSavedView = z.infer<typeof GridSavedView>;

/** Version prefix plus UTF-8 base64url; independent of Node and safe in browsers. */
export function serializeGridView(view: GridSavedView): string {
  const bytes = new TextEncoder().encode(JSON.stringify(GridSavedView.parse(view)));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return `1.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function parseGridView(value: string | null | undefined): GridSavedView | null {
  if (!value || value.length > 64_000 || !/^1\.[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.slice(2).replaceAll('-', '+').replaceAll('_', '/'));
    const parsed = GridSavedView.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export const GridViewRecord = z.object({
  orgId: z.uuid(),
  profileId: z.uuid().nullable(),
  ownerId: z.uuid(),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  view: GridSavedView,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type GridViewRecord = z.infer<typeof GridViewRecord>;

export const GridViewSave = z.object({
  profileId: z.uuid().nullable(),
  views: z.array(GridSavedView).min(1).max(500),
}).strict();
