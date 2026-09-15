import { z } from 'zod';
import { Uuid } from './primitives.js';
import { OrgActor } from './agency.js';
import { SpWriteSourceEvidence } from './sp-write-preview-evidence.js';
import { SpWriteMirrorCounts } from './sp-write-mirror.js';
import {
  ApproveSpWritePlan,
  SpWriteAuthorizationReceipt,
  SpWriteExecutionSnapshot,
  SpWriteObservedAction,
  SpWriteAction,
  SpWriteObservation,
  SpWritePreDispatchDisposition,
  SpWriteProviderPositionOutcome,
  SpWritePlan,
  SpWritePlanBinding,
  spWritePlanBinding,
  SpWriteForwardRowIds,
  SpWriteRetryOrigin,
} from './sp-writes.js';

/** Server authentication supplies this context; it is never part of request JSON. */
export const SpWriteActor = OrgActor;
export type SpWriteActor = z.infer<typeof SpWriteActor>;

/** Public execution prerequisites, not a reading of the worker's current environment. */
export const spWriteExecutionRequirements = Object.freeze({
  executor: 'worker',
  dispatchGate: Object.freeze({
    environmentVariable: 'OPENSPELL_SP_WRITE_DISPATCH_ENABLED',
    enabledByDefault: false,
  }),
  profileAuthorization: 'required',
} as const);

/** Forward and inverse plans can belong to the same execution cycle. */
export const SpWriteOperationId = z.object({
  executionId: Uuid,
  planId: Uuid,
}).strict();
export type SpWriteOperationId = z.infer<typeof SpWriteOperationId>;

export const SpWritePreviewRequest = z.object({
  requestId: Uuid,
  profileId: Uuid,
  applyBatchId: Uuid,
  forwardRowIds: SpWriteForwardRowIds.optional(),
  retryOrigin: SpWriteRetryOrigin.optional(),
}).strict().refine((request) => request.retryOrigin === undefined || request.forwardRowIds !== undefined, {
  path: ['forwardRowIds'], message: 'retry requires the original unresolved row selection',
});
export type SpWritePreviewRequest = z.infer<typeof SpWritePreviewRequest>;

export const SpWriteInversePreviewRequest = z.object({
  requestId: Uuid,
  profileId: Uuid,
  original: SpWriteOperationId,
}).strict();
export type SpWriteInversePreviewRequest = z.infer<typeof SpWriteInversePreviewRequest>;

/** Ordinary UI confirmation cannot create a bounded test authorization. */
export const SpWriteManualApprovalRequest = z.object({
  profileId: Uuid,
  approval: ApproveSpWritePlan.refine((value) => value.approvalMode === 'manual', {
    message: 'the UI approval endpoint accepts manual confirmation only',
  }),
}).strict().refine((value) => value.profileId === value.approval.plan.profileId, {
  path: ['profileId'], message: 'approval must bind the requested profile',
});
export type SpWriteManualApprovalRequest = z.infer<typeof SpWriteManualApprovalRequest>;

/** The HTTP command records the exact text shown for this immutable preview. */
export const SpWriteConfirmedApprovalRequest = SpWriteManualApprovalRequest.safeExtend({
  confirmation: z.string(),
}).refine((value) => value.confirmation === spWriteConfirmation(value.approval.plan.counts.logicalChanges), {
  path: ['confirmation'], message: 'confirm the exact Amazon change count',
});
export type SpWriteConfirmedApprovalRequest = z.infer<typeof SpWriteConfirmedApprovalRequest>;

export function spWriteConfirmation(logicalChanges: number): string {
  return `Yes, apply ${z.number().int().positive().parse(logicalChanges)} changes to Amazon`;
}


export const SpWriteOperationRequest = SpWriteOperationId.extend({
  profileId: Uuid,
}).strict();
export type SpWriteOperationRequest = z.infer<typeof SpWriteOperationRequest>;

