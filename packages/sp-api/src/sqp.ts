import {
  SqpIngestionCounts,
  SqpWeeklyFact,
  type QueryCategory,
  type SqpIngestionCounts as SqpIngestionCountsType,
  type SqpWeeklyFact as SqpWeeklyFactType,
} from '@wizard-ads/shared';
import { SpApiParseError } from './errors.js';
import type { CreateReportInput } from './types.js';

export const SQP_REPORT_TYPE = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT';
export const SQP_ASIN_OPTION_MAX_CHARS = 200;

export interface SqpReportRequestPlan {
  /** Stable for the marketplace, week and canonical ASIN batch. */
  requestKey: string;
  marketplaceId: string;
  weekStart: string;
  weekEnd: string;
  asins: string[];
  request: CreateReportInput;
}

function dateAtUtc(date: string): Date {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new SpApiParseError(`invalid calendar date: ${date}`);
  }
  return parsed;
}

export function assertWeeklyPeriod(weekStart: string, weekEnd: string): void {
  const start = dateAtUtc(weekStart);
  const end = dateAtUtc(weekEnd);
  if (start.getUTCDay() !== 0) throw new SpApiParseError('SQP week must start on Sunday');
  if (end.getUTCDay() !== 6) throw new SpApiParseError('SQP week must end on Saturday');
  if (end.valueOf() - start.valueOf() !== 6 * 86_400_000) {
    throw new SpApiParseError('SQP request must cover exactly one Sunday-Saturday week');
  }
}

export function batchSqpAsins(asins: readonly string[]): string[][] {
  const unique = [...new Set(asins.map(normalizeSqpAsin))].sort();
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const asin of unique) {
    if (asin.length > SQP_ASIN_OPTION_MAX_CHARS) {
      throw new SpApiParseError('one ASIN exceeds the SQP report-option character limit');
    }
    const nextLength = currentLength + (current.length === 0 ? 0 : 1) + asin.length;
    if (current.length > 0 && nextLength > SQP_ASIN_OPTION_MAX_CHARS) {
      batches.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(asin);
    currentLength += (current.length === 1 ? 0 : 1) + asin.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function normalizeSqpAsin(value: string): string {
  const asin = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) {
    throw new SpApiParseError('SQP ASIN must be ten letters or digits');
  }
  return asin;
}

export function buildSqpReportRequests(input: {
  marketplaceId: string;
  asins: readonly string[];
  weekStart: string;
  weekEnd: string;
}): CreateReportInput[] {
  assertWeeklyPeriod(input.weekStart, input.weekEnd);
  return batchSqpAsins(input.asins).map((batch) => ({
    reportType: SQP_REPORT_TYPE,
    marketplaceId: input.marketplaceId,
    // Reports v2021-06-30 requires RFC 3339 date-times. Keep the public
    // builder week-shaped, then expand the verified Sunday-Saturday period to
    // the complete UTC days only at the transport boundary.
    dataStartTime: `${input.weekStart}T00:00:00.000Z`,
    dataEndTime: `${input.weekEnd}T23:59:59.999Z`,
    reportOptions: { reportPeriod: 'WEEK', asin: batch.join(' ') },
  }));
}

export function planSqpReportRequests(input: {
  marketplaceId: string;
  asins: readonly string[];
  weekStart: string;
  weekEnd: string;
}): SqpReportRequestPlan[] {
  if (input.marketplaceId.trim().length === 0) {
    throw new SpApiParseError('SQP request requires one marketplace');
  }
  assertWeeklyPeriod(input.weekStart, input.weekEnd);
  const batches = batchSqpAsins(input.asins);
  if (batches.length === 0) throw new SpApiParseError('SQP request requires at least one ASIN');
  return batches.map((asins) => {
    const [request] = buildSqpReportRequests({ ...input, asins });
    if (!request) throw new SpApiParseError('SQP request planner produced no request');
    return {
      // This identity is persisted inside a Postgres jsonb checkpoint. JSONB
      // rejects U+0000 even when JSON.stringify escapes it, so use an encoded
      // tuple rather than the in-memory NUL separators used only for hashing.
      requestKey: JSON.stringify([
        input.marketplaceId,
        input.weekStart,
        input.weekEnd,
        asins.join(' '),
      ]),
      marketplaceId: input.marketplaceId,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      asins,
      request,
    };
  });
}

/**
 * Behaviour version of `parseSqpReport`. A dead `sqp.request` job whose rows
 * were refused records the version that refused them, so a release with a
 * different parser may offer that week once more (see the worker scheduler and
 * `sqp:requeue`). Version 1 passed share values through unchanged; version 2
 * resolves each share's unit against its own counts and refuses with fixed
 * reasons only.
 */
export const SQP_PARSER_VERSION = 2;

/** Largest absolute gap, on the 0..1 scale, between a share and its counts. */
const SHARE_TOLERANCE = 0.0051;

/**
 * A row refusal whose reason is built only from fixed text and Amazon or
 * contract field names. It never carries a row value, so it may reach a job
 * error, a checkpoint or a log line.
 */
class SqpRowRefusal extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'SqpRowRefusal';
  }
}

