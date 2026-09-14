import { approveQueuedTargetChange } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, mutationUuid } from '../../../../../../src/server/authenticated-mutation';
import { targetQueueError } from '../route';
export const runtime = 'nodejs';
export async function POST(request: Request, route: { params: Promise<{ id: string; changeId: string }> }) {
  const started = performance.now();
  let admitted = started;
  let approved = started;
  const response = await authenticatedMutation(request, async (context) => {
    admitted = performance.now();
    const [params, body] = await Promise.all([route.params, mutationBody(request)]);
    const id = await approveQueuedTargetChange(context, { profileId: mutationUuid(body['profileId'],'profileId'), targetId: params.id, changeId: mutationUuid(params.changeId,'changeId') });
    const rows = await context.sql<{ id: string; approvedAt: string; approvedBy: string }[]>`
      select change_id::text as id, approved_at::text as "approvedAt", approved_by::text as "approvedBy"
      from public.queued_change_approvals
      where org_id=${context.actor.orgId}::uuid and change_id=${id}::uuid
    `;
    if (rows.length !== 1) throw new Error('Approval readback count mismatch');
    approved = performance.now();
    return Response.json({ approval: rows[0] });
  }, targetQueueError);
  response.headers.set('Server-Timing', `admission;dur=${(admitted-started).toFixed(1)}, approval;dur=${(approved-admitted).toFixed(1)}, finalize;dur=${(performance.now()-approved).toFixed(1)}, total;dur=${(performance.now()-started).toFixed(1)}`);
  return response;
}
