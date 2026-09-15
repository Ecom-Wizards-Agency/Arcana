/** Operator-owned keyword classification, independent of Amazon entity state. */
import { z } from 'zod';
import { AmazonId, Uuid } from './primitives.js';

export const BrandLensBucket = z.enum(['branded', 'competitor', 'generic']);
export type BrandLensBucket = z.infer<typeof BrandLensBucket>;
export const BrandLensDecision = z.enum(['kept', 'confirmed', 'changed']);
export type BrandLensDecision = z.infer<typeof BrandLensDecision>;
export const BrandLensOverrideInput = z.object({
  profileId: Uuid,
  keyword: z.string().trim().min(1).max(1000),
  bucket: BrandLensBucket,
  decision: BrandLensDecision,
}).strict();
export type BrandLensOverrideInput = z.infer<typeof BrandLensOverrideInput>;
export const BrandLensOverride = z.object({
  orgId: Uuid,
  profileId: Uuid,
  normalizedKeyword: z.string().min(1),
  bucket: BrandLensBucket,
  decision: BrandLensDecision,
  decidedBy: Uuid,
  decidedAt: z.iso.datetime(),
});
export type BrandLensOverride = z.infer<typeof BrandLensOverride>;
export const BrandLensKeyword = z.object({
  id: AmazonId,
  campaignId: AmazonId,
  keyword: z.string().min(1),
  matchType: z.string(),
  spend: z.number().nonnegative().nullable(),
  sales: z.number().nonnegative().nullable(),
  clicks: z.number().nonnegative().nullable(),
  orders: z.number().nonnegative().nullable(),
});
export type BrandLensKeyword = z.infer<typeof BrandLensKeyword>;
export const BrandLensCampaign = z.object({
  id: AmazonId,
  name: z.string(),
  groupId: Uuid.nullable(),
  groupRole: z.string().nullable(),
  excluded: z.boolean(),
});
export type BrandLensCampaign = z.infer<typeof BrandLensCampaign>;
