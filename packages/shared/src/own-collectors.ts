import { z } from 'zod';
import { Uuid } from './primitives.js';
import { CreativeChangeCertainty } from './change-certainty.js';
import { SpCompleteCampaignBiddingState } from './sp-writes.js';
import { IngestionCounts } from './ingestion.js';

const instant = z.string().datetime({ offset: true }).transform((v) => new Date(v).toISOString());
const identity = z.string().trim().min(1).max(200);
export const CollectorScope = z.object({ orgId: Uuid, profileId: Uuid, marketplace: z.string().regex(/^[A-Z]{2}$/) }).strict();
export type CollectorScope = z.infer<typeof CollectorScope>;
export const CollectorProvenance = z.object({
  source: identity, sourceIdentity: identity, observedAt: instant, collectedAt: instant,
}).strict().refine((v) => v.observedAt <= v.collectedAt, 'Observation must precede collection');
export type CollectorProvenance = z.infer<typeof CollectorProvenance>;
const timedAmount = z.object({ value: z.number().finite().nonnegative(), provenance: CollectorProvenance }).strict();
export const EffectiveBidObservation = z.object({
  scope: CollectorScope, sourceIdentity: identity, campaignId: identity, adGroupId: identity, targetId: identity,
  targetKind: z.enum(['keyword', 'target']), observedAt: instant, collectedAt: instant,
  inheritance: z.object({ targetBidAbsentAt: instant, defaultBidObservedAt: instant }).strict().optional(),
  bid: timedAmount.nullable(), bidOrigin: z.enum(['explicit', 'inherited', 'unknown']),
  bidding: SpCompleteCampaignBiddingState.nullable(),
  placementProvenance: CollectorProvenance.nullable(), audienceProvenance: CollectorProvenance.nullable(),
}).strict().superRefine((v, ctx) => {
  if ((v.bid === null) !== (v.bidOrigin === 'unknown')) ctx.addIssue({ code: 'custom', message: 'Bid origin requires bid evidence' });
  if (v.bidOrigin === 'inherited' && (!v.inheritance || v.inheritance.defaultBidObservedAt !== v.bid?.provenance.observedAt || v.inheritance.targetBidAbsentAt > v.observedAt)) ctx.addIssue({ code: 'custom', message: 'Inherited bid requires observed absence and default provenance' });
  if (v.observedAt > v.collectedAt) ctx.addIssue({ code: 'custom', message: 'Future observation' });
  for (const p of [v.bid?.provenance, v.placementProvenance, v.audienceProvenance]) {
    if (p && (p.observedAt > v.observedAt || p.collectedAt > v.collectedAt)) ctx.addIssue({ code: 'custom', message: 'Component time exceeds observation time' });
  }
});
export type EffectiveBidObservation = z.infer<typeof EffectiveBidObservation>;
export const ConfiguredBidScenario = z.object({ placement: z.enum(['topOfSearch', 'productPages', 'restOfSearch']),
  percentage: z.number().nonnegative(), configuredExposure: z.number().nonnegative() });
export const EffectiveBidProjection = z.object({ observation: EffectiveBidObservation, date: z.iso.date(),
  observedBid: z.number().nonnegative().nullable(), scenarios: z.array(ConfiguredBidScenario), configuredExposure: z.number().nonnegative().nullable(),
  composition: z.enum(['placement_only', 'unsupported_audience', 'incomplete', 'different_observation_days']),
});
export type EffectiveBidProjection = z.infer<typeof EffectiveBidProjection>;

const field = <K extends string, V extends z.ZodType>(name: K, value: V) => z.object({ field: z.literal(name), value, provenance: CollectorProvenance }).strict();
export const ListingFieldObservation = z.discriminatedUnion('field', [
  field('price', z.number().finite().nonnegative()), field('buyBoxPrice', z.number().finite().nonnegative()),
  field('rating', z.number().min(0).max(5)), field('reviewCount', z.number().int().nonnegative()),
  field('bsr', z.object({ category: identity, rank: z.number().int().positive() }).strict()),
  field('lightningDeal', z.boolean()), field('coupon', z.tuple([z.number().finite(), z.number().finite()])),
  field('inStock', z.boolean()), field('ownsBuyBox', z.boolean()), field('suppressed', z.boolean()),
  field('title', z.string().min(1).max(2000)),
]);
export type ListingFieldObservation = z.infer<typeof ListingFieldObservation>;
export const ListingSnapshot = z.object({ scope: CollectorScope, asin: z.string().regex(/^[A-Z0-9]{10}$/),
  sourceIdentity: identity, collectedAt: instant, fields: z.array(ListingFieldObservation).min(1).max(11),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.fields.map((f) => f.field)).size !== v.fields.length) ctx.addIssue({ code: 'custom', message: 'Duplicate listing field' });
  if (v.fields.some((f) => f.provenance.collectedAt > v.collectedAt)) ctx.addIssue({ code: 'custom', message: 'Field collection exceeds snapshot' });
});
export type ListingSnapshot = z.infer<typeof ListingSnapshot>;
export const ListingChange = z.object({ id: identity, scope: CollectorScope, asin: z.string(),
  previous: ListingFieldObservation.nullable(), current: ListingFieldObservation, certainty: CreativeChangeCertainty,
});
export type ListingChange = z.infer<typeof ListingChange>;
export const ListingExport = z.object({ scope: CollectorScope, rows: z.array(ListingSnapshot).min(1).max(1000) }).strict()
  .refine((v) => v.rows.every((r) => JSON.stringify(r.scope) === JSON.stringify(v.scope)), 'Cross-profile listing export');
