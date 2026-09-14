import { z } from 'zod';
import { SpMoney } from './sp-writes.js';

/** The common daily evidence consumed by the corridor model and presentation. */
export const TargetCorridorPoint = z.object({
  date: z.string(), low: z.number().nullable(), median: z.number().nullable(), high: z.number().nullable(),
  bid: z.number().nullable(), cpc: z.number().nullable(), maxCpc: z.number().nullable(),
  components: z.array(z.object({ name: z.string(), pct: z.number() })).readonly(),
});
export type TargetCorridorPoint = z.infer<typeof TargetCorridorPoint>;
export const TargetDailyPerformance = z.object({
  date: z.string(), impressions: z.number().nullable(), clicks: z.number().nullable(),
  spend: z.number().nullable(), sales: z.number().nullable(), orders: z.number().nullable(),
  acos: z.number().nullable(), cpc: z.number().nullable(), topOfSearchShare: z.number().nullable(),
});
export type TargetDailyPerformance = z.infer<typeof TargetDailyPerformance>;
export const QueuedBidCheck = z.object({
  key: z.enum(['rank_gate', 'band_position', 'max_increase', 'max_decrease', 'campaign_limits']),
  passed: z.boolean(), reason: z.string().min(1), source: z.string().min(1),
}).strict();
export type QueuedBidCheck = z.infer<typeof QueuedBidCheck>;
export const TargetBidContext = z.object({
  profileId: z.uuid(), profileLabel: z.string(), targetId: z.string(), targetLabel: z.string(),
  campaignId: z.string(), campaignLabel: z.string(), oldBid: SpMoney.nullable(), readAt: z.string().nullable(),
  organicRank: z.number().nullable(), protectionRank: z.number().nullable(),
  suggestedLow: z.number().nullable(), suggestedMedian: z.number().nullable(), suggestedHigh: z.number().nullable(),
  maxIncrease: z.number().nullable(), maxDecrease: z.number().nullable(),
  bidFloor: z.number().nullable(), bidCeiling: z.number().nullable(), campaignBudget: z.number().nullable(),
  placementModifiers: z.object({ topOfSearch: z.number().nullable(), restOfSearch: z.number().nullable(), productPages: z.number().nullable() }).nullable(),
  targetAcos: z.number().nullable(), settingSource: z.string(),
}).strict();
export type TargetBidContext = z.infer<typeof TargetBidContext>;
export const QueuedBidRequest = z.object({
  requestId: z.uuid(), profileId: z.uuid(), targetId: z.string().min(1).max(200),
  expectedBid: SpMoney, expectedReadAt: z.string().min(1), newBid: SpMoney,
  overrideReason: z.string().trim().min(1).max(1000).nullable(),
}).strict().refine((request) => request.expectedBid.currencyCode === request.newBid.currencyCode, 'Bid currency must stay fixed').refine((request) => request.expectedBid.amount !== request.newBid.amount, 'Proposed bid must differ from the current bid');
export type QueuedBidRequest = z.infer<typeof QueuedBidRequest>;
export const QueuedBidChange = z.object({
  id: z.uuid(), orgId: z.uuid(), createdBy: z.uuid(), createdAt: z.string(),
  context: TargetBidContext, request: QueuedBidRequest,
  checks: z.array(QueuedBidCheck).length(5).refine((checks) => new Set(checks.map((c) => c.key)).size === 5),
  approvedAt: z.string().nullable(), approvedBy: z.uuid().nullable(),
}).strict();
export type QueuedBidChange = z.infer<typeof QueuedBidChange>;
