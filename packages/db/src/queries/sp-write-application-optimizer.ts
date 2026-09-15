import { OptimizerRetryRequest, OptimizerRetryPreview, SpWritePreview, type SpWriteRecordedPreview } from '@wizard-ads/shared/sp-write-application';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { assertOptimizerApplyBatch } from './optimizer-run.js';
import { previewSpWriteForActor } from './sp-write-commands.js';
import { loadSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { spWritePlanBinding } from '@wizard-ads/shared/sp-writes';
import { SpWriteApplicationError } from './sp-write-errors.js';

type Context = AuthenticatedEditorTransaction | AuthenticatedReadSnapshot;

/** Names come from frozen source evidence across the lineage, never browser state. */
export async function readOptimizerRetryExclusions(context: Context, recorded: Pick<SpWriteRecordedPreview['preview'], 'plan'>) {
  const { plan } = recorded;
  if (plan.source.kind !== 'apply_batch' || plan.source.retryOrigin === undefined) return [];
  const rows = await context.sql<{ apply_row_id: string; name: string }[]>`
    with recursive ancestors(plan_id,execution_id) as (
      select ${plan.source.retryOrigin.planId}::uuid,${plan.source.retryOrigin.executionId}::uuid
      union
      select edge.parent_plan_id,edge.parent_execution_id from app.sp_write_forward_lineage edge
      join ancestors a on a.plan_id=edge.retry_plan_id where edge.org_id=${plan.orgId}::uuid and edge.profile_id=${plan.profileId}::uuid
    ), successful as (
      select population.source_row_id,a.plan_id from ancestors a
      cross join lateral app.sp_write_retry_population(${plan.orgId}::uuid,${plan.profileId}::uuid,a.execution_id,a.plan_id) population
      where population.successful
    ) select distinct on(successful.source_row_id) successful.source_row_id::text as apply_row_id,
        coalesce((e.artifact#>>'{provenance,artifactText}')::jsonb->(r.position::integer-1)->>'name',
          (e.artifact#>>'{provenance,artifactText}')::jsonb->(r.position::integer-1)->>'entity_id') as name
      from successful join public.sp_write_preview_evidence e on e.org_id=${plan.orgId}::uuid
        and e.profile_id=${plan.profileId}::uuid and e.plan_id=successful.plan_id
      cross join lateral jsonb_array_elements(e.artifact#>'{provenance,rows}') with ordinality r(value,position)
      where r.value->>'applyRowId'=successful.source_row_id::text order by successful.source_row_id,successful.plan_id`;

  return rows.map((row) => ({ applyRowId: row.apply_row_id, name: row.name }));
}

/** Derive the exact eligible population and persist its lineage before presenting confirmation. */
export async function prepareOptimizerRetry(context: AuthenticatedEditorTransaction, raw: OptimizerRetryRequest): Promise<OptimizerRetryPreview> {
  const request = OptimizerRetryRequest.parse(raw);
  const original = await loadSpWritePreviewEvidence(context.sql, { orgId: context.actor.orgId,
    profileId: request.profileId, planId: request.original.planId });
  if (!original || original.plan.source.kind !== 'apply_batch' || original.plan.schemaVersion !== 'openspell.sp-write-plan.v1') throw new SpWriteApplicationError('unsupported_source');
  await assertOptimizerApplyBatch(context, { orgId: context.actor.orgId, profileId: request.profileId,
    batchId: request.batchId, applyBatchId: original.plan.source.applyBatchId });
  const retryOrigin = { ...request.original, planFingerprint: original.plan.fingerprint };
  const existing = await loadSpWritePreviewEvidence(context.sql, { orgId: context.actor.orgId, profileId: request.profileId, planId: request.requestId });
  let preview: SpWritePreview;
  if (existing) {
    if (existing.plan.source.kind !== 'apply_batch'
      || JSON.stringify(existing.plan.source.retryOrigin) !== JSON.stringify(retryOrigin)
      || existing.plan.source.applyBatchId !== original.plan.source.applyBatchId) throw new SpWriteApplicationError('identity_conflict');
    // Still use the actor command for its owner/admin and exact request replay checks.
    preview = await previewSpWriteForActor(context, { requestId: request.requestId, profileId: request.profileId,
      applyBatchId: existing.plan.source.applyBatchId, forwardRowIds: existing.plan.source.forwardRowIds, retryOrigin });
  } else {
    const population = await context.sql<{ source_row_id: string; eligible: boolean }[]>`select source_row_id::text,eligible
      from app.sp_write_retry_population(${context.actor.orgId}::uuid,${request.profileId}::uuid,
        ${request.original.executionId}::uuid,${request.original.planId}::uuid)`;
    if (population.length !== original.plan.counts.providerRows) throw new SpWriteApplicationError('source_changed');
    const forwardRowIds = population.filter((row) => row.eligible).map((row) => row.source_row_id).sort();
    if (!forwardRowIds.length) throw new SpWriteApplicationError('unsupported_source');
    preview = await previewSpWriteForActor(context, { requestId: request.requestId, profileId: request.profileId,
      applyBatchId: original.plan.source.applyBatchId, forwardRowIds, retryOrigin });
  }
  return OptimizerRetryPreview.parse({ preview: SpWritePreview.parse({ ...preview, binding: spWritePlanBinding(preview.plan) }),
    excludedSuccessfulRows: await readOptimizerRetryExclusions(context, preview) });
}
