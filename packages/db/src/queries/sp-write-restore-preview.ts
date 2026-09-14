import { COORDINATED_RESTORE_UNAVAILABLE, RestoreProposalRequest } from '@wizard-ads/shared';
import { SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import { serializeSpWritePlanFingerprint, serializeSpWriteActionFingerprint, spWritePlanBinding } from '@wizard-ads/shared/sp-writes';
import { serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import type { QuerySql } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
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