export const SpWritePreview = z.object({
  plan: SpWritePlan,
  binding: SpWritePlanBinding,
  /** Inverses refer to their recorded source operation instead of a new export. */
  evidence: SpWriteSourceEvidence.nullable(),
}).strict().superRefine((value, context) => {
  if (JSON.stringify(spWritePlanBinding(value.plan)) !== JSON.stringify(value.binding)) {
    context.addIssue({ code: 'custom', path: ['binding'], message: 'preview binding differs from its plan' });
  }
  if ((value.plan.direction === 'forward') !== (value.evidence !== null)
    || (value.evidence !== null && (
      value.evidence.schemaVersion.replace('preview-evidence', 'plan') !== value.plan.schemaVersion
      || value.evidence.planId !== value.plan.id
      || value.plan.source.kind !== 'apply_batch'
      || value.evidence.provenance.applyBatchId !== value.plan.source.applyBatchId
      || value.evidence.provenance.rows.length !== value.plan.counts.providerRows
      || JSON.stringify(value.evidence.guardrails.providerScope) !== JSON.stringify(value.plan.providerScope)
    ))) {
    context.addIssue({ code: 'custom', path: ['evidence'], message: 'preview needs the exact frozen source evidence' });
  }
});
export type SpWritePreview = z.infer<typeof SpWritePreview>;

/** The server derives the retry population; a browser cannot assert eligibility. */
export const OptimizerRetryRequest = z.object({ requestId: Uuid, profileId: Uuid, batchId: Uuid,
  original: SpWriteOperationId }).strict();
export type OptimizerRetryRequest = z.infer<typeof OptimizerRetryRequest>;
export const OptimizerRetryPreview = z.object({
  preview: SpWritePreview,
  excludedSuccessfulRows: z.array(z.object({ applyRowId: Uuid, name: z.string() }).strict()),
}).strict();
export type OptimizerRetryPreview = z.infer<typeof OptimizerRetryPreview>;

/** A known approval survives a lost or failed enqueue response and can be resumed. */
export const SpWriteAdmission = z.object({
  kind: z.enum(['queued', 'approved_pending_start']),
  operation: SpWriteOperationId,
  approvalId: Uuid,
  approvalRequestId: Uuid,
}).strict();
export type SpWriteAdmission = z.infer<typeof SpWriteAdmission>;

/** Identifies evidence that already exists; reading it cannot prepare a new plan. */
export const SpWriteRecordedPreviewRequest = z.object({ profileId: Uuid, planId: Uuid }).strict();
export type SpWriteRecordedPreviewRequest = z.infer<typeof SpWriteRecordedPreviewRequest>;

export const SpWritePreviewFreshnessReason = z.enum([
  'expired', 'profile_changed', 'grant_changed', 'gate_disabled', 'source_changed',
  'current_value_changed', 'entity_unavailable', 'unsupported_action',
]);
export type SpWritePreviewFreshnessReason = z.infer<typeof SpWritePreviewFreshnessReason>;

/** Frozen evidence and current synchronized state are intentionally separate. */
export const SpWriteRecordedPreview = z.object({
  preview: SpWritePreview,
  profile: z.object({ id: Uuid, label: z.string(), currencyCode: z.string().regex(/^[A-Z]{3}$/) }).strict(),
  currentRows: z.array(z.object({
    actionId: Uuid,
    entityName: z.string().nullable(),
    syncedAt: z.iso.datetime().nullable(),
    observation: SpWriteObservedAction.nullable(),
  }).strict()),
  /** Advisory as of checkedAt; admission and dispatch still recheck authority and state. */
  freshness: z.object({
    checkedAt: z.iso.datetime(),
    status: z.enum(['current', 'stale', 'unavailable']),
    reasons: z.array(SpWritePreviewFreshnessReason),
  }).strict(),
  admission: SpWriteAdmission.nullable(),
}).strict().superRefine((value, context) => {
  const plan = value.preview.plan;
  if (value.profile.id !== plan.profileId
    || value.profile.currencyCode !== plan.providerScope.currencyCode) {
    context.addIssue({ code: 'custom', path: ['profile'], message: 'profile differs from the recorded plan' });
  }
  const actions = new Map(plan.actions.map((action) => [action.actionId, action]));
  if (value.currentRows.length !== plan.actions.length
    || new Set(value.currentRows.map((row) => row.actionId)).size !== plan.actions.length
    || value.currentRows.some((row) => {
      const action = actions.get(row.actionId);
      if (action === undefined) return true;
      return row.observation !== null && (row.syncedAt === null
        || row.observation.actionId !== action.actionId
        || row.observation.actionFingerprint !== action.fingerprint
        || row.observation.routeKey !== action.routeKey
        || !Object.values(action.entity).includes(row.observation.amazonEntityId));
    })) {
    context.addIssue({ code: 'custom', path: ['currentRows'], message: 'current rows must cover the exact recorded actions' });
  }
  const reasons = value.freshness.reasons;
  const unavailable = reasons.includes('entity_unavailable') || reasons.includes('unsupported_action');
  if (new Set(reasons).size !== reasons.length
    || value.freshness.status !== (unavailable ? 'unavailable' : reasons.length > 0 ? 'stale' : 'current')
    || (value.currentRows.some((row) => row.observation === null) && !unavailable)) {
    context.addIssue({ code: 'custom', path: ['freshness'], message: 'freshness must agree with its evidence and reasons' });
  }
  if (value.admission !== null && value.admission.operation.planId !== plan.id) {
    context.addIssue({ code: 'custom', path: ['admission'], message: 'admission differs from the recorded plan' });
  }
});
export type SpWriteRecordedPreview = z.infer<typeof SpWriteRecordedPreview>;

