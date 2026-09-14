import { QueuedBidChange, QueuedBidRequest, TargetBidContext } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';
export async function readTargetBidContext(handle: QueryHandle, orgId: string, profileId: string, targetId: string): Promise<TargetBidContext | null> {
  const rows = await handle.sql<{ context: unknown }[]>`select app.target_bid_context(${orgId}::uuid,${profileId}::uuid,${targetId}) as context`;
  return rows[0]?.context == null ? null : TargetBidContext.parse(rows[0].context);
}
/** WP-265 consumes these same immutable proposals and separate approvals. */
export async function listQueuedTargetChanges(handle: QueryHandle, orgId: string, profileId: string, targetId: string | null = null): Promise<QueuedBidChange[]> {
  const rows = await handle.sql<{ artifact: unknown }[]>`
    select jsonb_build_object('id',q.id,'orgId',q.org_id,'createdBy',q.created_by,'createdAt',q.created_at,
      'context',q.context,'request',q.request,'checks',q.checks,'approvedAt',a.approved_at,'approvedBy',a.approved_by) as artifact
    from public.queued_changes q left join public.queued_change_approvals a
      on a.org_id=q.org_id and a.profile_id=q.profile_id and a.change_id=q.id
    where q.org_id=${orgId}::uuid and q.profile_id=${profileId}::uuid and (${targetId}::text is null or q.target_id=${targetId})
    order by q.created_at desc,q.id
  `;
  return rows.map((row) => QueuedBidChange.parse(row.artifact));
}
export async function queueTargetBidChange(context: AuthenticatedEditorTransaction, input: unknown): Promise<string> {
  const request = QueuedBidRequest.parse(input);
  const rows = await context.sql<{ id: string }[]>`select app.queue_target_bid(${context.actor.orgId}::uuid,${JSON.stringify(request)}::text::jsonb)::text as id`;
  if (rows.length !== 1 || rows[0]?.id !== request.requestId) throw new Error('Queued change count mismatch');
  return rows[0].id;
}
export async function approveQueuedTargetChange(context: AuthenticatedEditorTransaction, identity: { profileId: string; targetId: string; changeId: string }): Promise<string> {
  const rows = await context.sql<{ id: string }[]>`select app.approve_queued_target_bid(${context.actor.orgId}::uuid,${identity.profileId}::uuid,${identity.targetId},${identity.changeId}::uuid)::text as id`;
  if (rows.length !== 1 || rows[0]?.id !== identity.changeId) throw new Error('Approval count mismatch');
  return rows[0].id;
}
