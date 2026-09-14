import { z } from 'zod';

/** Operator display preference, expressed in percentage points. */
export const MarketPositionThreshold = z.number().finite().min(0).max(100);
export const DEFAULT_MARKET_POSITION_THRESHOLD = 15;
export const MarketPositionSettingsInput = z.object({
  profileId: z.uuid(),
  thresholdPercent: MarketPositionThreshold,
}).strict();
export type MarketPositionSettingsInput = z.infer<typeof MarketPositionSettingsInput>;
export const MarketPositionSettings = MarketPositionSettingsInput.extend({ updatedAt: z.string().nullable() });
export type MarketPositionSettings = z.infer<typeof MarketPositionSettings>;
export const MarketRankPoint = z.object({
  date: z.iso.date(), bsr: z.number().int().positive().nullable(),
  observedAt: z.iso.datetime().optional(),
  // Absence is unknown. Neither badge ownership nor a subcategory follows from BSR.
  bestSellerBadge: z.boolean().nullable().optional(),
  subcategory: z.object({ rank: z.number().int().positive(), name: z.string() }).nullable().optional(),
});
export type MarketRankPoint = z.infer<typeof MarketRankPoint>;
export const MarketRankSeries = z.object({ asin: z.string(), category: z.string(), name: z.string().optional(), points: z.array(MarketRankPoint) });
export type MarketRankSeries = z.infer<typeof MarketRankSeries>;
export const MarketProximityCause = z.enum(['own_rank_worsened', 'competitor_improved', 'both']);
export type MarketProximityCause = z.infer<typeof MarketProximityCause>;
export const MarketProximityAlert = z.object({
  date: z.iso.date(), ownAsin: z.string(), competitorAsin: z.string(), category: z.string(),
  ownBsr: z.number().positive(), competitorBsr: z.number().positive(),
  gap: z.number(), gapPercent: z.number(), cause: MarketProximityCause.nullable(),
});
export type MarketProximityAlert = z.infer<typeof MarketProximityAlert>;
export const MarketPositionProduct = z.object({ asin: z.string(), name: z.string().nullable() });
export type MarketPositionProduct = z.infer<typeof MarketPositionProduct>;
export const MarketPositionLink = z.object({ ownAsin: z.string(), competitorAsin: z.string(), category: z.string().nullable() });
export type MarketPositionLink = z.infer<typeof MarketPositionLink>;
