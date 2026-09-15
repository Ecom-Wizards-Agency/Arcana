import { getReversionBatchPreview, listChangeQueue, readRestoreProposal } from '@wizard-ads/db';
import { ChangeQueueSource, ChangeQueueState, Uuid } from '@wizard-ads/shared';
import { TimeMachineEntryId, TimeMachineInstant } from '@wizard-ads/shared/time-machine-writes';
import { redirect, notFound } from 'next/navigation';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { listOrgProfiles } from '../../recommendations/data';
import { requireOrgRole } from '../../server/org-role';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { resolveQueueViewQuery } from './saved-view';
import { classifyRestoreRow } from '../../../../../packages/core/src/restore-preview';

function one(value: string | string[] | undefined) { return Array.isArray(value) ? value[0] : value; }
function date(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value ? value : null;
}
export function queueCursor(query: ScreenParams['searchParams']) {
  const observedAt = one(query['before_at']), id = one(query['before_id']);
  if (!observedAt || !id || (!TimeMachineEntryId.safeParse(id).success && !/^(?:amazon|queued|restore):[0-9a-f-]{36}$/.test(id))) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(observedAt) || !date(observedAt.slice(0,10)) || !Number.isFinite(Date.parse(observedAt))) return null;
  const instant = TimeMachineInstant.safeParse(observedAt);
  return instant.success ? { observedAt: instant.data, id } : null;
}
export async function load(access: ScreenActor, input: ScreenParams) {
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      const query = resolveQueueViewQuery(Object.fromEntries(Object.entries(input.searchParams).flatMap(([key,value]) => { const item=one(value); return item===undefined ? [] : [[key,item]]; })));
      const profiles = await listOrgProfiles(database, actor.orgId);
      const profile = access.selectProfile(profiles, one(query['profile']));
      if (one(query['profile']) && profile?.id !== one(query['profile'])) notFound();
      if (profile === null) return { view: 'empty' as const, props: {} };
      const from = date(one(query['from'])), to = date(one(query['to']));
      const source = ChangeQueueSource.safeParse(one(query['source']));
      const state = ChangeQueueState.safeParse(one(query['state']));
      const cursor = queueCursor(query);
      const entries = await listChangeQueue(database, { orgId: actor.orgId, profileId: profile.id, from,
        to: to === null ? null : `${to}T23:59:59.999999Z`, source: source.success ? source.data : null,
        state: state.success ? state.data : null, entityType: one(query['type']) ?? null,
        field: one(query['field']) ?? null, before: cursor, limit: 51 });
      const proposalId=one(query['proposal']);
      const proposal=proposalId && Uuid.safeParse(proposalId).success ? await readRestoreProposal(database,{orgId:actor.orgId,profileId:profile.id,planId:proposalId}) : null;
      if(proposalId && proposal===null) notFound();
      const batch = one(query['batch']);
      const preview = batch && Uuid.safeParse(batch).success ? await getReversionBatchPreview(database, { orgId: actor.orgId, batchId: batch }) : null;
      if (batch && (preview === null || preview.profileId !== profile.id)) notFound();
      if (preview !== null && (preview.rows.length !== preview.reversibleRows || preview.unsupportedRows > 0)) {
        return { view: 'error' as const, props: { message: 'A complete restore preview is unavailable: some batch rows have no recorded before-value.' } };
      }
      const [freshness] = await database.sql<{ partial: boolean }[]>`select exists(
        select 1 from public.apply_batches b join public.apply_rows ar on ar.org_id=b.org_id and ar.profile_id=b.profile_id and ar.batch_id=b.id
        cross join lateral app.resolve_apply_current_value(b.org_id,b.profile_id,ar.entity_type,ar.entity_id,ar.field) mirror
        where b.org_id=${actor.orgId}::uuid and b.profile_id=${profile.id}::uuid and b.source_kind='legacy_export'
          and mirror.supported and (mirror.current_synced_at is null or mirror.current_synced_at<b.exported_at
            or exists(select 1 from public.entity_changes ec where ec.org_id=b.org_id and ec.profile_id=b.profile_id
              and ec.apply_batch_id=b.id and ec.apply_row_id=ar.id and ec.observed_at>mirror.current_synced_at))
      ) as partial`;
      const preserved = Object.fromEntries(Object.entries(query).flatMap(([key,value]) => {
        const item = one(value); return item === undefined ? [] : [[key,item]];
      }));
      preserved['profile'] = profile.id;
      return { view: 'ready' as const, props: { profileId: profile.id, currencyCode: profile.currencyCode,
        role, viewActor:actor, proposal, entries: entries.slice(0,50), hasOlder: entries.length > 50, cursor, query: preserved,
        partial: freshness?.partial ?? true,
        preview: preview === null ? null : { batchId: preview.batchId, label: preview.tag,
          blockedReason: preview.activeReversionBatchId === null ? null : 'This batch already has an active reversion export.',
          rows: preview.rows.map((row) => classifyRestoreRow({ row, exportedAt: preview.exportedAt })) } } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    if (error instanceof Error && 'digest' in error && String(error.digest).startsWith('NEXT_HTTP_ERROR_FALLBACK')) throw error;
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The change history is unavailable') } };
  }
}
