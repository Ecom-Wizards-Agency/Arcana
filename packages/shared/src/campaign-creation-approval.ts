import { z } from 'zod';
import { Uuid } from './primitives.js';
import { AssetLibraryObservation } from './asset-library.js';
import {
  CampaignCreationPlan, CampaignCreationProviderScope, CampaignCreationSha256,
  CampaignCreationAuthorizationReceipt, CampaignCreationExecutionEvidence,
  CampaignCreationExecutionSnapshot,
} from './campaign-creation.js';

/** Identifies an existing record. Loading never generates or saves a plan. */
export const CampaignCreationApprovalRequest = z.object({ profileId: Uuid, planId: Uuid }).strict();
export type CampaignCreationApprovalRequest = z.infer<typeof CampaignCreationApprovalRequest>;

/** Stable failures for recorded previews; no raw database/provider diagnostics cross the boundary. */
export const CampaignCreationPreviewErrorCode = z.enum([
  'invalid_request', 'not_found', 'authorization_refused', 'identity_conflict', 'unavailable',
]);
export type CampaignCreationPreviewErrorCode = z.infer<typeof CampaignCreationPreviewErrorCode>;

/** Server-derived expected ownership; this is not request JSON or proof of membership. */
export const CampaignCreationApprovalScope = CampaignCreationApprovalRequest.extend({ orgId: Uuid }).strict();
export type CampaignCreationApprovalScope = z.infer<typeof CampaignCreationApprovalScope>;

/** One dated capability/eligibility check for the exact node in this complete plan. */
export const CampaignCreationReviewCheck = z.object({
  nodeId: Uuid, nodeFingerprint: CampaignCreationSha256,
  result: z.enum(['passed', 'blocked', 'unknown']),
  reason: z.enum(['unsupported', 'ineligible', 'unverified', 'unavailable']).nullable(),
  checkedAt: z.iso.datetime().nullable(), validUntil: z.iso.datetime().nullable(),
}).strict().superRefine((check, context) => {
  if ((check.result === 'passed') !== (check.reason === null)
    || (check.result === 'blocked' && !['unsupported', 'ineligible'].includes(check.reason ?? ''))
    || (check.result === 'unknown' && !['unverified', 'unavailable'].includes(check.reason ?? ''))
    || (check.result !== 'unknown' && (check.checkedAt === null || check.validUntil === null))
    || (check.checkedAt === null) !== (check.validUntil === null)
    || (check.checkedAt !== null && check.validUntil !== null
      && Date.parse(check.validUntil) <= Date.parse(check.checkedAt))) {
    context.addIssue({ code: 'custom', message: 'check result needs consistent dated evidence and reason' });
  }
});
export type CampaignCreationReviewCheck = z.infer<typeof CampaignCreationReviewCheck>;

export const CampaignCreationReviewAsset = z.object({
  nodeId: Uuid,
  /** Evidence about the selected version, never a substitute chosen from latest search. */
  observation: AssetLibraryObservation.nullable(),
  /** Creative moderation needs a created ad/creative identity, absent from library metadata. */
  moderation: z.literal('unknown'),
}).strict();
export type CampaignCreationReviewAsset = z.infer<typeof CampaignCreationReviewAsset>;

const profile = z.object({ id: Uuid, label: z.string().min(1) }).strict();
const current = z.object({
  orgId: Uuid, profileId: Uuid, planFingerprint: CampaignCreationSha256,
  providerScope: CampaignCreationProviderScope.nullable(),
  checks: z.array(CampaignCreationReviewCheck), assets: z.array(CampaignCreationReviewAsset),
}).strict();
const sourceAdmission = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('recorded'), receipt: CampaignCreationAuthorizationReceipt,
    execution: CampaignCreationExecutionEvidence.nullable() }).strict(),
]);

const snapshotShape = { plan: CampaignCreationPlan, profile, checkedAt: z.iso.datetime(), current };
type Snapshot = z.infer<z.ZodObject<typeof snapshotShape>>;