export type ListingExport = z.infer<typeof ListingExport>;
export const StoredCollectorExport = z.object({ id: Uuid, scope: CollectorScope,
  family: z.enum(['listing', 'prompts']), enabled: z.boolean(),
  /** Relative to an operator-configured root; never supplied by the job caller. */
  objectKey: z.string().min(1).max(500).regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
    .refine((v) => !v.split('/').some((p) => p === '..' || p === '.' || p === ''), 'Invalid object key'),
}).strict();
export type StoredCollectorExport = z.infer<typeof StoredCollectorExport>;
const CollectorReceiptAccounting = z.object({ counts: IngestionCounts,
  inserted: z.number().int().nonnegative(), alreadyPresent: z.number().int().nonnegative(),
  outputIdentities: z.array(identity), observedAt: instant.nullable(),
  state: z.enum(['measured', 'partial', 'missing', 'disabled', 'unconfigured']),
}).strict().superRefine((v, ctx) => {
  if (v.inserted + v.alreadyPresent !== v.counts.loadedRows || v.outputIdentities.length !== v.counts.loadedRows
    || new Set(v.outputIdentities).size !== v.outputIdentities.length) ctx.addIssue({ code: 'custom', message: 'Output identities do not reconcile' });
  if (v.state === 'measured' && (v.observedAt === null || v.counts.loadedRows === 0 || v.counts.refusedRows > 0)) ctx.addIssue({ code: 'custom', message: 'Measured coverage requires evidence' });
});
export const CollectorReceipt = CollectorReceiptAccounting.safeExtend({
  /** Import accounting is distinct from the stable coverage readback grain. */
  sourceImports: z.array(z.object({ referenceId: Uuid, receipt: CollectorReceiptAccounting }).strict()).optional(),
});
export type CollectorReceipt = z.infer<typeof CollectorReceipt>;
export const ListingEvidence = z.object({ scope: CollectorScope, asin: z.string(), fields: z.array(z.object({
  observation: ListingFieldObservation, availability: z.enum(['measured', 'stale']),
})), availability: z.enum(['absent', 'partial', 'measured', 'stale']), moderation: z.literal('unavailable') });
export type ListingEvidence = z.infer<typeof ListingEvidence>;

/** Validated at every collector reader boundary. */
export const CollectorTimezone = z.string().min(1).refine((value) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Invalid profile timezone');
export const CollectorProfile = z.object({ scope: CollectorScope, timezone: CollectorTimezone, enabled: z.boolean() }).strict();
export type CollectorProfile = z.infer<typeof CollectorProfile>;
export const EffectiveBidHistory = z.object({ timezone: CollectorTimezone, observations: z.array(EffectiveBidObservation) }).strict();
export type EffectiveBidHistory = z.infer<typeof EffectiveBidHistory>;
export const ListingEvidenceCollection = z.array(ListingEvidence);
export type ListingEvidenceCollection = z.infer<typeof ListingEvidenceCollection>;
export const ListingChanges = z.array(ListingChange);
export type ListingChanges = z.infer<typeof ListingChanges>;
export const CollectorExportReferences = z.array(StoredCollectorExport);
export type CollectorExportReferences = z.infer<typeof CollectorExportReferences>;
export const ListingChangeInput = z.object({
  id: identity, scope: CollectorScope, asin: z.string().regex(/^[A-Z0-9]{10}$/),
  previous: ListingFieldObservation.nullable(), current: ListingFieldObservation,
  timezone: CollectorTimezone, hasEarlierObservation: z.boolean(),
}).strict().refine((value) => value.previous === null || value.previous.field === value.current.field, 'Listing boundary fields differ');
export type ListingChangeInput = z.infer<typeof ListingChangeInput>;
export const CollectorRefusalCode = z.enum(['malformed_content', 'scope_mismatch', 'unauthorized_reference', 'invalid_file_bounds']);
export type CollectorRefusalCode = z.infer<typeof CollectorRefusalCode>;
export const CollectorRefusal = z.object({ code: CollectorRefusalCode, detail: z.string().min(1).max(500) }).strict();
export type CollectorRefusal = z.infer<typeof CollectorRefusal>;
