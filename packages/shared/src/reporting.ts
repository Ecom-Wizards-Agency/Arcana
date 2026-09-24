/** Historical coverage, safe promotion, and attribution revision contracts. */
import { z } from 'zod';
import { AdProduct, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative();

/**
 * WP-324: the days completed loads actually returned, read from a coverage row's
 * verified span (its earliest returned day through its newest held day, minus
 * the days no load returned). `gapDays` counts those unreturned days inside it.
 */
export const VerifiedCoverageSpan = z.object({
  from: IsoDate,
  through: IsoDate,
  daysHeld: count.positive(),
  gapDays: count,
}).refine((span) => span.from <= span.through, 'verified span dates do not reconcile');
export type VerifiedCoverageSpan = z.infer<typeof VerifiedCoverageSpan>;

/** Source-neutral freshness evidence; null counts mean accounting is unavailable. */
export const FreshnessCoverage = z.object({
  source: z.string().min(1),
  reportType: z.string().min(1),
  status: z.string().min(1),
  coveredThrough: IsoDate.nullable(),
  observedAt: z.iso.datetime(),
  sourceRows: count.nullable(),
  parsedRows: count.nullable(),
  loadedRows: count.nullable(),
  refusedRows: count.nullable(),
  /** Producer assertion; aggregation can make parsed and loaded counts differ. */
  countsMatch: z.boolean().nullable(),
  /**
   * Absent when the producer records no verified span; null when it records one
   * and no completed load has returned a day yet (not measured).
   */
  verified: VerifiedCoverageSpan.nullable().optional(),
});
export type FreshnessCoverage = z.infer<typeof FreshnessCoverage>;

export const FreshnessLedgerEntry = z.object({
  source: z.string().optional(),
  reportType: z.string(),
  status: z.string(),
  endDate: IsoDate,
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  rowsParsed: count.nullable(),
  rowsLoaded: count.nullable(),
  countsMatch: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type FreshnessLedgerEntry = z.infer<typeof FreshnessLedgerEntry>;

export const ReportDataSource = z.enum([
  'amazon_reporting_v3',
  'amazon_unified_reporting',
  'amazon_marketing_stream',
  'secondary_import',
]);
export type ReportDataSource = z.infer<typeof ReportDataSource>;

export const HistoricalBootstrapStatus = z.enum([
  'pending',
  'loading',
  'complete',
  'partial',
  'unavailable',
  'failed',
]);
export type HistoricalBootstrapStatus = z.infer<typeof HistoricalBootstrapStatus>;

export const ReportCoverage = z.object({
  profileId: Uuid,
  reportType: z.string().min(1),
  grain: z.string().min(1),
  source: z.string().min(1),
  sourceRows: count.nullable().optional(),
  parsedRows: count.nullable().optional(),
  loadedRows: count.nullable().optional(),
  refusedRows: count.nullable().optional(),
  observedAt: z.iso.datetime().nullable().optional(),
  countsMatch: z.boolean().nullable().optional(),
  status: HistoricalBootstrapStatus,
  earliestRequestedDate: IsoDate.nullable(),
  earliestReturnedDate: IsoDate.nullable(),
  latestLoadedDate: IsoDate.nullable(),
  latestSettledDate: IsoDate.nullable(),
  availabilityStartDate: IsoDate.nullable(),
  missingDates: z.array(IsoDate),
  updatedAt: z.iso.datetime(),
});
export type ReportCoverage = z.infer<typeof ReportCoverage>;

export const ReportPromotionWatermark = z.object({
  profileId: Uuid,
  reportType: z.string().min(1),
  date: IsoDate,
  source: ReportDataSource,
  reportRequestId: Uuid,
  requestedAt: z.iso.datetime(),
  promotedAt: z.iso.datetime(),
  sourceRows: count,
  parsedRows: count,
  refusedRows: count,
  promotedRows: count,
  canonicalRows: count,
});
export type ReportPromotionWatermark = z.infer<typeof ReportPromotionWatermark>;

export const AttributionObservation = z.object({
  id: Uuid.optional(),
  profileId: Uuid,
  date: IsoDate,
  adProduct: AdProduct,
  reportType: z.string().min(1),
  source: ReportDataSource,
  observedAt: z.iso.datetime(),
  attributionWindowDays: z.number().int().positive(),
  eventDateAgeDays: z.number().int().nonnegative(),
  impressions: count,
  clicks: count,
  cost: metric,
  purchases: count,
  sales: metric,
  supersededAt: z.iso.datetime().nullable(),
});
export type AttributionObservation = z.infer<typeof AttributionObservation>;

/** The expression dialect accepted by theme-based SP bid recommendations v3. */
export const BidRecommendationExpression = z.object({
  type: z.enum([
    'CLOSE_MATCH', 'LOOSE_MATCH', 'SUBSTITUTES', 'COMPLEMENTS',
    'KEYWORD_BROAD_MATCH', 'KEYWORD_EXACT_MATCH', 'KEYWORD_PHRASE_MATCH',
  ]),
  value: z.string().optional(),
});
export type BidRecommendationExpression = z.infer<typeof BidRecommendationExpression>;

/** Null expression means the mirror target cannot be represented by v3. */
export const BidRecommendationTarget = z.object({
  targetId: z.string().min(1),
  campaignId: z.string().min(1),
  adGroupId: z.string().min(1),
  isKeyword: z.boolean(),
  targetingExpression: BidRecommendationExpression.nullable(),
});
export type BidRecommendationTarget = z.infer<typeof BidRecommendationTarget>;

export const BidRecommendationCorridor = BidRecommendationTarget.extend({
  low: metric.nullable(),
  median: metric.nullable(),
  high: metric.nullable(),
});
export type BidRecommendationCorridor = z.infer<typeof BidRecommendationCorridor>;

/** Counts use target rows; unmatched counts extra response expressions in the base theme. */
export const BidRecommendationReadCounts = z.object({
  offered: count,
  eligible: count,
  requested: count,
  returned: count,
  refused: count,
  unmatched: count,
}).refine((c) => c.offered >= c.eligible && c.eligible === c.requested
  && c.requested === c.returned + c.refused, 'bid recommendation counts do not reconcile');
export type BidRecommendationReadCounts = z.infer<typeof BidRecommendationReadCounts>;

/** Daily history retains one context row for every offered target, even without a corridor. */
export const BidSeriesReconciliationCounts = BidRecommendationReadCounts.safeExtend({ written: count })
  .refine((c) => c.written === c.offered, 'bid history rows do not reconcile');
export type BidSeriesReconciliationCounts = z.infer<typeof BidSeriesReconciliationCounts>;

/** Full mirror identity; numeric keyword and product-target ids may overlap. */
export function bidRecommendationTargetKey(target: BidRecommendationTarget): string {
  return JSON.stringify([target.campaignId, target.adGroupId, target.isKeyword, target.targetId]);
}
/** One successful range observation; legacy ledger accounting can be unknown. */
export const ReportCoverageObservation = FreshnessCoverage.omit({ verified: true }).extend({
  /** Immutable source run for collectors whose accounting can change at the same provider time. */
  sourceRunId: Uuid.optional(),
  orgId: Uuid,
  profileId: Uuid,
  grain: z.string().min(1),
  status: z.enum(['complete', 'partial']),
  coveredThrough: IsoDate,
  earliestDate: IsoDate,
  /** Independently verified period boundary; absent for legacy request-only ranges. */
  verifiedStartDate: IsoDate.optional(),
  settledThrough: IsoDate.nullable(),
}).refine((row) => row.earliestDate <= row.coveredThrough &&
  (row.settledThrough === null || row.settledThrough <= row.coveredThrough),
  'coverage date bounds do not reconcile').refine(row => row.verifiedStartDate === undefined ||
  (row.verifiedStartDate >= row.earliestDate && row.verifiedStartDate <= row.coveredThrough),
  'verified coverage boundary is outside the requested range');
export type ReportCoverageObservation = z.infer<typeof ReportCoverageObservation>;

/** Additional source accounting supplied by the worker after its load assertion. */
export const ReportCoverageAccounting = z.object({
  sourceRows: count,
  parsedRows: count,
  refusedRows: count,
  observedAt: z.iso.datetime(),
  settledThrough: IsoDate.nullable(),
}).refine((row) => row.sourceRows === row.parsedRows + row.refusedRows,
  'coverage source counts do not reconcile');
export type ReportCoverageAccounting = z.infer<typeof ReportCoverageAccounting>;

/**
 * WP-323: the Reporting v3 lane, stage by stage, in pipeline order.
 * `fetch` is download, inflate and parse; `load` is parsed rows to facts.
 */
export const ReportLaneStage = z.enum(['request', 'poll', 'fetch', 'load']);
export type ReportLaneStage = z.infer<typeof ReportLaneStage>;

/**
 * Bounded, operator-safe failure classes derived from a job's recorded error.
 * Never raw provider, SQL or payload text.
 */
export const ReportLaneErrorClass = z.enum([
  'create_outcome_unknown',
  'provider_throttled',
  'provider_auth',
  'provider_unavailable',
  'report_failed',
  'report_timeout',
  'download_url_expired',
  'download_url_rejected',
  'download_transport',
  'download_timeout',
  'download_compressed_limit',
  'download_inflate_limit',
  'payload_format',
  'payload_corrupt',
  'parser_limit',
  'parser_refused_rows',
  'count_mismatch',
  'load_failed',
  'store_failed',
  'retry_budget_exhausted',
  'unclassified',
]);
export type ReportLaneErrorClass = z.infer<typeof ReportLaneErrorClass>;

export type ReportLaneJobType = 'report.request' | 'report.poll' | 'report.fetch';

export interface ReportLaneFailure {
  stage: ReportLaneStage;
  errorClass: ReportLaneErrorClass;
  /**
   * The failure can be repaired by requesting the same window again: the
   * report itself was fine, the copy of it this job held was not. Only ever
   * true for `report.fetch`.
   */
  recoverableByReRequest: boolean;
}

const LOAD_STAGE_CLASSES: ReadonlySet<ReportLaneErrorClass> = new Set([
  'parser_refused_rows', 'count_mismatch', 'load_failed',
]);

const RE_REQUESTABLE_FETCH_CLASSES: ReadonlySet<ReportLaneErrorClass> = new Set([
  'download_url_expired',
  'download_url_rejected',
  'download_transport',
  'download_timeout',
  // Before WP-323 a parser thread that could not start in the bundled cron
  // runtime was recorded under the inflate limit, so this class is re-requested
  // (bounded by the re-request generation limit) rather than trusted.
  'download_inflate_limit',
  'payload_corrupt',
]);

/** Ordered: the first matching rule wins. Patterns match the worker's fixed messages. */
const ERROR_CLASS_RULES: readonly (readonly [RegExp, ReportLaneErrorClass])[] = [
  [/reporting v3 create outcome is unknown|report create outcome unknown/, 'create_outcome_unknown'],
  [/report download url (?:expired|remained expired)/, 'download_url_expired'],
  [/report download url was rejected/, 'download_url_rejected'],
  [/report download exceeded compressed_bytes limit/, 'download_compressed_limit'],
  [/report download exceeded decompressed_bytes limit/, 'download_inflate_limit'],
  [/report download exceeded (?:idle_timeout|total_timeout|source_cancellation) limit/, 'download_timeout'],
  [/report download exceeded (?:parsed_row_bytes|parsed_rows|parsed_bytes) limit/, 'parser_limit'],
  [/report payload gzip stream is corrupt/, 'payload_corrupt'],
  [/report payload (?:is empty|is neither gzip nor json|is not valid json|must be a json array)/, 'payload_format'],
  [/report download failed with (?:429|5\d\d)|report download failed|fetch failed|econnreset|socket hang up|network/, 'download_transport'],
  [/parser refused|replacement parser refused|must be a non-empty string|must be yyyy-mm-dd|must be a non-negative|report row must be an object|report parser chunk kind changed/, 'parser_refused_rows'],
  [/report parsed \d+ rows but loaded \d+|parser chunk accounting did not match|count mismatch|do not reconcile|source rows but/, 'count_mismatch'],
  [/failed query|partition months|promotion blocked|duplicate key|violates|database/, 'load_failed'],
  [/did not complete within 4 hours/, 'report_timeout'],
  [/has no download url|report (?:failed|cancelled)/, 'report_failed'],
  [/exhausting its retry budget/, 'retry_budget_exhausted'],
  [/\b429\b|throttl|too many requests|rate limit/, 'provider_throttled'],
  [/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid_grant|refresh token/, 'provider_auth'],
  [/\b5\d\d\b|timed? out|timeout|unavailable/, 'provider_unavailable'],
];

/** Classify one recorded report-lane job failure into its stage and bounded class. */
export function classifyReportLaneFailure(
  jobType: ReportLaneJobType,
  message: string | null | undefined,
): ReportLaneFailure {
  const normalized = (message ?? '').toLowerCase();
  let errorClass: ReportLaneErrorClass = 'unclassified';
  for (const [pattern, candidate] of ERROR_CLASS_RULES) {
    if (pattern.test(normalized)) { errorClass = candidate; break; }
  }
  if (jobType === 'report.fetch' && errorClass === 'provider_unavailable') errorClass = 'download_transport';
  // Loading facts only happens in a fetch job; elsewhere a database failure is
  // the request or poll bookkeeping itself.
  if (jobType !== 'report.fetch' && LOAD_STAGE_CLASSES.has(errorClass)) {
    errorClass = errorClass === 'load_failed' ? 'store_failed' : 'unclassified';
  }
  const stage: ReportLaneStage = jobType === 'report.request' ? 'request'
    : jobType === 'report.poll' ? 'poll'
      : LOAD_STAGE_CLASSES.has(errorClass) ? 'load' : 'fetch';
  return {
    stage,
    errorClass,
    recoverableByReRequest: jobType === 'report.fetch' && RE_REQUESTABLE_FETCH_CLASSES.has(errorClass),
  };
}

/** One stage's evidence: when it last worked, when it last failed and why. */
export const ReportLaneStageStatus = z.object({
  stage: ReportLaneStage,
  lastSucceededAt: z.iso.datetime().nullable(),
  lastFailedAt: z.iso.datetime().nullable(),
  lastErrorClass: ReportLaneErrorClass.nullable(),
  /** Jobs that failed and are queued to retry. */
  retrying: count,
  /** Jobs that exhausted retries or failed permanently. */
  dead: count,
});
export type ReportLaneStageStatus = z.infer<typeof ReportLaneStageStatus>;

export const ReportLaneBlock = z.object({
  stage: ReportLaneStage,
  errorClass: ReportLaneErrorClass,
  since: z.iso.datetime(),
  lastSucceededAt: z.iso.datetime().nullable(),
});
export type ReportLaneBlock = z.infer<typeof ReportLaneBlock>;

/**
 * The lane's blocking stage: the first stage, in pipeline order, whose latest
 * failure is newer than its latest success (or that has failed and never
 * succeeded). A downstream stage cannot produce facts while an upstream one is
 * blocked, so the earliest one is the one to fix.
 */
export function reportLaneBlockingStage(stages: readonly ReportLaneStageStatus[]): ReportLaneBlock | null {
  for (const stage of ReportLaneStage.options) {
    const row = stages.find((candidate) => candidate.stage === stage);
    if (!row || row.lastFailedAt === null || row.lastErrorClass === null) continue;
    if (row.lastSucceededAt !== null && Date.parse(row.lastSucceededAt) >= Date.parse(row.lastFailedAt)) continue;
    return { stage, errorClass: row.lastErrorClass, since: row.lastFailedAt, lastSucceededAt: row.lastSucceededAt };
  }
  return null;
}

/** Dead report jobs across the whole organisation, independent of profile scope. */
export const ReportLaneDeadSummary = z.object({
  total: count,
  byStage: z.object({ request: count, poll: count, fetch: count, load: count }),
  /** Dead fetches the lane has already re-requested automatically. */
  reRequested: count,
  /** Dead requests an operator resolved through reconciliation. */
  resolved: count,
});
export type ReportLaneDeadSummary = z.infer<typeof ReportLaneDeadSummary>;

/** Per-profile job health for every job type; `failed` is never a resting queue state. */
export const ProfileJobHealth = z.object({
  profileId: Uuid,
  retrying: count,
  dead: count,
});
export type ProfileJobHealth = z.infer<typeof ProfileJobHealth>;

export const ReportLaneStatus = z.object({
  scope: z.enum(['organisation', 'profile']),
  stages: z.array(ReportLaneStageStatus).length(ReportLaneStage.options.length),
  blocking: ReportLaneBlock.nullable(),
  organisationDead: ReportLaneDeadSummary,
  profiles: z.array(ProfileJobHealth),
});
export type ReportLaneStatus = z.infer<typeof ReportLaneStatus>;
