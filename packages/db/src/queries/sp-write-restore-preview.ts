import { COORDINATED_RESTORE_UNAVAILABLE, RestoreProposalRequest } from '@wizard-ads/shared';
import { OptimizerRetryRequest, OptimizerRetryPreview, SpWritePreview, SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import { serializeSpWritePlanFingerprint, serializeSpWriteActionFingerprint, spWritePlanBinding } from '@wizard-ads/shared/sp-writes';
import { serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import type { QuerySql } from '../client.js';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { SpWriteApplicationError } from './sp-write-errors.js';
import { readOptimizerOperation } from './optimizer-run.js';
import { readOptimizerRetryExclusions } from './sp-write-application-optimizer.js';
import { getReversionBatchPreview } from './time-machine.js';

export async function readRestoreProposal(handle: {sql:QuerySql}, scope: {orgId:string;profileId:string;planId:string}) {
  const [receipt] = await handle.sql<{reviewed_at:Date | string | null}[]>`select r.reviewed_at from public.sp_write_restore_proposals p
    left join public.sp_write_restore_reviews r on r.org_id=p.org_id and r.profile_id=p.profile_id and r.plan_id=p.plan_id
    where p.org_id=${scope.orgId}::uuid and p.profile_id=${scope.profileId}::uuid and p.plan_id=${scope.planId}::uuid`;
  if (!receipt) return null;
  const saved=await loadSpWritePreviewEvidence(handle.sql,scope);
  if (!saved || saved.evidence.schemaVersion !== 'openspell.sp-write-preview-evidence.v1'
    || saved.plan.schemaVersion !== 'openspell.sp-write-plan.v1' || saved.plan.source.kind!=='apply_batch' || !saved.plan.source.restoreProposal) throw new Error('Restore source unavailable');
  return {preview:SpWritePreview.parse({...saved,binding:spWritePlanBinding(saved.plan)}),approved:receipt.reviewed_at!==null};
}

/** Uses the same immutable plan, action proofs and preview evidence as forward admission. */
export async function recordRestoreProposal(context:AuthenticatedEditorTransaction, preview:SpWritePreview):Promise<string> {
  const {plan,evidence}=SpWritePreview.parse(preview);
  if (plan.schemaVersion!=='openspell.sp-write-plan.v1' || plan.orgId!==context.actor.orgId || plan.source.kind!=='apply_batch' || !plan.source.restoreProposal
    || evidence?.schemaVersion!=='openspell.sp-write-preview-evidence.v1') throw new Error('Restore source unavailable');
  const [saved]=await context.sql<{id:string}[]>`select app.record_sp_write_restore_proposal(${context.actor.orgId}::uuid,
    ${JSON.stringify(plan)},${serializeSpWritePlanFingerprint(plan)},
    ${JSON.stringify(plan.actions.map(action=>({artifactText:JSON.stringify(action),fingerprintPreimage:serializeSpWriteActionFingerprint(action)})))}::text::jsonb,
    ${JSON.stringify(evidence)},${serializeSpWritePreviewGuardrails(evidence)},${serializeSpWritePreviewProvenance(evidence)})::text as id`;
  if (saved?.id!==plan.id) throw new Error('Restore proposal count mismatch');
  return plan.id;
}

export async function buildRestoreProposal(context:AuthenticatedEditorTransaction,
  rawRequest:RestoreProposalRequest) {
  const request=RestoreProposalRequest.parse(rawRequest);
  const existing=await readRestoreProposal(context,{orgId:context.actor.orgId,profileId:request.profileId,planId:request.requestId});
  if(existing) {
    const source=existing.preview.plan.source;
    if(source.kind!=='apply_batch'||source.applyBatchId!==request.applyBatchId
      || JSON.stringify([...source.restoreProposal!.sourceRowIds].sort())!==JSON.stringify([...request.sourceRowIds].sort())) throw new Error('Restore identity conflict');
    return existing.preview;
  }
  const batch=await getReversionBatchPreview(context,{orgId:context.actor.orgId,batchId:request.applyBatchId});
  if(!batch || batch.profileId!==request.profileId) throw new Error('Resource not found');
  if(batch.dependencySetCount!==null) throw new Error(COORDINATED_RESTORE_UNAVAILABLE);
  if(batch.activeReversionBatchId!==null) throw Object.assign(new Error('restore_active_reversion: This batch already has an active reversion export.'),{code:'restore_active_reversion'});
  // Verify the original artifact before interpreting a mutable row selection. SQL repeats this under locks.
  const saved=await buildSpWriteLegacyPreview(context.sql,context.actor.orgId,request,request.sourceRowIds);
  if(batch.rows.some(row=>request.sourceRowIds.includes(row.rowId) && row.reason.startsWith('restore_mirror_stale:'))) throw Object.assign(new Error('restore_mirror_stale: Mirror predates the applied observation'),{code:'restore_mirror_stale'});
  const ready=batch.rows.filter(row=>row.state==='ready').map(row=>row.rowId).sort();
  if(ready.length===0 || JSON.stringify(ready)!==JSON.stringify([...request.sourceRowIds].sort())) throw new Error('Restore selection changed. Reload the preview.');
  const preview=SpWritePreview.parse({...saved,binding:spWritePlanBinding(saved.plan)});
  await recordRestoreProposal(context,preview);
  return preview;
}

/** Proposal review records no execution approval, outbox row or provider intent. */
export async function reviewRestoreProposal(context:AuthenticatedEditorTransaction,
  request:{profileId:string;planId:string;fingerprint:string}) {
  const [receipt]=await context.sql<{id:string}[]>`select app.review_sp_write_restore_proposal(${context.actor.orgId}::uuid,
    ${request.profileId}::uuid,${request.planId}::uuid,${request.fingerprint})::text as id`;
  if(receipt?.id!==request.planId) throw new Error('Restore review count mismatch');
}

/** Restore routes bind the source batch to the immutable plan in the caller's tenant. */
export async function assertRestoreBatchBinding(
  context: AuthenticatedEditorTransaction | AuthenticatedReadSnapshot,
  scope: { orgId: string; profileId: string; batchId: string; planId: string },
): Promise<void> {
  if (scope.orgId !== context.actor.orgId) throw new SpWriteApplicationError('not_found');
  const [row] = await context.sql<{ matches: boolean }[]>`select exists(
    select 1 from public.sp_write_restore_proposals proposal
    join public.sp_write_plans plan on plan.org_id=proposal.org_id and plan.profile_id=proposal.profile_id and plan.plan_id=proposal.plan_id
    join public.org_members member on member.org_id=proposal.org_id and member.user_id=auth.uid()
    where proposal.org_id=${scope.orgId}::uuid and proposal.profile_id=${scope.profileId}::uuid
      and proposal.plan_id=${scope.planId}::uuid and proposal.source_batch_id=${scope.batchId}::uuid
      and plan.artifact#>>'{source,restoreProposal,sourceBatchId}'=${scope.batchId}
      and member.user_id=${context.actor.userId}::uuid and member.role in ('owner','admin')) as matches`;
  if (!row?.matches) throw new SpWriteApplicationError('not_found');
}

export async function readRestoreOperation(context: AuthenticatedReadSnapshot, raw: SpWriteOperationRequest) {
  const request = SpWriteOperationRequest.parse(raw);
  const original = await readRestoreProposal(context, { orgId: context.actor.orgId, profileId: request.profileId, planId: request.planId });
  if (!original) throw new SpWriteApplicationError('not_found');
  return readOptimizerOperation(context, request);
}

/** A retry preserves the exact inverse and can include only conclusively failed rows. */
export async function prepareRestoreRetry(context: AuthenticatedEditorTransaction, raw: OptimizerRetryRequest): Promise<OptimizerRetryPreview> {
  const request = OptimizerRetryRequest.parse(raw);
  await context.sql`select app.lock_sp_write_operator(${context.actor.orgId}::uuid,${request.profileId}::uuid,${context.actor.userId}::uuid)`;
  await assertRestoreBatchBinding(context, { orgId: context.actor.orgId, profileId: request.profileId,
    batchId: request.batchId, planId: request.original.planId });
  const original = await readRestoreProposal(context, { orgId: context.actor.orgId, profileId: request.profileId, planId: request.original.planId });
  if (!original || original.preview.plan.source.kind !== 'apply_batch') throw new SpWriteApplicationError('not_found');
  const retryOrigin = { ...request.original, planFingerprint: original.preview.plan.fingerprint };
  const existing = await readRestoreProposal(context, { orgId: context.actor.orgId, profileId: request.profileId, planId: request.requestId });
  let preview: SpWritePreview;
  if (existing) {
    if (existing.preview.plan.source.kind !== 'apply_batch'
      || existing.preview.plan.source.applyBatchId !== request.batchId
      || JSON.stringify(existing.preview.plan.source.retryOrigin) !== JSON.stringify(retryOrigin)) {
      throw new SpWriteApplicationError('identity_conflict');
    }
    preview = existing.preview;
  } else {
    const population = await context.sql<{ source_row_id: string; eligible: boolean }[]>`select source_row_id::text,eligible
      from app.sp_write_retry_population(${context.actor.orgId}::uuid,${request.profileId}::uuid,
        ${request.original.executionId}::uuid,${request.original.planId}::uuid)`;
    if (population.length !== original.preview.plan.counts.providerRows) throw new SpWriteApplicationError('source_changed');
    const rowIds = population.filter((row) => row.eligible).map((row) => row.source_row_id).sort();
    if (!rowIds.length) throw new SpWriteApplicationError('unsupported_source');
    const built = await buildSpWriteLegacyPreview(context.sql, context.actor.orgId, {
      requestId: request.requestId, profileId: request.profileId, applyBatchId: request.batchId, retryOrigin,
    }, rowIds);
    preview = SpWritePreview.parse({ ...built, binding: spWritePlanBinding(built.plan) });
    await recordRestoreProposal(context, preview);
  }
  return OptimizerRetryPreview.parse({ preview,
    excludedSuccessfulRows: await readOptimizerRetryExclusions(context, preview) });
}
