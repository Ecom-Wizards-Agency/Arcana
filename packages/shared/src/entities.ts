/**
 * `EntityRow`: the shape of one row in the entity mirror, keyed
 * `(profileId, amazonId)`. One discriminated union covers every entity kind so
 * a sync diff, a grid row and an audit record all speak the same language.
 */
import { z } from 'zod';
import {
  AdProduct,
  AmazonId,
  EntityState,
  EntityType,
  MatchType,
  Uuid,
} from './primitives.js';

/** Fields every mirrored entity carries. */
const entityBase = {
  profileId: Uuid,
  amazonId: AmazonId,
  adProduct: AdProduct,
  name: z.string().nullable(),
  state: EntityState,
  /** When the last successful sync pass observed this row. */
  syncedAt: z.iso.datetime().optional(),
};

export const BudgetType = z.enum(['daily', 'lifetime']);
export type BudgetType = z.infer<typeof BudgetType>;

export const TargetingType = z.enum(['manual', 'auto']);
export type TargetingType = z.infer<typeof TargetingType>;

export const BiddingStrategy = z.enum([
  'legacy_for_sales',
  'auto_for_sales',
  'manual',
  'rule_based',
]);
export type BiddingStrategy = z.infer<typeof BiddingStrategy>;

/** Percent uplift per placement, as Amazon stores it (0-900). */
export const PlacementBidding = z.object({
  topOfSearch: z.number().nullable(),
  productPages: z.number().nullable(),
  restOfSearch: z.number().nullable(),
});
export type PlacementBidding = z.infer<typeof PlacementBidding>;

/** One clause of a product-targeting expression. */
export const TargetExpression = z.object({
  type: MatchType,
  value: z.string().nullable(),
});
export type TargetExpression = z.infer<typeof TargetExpression>;

export const PortfolioRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.portfolio),
  budgetAmount: z.number().nullable(),
  budgetPolicy: z.string().nullable(),
});

export const CampaignRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.campaign),
  portfolioId: AmazonId.nullable(),
  budgetAmount: z.number(),
  budgetType: BudgetType,
  targetingType: TargetingType.nullable(),
  biddingStrategy: BiddingStrategy.nullable(),
  placementBidding: PlacementBidding.nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});

export const AdGroupRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.ad_group),
  campaignId: AmazonId,
  defaultBid: z.number().nullable(),
});

export const ProductAdRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.product_ad),
  campaignId: AmazonId,
  adGroupId: AmazonId,
  asin: z.string().nullable(),
  sku: z.string().nullable(),
});

export const KeywordRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.keyword),
  campaignId: AmazonId,
  adGroupId: AmazonId,
  keywordText: z.string(),
  matchType: MatchType,
  bid: z.number().nullable(),
});

export const TargetRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.target),
  campaignId: AmazonId,
  adGroupId: AmazonId,
  expression: z.array(TargetExpression),
  /** Amazon's resolved form, kept verbatim so the grid can show what it shows. */
  resolvedExpression: z.string().nullable(),
  bid: z.number().nullable(),
});

/** Negative keywords and negative product targets, campaign- or ad-group-scoped. */
export const NegativeRow = z.object({
  ...entityBase,
  entityType: z.literal(EntityType.enum.negative),
  campaignId: AmazonId,
  adGroupId: AmazonId.nullable(),
  scope: z.enum(['campaign', 'ad_group']),
  keywordText: z.string().nullable(),
  expression: z.array(TargetExpression).nullable(),
  matchType: MatchType,
});

export const EntityRow = z.discriminatedUnion('entityType', [
  PortfolioRow,
  CampaignRow,
  AdGroupRow,
  ProductAdRow,
  KeywordRow,
  TargetRow,
  NegativeRow,
]);
export type EntityRow = z.infer<typeof EntityRow>;

export type PortfolioRow = z.infer<typeof PortfolioRow>;
export type CampaignRow = z.infer<typeof CampaignRow>;
export type AdGroupRow = z.infer<typeof AdGroupRow>;
export type ProductAdRow = z.infer<typeof ProductAdRow>;
export type KeywordRow = z.infer<typeof KeywordRow>;
export type TargetRow = z.infer<typeof TargetRow>;
export type NegativeRow = z.infer<typeof NegativeRow>;

/** Operator attribution inside Arcana; this does not change an Amazon product ad. */
export const AdGroupProductAssignmentScope = z.object({
  profileId: Uuid,
  start: z.iso.date(),
  end: z.iso.date(),
}).strict().refine((value) => value.start <= value.end, 'Start must not follow end');
export type AdGroupProductAssignmentScope = z.infer<typeof AdGroupProductAssignmentScope>;
export const AdGroupProductAssignmentInput = z.object({
  profileId: Uuid,
  adGroupId: AmazonId,
  asin: z.string().regex(/^[A-Z0-9]{10}$/),
}).strict();
export type AdGroupProductAssignmentInput = z.infer<typeof AdGroupProductAssignmentInput>;
export const AdGroupProductAssignmentList = z.object({
  profileId: Uuid,
  start: z.iso.date(),
  end: z.iso.date(),
  canAssign: z.boolean(),
  days: z.number().int().positive(),
  items: z.array(z.object({
    adGroupId: AmazonId,
    name: z.string().nullable(),
    campaignId: AmazonId,
    asins: z.array(z.string()),
    spend: z.number().nonnegative().nullable(),
    assignedAsin: z.string().nullable(),
  })),
  count: z.number().int().nonnegative(),
  unassignedCount: z.number().int().nonnegative(),
  unassignedSpend: z.number().nonnegative(),
}).superRefine((value, ctx) => {
  const unresolved = value.items.filter((item) => item.assignedAsin === null && item.spend !== null && item.spend > 0);
  if (value.count !== value.items.length || value.unassignedCount !== unresolved.length ||
      Math.abs(value.unassignedSpend - unresolved.reduce((total, item) => total + item.spend!, 0)) > 0.000001) {
    ctx.addIssue({ code: 'custom', message: 'Assignment counts must reconcile with listed rows' });
  }
});
export type AdGroupProductAssignmentList = z.infer<typeof AdGroupProductAssignmentList>;
