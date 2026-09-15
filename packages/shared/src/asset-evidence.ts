import { z } from 'zod';
import { AmazonId } from './primitives.js';
import { AssetLibraryIdentity, AssetLibraryScope } from './asset-library.js';

export const AssetModerationStatus = z.enum(['pending', 'approved', 'rejected', 'unknown']);
export type AssetModerationStatus = z.infer<typeof AssetModerationStatus>;

/** The caller obtains marketplace and program from authenticated profile/creative context. */
export const AssetModerationContext = z.object({
  scope: AssetLibraryScope, marketplace: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  program: z.string().regex(/^[A-Z0-9_]{1,100}$/),
}).strict();
export type AssetModerationContext = z.infer<typeof AssetModerationContext>;

/** Ad/creative versions are never treated as Asset Library versions. */
export const AssetModerationObservation = z.object({
  context: AssetModerationContext,
  subject: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ad'), adId: AmazonId, adVersion: z.string().min(1) }).strict(),
    z.object({ kind: z.literal('creative'), creativeId: AmazonId, creativeVersion: z.string().min(1).nullable() }).strict(),
    z.object({ kind: z.literal('component'), componentId: AmazonId, requestId: z.string().min(1) }).strict(),
  ]),
  /** Populated only after a counted, exact graph association has resolved. */
  assetIdentity: AssetLibraryIdentity.nullable(),
  stage: z.enum(['final', 'pre_moderation']),
  source: z.enum(['moderation_v4', 'unified_pre_moderation_v1', 'sd_moderation']),
  status: AssetModerationStatus,
  reasons: z.array(z.string().max(4000)).max(200),
  observedAt: z.iso.datetime(),
  contractVersion: z.literal('wp313.v1'),
}).strict().superRefine((value, context) => {
  if ((value.source === 'unified_pre_moderation_v1') !== (value.stage === 'pre_moderation')) {
    context.addIssue({ code: 'custom', message: 'moderation source and stage disagree' });
  }
});
export type AssetModerationObservation = z.infer<typeof AssetModerationObservation>;

export const AssetEligibilityEvidence = z.object({
  context: AssetModerationContext, identity: AssetLibraryIdentity,
  canRun: z.enum(['eligible', 'ineligible', 'unknown']),
  selectable: z.boolean(), status: AssetModerationStatus,
  evidenceState: z.enum(['measured', 'partial', 'stale', 'missing']),
  reasons: z.array(z.string().max(4000)), observedAt: z.iso.datetime().nullable(),
}).strict().superRefine((value, context) => {
  if (value.selectable && (value.canRun !== 'eligible' || value.status !== 'approved' || value.evidenceState !== 'measured')) {
    context.addIssue({ code: 'custom', message: 'selection requires current final approval' });
  }
});
export type AssetEligibilityEvidence = z.infer<typeof AssetEligibilityEvidence>;

export const AssetEvidencePersistenceCounts = z.object({
  source: z.number().int().nonnegative(), duplicates: z.number().int().nonnegative(),
  canonical: z.number().int().nonnegative(), stored: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(), verified: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
}).strict().refine((value) => value.source === value.duplicates + value.canonical
  && value.canonical === value.stored + value.existing && value.verified === value.canonical
  && value.unresolved <= value.canonical, { message: 'Asset evidence counts do not reconcile' });
export type AssetEvidencePersistenceCounts = z.infer<typeof AssetEvidencePersistenceCounts>;