function refuse(reason: string): never {
  throw new SqpRowRefusal(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numeric(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    refuse(`SQP row has invalid ${key}`);
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = numeric(record, key);
  if (!Number.isInteger(value)) refuse(`SQP row has non-integer ${key}`);
  return value;
}

function nested(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) refuse(`SQP row has no ${key}`);
  return value;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    refuse(`SQP row has invalid ${key}`);
  }
  return value;
}

function normalizeQuery(query: string): string {
  return query.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ');
}

interface ShareBlock {
  block: string;
  totalKey: string;
  asinKey: string;
  shareKey: string;
}

const SHARE_BLOCKS = {
  impression: {
    block: 'impressionData',
    totalKey: 'totalQueryImpressionCount',
    asinKey: 'asinImpressionCount',
    shareKey: 'asinImpressionShare',
  },
  click: {
    block: 'clickData',
    totalKey: 'totalClickCount',
    asinKey: 'asinClickCount',
    shareKey: 'asinClickShare',
  },
  cartAdd: {
    block: 'cartAddData',
    totalKey: 'totalCartAddCount',
    asinKey: 'asinCartAddCount',
    shareKey: 'asinCartAddShare',
  },
  purchase: {
    block: 'purchaseData',
    totalKey: 'totalPurchaseCount',
    asinKey: 'asinPurchaseCount',
    shareKey: 'asinPurchaseShare',
  },
} as const satisfies Record<string, ShareBlock>;

interface ShareMeasure {
  total: number;
  asin: number;
  /** Canonical 0..1 fraction; `SqpWeeklyFact` and `fact_sqp_weekly` store fractions. */
  share: number;
}

/**
 * Read one funnel block and convert its share to the canonical fraction.
 *
 * Amazon's published schema describes each share as a fraction, while the
 * Brand Analytics screens show percentages. The share is redundant with its two
 * counts (asin / total), so the unit is checked per value against that
 * evidence rather than assumed: a value above 1 can only be a percentage; at or
 * below 1 either reading may agree. A value outside 0..100, a nonzero share of a
 * zero total, or a value that agrees with neither reading is refused. An
 * accepted share is stored as asin / total, so a rounded source value never
 * reaches the fact.
 */
function shareMeasure(row: Record<string, unknown>, spec: ShareBlock): ShareMeasure {
  const data = nested(row, spec.block);
  const total = integer(data, spec.totalKey);
  const asin = integer(data, spec.asinKey);
  if (asin > total) refuse(`SQP row ${spec.asinKey} exceeds ${spec.totalKey}`);
  const value = data[spec.shareKey];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    refuse(`SQP row has invalid ${spec.shareKey}`);
  }
  if (value < 0 || value > 100) refuse(`SQP row has out-of-range ${spec.shareKey}`);
  if (total === 0) {
    if (value !== 0) refuse(`SQP row has nonzero ${spec.shareKey} with zero ${spec.totalKey}`);
    return { total, asin, share: 0 };
  }
  const observed = asin / total;
  const asPercentage = value / 100;
  const percentageGap = Math.abs(asPercentage - observed);
  const fractionGap = value > 1 ? Number.POSITIVE_INFINITY : Math.abs(value - observed);
  if (Math.min(percentageGap, fractionGap) > SHARE_TOLERANCE) {
    refuse(`SQP row ${spec.shareKey} disagrees with ${spec.asinKey} and ${spec.totalKey}`);
  }
  return { total, asin, share: observed };
}