function checkSnapshot(value: Snapshot, context: z.RefinementCtx): void {
  const { plan } = value;
  const now = Date.parse(value.checkedAt);
  if (value.profile.id !== plan.profileId || value.current.orgId !== plan.orgId
    || value.current.profileId !== plan.profileId || value.current.planFingerprint !== plan.fingerprint
    || now < Date.parse(plan.frozenAt)) {
    context.addIssue({ code: 'custom', message: 'review snapshot differs from its saved plan scope or time' });
  }
  const nodes = new Map(plan.nodes.map((node) => [node.nodeId, node]));
  if (value.current.checks.length !== nodes.size
    || new Set(value.current.checks.map((check) => check.nodeId)).size !== nodes.size
    || value.current.checks.some((check) => nodes.get(check.nodeId)?.fingerprint !== check.nodeFingerprint
      || (check.checkedAt !== null && Date.parse(check.checkedAt) > now))) {
    context.addIssue({ code: 'custom', path: ['current', 'checks'], message: 'checks must cover the exact nodes without future evidence' });
  }
  const assets = plan.nodes.filter((node) => node.kind === 'asset.require_existing');
  if (value.current.assets.length !== assets.length
    || new Set(value.current.assets.map((asset) => asset.nodeId)).size !== assets.length
    || value.current.assets.some((asset) => !assets.some((node) => node.nodeId === asset.nodeId)
      || (asset.observation !== null && (Date.parse(asset.observation.observedAt) > now
        || plan.schemaVersion !== 'openspell.campaign-creation-plan.v2'
        || asset.observation.scope.region !== plan.providerScope.region
        || asset.observation.scope.amazonProfileId !== plan.providerScope.amazonProfileId)))) {
    context.addIssue({ code: 'custom', path: ['current', 'assets'], message: 'asset rows must cover the selected nodes in their frozen scope' });
  }
}

/** Server-only source evidence. A schema cannot establish that these records were persisted. */
export const CampaignCreationApprovalSource = z.object({ ...snapshotShape, admission: sourceAdmission })
  .strict().superRefine((value, context) => {
    checkSnapshot(value, context);
    if (value.admission.kind !== 'recorded') return;
    const { plan } = value;
    const { receipt, execution } = value.admission;
    if (receipt.planId !== plan.id || receipt.planFingerprint !== plan.fingerprint
      || receipt.schemaVersion !== plan.schemaVersion || receipt.orgId !== plan.orgId
      || receipt.profileId !== plan.profileId || receipt.marketplaceId !== plan.marketplaceId
      || receipt.adProduct !== plan.adProduct || receipt.apiDialect !== plan.apiDialect
      || receipt.expiresAt !== plan.expiresAt
      || JSON.stringify(receipt.expectedCounts) !== JSON.stringify(plan.counts)
      || JSON.stringify(receipt.noRollbackAcknowledgement) !== JSON.stringify(plan.noRollbackAcknowledgement)
      || Date.parse(receipt.approvedAt) < Date.parse(plan.frozenAt)
      || Date.parse(receipt.approvedAt) > Date.parse(value.checkedAt)) {
      context.addIssue({ code: 'custom', path: ['admission'], message: 'admission must bind the complete saved plan and approval time' });
    }
    if (execution !== null && (
      JSON.stringify(execution.plan) !== JSON.stringify(plan) || execution.executionId !== receipt.executionId
      || execution.providerCallIntents.some((intent) => intent.authorizationId !== receipt.authorizationId
        || intent.generation !== receipt.generation || Date.parse(intent.recordedAt) < Date.parse(receipt.approvedAt)
        || Date.parse(intent.recordedAt) > Date.parse(value.checkedAt))
      || execution.providerResults.some((result) => Date.parse(result.startedAt) < Date.parse(receipt.approvedAt)
        || Date.parse(result.completedAt) > Date.parse(value.checkedAt))
      || execution.observations.some((observation) => observation.authorizationId !== receipt.authorizationId
        || observation.generation !== receipt.generation || Date.parse(observation.observedAt) > Date.parse(value.checkedAt))
    )) {
      context.addIssue({ code: 'custom', path: ['admission', 'execution'], message: 'execution differs from the recorded admission' });
    }
  });
export type CampaignCreationApprovalSource = z.infer<typeof CampaignCreationApprovalSource>;

export const CampaignCreationReviewReason = z.enum([
  'plan_expired', 'legacy_plan', 'profile_unavailable', 'profile_changed',
  'check_unknown', 'check_blocked', 'check_stale', 'asset_unavailable',
  'asset_identity_mismatch', 'asset_processing', 'asset_type_mismatch', 'asset_check_mismatch',
]);
export type CampaignCreationReviewReason = z.infer<typeof CampaignCreationReviewReason>;

const freshness = z.object({
  status: z.enum(['current', 'stale', 'unavailable']), reasons: z.array(CampaignCreationReviewReason),
}).strict();

/** Zod's UTC instant spellings may omit seconds or fractional trailing zeroes. */
function canonicalInstant(value: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?Z$/.exec(value ?? '');
  return match === null ? null : `${match[1]}:${match[2] ?? '00'}.${(match[3] ?? '').replace(/0+$/, '')}Z`;
}

