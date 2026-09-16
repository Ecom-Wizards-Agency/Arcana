import { z } from 'zod';
import { ProviderGraphAssociation, ProviderGraphScope, ProviderGraphStoredEvidence } from './provider-graph.js';
import { AdProduct, Region, Uuid } from './primitives.js';

/** Separate from the seven hourly ledger datasets; no DSP admission. */
export const StreamExtensionDataset = z.enum([
  'sponsored-ads-campaign-diagnostics-recommendations', 'sp-budget-recommendations',
  'ads-campaign-management-campaigns', 'ads-campaign-management-adgroups',
  'ads-campaign-management-ads', 'ads-campaign-management-targets',
  'sb-clickstream', 'sb-rich-media',
]);
export type StreamExtensionDataset = z.infer<typeof StreamExtensionDataset>;
const id = z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(256);
const count = z.number().int().nonnegative();
const time = z.iso.datetime();
export const StreamExtensionBinding = z.object({
  orgId: Uuid, profileId: Uuid, datasetId: StreamExtensionDataset,
  subscriptionId: id, advertiserId: id, marketplaceId: id, region: Region,
  destinationArn: z.string().regex(/^arn:aws:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/),
  enabled: z.boolean().default(false), confirmed: z.boolean().default(false),
  /** Exact adapter version approved for this binding; fixture versions are never live evidence. */
  contractVersion: id, capabilityVerified: z.boolean().default(false),
}).strict();
export type StreamExtensionBinding = z.infer<typeof StreamExtensionBinding>;
const dimension = {
  entityId: id, adProduct: AdProduct, operation: z.enum(['patch', 'tombstone']),
  name: z.string().max(500).optional(), state: z.enum(['enabled', 'paused', 'archived']).optional(),
};
export const StreamCampaignObservation = z.object({ ...dimension }).strict();
export const StreamAdGroupObservation = z.object({ ...dimension, campaignId: id }).strict();
export const StreamAdObservation = z.object({ ...dimension, campaignId: id, adGroupId: id,
  assetId: id.optional(), assetVersion: id.optional(), asin: z.string().regex(/^[A-Z0-9]{10}$/).optional(),
}).strict().refine((v) => (v.assetId === undefined) === (v.assetVersion === undefined), 'asset identity needs its version');
export const StreamTargetObservation = z.object({ ...dimension, campaignId: id, adGroupId: id }).strict();
export const StreamDiagnosticsObservation = z.object({ campaignId: id, diagnosticCode: id,
  recommendationId: id, severity: z.enum(['info', 'warning', 'critical']),
}).strict();
/** Held as source evidence until the WP-312 canonical provider contract is available. */
export const StreamBudgetObservation = z.object({ campaignId: id, recommendationId: id,
  currency: z.string().regex(/^[A-Z]{3}$/), recommendedBudget: z.number().finite().nonnegative(),
}).strict();
/** Explicit aggregate contract; there is no person, request, device or click identity. */
export const StreamClickAggregate = z.object({ campaignId: id, creativeId: id, clicks: count }).strict();
export const StreamRichMediaAggregate = z.object({ campaignId: id, creativeId: id,
  engagements: count,
}).strict();
const common = {
  contractVersion: id, subscriptionId: id, advertiserId: id, marketplaceId: id, region: Region,
  destinationArn: StreamExtensionBinding.shape.destinationArn,
  eventId: id, revision: count, eventTime: time,
  window: z.object({ start: time, end: time }).strict().refine((v) => v.start < v.end, 'empty or reversed window').nullable(),
};
/** Canonical adapter envelope, not a claim about an unverified provider wire schema. */
export const StreamExtensionRecord = z.discriminatedUnion('datasetId', [
  z.object({ ...common, datasetId: z.literal(StreamExtensionDataset.enum['sponsored-ads-campaign-diagnostics-recommendations']), observation: StreamDiagnosticsObservation }).strict(),
  z.object({ ...common, datasetId: z.literal('sp-budget-recommendations'), observation: StreamBudgetObservation }).strict(),
  z.object({ ...common, datasetId: z.literal('ads-campaign-management-campaigns'), observation: StreamCampaignObservation }).strict(),
  z.object({ ...common, datasetId: z.literal('ads-campaign-management-adgroups'), observation: StreamAdGroupObservation }).strict(),
  z.object({ ...common, datasetId: z.literal('ads-campaign-management-ads'), observation: StreamAdObservation }).strict(),
  z.object({ ...common, datasetId: z.literal('ads-campaign-management-targets'), observation: StreamTargetObservation }).strict(),
  z.object({ ...common, datasetId: z.literal('sb-clickstream'), observation: StreamClickAggregate }).strict(),
  z.object({ ...common, datasetId: z.literal('sb-rich-media'), observation: StreamRichMediaAggregate }).strict(),
]).superRefine((v, ctx) => {
  if ((v.datasetId === 'sb-clickstream' || v.datasetId === 'sb-rich-media') && v.window === null)
    ctx.addIssue({ code: 'custom', message: 'aggregate measures require a source window' });
});
export type StreamExtensionRecord = z.infer<typeof StreamExtensionRecord>;
export const StreamExtensionEvent = z.object({
  orgId: Uuid, profileId: Uuid, identity: z.string().regex(/^[a-f0-9]{64}$/),
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/), receivedAt: time, record: StreamExtensionRecord,
}).strict();
export type StreamExtensionEvent = z.infer<typeof StreamExtensionEvent>;
export const StreamExtensionCounts = z.object({
  received: z.literal(1), undecodable: z.union([z.literal(0), z.literal(1)]), decoded: count, accepted: count, deduplicated: count,
  stored: count, rejected: count, deadLettered: z.union([z.literal(0), z.literal(1)]),
  verifiedStored: count,
}).strict().superRefine((v, ctx) => {
  if ((v.decoded === 0 ? 1 : 0) !== v.undecodable || v.decoded !== v.accepted + v.rejected || v.accepted !== v.stored + v.deduplicated
    || v.verifiedStored !== v.stored + v.deduplicated)
    ctx.addIssue({ code: 'custom', message: 'extension delivery counts do not reconcile' });
});
export type StreamExtensionCounts = z.infer<typeof StreamExtensionCounts>;
export const StreamExtensionRefusal = z.enum(['invalid_json', 'unsupported_schema', 'binding_mismatch',
  'disabled', 'unconfirmed', 'revision_conflict', 'unsafe_confirmation']);