function contractRefusal(error: unknown): string | null {
  if (!(error instanceof Error) || error.name !== 'ZodError') return null;
  const issues = (error as Error & { issues?: unknown }).issues;
  const first = Array.isArray(issues) && isRecord(issues[0]) ? issues[0] : null;
  if (first === null) return 'SQP row failed the SqpWeeklyFact contract';
  // Paths name SqpWeeklyFact keys; codes are zod's fixed vocabulary.
  const path = Array.isArray(first['path'])
    ? first['path'].filter((part): part is string | number =>
        typeof part === 'string' || typeof part === 'number').join('.')
    : '';
  const code = typeof first['code'] === 'string' ? first['code'] : 'invalid';
  return `SQP row failed the SqpWeeklyFact contract at ${path || 'root'} (${code})`;
}

function parseRow(input: {
  row: Record<string, unknown>;
  profileId: string;
  marketplaceId: string;
  category: QueryCategory;
}): SqpWeeklyFactType {
  const search = nested(input.row, 'searchQueryData');
  const impression = shareMeasure(input.row, SHARE_BLOCKS.impression);
  const click = shareMeasure(input.row, SHARE_BLOCKS.click);
  const cart = shareMeasure(input.row, SHARE_BLOCKS.cartAdd);
  const purchase = shareMeasure(input.row, SHARE_BLOCKS.purchase);
  const searchQuery = text(search, 'searchQuery');
  const weekStart = text(input.row, 'startDate');
  const weekEnd = text(input.row, 'endDate');
  const rawAsin = text(input.row, 'asin');
  let asin: string;
  try {
    asin = normalizeSqpAsin(rawAsin);
  } catch {
    refuse('SQP row asin is not ten letters or digits');
  }
  try {
    assertWeeklyPeriod(weekStart, weekEnd);
  } catch {
    refuse('SQP row startDate and endDate are not one Sunday-Saturday week');
  }
  const searchQueryScore =
    search['searchQueryScore'] === null || search['searchQueryScore'] === undefined
      ? null
      : numeric(search, 'searchQueryScore');
  const searchQueryVolume = integer(search, 'searchQueryVolume');

  try {
    return SqpWeeklyFact.parse({
      profileId: input.profileId,
      marketplaceId: input.marketplaceId,
      asin,
      weekStart,
      weekEnd,
      searchQuery,
      normalizedQuery: normalizeQuery(searchQuery),
      category: input.category,
      searchQueryScore,
      searchQueryVolume,
      totalImpressions: impression.total,
      asinImpressions: impression.asin,
      asinImpressionShare: impression.share,
      totalClicks: click.total,
      asinClicks: click.asin,
      asinClickShare: click.share,
      totalCartAdds: cart.total,
      asinCartAdds: cart.asin,
      asinCartAddShare: cart.share,
      totalPurchases: purchase.total,
      asinPurchases: purchase.asin,
      asinPurchaseShare: purchase.share,
    });
  } catch (error) {
    refuse(contractRefusal(error) ?? 'unknown parse error');
  }
}

/** Amazon field names the report schema defines for one `dataByAsin` row. */
const SQP_ROW_FIELDS: Readonly<Record<string, readonly string[] | null>> = {
  startDate: null,
  endDate: null,
  asin: null,
  searchQueryData: ['searchQuery', 'searchQueryScore', 'searchQueryVolume'],
  impressionData: ['totalQueryImpressionCount', 'asinImpressionCount', 'asinImpressionShare'],
  clickData: [
    'totalClickCount', 'totalClickRate', 'asinClickCount', 'asinClickShare',
    'totalMedianClickPrice', 'asinMedianClickPrice', 'totalSameDayShippingClickCount',
    'totalOneDayShippingClickCount', 'totalTwoDayShippingClickCount',
  ],
  cartAddData: [
    'totalCartAddCount', 'totalCartAddRate', 'asinCartAddCount', 'asinCartAddShare',
    'totalMedianCartAddPrice', 'asinMedianCartAddPrice', 'totalSameDayShippingCartAddCount',
    'totalOneDayShippingCartAddCount', 'totalTwoDayShippingCartAddCount',
  ],
  purchaseData: [
    'totalPurchaseCount', 'totalPurchaseRate', 'asinPurchaseCount', 'asinPurchaseShare',
    'totalMedianPurchasePrice', 'asinMedianPurchasePrice', 'totalSameDayShippingPurchaseCount',
    'totalOneDayShippingPurchaseCount', 'totalTwoDayShippingPurchaseCount',
  ],
};