export const SpWriteOperationDetail = z.object({
  operation: SpWriteOperationId,
  admission: z.enum(['queued', 'approved_pending_start']),
  receipt: SpWriteAuthorizationReceipt,
  snapshot: SpWriteExecutionSnapshot,
  mirror: SpWriteMirrorCounts,
  original: SpWriteOperationId.nullable(),
  inverses: z.array(SpWriteOperationId),
}).strict().superRefine((value, context) => {
  const receiptPlans = [value.receipt.plan, value.receipt.preapprovedInversePlan];
  const binding = receiptPlans.find((plan) => plan?.planId === value.operation.planId);
  if (value.operation.executionId !== value.receipt.executionId
    || binding === undefined || binding === null) {
    context.addIssue({ code: 'custom', path: ['operation'], message: 'operation differs from its receipt' });
  }
  const inverseBinding = value.receipt.preapprovedInversePlan;
  if (inverseBinding !== null && (
    inverseBinding.direction !== 'inverse'
    || inverseBinding.planId === value.receipt.plan.planId
    || inverseBinding.orgId !== value.receipt.plan.orgId
    || inverseBinding.profileId !== value.receipt.plan.profileId
    || JSON.stringify(inverseBinding.providerScope) !== JSON.stringify(value.receipt.plan.providerScope)
    || JSON.stringify(inverseBinding.counts) !== JSON.stringify(value.receipt.plan.counts)
  )) {
    context.addIssue({ code: 'custom', path: ['receipt'], message: 'bounded inverse scope differs from its forward plan' });
  }
  if (binding != null && (binding.direction === 'inverse') !== (value.original !== null)) {
    context.addIssue({ code: 'custom', path: ['original'], message: 'only inverse operations require an original link' });
  }
  if (value.original !== null && (
    value.original.planId === value.operation.planId
    || value.original.executionId !== value.operation.executionId
    || (binding === inverseBinding && value.original.planId !== value.receipt.plan.planId)
  )) {
    context.addIssue({ code: 'custom', path: ['original'], message: 'original link differs from the source cycle' });
  }
  const inversePlans = value.inverses.map((inverse) => inverse.planId);
  if (new Set(inversePlans).size !== inversePlans.length || inversePlans.includes(value.operation.planId)
    || value.inverses.some((inverse) => inverse.executionId !== value.operation.executionId)
    || (binding?.direction === 'inverse' && value.inverses.length !== 0)) {
    context.addIssue({ code: 'custom', path: ['inverses'], message: 'inverse links must be distinct operations' });
  }
  if (binding != null && value.snapshot.accounting.approvedRows !== binding.counts.providerRows) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'accounting differs from the approved plan count' });
  }
  const accounting = value.snapshot.accounting;
  if (value.mirror.observations !== accounting.observedRequested + accounting.observedExpectedAfterAmbiguous
    + accounting.observationConflict + accounting.observationMissing) {
    context.addIssue({ code: 'custom', path: ['mirror'], message: 'mirror counts differ from persisted provider observations' });
  }
  if (value.admission === 'approved_pending_start' && (
    value.snapshot.status !== 'queued'
    || value.snapshot.accounting.pendingDispatch !== value.snapshot.accounting.approvedRows
    || Object.entries(value.snapshot.accounting).some(([key, count]) =>
      !['approvedRows', 'pendingDispatch'].includes(key) && count !== 0)
  )) {
    context.addIssue({ code: 'custom', path: ['snapshot'], message: 'unstarted approval cannot contain execution evidence' });
  }
});
export type SpWriteOperationDetail = z.infer<typeof SpWriteOperationDetail>;

