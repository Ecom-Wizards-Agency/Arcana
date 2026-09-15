import { z } from 'zod';
import { Uuid } from './primitives.js';

/** External advice has no Arcana approval, execution or doctrine authority. */
export const ProviderEvidenceFamily = z.enum(['tactical', 'sp-budget', 'sp-research', 'sp-bid', 'sb-research', 'sb-recommendations', 'sb-forecast', 'sd-recommendations', 'sd-forecast', 'identity', 'rule-evidence', 'opportunities', 'audiences', 'benchmarks', 'target-kpi', 'reach-forecast']);
export type ProviderEvidenceFamily = z.infer<typeof ProviderEvidenceFamily>;
export const ProviderEvidenceConsumer = z.enum(['recommendations', 'targets', 'query-intelligence', 'creative', 'home', 'market-position', 'sync-status']);
export type ProviderEvidenceConsumer = z.infer<typeof ProviderEvidenceConsumer>;
export const ProviderRetrievalStatus = z.enum(['running', 'complete', 'partial', 'unsupported', 'failed']);
export const ProviderAvailability = z.enum(['not-measured', 'measured', 'partial', 'unsupported', 'stale', 'expired']);
export type ProviderAvailability = z.infer<typeof ProviderAvailability>;
const identifier = z.string().min(1).max(256);
const timestamp = z.iso.datetime({ offset: true });
export const ProviderEntity = z.strictObject({
  adProduct: z.enum(['SP', 'SB', 'SD']).nullable(),
  entityType: z.enum(['profile', 'campaign', 'ad-group', 'keyword', 'target', 'product', 'creative', 'unknown']),
  entityId: identifier.nullable(), campaignId: identifier.nullable(), adGroupId: identifier.nullable(),
  mapping: z.enum(['unresolved', 'mapped', 'missing', 'ambiguous', 'scope-mismatch']),
});
export type ProviderEntity = z.infer<typeof ProviderEntity>;
export const ProviderValue = z.strictObject({
  value: z.union([z.number().finite(), z.string().max(2000)]).nullable(),
  units: z.string().max(100).nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
});
export type ProviderValue = z.infer<typeof ProviderValue>;
export const ProviderEstimate = z.strictObject({
  label: z.literal('Amazon estimate'), metric: identifier,
  value: z.number().finite().nullable(), low: z.number().finite().nullable(), high: z.number().finite().nullable(),
  units: z.string().max(100).nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  horizon: z.string().max(256).nullable(), attribution: z.string().max(256).nullable(),
});
export type ProviderEstimate = z.infer<typeof ProviderEstimate>;
export const ProviderEvidenceScope = z.strictObject({ orgId: Uuid, profileId: Uuid, marketplaceId: identifier, amazonProfileId: identifier, countryCode: z.string().regex(/^[A-Z]{2}$/).optional() });
export type ProviderEvidenceScope = z.infer<typeof ProviderEvidenceScope>;
export const ProviderRecommendation = z.strictObject({
  family: ProviderEvidenceFamily, namespace: identifier, providerId: identifier,
  identityMethod: z.enum(['provider', 'payload-sha256']), version: z.string().regex(/^[a-f0-9]{64}$/),
  apiVersion: identifier, contractHash: z.string().regex(/^[a-f0-9]{64}$/), transport: z.literal('http'),
  scope: ProviderEvidenceScope, entity: ProviderEntity, kind: identifier,
  action: z.enum(['bid', 'budget', 'target', 'headline', 'forecast', 'eligibility', 'research', 'unknown']),
  current: ProviderValue, proposed: ProviderValue, estimates: z.array(ProviderEstimate).max(100),
  objective: identifier.nullable(), horizon: z.string().max(256).nullable(), attribution: z.string().max(256).nullable(),
  eligibility: z.enum(['eligible', 'ineligible', 'unknown', 'unsupported']),
  generatedAt: timestamp.nullable(), expiresAt: timestamp.nullable(), retrievedAt: timestamp,
  /** First observation when the provider omits generation time; preserved on replay. */
  observedAt: timestamp, payload: z.record(z.string(), z.json()),
});
export type ProviderRecommendation = z.infer<typeof ProviderRecommendation>;
const count = z.number().int().nonnegative();
export const ProviderEvidenceCounts = z.strictObject({
  source: count, parsed: count, refused: count, duplicates: count, conflicts: count,
  canonical: count, written: count, existing: count, readback: count,
}).superRefine((c, ctx) => {
  if (c.source !== c.parsed + c.refused || c.parsed !== c.canonical + c.duplicates ||
      c.canonical !== c.written + c.existing || c.canonical !== c.readback || c.conflicts > c.canonical) {
    ctx.addIssue({ code: 'custom', message: 'Provider evidence counts do not reconcile' });
  }
});
export type ProviderEvidenceCounts = z.infer<typeof ProviderEvidenceCounts>;
export const ProviderCollectionConfig = z.strictObject({
  id: Uuid, scope: ProviderEvidenceScope, family: ProviderEvidenceFamily, operation: identifier,
  enabled: z.boolean().default(false), request: z.record(z.string(), z.json()),
  maxPages: z.number().int().min(1).max(100), maxRows: z.number().int().min(1).max(10000),
  cadence: z.enum(['daily', 'weekly', 'manual']).default('manual'),
});
export type ProviderCollectionConfig = z.infer<typeof ProviderCollectionConfig>;
export const ProviderEvidencePage = z.strictObject({
  rows: z.array(ProviderRecommendation).max(10000), source: count, refused: count,
  expectedTotal: count.nullable().optional(), nextToken: z.string().max(4096).nullable(), status: z.enum(['complete', 'partial', 'unsupported']),
}).superRefine((p, ctx) => {
  if (p.source !== p.rows.length + p.refused) ctx.addIssue({ code: 'custom', message: 'Provider page counts do not reconcile' });
  if (p.status === 'unsupported' && (p.nextToken !== null || p.source !== 0)) ctx.addIssue({ code: 'custom', message: 'Unsupported capability cannot contain a page or cursor' });
});
export type ProviderEvidencePage = z.infer<typeof ProviderEvidencePage>;
export const ProviderComparison = z.strictObject({
  status: z.enum(['agrees', 'disagrees', 'not-comparable']), reason: z.string().max(256),
  amazon: ProviderValue, arcana: ProviderValue.nullable(),
});
export type ProviderComparison = z.infer<typeof ProviderComparison>;
/** Read-only projection of Arcana facts; unknown comparison dimensions stay null. */
export const ArcanaEvidenceBaseline = z.object({
  scope: ProviderEvidenceScope, entity: ProviderEntity, action: ProviderRecommendation.shape.action,
  current: ProviderValue, proposed: ProviderValue, objective: identifier.nullable(),
  horizon: z.string().nullable(), attribution: z.string().nullable(), observedAt: timestamp,
});
export type ArcanaEvidenceBaseline = z.infer<typeof ArcanaEvidenceBaseline>;
export const ProviderEvidenceRun = z.strictObject({
  id: Uuid, config: ProviderCollectionConfig, status: ProviderRetrievalStatus,
  expectedTotal: count.nullable().optional(), page: count, nextToken: z.string().max(4096).nullable(), startedAt: timestamp, incomplete: z.boolean().default(false),
  observedAt: timestamp, earliestExpiry: timestamp.nullable().optional(), counts: ProviderEvidenceCounts,
});
export type ProviderEvidenceRun = z.infer<typeof ProviderEvidenceRun>;
export const ProviderEvidenceSnapshot = z.strictObject({
  families: z.array(z.strictObject({ family: ProviderEvidenceFamily, availability: ProviderAvailability, reason: z.string(), counts: ProviderEvidenceCounts.nullable(), observedAt: timestamp.nullable() })),
  rows: z.array(z.strictObject({ recommendation: ProviderRecommendation, availability: ProviderAvailability, comparison: ProviderComparison })),
  returnedCount: count, totalCount: count, truncated: z.boolean(),
}).superRefine((s, ctx) => {
  if (s.rows.length !== s.returnedCount || s.returnedCount > s.totalCount || s.truncated !== (s.returnedCount < s.totalCount)) ctx.addIssue({ code: 'custom', message: 'Provider reader counts do not reconcile' });
});
export type ProviderEvidenceSnapshot = z.infer<typeof ProviderEvidenceSnapshot>;
export const ProviderEvidenceReadResult = z.object({
  rows: z.array(ProviderRecommendation),
  arcana: z.array(ArcanaEvidenceBaseline).optional(),
  runs: z.array(z.object({ configId: Uuid.optional(), expiresAt: timestamp.nullable().optional(), family: ProviderEvidenceFamily, status: ProviderRetrievalStatus, observedAt: timestamp, startedAt: timestamp, counts: ProviderEvidenceCounts })),
  totalCount: count,
});
export type ProviderEvidenceReadResult = z.infer<typeof ProviderEvidenceReadResult>;
export const PROVIDER_FAMILY_CONSUMERS: Readonly<Record<ProviderEvidenceFamily, readonly ProviderEvidenceConsumer[]>> = {
  tactical: ['recommendations', 'home'], 'sp-budget': ['recommendations', 'home'],
  'sp-research': ['query-intelligence', 'targets'], 'sp-bid': ['targets', 'recommendations'],
  'sb-research': ['query-intelligence'], 'sb-recommendations': ['recommendations', 'creative', 'query-intelligence'],
  'sb-forecast': ['recommendations'], 'sd-recommendations': ['recommendations', 'targets', 'creative'],
  'sd-forecast': ['recommendations'], identity: ['sync-status'], 'rule-evidence': ['recommendations'],
  opportunities: ['home', 'recommendations'], audiences: ['query-intelligence'], benchmarks: ['market-position'],
  'target-kpi': ['recommendations', 'targets'], 'reach-forecast': ['recommendations'],
};