/** Field paths this parser reads; absence of any one refuses the row. */
const SQP_PARSED_FIELDS: readonly string[] = [
  'startDate', 'endDate', 'asin',
  'searchQueryData.searchQuery', 'searchQueryData.searchQueryVolume',
  ...Object.values(SHARE_BLOCKS).flatMap((spec) =>
    [spec.totalKey, spec.asinKey, spec.shareKey].map((key) => `${spec.block}.${key}`)),
];

/**
 * Field names of one refused source row, for reading a schema drift. Only names
 * from the published schema are rendered; any other key is counted, never
 * named, because an unknown key could itself be report data. No value is read.
 */
export interface SqpRefusalFieldSample {
  /** Index of the first refused row in its `dataByAsin` array. */
  index: number;
  rowIsObject: boolean;
  /** Schema field paths present on the row (for example `clickData.asinClickShare`). */
  presentFields: string[];
  /** Field paths this parser reads that the row lacks. */
  missingFields: string[];
  /** Keys outside the published schema; counted only. */
  unrecognizedFieldCount: number;
}

function fieldSample(index: number, row: unknown): SqpRefusalFieldSample {
  if (!isRecord(row)) {
    return {
      index,
      rowIsObject: false,
      presentFields: [],
      missingFields: [...SQP_PARSED_FIELDS],
      unrecognizedFieldCount: 0,
    };
  }
  const present: string[] = [];
  let unrecognized = 0;
  for (const key of Object.keys(row)) {
    const children = Object.hasOwn(SQP_ROW_FIELDS, key) ? SQP_ROW_FIELDS[key] : undefined;
    if (children === undefined) {
      unrecognized += 1;
      continue;
    }
    present.push(key);
    const value = row[key];
    if (children === null || !isRecord(value)) continue;
    for (const child of Object.keys(value)) {
      if (children.includes(child)) present.push(`${key}.${child}`);
      else unrecognized += 1;
    }
  }
  const presentSet = new Set(present);
  return {
    index,
    rowIsObject: true,
    presentFields: present.sort(),
    missingFields: SQP_PARSED_FIELDS.filter((field) => !presentSet.has(field)),
    unrecognizedFieldCount: unrecognized,
  };
}

export interface ParsedSqpReport {
  rows: SqpWeeklyFactType[];
  counts: SqpIngestionCountsType;
  /** Reasons are fixed text plus field names; no row value is ever included. */
  refused: Array<{ index: number; reason: string }>;
  /** Field names of the lowest-index refused row; null when nothing was refused. */
  firstRefusedRow: SqpRefusalFieldSample | null;
}

