/** Historical coverage, safe promotion, and attribution revision contracts. */
import { z } from 'zod';
import { AdProduct, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const metric = z.number().nonnegative();

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
  source: ReportDataSource,
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
