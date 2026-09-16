import { createHash } from 'node:crypto';
import { SpWriteRestoreExportPreview, SpWriteRestoreExportRequest } from '@wizard-ads/shared/sp-write-application';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { getReversionBatchPreview } from './time-machine.js';
import { createReversionExportForActor } from './recommendations-authority.js';
import { SpWriteApplicationError } from './sp-write-errors.js';

type Context = AuthenticatedEditorTransaction | AuthenticatedReadSnapshot;

/** A read credential or a live connection never implies an enabled write grant. */
export async function restoreProfileWriteEnabled(context: Context, profileId: string): Promise<boolean> {
  const rows = await context.sql<{ enabled: boolean }[]>`
    select coalesce(g.enabled and g.amazon_profile_id=p.amazon_profile_id and g.connection_id=p.connection_id
      and g.region=p.region and g.currency_code=p.currency_code and g.api_dialect='sp_v3',false) as enabled
    from public.ad_profiles p
    left join public.sp_write_profile_grant_heads h on h.org_id=p.org_id and h.profile_id=p.id
    left join public.sp_write_profile_grant_versions g on g.org_id=h.org_id and g.profile_id=h.profile_id
      and g.grant_id=h.grant_id and g.version_id=h.version_id
    where p.org_id=${context.actor.orgId}::uuid and p.id=${profileId}::uuid
      and exists(select 1 from public.org_members m where m.org_id=p.org_id
        and m.user_id=${context.actor.userId}::uuid and m.role in ('owner','admin'))`;
  if (rows.length !== 1) throw new SpWriteApplicationError('not_found');
  return rows[0]!.enabled;
}

/** An exact export snapshot remains readable without inventing a write grant. */
export async function readRestoreExportPreview(context: Context, input: { profileId: string; batchId: string }) {
  if (await restoreProfileWriteEnabled(context, input.profileId)) throw new SpWriteApplicationError('authorization_refused');
  const preview = await getReversionBatchPreview(context, { orgId: context.actor.orgId, batchId: input.batchId });
  if (preview === null || preview.profileId !== input.profileId) throw new SpWriteApplicationError('not_found');
  if (preview.dependencySetCount !== null) throw new SpWriteApplicationError('unsupported_source');
  const fingerprint = createHash('sha256').update(JSON.stringify(['arcana.restore-export-preview.v1', preview])).digest('hex');
  return SpWriteRestoreExportPreview.parse({ kind: 'export_only', profileId: input.profileId, batchId: input.batchId, preview, fingerprint });
}

/** The caller owns the authenticated transaction, including file count readback. */
export async function exportRestoreProposalForActor(context: AuthenticatedEditorTransaction,
  raw: SpWriteRestoreExportRequest, tag: string) {
  const request = SpWriteRestoreExportRequest.parse(raw);
  await context.sql`select pg_advisory_xact_lock(hashtextextended(${`time-machine:${context.actor.orgId}:${request.batchId}`},0))`;
  await context.sql`select id from public.apply_batches where org_id=${context.actor.orgId}::uuid
    and profile_id=${request.profileId}::uuid and id=${request.batchId}::uuid for update`;
  // Freeze source identities before deriving the mirror targets, then take the
  // same mirror locks as the legacy exporter before checking the saved snapshot.
  const sourceRows = await context.sql<{ id: string }[]>`select id::text from public.apply_rows
    where org_id=${context.actor.orgId}::uuid and profile_id=${request.profileId}::uuid and batch_id=${request.batchId}::uuid
    order by id for share`;
  const initial = await readRestoreExportPreview(context, request);
  if (sourceRows.length !== initial.preview.rows.length) throw new SpWriteApplicationError('source_changed');
  await context.sql`select app.lock_review_export_rows(${context.actor.orgId}::uuid,${request.profileId}::uuid,null,
    ${JSON.stringify(initial.preview.rows.map(row=>({entityType:row.entityType,entityId:row.entityId})))}::text::jsonb)`;
  const saved = await readRestoreExportPreview(context, request);
  if (saved.preview.readyRows !== request.expectedRows || saved.fingerprint !== request.fingerprint) {
    throw new SpWriteApplicationError('source_changed');
  }
  if (!saved.preview.exportAllowed) throw new SpWriteApplicationError('source_changed');
  const result = await createReversionExportForActor(context, { batchId: request.batchId, tag, note: request.note });
  if (result.rows.length !== request.expectedRows || result.sourceBatchId !== request.batchId) {
    throw new SpWriteApplicationError('outcome_unknown');
  }
  return result;
}
