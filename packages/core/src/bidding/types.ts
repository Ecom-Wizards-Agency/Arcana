/** Reference bidding vocabulary is owned by shared; constants preserve the published baseline. */
import type { ReferenceBidRequest, ReferenceBidOutcome } from '@wizard-ads/shared';
export type BidRequest = ReferenceBidRequest;
export type LevelMetrics = BidRequest['metrics'];
export type ConfidenceLevels = BidRequest['levels'];
export type ChangeCaps = BidRequest['caps'];
export type CeilingConfig = NonNullable<BidRequest['ceilings']>;
export type FloorConfig = NonNullable<BidRequest['floors']>;
export type BidSettings = Required<NonNullable<BidRequest['settings']>>;
export type PacingCondition = NonNullable<BidRequest['pacingCondition']>;
export type StockSignal = NonNullable<BidRequest['stock']>;
export type OrganicRankSignal = NonNullable<BidRequest['organicRank']>;
export type ResolvedConfidence = Extract<ReferenceBidOutcome, { kind: 'proposal' }>['confidence'];
export type BidPreconditionNote = Extract<ReferenceBidOutcome, { kind: 'proposal' }>['notes'][number];
export type BidPreconditionNoteCode = BidPreconditionNote['code'];
export type CeilingName = 'manual_max_bid' | 'max_affordable_cpc' | 'data_based_keyword' |
  'data_based_ad_group' | 'data_based_campaign' | 'data_based_profile' | 'suggested_bid' | 'budget';
export type FloorName = 'amazon_min_bid' | 'manual_min_bid' | 'suggested_bid_low' | 'data_based_floor';

export const DEFAULT_BID_SETTINGS: BidSettings = {
  graceRange: 0.1,
  lowAcosBuffer: 0.2,
  lowAcosStepPct: 0.1,
  lowVisibilityStepPct: 0.05,
  lowVisibilityClicksBand: 0.1,
  nonConvertingModel: 'projected',
  minBid: 0.02,
  bidPrecision: 2,
  minOrdersForConfidence: 1,
};

/** The guide's step table, used when a pacing condition is supplied. */
export const STEP_BY_PACING_CONDITION: Record<PacingCondition, { lowAcos: number; lowVisibility: number }> = {
  on_target: { lowAcos: 0.1, lowVisibility: 0.1 },
  under_pacing: { lowAcos: 0.2, lowVisibility: 0.2 },
  launch: { lowAcos: 0.25, lowVisibility: 0.2 },
};