export function parseSqpReport(
  document: unknown,
  context: {
    profileId: string;
    marketplaceId: string;
    category?: QueryCategory;
    expectedWeekStart?: string;
    expectedWeekEnd?: string;
    expectedAsins?: readonly string[];
  },
): ParsedSqpReport {
  if (!isRecord(document) || !Array.isArray(document['dataByAsin'])) {
    throw new SpApiParseError('SQP document has no dataByAsin array');
  }
  const source = document['dataByAsin'];
  const candidates: Array<{ index: number; row: SqpWeeklyFactType }> = [];
  const refused: Array<{ index: number; reason: string }> = [];
  const expectedAsins = context.expectedAsins === undefined
    ? undefined
    : new Set(context.expectedAsins.map(normalizeSqpAsin));

  source.forEach((candidate, index) => {
    if (!isRecord(candidate)) {
      refused.push({ index, reason: 'row is not an object' });
      return;
    }
    try {
      const row = parseRow({
          row: candidate,
          profileId: context.profileId,
          marketplaceId: context.marketplaceId,
          category: context.category ?? 'unreviewed',
        });
      if (
        (context.expectedWeekStart !== undefined && row.weekStart !== context.expectedWeekStart) ||
        (context.expectedWeekEnd !== undefined && row.weekEnd !== context.expectedWeekEnd)
      ) {
        refuse('SQP row is outside the requested week');
      }
      if (expectedAsins !== undefined && !expectedAsins.has(row.asin)) {
        refuse('SQP row returned an unrequested ASIN');
      }
      candidates.push({ index, row });
    } catch (error) {
      // Only a fixed refusal reason is kept. Any other message could quote a
      // row value, so it collapses to one fixed string.
      refused.push({
        index,
        reason: error instanceof SqpRowRefusal ? error.reason : 'unknown parse error',
      });
    }
  });

  const grouped = new Map<string, Array<{ index: number; row: SqpWeeklyFactType }>>();
  for (const candidate of candidates) {
    const key = [
      candidate.row.marketplaceId,
      candidate.row.asin,
      candidate.row.weekStart,
      candidate.row.normalizedQuery,
    ].join('\u0000');
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }
  const rows: SqpWeeklyFactType[] = [];
  let conflictingRows = 0;
  for (const group of grouped.values()) {
    const first = group[0];
    if (!first) continue;
    if (group.every((candidate) => sameFact(first.row, candidate.row))) {
      rows.push(first.row);
      continue;
    }
    conflictingRows += group.length;
    refused.push(...group.map(({ index }) => ({
      index,
      reason: 'conflicting duplicate normalized SQP grain',
    })));
  }
  const counts = SqpIngestionCounts.parse({
    sourceAsins: new Set(source.filter(isRecord).map((row) => row['asin']).filter((value): value is string => typeof value === 'string')).size,
    sourceRows: source.length,
    parsedRows: candidates.length - conflictingRows,
    deduplicatedRows: rows.length,
    refusedRows: refused.length,
    upserts: rows.length,
  });
  if (counts.parsedRows + counts.refusedRows !== counts.sourceRows) {
    throw new SpApiParseError('SQP row reconciliation failed');
  }
  const firstIndex = refused.reduce<number | null>(
    (lowest, entry) => lowest === null || entry.index < lowest ? entry.index : lowest,
    null,
  );
  return {
    rows,
    counts,
    refused,
    firstRefusedRow: firstIndex === null ? null : fieldSample(firstIndex, source[firstIndex]),
  };
}

function sameFact(left: SqpWeeklyFactType, right: SqpWeeklyFactType): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The most distinct refusal reasons a summary names. */
export const SQP_REFUSAL_SUMMARY_REASONS = 5;

/** Value-free account of why a set of SQP reports could not be promoted. */
export interface SqpRefusalSummary {
  parserVersion: number;
  sourceRows: number;
  refusedRows: number;
  distinctReasons: number;
  /** Up to five reasons, most frequent first, then alphabetical. */
  topReasons: Array<{ reason: string; count: number }>;
  firstRefusedRow: SqpRefusalFieldSample | null;
}

/** Summarize the refusals of one or more parsed reports, in report order. */
export function summarizeSqpRefusals(reports: readonly ParsedSqpReport[]): SqpRefusalSummary {
  const tally = new Map<string, number>();
  let sourceRows = 0;
  let refusedRows = 0;
  let firstRefusedRow: SqpRefusalFieldSample | null = null;
  for (const report of reports) {
    sourceRows += report.counts.sourceRows;
    refusedRows += report.counts.refusedRows;
    for (const { reason } of report.refused) tally.set(reason, (tally.get(reason) ?? 0) + 1);
    firstRefusedRow ??= report.firstRefusedRow;
  }
  const ranked = [...tally.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason));
  return {
    parserVersion: SQP_PARSER_VERSION,
    sourceRows,
    refusedRows,
    distinctReasons: ranked.length,
    topReasons: ranked.slice(0, SQP_REFUSAL_SUMMARY_REASONS),
    firstRefusedRow,
  };
}

/** One line for a job error or log: counts, top reasons, and field names only. */
export function formatSqpRefusalSummary(summary: SqpRefusalSummary): string {
  const reasons = summary.topReasons.map(({ reason, count }) => `${reason} x${count}`).join('; ');
  const more = summary.distinctReasons > summary.topReasons.length
    ? `; ${summary.distinctReasons - summary.topReasons.length} more distinct reasons`
    : '';
  const sample = summary.firstRefusedRow;
  let fields = '';
  if (sample !== null && !sample.rowIsObject) {
    fields = '; first refused row is not an object';
  } else if (sample !== null) {
    fields = `; first refused row: missing [${sample.missingFields.join(', ')}], ` +
      `${sample.presentFields.length} schema fields present, ` +
      `${sample.unrecognizedFieldCount} unrecognized`;
  }
  return `parser v${summary.parserVersion} refused ${summary.refusedRows} of ${summary.sourceRows} rows: ` +
    `${reasons}${more}${fields}`;
}
