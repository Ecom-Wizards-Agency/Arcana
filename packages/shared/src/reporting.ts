/** Historical coverage, safe promotion, and attribution revision contracts. */
import { z } from 'zod';
import { AdProduct, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative();

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
export const ReportCoverageObservation = FreshnessCoverage.extend({
  /** Immutable source run for collectors whose accounting can change at the same provider time. */
  sourceRunId: Uuid.optional(),
  orgId: Uuid,
  profileId: Uuid,
  grain: z.string().min(1),
  status: z.enum(['complete', 'partial']),
  coveredThrough: IsoDate,
  earliestDate: IsoDate,
  settledThrough: IsoDate.nullable(),
}).refine((row) => row.earliestDate <= row.coveredThrough &&
  (row.settledThrough === null || row.settledThrough <= row.coveredThrough),
  'coverage date bounds do not reconcile');
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