/** No measured coverage or admission is implied by an extension's catalog entry. */
export const PROVIDER_DEFERRED_EXTENSIONS = [
  { family: 'identity', rows: ['catalog-05','catalog-07','catalog-61'], reason: 'Existing profile binding resolves current HTTP scope; no required brand/manager/account join or pinned dependency payload is available.' },
  { family: 'opportunities', rows: ['catalog-43'], reason: 'Partner Opportunity payload, eligibility and stable identity are not pinned for the Home/Recommendations measure.' },
  { family: 'audiences', rows: ['catalog-12','catalog-45'], reason: 'Audience discovery/insight payload and Query Intelligence measure are not pinned.' },
  { family: 'benchmarks', rows: ['catalog-15','catalog-16','catalog-21','report-08'], reason: 'Comparable Brand Metrics, Store and cross-program benchmark grain is not pinned. Report-backed variants require the shared report lifecycle and reporting recovery.' },
  { family: 'target-kpi', rows: ['catalog-60'], reason: 'Target KPI action, observed baseline and units are not pinned for comparison.' },
  { family: 'reach-forecast', rows: ['catalog-67'], reason: 'Cross-program reach/performance forecast objective, horizon and account binding are not pinned.' },
] as const satisfies readonly { family: ProviderEvidenceFamily; rows: readonly string[]; reason: string }[];
