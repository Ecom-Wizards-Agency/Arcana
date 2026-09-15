import { z } from 'zod';
import { AdProduct, AmazonId, CurrencyCode, Uuid } from './primitives.js';

export const AdsCatalogueFamily = z.enum([
  'product_metadata', 'product_eligibility', 'validation_configurations', 'change_history',
]);
export type AdsCatalogueFamily = z.infer<typeof AdsCatalogueFamily>;

export const AdsCatalogueScope = z.object({
  orgId: Uuid, profileId: Uuid, marketplaceId: AmazonId,
});
export type AdsCatalogueScope = z.infer<typeof AdsCatalogueScope>;

export const EvidenceProvenance = z.object({
  family: AdsCatalogueFamily, contractVersion: z.string().min(1),
  providerObservedAt: z.iso.datetime().nullable(), acquiredAt: z.iso.datetime(), retrievedAt: z.iso.datetime(),
});
export type EvidenceProvenance = z.infer<typeof EvidenceProvenance>;

export const EvidenceField = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.object({ state: z.literal('returned'), value, sourceField: z.string().min(1) }),
  z.object({ state: z.enum(['absent', 'refused', 'contradictory']), reason: z.string().min(1).nullable() }),
]);
export type EvidenceField<T> =
  | { state: 'returned'; value: T; sourceField: string }
  | { state: 'absent' | 'refused' | 'contradictory'; reason: string | null };

const optionalString = EvidenceField(z.string());
const optionalNumber = EvidenceField(z.number().finite());
const optionalMoney = EvidenceField(z.object({ amount: z.number().finite(), currency: CurrencyCode }));

export const ProductMetadataSnapshot = z.object({
  scope: AdsCatalogueScope, asin: AmazonId, sku: z.string().min(1).nullable(), adProduct: AdProduct,
  provenance: EvidenceProvenance,
  title: optionalString, imageUrl: optionalString, category: optionalString,
  variationAsins: EvidenceField(z.array(AmazonId)), price: optionalMoney, basisPrice: optionalMoney,
  availability: optionalString, inventoryQuantity: optionalNumber, bestSellerRank: optionalNumber,
});
export type ProductMetadataSnapshot = z.infer<typeof ProductMetadataSnapshot>;

export const ProductEligibilityVerdict = z.enum(['eligible', 'eligible_with_warning', 'ineligible', 'unknown']);
export const ProductEligibilitySnapshot = z.object({
  scope: AdsCatalogueScope, asin: AmazonId, sku: z.string().min(1).nullable(), adProduct: AdProduct,
  verdict: ProductEligibilityVerdict,
  reasons: z.array(z.object({ code: z.string().min(1), message: z.string().nullable(), severity: z.string().nullable() })),
  provenance: EvidenceProvenance,
});
export type ProductEligibilitySnapshot = z.infer<typeof ProductEligibilitySnapshot>;

export const ValidationConfiguration = z.object({
  scope: AdsCatalogueScope, resource: z.enum(['campaigns', 'targeting_clauses']),
  countryCode: z.string().regex(/^[A-Z]{2}$/), entityType: z.enum(['SELLER', 'VENDOR']),
  adProduct: AdProduct, providerVersion: z.null(), contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: z.record(z.string(), z.unknown()), provenance: EvidenceProvenance,
});
export type ValidationConfiguration = z.infer<typeof ValidationConfiguration>;

export const AmazonChangeEvent = z.object({
  scope: AdsCatalogueScope,
  sourceNamespace: z.literal('amazon_ads_change_history_v1'),
  sourceEventKey: z.string().regex(/^[a-f0-9]{64}$/), identityQuality: z.literal('derived'),
  entityType: z.enum(['AD', 'AD_GROUP', 'CAMPAIGN', 'KEYWORD', 'NEGATIVE_KEYWORD', 'PRODUCT_TARGETING']),
  entityId: AmazonId, changeType: z.string().min(1), occurredAt: z.iso.datetime(),
  previousValue: z.string().nullable(), newValue: z.string().nullable(),
  metadata: z.record(z.string(), z.string()), provenance: EvidenceProvenance,
});
export type AmazonChangeEvent = z.infer<typeof AmazonChangeEvent>;

export const ReaderAvailability = z.enum(['measured', 'missing', 'partial', 'stale']);
export const ProductEvidence = z.object({
  scope: AdsCatalogueScope, asin: AmazonId, availability: ReaderAvailability,
  metadata: ProductMetadataSnapshot.nullable(), eligibility: ProductEligibilitySnapshot.nullable(),
});
export type ProductEvidence = z.infer<typeof ProductEvidence>;

export const CatalogueCollectionCounts = z.object({
  requestedMembers: z.number().int().nonnegative(), pages: z.number().int().nonnegative(),
  sourceRows: z.number().int().nonnegative(), parsedRows: z.number().int().nonnegative(),
  refusedRows: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative(),
  canonicalRows: z.number().int().nonnegative(), writtenRows: z.number().int().nonnegative(),
  existingRows: z.number().int().nonnegative(), verifiedRows: z.number().int().nonnegative(),
}).superRefine((counts, context) => {
  if (counts.sourceRows !== counts.parsedRows + counts.refusedRows) context.addIssue({ code: 'custom', message: 'source rows do not reconcile' });
  if (counts.canonicalRows !== counts.writtenRows + counts.existingRows || counts.canonicalRows !== counts.verifiedRows) {
    context.addIssue({ code: 'custom', message: 'destination rows do not reconcile' });
  }
});
export type CatalogueCollectionCounts = z.infer<typeof CatalogueCollectionCounts>;

export const CatalogueSourceReceipt = z.object({
  id: Uuid, scope: AdsCatalogueScope, family: AdsCatalogueFamily,
  windowStart: z.iso.datetime(), windowEnd: z.iso.datetime(), completedAt: z.iso.datetime(),
  continuation: z.string().nullable(), counts: CatalogueCollectionCounts,
});
export type CatalogueSourceReceipt = z.infer<typeof CatalogueSourceReceipt>;

export const CatalogueReaderStatus = z.object({
  family: AdsCatalogueFamily, availability: ReaderAvailability, coveredFrom: z.iso.datetime().nullable(),
  coveredThrough: z.iso.datetime().nullable(), observedAt: z.iso.datetime().nullable(),
  sourceRows: z.number().int().nonnegative(), loadedRows: z.number().int().nonnegative(),
  cursorFailure: z.string().nullable(),
});
export type CatalogueReaderStatus = z.infer<typeof CatalogueReaderStatus>;