/** Saved optimizer results use ledger evidence, never a provider-success guess. */
/** Only irrevocable nonexecution evidence permits another original-row attempt. */
export function spWriteRetryEvidenceAllows(input: {
  refusal: Pick<SpWritePreDispatchDisposition, 'reason'> | null;
  providerOutcome: SpWriteProviderPositionOutcome | null;
  observation: Pick<SpWriteObservation, 'outcome'> | null;
}): boolean {
  return input.observation === null && (input.providerOutcome === 'authoritative_rejected'
    || (input.providerOutcome === null && input.refusal !== null && [
      'approval_expired', 'authorization_revoked', 'environment_gate_closed', 'profile_gate_closed', 'lease_unavailable',
    ].includes(input.refusal.reason)));
}

export const OptimizerOperationRow = z.object({
  actionId: Uuid,
  action: SpWriteAction,
  name: z.string(),
  applyRowIds: z.array(Uuid),
  before: z.string().nullable(),
  requested: z.string().nullable(),
  observed: z.string().nullable(),
  status: z.enum(['pending', 'sending', 'accepted', 'observed', 'failed', 'refused', 'ambiguous', 'conflict']),
  reason: z.string().nullable(),
  providerOutcome: SpWriteProviderPositionOutcome.nullable(),
  observation: SpWriteObservation.nullable(),
  refusal: SpWritePreDispatchDisposition.nullable(),
  retryEligible: z.boolean(),
  retryReason: z.string(),
}).strict().superRefine((row, context) => {
  if (row.actionId !== row.action.actionId
    || (row.observation !== null && row.observation.actionId !== row.actionId)
    || (row.refusal !== null && row.refusal.actionId !== row.actionId)
    || JSON.stringify(row.applyRowIds) !== JSON.stringify(row.action.sources.flatMap((source) =>
      source.kind === 'apply_row' ? [source.applyRowId] : []))) {
    context.addIssue({ code: 'custom', message: 'result row must retain its exact action and source identities' });
  }
  if (row.retryEligible && (row.applyRowIds.length === 0 || !spWriteRetryEvidenceAllows(row))) {
    context.addIssue({ code: 'custom', path: ['retryEligible'], message: 'retry requires evidence that the original action did not succeed' });
  }
});
export type OptimizerOperationRow = z.infer<typeof OptimizerOperationRow>;

export const OptimizerOperation = z.object({
  detail: SpWriteOperationDetail,
  plan: SpWritePlan,
  rows: z.array(OptimizerOperationRow),
}).strict().superRefine((value, context) => {
  if (value.plan.id !== value.detail.operation.planId
    || value.rows.length !== value.plan.actions.length
    || value.rows.some((row, index) => JSON.stringify(row.action) !== JSON.stringify(value.plan.actions[index]))) {
    context.addIssue({ code: 'custom', message: 'optimizer results must cover the complete recorded plan in order' });
  }
  const counts = value.detail.snapshot.accounting;
  if (value.rows.filter((row) => row.refusal !== null).length !== counts.refusedBeforeDispatch
    || value.rows.filter((row) => row.providerOutcome !== null).length !== counts.intentCommitted
    || value.rows.filter((row) => row.providerOutcome === 'accepted').length !== counts.providerAccepted
    || value.rows.filter((row) => row.providerOutcome === 'authoritative_rejected').length !== counts.providerRejected
    || value.rows.filter((row) => row.providerOutcome === 'ambiguous').length !== counts.providerAmbiguous
    || value.rows.filter((row) => row.observation?.outcome === 'observed_requested').length !== counts.observedRequested
    || value.rows.filter((row) => row.observation?.outcome === 'observed_expected_after_ambiguous').length !== counts.observedExpectedAfterAmbiguous
    || value.rows.filter((row) => row.observation?.outcome === 'conflict').length !== counts.observationConflict
    || value.rows.filter((row) => row.observation?.outcome === 'missing').length !== counts.observationMissing) {
    context.addIssue({ code: 'custom', path: ['rows'], message: 'row outcomes must reconcile with the persisted operation accounting' });
  }
});
export type OptimizerOperation = z.infer<typeof OptimizerOperation>;
