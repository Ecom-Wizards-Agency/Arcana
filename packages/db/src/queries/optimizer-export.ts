import { createHash } from 'node:crypto';
import { OptimizerSelectionExportRequest, OptimizerSelectionExportResult, serializeApplyRows, type ApplyRow } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';
import type { QueryHandle } from '../client.js';
import { SpWriteApplicationError } from './sp-write-errors.js';

/** Read-only binding excludes decisions while retaining every recorded input and child. */
export async function readOptimizerExportBinding(handle: QueryHandle, scope: { orgId: string; profileId: string; batchId: string }) {
  const [row] = await handle.sql<{ source: string | null }[]>`select
    app.optimizer_review_source(${scope.orgId}::uuid,${scope.profileId}::uuid,${scope.batchId}::uuid)::text as source`;
  return row?.source == null ? null : createHash('sha256').update(row.source).digest('hex');
}

/** One command owns the complete cross-child export; SQL independently verifies this rendered envelope. */
export async function exportOptimizerSelection(context: AuthenticatedEditorTransaction, raw: OptimizerSelectionExportRequest): Promise<OptimizerSelectionExportResult> {
  const request = OptimizerSelectionExportRequest.parse(raw);
  // Recovery is actor-bound and precedes mutable accepted/current-value predicates.
  const [existing] = await context.sql<{ result: unknown; request: unknown; actor_id: string }[]>`
    select result,request,actor_id::text from app.optimizer_selection_exports
    where org_id=${context.actor.orgId}::uuid and request_id=${request.requestId}::uuid`;
  let artifact = '[]';
  if (!existing) {
    const rows = await context.sql<{ id: string; entity_type: string; entity_id: string; field: string;
      current_value: unknown; proposed_value: unknown; entity_name: string | null }[]>`
      select r.id::text,r.entity_type::text,r.entity_id,r.field,r.current_value,r.proposed_value,r.entity_name
      from public.recommendations r join public.recommendation_runs run
        on run.org_id=r.org_id and run.profile_id=r.profile_id and run.id=r.run_id
      where r.org_id=${context.actor.orgId}::uuid and r.profile_id=${request.profileId}::uuid
        and run.batch_id=${request.batchId}::uuid and r.id=any(${request.recommendationIds}::uuid[])
      order by r.created_at,r.id`;
    if (rows.length !== request.recommendationIds.length) throw new SpWriteApplicationError('source_changed');
    artifact = serializeApplyRows(rows.map((row): ApplyRow => {
      if (row.entity_type !== 'keyword' || row.field !== 'bid'
        || typeof row.current_value !== 'number' || typeof row.proposed_value !== 'number') throw new SpWriteApplicationError('unsupported_source');
      return { entityType: 'keyword', entityId: row.entity_id, field: row.field, old: row.current_value, new: row.proposed_value,
        ...(row.entity_name === null ? {} : { name: row.entity_name }) };
    }));
  }
  const [saved] = await context.sql<{ result: unknown }[]>`select app.export_optimizer_selection(
    ${context.actor.orgId}::uuid,${JSON.stringify(request)}::jsonb,${artifact}) as result`;
  const result = OptimizerSelectionExportResult.parse(saved?.result);
  if (result.requestId !== request.requestId || result.batchId !== request.batchId
    || result.counts.offered !== request.recommendationIds.length) throw new SpWriteApplicationError('outcome_unknown');
  return result;
}

export async function readOptimizerExports(handle: QueryHandle, scope: { orgId: string; profileId: string; batchId: string }): Promise<OptimizerSelectionExportResult[]> {
  const rows = await handle.sql<{ result: unknown }[]>`select result from app.optimizer_selection_exports
    where org_id=${scope.orgId}::uuid and profile_id=${scope.profileId}::uuid and preview_batch_id=${scope.batchId}::uuid
    order by request_id`;
  return rows.map((row) => OptimizerSelectionExportResult.parse(row.result));
}
