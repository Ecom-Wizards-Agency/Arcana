/** Authenticated application commands. The caller owns one WP-253 transaction. */
import {
  SpWriteAdmission, SpWriteConfirmedApprovalRequest, SpWriteOperationRequest,
  SpWritePreview, SpWritePreviewRequest, SpWriteRecordedPreviewRequest,
} from '@wizard-ads/shared/sp-write-application';
import { serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import { serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint, spWritePlanBinding } from '@wizard-ads/shared/sp-writes';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { buildSpWriteLegacyPreview, spWritePreviewRequestMatches } from './sp-write-plan-builder.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { loadRecordedSpWritePreview } from './sp-write-recorded-preview.js';
import { loadSpWriteOperationDetail } from './sp-write-operation-read.js';

function requireTransaction(context: AuthenticatedEditorTransaction | AuthenticatedReadSnapshot): void {
  if ('begin' in context.sql || !('savepoint' in context.sql)) {
    throw new SpWriteApplicationError('authorization_refused');
  }
}

async function requireRead(context: AuthenticatedReadSnapshot, profileId: string): Promise<void> {
  requireTransaction(context);
  const rows = await context.sql<{ allowed: boolean }[]>`select exists (
    select 1 from public.ad_profiles profile join public.org_members member on member.org_id = profile.org_id
    where profile.org_id = ${context.actor.orgId}::uuid and profile.id = ${profileId}::uuid
      and member.user_id = auth.uid() and member.user_id = ${context.actor.userId}::uuid
      and member.role in ('owner','admin')) as allowed`;
  if (rows.length !== 1 || !rows[0]?.allowed) throw new SpWriteApplicationError('not_found');
}

/** Records source and plan atomically; it neither approves nor enqueues a write. */
export async function previewSpWriteForActor(context: AuthenticatedEditorTransaction, raw: SpWritePreviewRequest) {
  requireTransaction(context);
  const request = SpWritePreviewRequest.parse(raw);
  await context.sql`select app.lock_sp_write_operator(${context.actor.orgId}::uuid,
    ${request.profileId}::uuid, ${context.actor.userId}::uuid)`;
  const existing = await loadSpWritePreviewEvidence(context.sql, {
    orgId: context.actor.orgId, profileId: request.profileId, planId: request.requestId,
  });
  if (existing !== null) {
    if (!spWritePreviewRequestMatches(existing.plan, request)
      || existing.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v2') {
      throw new SpWriteApplicationError('identity_conflict');
    }
    return SpWritePreview.parse({ ...existing, binding: spWritePlanBinding(existing.plan) });
  }
  const { plan, evidence } = await buildSpWriteLegacyPreview(context.sql, context.actor.orgId, request);
  const rows = await context.sql<{ id: string }[]>`select app.record_sp_write_preview_for_actor(
    ${context.actor.orgId}::uuid, ${context.actor.userId}::uuid,
    ${JSON.stringify(plan)}, ${serializeSpWritePlanFingerprint(plan)},
    ${JSON.stringify(plan.actions.map((action) => ({ artifactText: JSON.stringify(action),
      fingerprintPreimage: serializeSpWriteActionFingerprint(action) })))}::text::jsonb,
    ${JSON.stringify(evidence)}, ${serializeSpWritePreviewGuardrails(evidence)},
    ${serializeSpWritePreviewProvenance(evidence)})::text as id`;
  if (rows.length !== 1 || rows[0]?.id !== plan.id) throw new SpWriteApplicationError('outcome_unknown');
  const recorded = await loadSpWritePreviewEvidence(context.sql, {
    orgId: context.actor.orgId, profileId: request.profileId, planId: plan.id,
  });
  if (recorded === null || JSON.stringify(recorded) !== JSON.stringify({ plan, evidence })) {
    throw new SpWriteApplicationError('outcome_unknown');
  }
  return SpWritePreview.parse({ ...recorded, binding: spWritePlanBinding(recorded.plan) });
}

/** SQL rechecks the saved plan, exact text, method evidence and authority before enqueue. */
export async function approveSpWriteForActor(context: AuthenticatedEditorTransaction, raw: SpWriteConfirmedApprovalRequest) {
  requireTransaction(context);
  const request = SpWriteConfirmedApprovalRequest.parse(raw);
  if (request.approval.plan.orgId !== context.actor.orgId || request.approval.plan.direction !== 'forward') {
    throw new SpWriteApplicationError('authorization_refused');
  }
  const rows = await context.sql<{ admission: unknown }[]>`select app.approve_and_queue_sp_write_for_actor(
    ${context.actor.orgId}::uuid, ${context.actor.userId}::uuid,
    ${request.profileId}::uuid, ${JSON.stringify(request.approval)}, ${request.confirmation}) as admission`;
  if (rows.length !== 1) throw new SpWriteApplicationError('outcome_unknown');
  const admission = SpWriteAdmission.parse(rows[0]?.admission);
  if (admission.kind !== 'queued' || admission.operation.planId !== request.approval.plan.planId
    || admission.approvalRequestId !== request.approval.approvalRequestId) {
    throw new SpWriteApplicationError('outcome_unknown');
  }
  return admission;
}

export async function readRecordedSpWritePreviewForActor(context: AuthenticatedReadSnapshot, raw: SpWriteRecordedPreviewRequest) {
  const request = SpWriteRecordedPreviewRequest.parse(raw);
  await requireRead(context, request.profileId);
  return loadRecordedSpWritePreview(context.sql, context.actor, request);
}

export async function readSpWriteOperationForActor(context: AuthenticatedReadSnapshot, raw: SpWriteOperationRequest) {
  const request = SpWriteOperationRequest.parse(raw);
  await requireRead(context, request.profileId);
  const roots = await context.sql<{ approval_id: string; generation: string }[]>`
    select approval_id::text, generation::text from public.sp_write_cycle_plans
    where org_id = ${context.actor.orgId}::uuid and profile_id = ${request.profileId}::uuid
      and execution_id = ${request.executionId}::uuid and plan_id = ${request.planId}::uuid`;
  if (roots.length === 0) throw new SpWriteApplicationError('not_found');
  if (roots.length !== 1) throw new SpWriteApplicationError('identity_conflict');
  return loadSpWriteOperationDetail(context, { ...request, orgId: context.actor.orgId,
    approvalId: roots[0]!.approval_id, generation: roots[0]!.generation });
}
