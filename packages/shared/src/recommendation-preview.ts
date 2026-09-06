/** Version-compatible HTTP results for persisted, read-only recommendation previews. */
import { z } from 'zod';
import { OneTimeRpcSnapshot, ONE_TIME_PREVIEW_CAMPAIGN_MAX } from './one-time-optimization.js';

const Count = z.number().int().nonnegative();
const CampaignCount = z.number().int().positive().max(ONE_TIME_PREVIEW_CAMPAIGN_MAX);
export const RecommendationPreviewStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type RecommendationPreviewStatus = z.infer<typeof RecommendationPreviewStatus>;

export const RecommendationPreviewAccepted = z.object({
  batchId: z.string().min(1),
  status: z.literal('queued'),
  scope: z.object({ mode: z.enum(['all', 'selected']), campaignCount: CampaignCount,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  childCount: CampaignCount,
}).refine((result) => result.childCount <= result.scope.campaignCount, 'A run must contain at least one campaign.');
export type RecommendationPreviewAccepted = z.infer<typeof RecommendationPreviewAccepted>;

/** Complete aggregate counts; bounded examples and provider errors stay out of HTTP status. */
export const RecommendationPreviewDiagnostics = z.object({
  targetsRead: Count,
  targetsConsidered: Count,
  proposed: Count,
  suppressed: Count,
  declined: Count,
  blockedOutOfStock: Count,
  skippedInactive: Count,
  skippedMissingStrategy: Count,
  corridorsAvailable: Count,
  corridorsMissing: Count,
  preconditionNotes: Count,
  declinedReasons: z.record(z.string(), Count),
});
export type RecommendationPreviewDiagnostics = z.infer<typeof RecommendationPreviewDiagnostics>;

export const RecommendationPreviewChildStatus = z.object({
  runId: z.string().min(1),
  groupName: z.string().nullable(),
  status: RecommendationPreviewStatus,
  campaignCount: CampaignCount,
  proposalsCount: Count,
  // Additive fields keep historical and in-flight v1 responses readable.
  outcome: z.enum(['queued', 'running', 'completed', 'empty', 'failed']).optional(),
  detail: z.string().max(1_000).optional(),
  diagnostics: RecommendationPreviewDiagnostics.optional(),
});
export type RecommendationPreviewChildStatus = z.infer<typeof RecommendationPreviewChildStatus>;

export const RecommendationPreviewBatchStatus = z.object({
  batchId: z.string().min(1),
  status: RecommendationPreviewStatus,
  campaignCount: CampaignCount,
  proposalsCount: Count,
  children: z.array(RecommendationPreviewChildStatus).min(1).max(ONE_TIME_PREVIEW_CAMPAIGN_MAX),
  executionSnapshot: OneTimeRpcSnapshot.optional(),
}).superRefine((batch, context) => {
  if (new Set(batch.children.map((child) => child.runId)).size !== batch.children.length) {
    context.addIssue({ code: 'custom', path: ['children'], message: 'Preview run identities must be distinct.' });
  }
  if (batch.children.reduce((count, child) => count + child.campaignCount, 0) !== batch.campaignCount ||
      batch.children.reduce((count, child) => count + child.proposalsCount, 0) !== batch.proposalsCount) {
    context.addIssue({ code: 'custom', path: ['children'], message: 'Preview totals must match the complete run roster.' });
  }
});
export type RecommendationPreviewBatchStatus = z.infer<typeof RecommendationPreviewBatchStatus>;

/** Compiled execution support; deployment configuration cannot claim extra formats. */
export const RECOMMENDATION_EXECUTION_VERSIONS = [1, 2] as const;
export const OneTimePreviewUnavailableReason = z.enum([
  'misconfigured', 'worker_not_activated', 'admission_paused', 'revision_mismatch',
  'worker_unavailable', 'execution_unsupported', 'authority_unavailable',
]);
export type OneTimePreviewUnavailableReason = z.infer<typeof OneTimePreviewUnavailableReason>;
export const OneTimePreviewReadiness = z.discriminatedUnion('ready', [
  z.object({ ready: z.literal(true), mode: z.literal('fenced') }),
  z.object({ ready: z.literal(false), reason: OneTimePreviewUnavailableReason }),
]);
export type OneTimePreviewReadiness = z.infer<typeof OneTimePreviewReadiness>;
