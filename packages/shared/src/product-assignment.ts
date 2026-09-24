import { z } from 'zod';
import { AmazonId, Uuid } from './primitives.js';

const asin = z.string().regex(/^[A-Z0-9]{10}$/);
/** Operator attribution inside Arcana; this does not change an Amazon product ad. */
export const ProductAssignmentScope = z.object({
  profileId: Uuid,
  start: z.iso.date(),
  end: z.iso.date(),
}).strict().refine((value) => value.start <= value.end, 'Start must not follow end');
export type ProductAssignmentScope = z.infer<typeof ProductAssignmentScope>;
export const ProductAssignmentSource = z.enum(['derived', 'derived_parent', 'proposed', 'manual', 'unassigned']);
export type ProductAssignmentSource = z.infer<typeof ProductAssignmentSource>;
export const ProductAssignmentCandidate = z.object({
  asin, skus: z.array(z.string()), parentAsin: asin.nullable(), spend: z.number().finite().nonnegative().nullable(),
});
export const ProductAssignmentDerivation = z.object({
  adGroupId: AmazonId,
  assignedAsin: asin.nullable(),
  source: ProductAssignmentSource.exclude(['manual']),
  ambiguous: z.boolean(),
  reason: z.string().nullable(),
  candidates: z.array(ProductAssignmentCandidate),
}).superRefine((value, ctx) => {
  if ((value.source === 'unassigned') !== (value.assignedAsin === null) || value.ambiguous !== (value.source === 'proposed')) {
    ctx.addIssue({ code: 'custom', message: 'Assignment outcome must match its source' });
  }
});
export type ProductAssignmentDerivation = z.infer<typeof ProductAssignmentDerivation>;
export const ProductAssignmentEvidence = z.object({
  adGroupId: AmazonId,
  ads: z.array(z.object({
    asin: asin.nullable(), sku: z.string().nullable(), state: z.enum(['enabled', 'paused', 'archived']),
    parentAsin: asin.nullable(),
  })),
  // One aggregate per product over the mature days counted below, never group spend.
  spend: z.array(z.object({ asin, spend: z.number().finite().nonnegative() })),
  /** Reconciled report days on or before the maturity cutoff, out of the window's calendar days. */
  matureDays: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if (value.matureDays > value.windowDays || (value.matureDays === 0 && value.spend.length > 0)) {
    ctx.addIssue({ code: 'custom', message: 'Product spend requires counted mature days' });
  }
});
export type ProductAssignmentEvidence = z.infer<typeof ProductAssignmentEvidence>;
export const ProductAssignmentMutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign'), profileId: Uuid, adGroupId: AmazonId, asin }).strict(),
  z.object({ action: z.literal('revert'), profileId: Uuid, adGroupId: AmazonId }).strict(),
]);
export type ProductAssignmentMutation = z.infer<typeof ProductAssignmentMutation>;
/** Why a mutation was refused before any write. */
export const ProductAssignmentRefusal = z.enum(['assignment_derived']);
export type ProductAssignmentRefusal = z.infer<typeof ProductAssignmentRefusal>;
/** The worker's latest rule outcome; a manual row keeps it as the revert target. */
export const ProductAssignmentBaseline = z.object({
  asin: asin.nullable(), source: ProductAssignmentSource.exclude(['manual']),
}).refine((value) => (value.source === 'unassigned') === (value.asin === null), 'Derived outcome must match its source');
export type ProductAssignmentBaseline = z.infer<typeof ProductAssignmentBaseline>;
const ProductAssignmentItem = z.object({
  adGroupId: AmazonId, campaignId: AmazonId, name: z.string().nullable(), asins: z.array(asin),
  assignedAsin: asin.nullable(), source: ProductAssignmentSource, derivedAt: z.string().nullable(),
  // Null until the worker has derived this ad group once.
  derived: ProductAssignmentBaseline.nullable(),
  ambiguous: z.boolean(), reason: z.string().nullable(), candidates: z.array(ProductAssignmentCandidate),
  spend: z.number().finite().nonnegative().nullable(),
}).superRefine((row, ctx) => {
  if ((row.source === 'unassigned') !== (row.assignedAsin === null) || row.ambiguous !== (row.source === 'proposed')) {
    ctx.addIssue({ code: 'custom', message: 'Effective assignment must match its source' });
  }
  if (row.source !== 'manual' && row.derived !== null && (row.derived.source !== row.source || row.derived.asin !== row.assignedAsin)) {
    ctx.addIssue({ code: 'custom', message: 'A derived assignment must equal its saved derivation' });
  }
});
type ProductAssignmentItem = z.infer<typeof ProductAssignmentItem>;
/** Never derived: no rule outcome exists yet, so the group is waiting, not unresolved. */
export const awaitingProductDerivation = (row: Pick<ProductAssignmentItem, 'source' | 'derived'>): boolean =>
  row.source !== 'manual' && row.derived === null;
/** The rows the notice counts: the rule proposed a product or found none. */
export const unresolvedProductAssignment = (row: Pick<ProductAssignmentItem, 'source' | 'derived'>): boolean =>
  (row.source === 'proposed' || row.source === 'unassigned') && !awaitingProductDerivation(row);
export const ProductAssignmentList = z.object({
  profileId: Uuid, start: z.iso.date(), end: z.iso.date(), days: z.number().int().positive(), canAssign: z.boolean(),
  items: z.array(ProductAssignmentItem),
  count: z.number().int().nonnegative(), unassignedCount: z.number().int().nonnegative(), unassignedSpend: z.number().nonnegative(),
}).superRefine((value, ctx) => {
  const unresolved = value.items.filter(unresolvedProductAssignment);
  if (value.count !== value.items.length || value.unassignedCount !== unresolved.length ||
    Math.abs(value.unassignedSpend - unresolved.reduce((sum, row) => sum + (row.spend ?? 0), 0)) > 0.000001) {
    ctx.addIssue({ code: 'custom', message: 'Assignment counts must reconcile with listed rows' });
  }
});
export type ProductAssignmentList = z.infer<typeof ProductAssignmentList>;
