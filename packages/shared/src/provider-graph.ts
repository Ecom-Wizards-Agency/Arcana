import { z } from 'zod';
import { AdProduct, Region, Uuid } from './primitives.js';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);
export const ProviderGraphScope = z.object({
  orgId: Uuid, profileId: Uuid, amazonProfileId: identifier, region: Region,
}).strict();
export type ProviderGraphScope = z.infer<typeof ProviderGraphScope>;
export const ProviderGraphEntityKind = z.enum([
  'campaign', 'ad_group', 'ad', 'creative', 'target', 'negative', 'asset', 'product',
]);
export type ProviderGraphEntityKind = z.infer<typeof ProviderGraphEntityKind>;
export const ProviderGraphIdentity = z.object({
  adProduct: AdProduct, kind: ProviderGraphEntityKind, providerId: identifier,
  version: identifier.nullable(),
}).strict();
export type ProviderGraphIdentity = z.infer<typeof ProviderGraphIdentity>;
export const ProviderGraphObservation = z.object({
  scope: ProviderGraphScope, identity: ProviderGraphIdentity,
  source: z.enum(['product_api', 'marketing_stream']), contractVersion: identifier,
  sourceEventAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  revision: z.string().regex(/^\d+$/).nullable(),
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(['upsert', 'tombstone']),
  state: z.enum(['enabled', 'paused', 'archived', 'unknown']),
}).strict();
export type ProviderGraphObservation = z.infer<typeof ProviderGraphObservation>;
export const ProviderGraphAssociation = z.object({
  scope: ProviderGraphScope, from: ProviderGraphIdentity, to: ProviderGraphIdentity,
  relation: z.enum(['parent', 'creative', 'asset', 'advertised_product']),
  sourceEventAt: z.iso.datetime(), revision: z.string().regex(/^\d+$/).nullable(),
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  operation: z.enum(['upsert', 'tombstone']),
}).strict().refine((edge) => edge.from.adProduct === edge.to.adProduct, {
  message: 'Association endpoints must have the same advertising product.',
});
export type ProviderGraphAssociation = z.infer<typeof ProviderGraphAssociation>;
export const ProviderGraphCounts = z.object({
  source: z.number().int().nonnegative(), parsed: z.number().int().nonnegative(),
  refused: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative(),
  canonical: z.number().int().nonnegative(), stored: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(), verified: z.number().int().nonnegative(),
}).strict().refine((v) => v.source === v.parsed + v.refused
  && v.parsed === v.duplicates + v.canonical
  && v.canonical === v.stored + v.existing && v.verified === v.canonical, {
  message: 'Graph source, canonical, persistence and independent verification counts must reconcile.',
});
export type ProviderGraphCounts = z.infer<typeof ProviderGraphCounts>;

export const ProviderGraphResource = z.enum(['sb_ads', 'sb_creatives', 'sd_campaigns_extended',
  'sd_ad_groups_extended', 'sd_ads', 'sd_ads_extended', 'sd_targets', 'sd_targets_extended',
  'sd_negatives', 'sd_negatives_extended', 'sd_creatives']);
export type ProviderGraphResource = z.infer<typeof ProviderGraphResource>;
export const ProviderGraphReadResult = z.object({
  observations: z.array(ProviderGraphObservation), associations: z.array(ProviderGraphAssociation),
  sourceRows: z.number().int().nonnegative(), parsed: z.number().int().nonnegative(),
  refusals: z.array(z.object({ index: z.number().int().nonnegative(),
    reason: z.enum(['invalid_row', 'missing_identity', 'wrong_ad', 'invalid_association']) }).strict()),
  pages: z.number().int().nonnegative(), completeness: z.enum(['complete', 'partial']),
}).strict().refine((r) => r.sourceRows === r.parsed + r.refusals.length
  && r.parsed === r.observations.length);
export type ProviderGraphReadResult = z.infer<typeof ProviderGraphReadResult>;
export const ProviderGraphIntakeReceipt = z.object({ observations: ProviderGraphCounts,
  associations: ProviderGraphCounts }).strict();
export type ProviderGraphIntakeReceipt = z.infer<typeof ProviderGraphIntakeReceipt>;
export const ProviderGraphStoredEvidence = z.object({
  observations: z.array(ProviderGraphObservation), associations: z.array(ProviderGraphAssociation),
  persistedObservations: z.number().int().nonnegative(), persistedAssociations: z.number().int().nonnegative(),
}).strict().refine((r) => r.persistedObservations === r.observations.length
  && r.persistedAssociations === r.associations.length);
export type ProviderGraphStoredEvidence = z.infer<typeof ProviderGraphStoredEvidence>;

/** Version and tenant scope remain part of identity even for unresolved endpoints. */
export function providerGraphIdentityKey(scope: ProviderGraphScope, identity: ProviderGraphIdentity): string {
  return JSON.stringify([scope.orgId, scope.profileId, scope.amazonProfileId, scope.region,
    identity.adProduct, identity.kind, identity.providerId, identity.version]);
}