export type StreamExtensionRefusal = z.infer<typeof StreamExtensionRefusal>;
export const StreamExtensionReceipt = z.object({
  deliveryId: z.string().regex(/^[a-f0-9]{64}$/), bodyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  receivedAt: time, outcome: z.enum(['accepted', 'rejected']), reason: StreamExtensionRefusal.nullable(),
  counts: StreamExtensionCounts,
}).strict().refine((v) => (v.outcome === 'accepted') === (v.reason === null), 'receipt outcome and reason disagree');
export type StreamExtensionReceipt = z.infer<typeof StreamExtensionReceipt>;
export const StreamExtensionEvidence = z.object({
  events: z.array(StreamExtensionEvent), source: z.literal('amazon_marketing_stream'),
  completeness: z.enum(['missing', 'partial', 'stale']), selectionAuthority: z.literal(false),
  count: count,
}).strict().refine((v) => v.events.length === v.count, 'reader count mismatch');
export type StreamExtensionEvidence = z.infer<typeof StreamExtensionEvidence>;

export const StreamExtensionHealth = z.object({
  datasetId: StreamExtensionDataset, bindingCount: count, enabled: z.boolean(), confirmed: z.boolean(),
  stored: count, latestEventAt: time.nullable(), maximumLagSeconds: z.number().nullable(),
  /** Unmatched refusal receipts are infrastructure-only, not attributed to a guessed tenant. */
  duplicates: count.nullable(), rejected: count.nullable(), deadLettered: count.nullable(),
}).strict();
export type StreamExtensionHealth = z.infer<typeof StreamExtensionHealth>;

/** Consumer evidence remains separate from report totals and local write history. */
export const StreamConsumerEvidence = z.object({
  events: z.array(StreamExtensionEvent),
  measured: count, unresolved: count,
  associations: z.array(ProviderGraphAssociation).default([]),
  staleEventIds: z.array(z.string()).default([]), excluded: count.default(0), truncated: z.boolean().default(false),
  completeness: z.enum(['missing', 'partial', 'stale']),
  source: z.literal('amazon_marketing_stream'),
  mutationAuthority: z.literal(false),
}).strict().refine((v) => v.measured === v.events.length, 'consumer readback count mismatch');
export type StreamConsumerEvidence = z.infer<typeof StreamConsumerEvidence>;

/** WP-292/WP-312 may consume advice; observed budget usage remains a separate fact. */
export const StreamBudgetHandoff = z.object({
  event: StreamExtensionEvent.refine((v) => v.record.datasetId === 'sp-budget-recommendations'),
  transport: z.literal('marketing_stream'),
  kind: z.literal('provider_budget_recommendation'),
  observedUsage: z.null(), approvalAuthority: z.literal(false),
}).strict();
export type StreamBudgetHandoff = z.infer<typeof StreamBudgetHandoff>;

export const EvidenceReconciliationCounts = z.object({
  requested: count, attempted: count, succeeded: count, failed: count, refused: count,
}).strict().refine((v) => v.requested === v.succeeded + v.failed + v.refused
  && v.attempted >= v.succeeded + v.failed && v.attempted <= v.requested, 'reconciliation counts do not agree');
export type EvidenceReconciliationCounts = z.infer<typeof EvidenceReconciliationCounts>;

export const StreamConsumerSource = z.object({
  events: z.array(StreamExtensionEvent), graph: ProviderGraphStoredEvidence,
  scope: ProviderGraphScope, truncated: z.boolean(),
}).strict();
export type StreamConsumerSource = z.infer<typeof StreamConsumerSource>;
export interface StreamConsumerSelection {
  asOf: string; maxAgeMs: number; from?: string; to?: string; campaignId?: string | null;
  assetId?: string | null; entityId?: string | null; asin?: string | null; history?: boolean;
}
