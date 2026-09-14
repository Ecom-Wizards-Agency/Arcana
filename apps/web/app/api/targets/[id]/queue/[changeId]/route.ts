import { approveQueuedTargetChange } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, mutationUuid } from '../../../../../../src/server/authenticated-mutation';
import { targetQueueError } from '../route';
export const runtime = 'nodejs';
export async function POST(request: Request, route: { params: Promise<{ id: string; changeId: string }> }) {
  return authenticatedMutation(request, async (context) => {
    const params = await route.params;
    const body = await mutationBody(request);
    const id = await approveQueuedTargetChange(context, { profileId: mutationUuid(body['profileId'],'profileId'), targetId: params.id, changeId: mutationUuid(params.changeId,'changeId') });
    return Response.json({ id, status: 'approved' });
  }, targetQueueError);
}