/** Display freshness only. No gate, allowance, membership or execution permission is implied. */
export function campaignCreationReviewFreshness(value: Snapshot): z.infer<typeof freshness> {
  const reasons = new Set<CampaignCreationReviewReason>();
  const { plan } = value;
  const now = Date.parse(value.checkedAt);
  if (now >= Date.parse(plan.expiresAt)) reasons.add('plan_expired');
  if (plan.schemaVersion === 'openspell.campaign-creation-plan.v1') reasons.add('legacy_plan');
  if (value.current.providerScope === null) reasons.add('profile_unavailable');
  else if (plan.schemaVersion === 'openspell.campaign-creation-plan.v2'
    && JSON.stringify(value.current.providerScope) !== JSON.stringify(plan.providerScope)) reasons.add('profile_changed');
  for (const check of value.current.checks) {
    if (check.result === 'unknown') reasons.add('check_unknown');
    if (check.result === 'blocked') reasons.add('check_blocked');
    if (check.validUntil !== null && now >= Date.parse(check.validUntil)) reasons.add('check_stale');
  }
  for (const asset of value.current.assets) {
    const node = plan.nodes.find((entry) => entry.nodeId === asset.nodeId);
    if (asset.observation === null) reasons.add('asset_unavailable');
    else {
      if (node?.kind !== 'asset.require_existing'
        || asset.observation.identity.assetId !== node.payload.assetId
        || asset.observation.identity.version !== node.payload.version) reasons.add('asset_identity_mismatch');
      if (asset.observation.processing !== 'active') reasons.add('asset_processing');
      const expectedType = node?.kind === 'asset.require_existing'
        ? node.payload.purpose === 'video' ? 'video'
          : node.payload.purpose === 'image' || node.payload.purpose === 'logo' ? 'image' : null
        : null;
      if (expectedType === null || asset.observation.assetType !== expectedType) reasons.add('asset_type_mismatch');
      // The check validity horizon belongs to this exact observation event, not newly
      // stamped eligibility applied to older/different processing evidence.
      const check = value.current.checks.find((entry) => entry.nodeId === asset.nodeId);
      if (canonicalInstant(check?.checkedAt) !== canonicalInstant(asset.observation.observedAt)) reasons.add('asset_check_mismatch');
    }
  }
  const unavailable = ['legacy_plan', 'profile_unavailable', 'check_unknown', 'check_blocked',
    'asset_unavailable', 'asset_identity_mismatch', 'asset_processing', 'asset_type_mismatch', 'asset_check_mismatch'] as const;
  return { status: unavailable.some((reason) => reasons.has(reason)) ? 'unavailable'
    : reasons.size > 0 ? 'stale' : 'current', reasons: [...reasons] };
}

const viewAdmission = z.discriminatedUnion('kind', [
  sourceAdmission.options[0], sourceAdmission.options[1],
  z.object({ kind: z.literal('recorded'), executionId: Uuid, approvedBy: Uuid,
    approvedAt: z.iso.datetime(), snapshot: CampaignCreationExecutionSnapshot.nullable() }).strict(),
]);

/** Exact rendering data. Worker intents, raw responses and execution authority are not exposed. */
export const CampaignCreationApprovalView = z.object({
  schemaVersion: z.literal('openspell.campaign-creation-approval-view.v1'),
  ...snapshotShape,
  freshness,
  recordedContext: z.object({
    guardrails: z.literal('not_recorded'), provenance: z.literal('not_recorded'),
    frozenProfileLabel: z.literal('not_recorded'),
  }).strict(),
  admission: viewAdmission,
}).strict().superRefine((value, context) => {
  checkSnapshot(value, context);
  if (JSON.stringify(value.freshness) !== JSON.stringify(campaignCreationReviewFreshness(value))) {
    context.addIssue({ code: 'custom', path: ['freshness'], message: 'freshness must derive from the dated source evidence' });
  }
  if (value.admission.kind === 'recorded' && (
    Date.parse(value.admission.approvedAt) < Date.parse(value.plan.frozenAt)
    || Date.parse(value.admission.approvedAt) >= Date.parse(value.plan.expiresAt)
    || Date.parse(value.admission.approvedAt) > Date.parse(value.checkedAt)
    || (value.admission.snapshot !== null && (
      value.admission.snapshot.accounting.operatorApproved !== value.plan.counts.irreversibleCreates
      || value.admission.snapshot.accounting.readChecksRequested !== value.plan.counts.readChecks
    ))
  )) context.addIssue({ code: 'custom', path: ['admission'], message: 'display admission differs from the saved plan' });
});
export type CampaignCreationApprovalView = z.infer<typeof CampaignCreationApprovalView>;
