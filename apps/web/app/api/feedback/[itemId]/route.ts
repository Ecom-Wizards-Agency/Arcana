/** Read an item or commit one current-member feedback command. */
import { getFeedbackItem } from '@wizard-ads/db';
import { feedbackMutationResponse, feedbackPatch } from '../../../../src/feedback/mutation-http';
import { mutationBody } from '../../../../src/server/authenticated-mutation';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ itemId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    const { itemId } = await context.params;
    readUuid(itemId, 'itemId');
    const item = await getFeedbackItem(database, {
      orgId: actor.orgId,
      itemId,
      viewerId: actor.userId,
    });
    if (!item) return Response.json({ error: 'Feedback item not found' }, { status: 404 });
    return Response.json({ item });
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return feedbackMutationResponse(request, async () => {
    const { itemId } = await context.params;
    return feedbackPatch(itemId, await mutationBody(request));
  });
}
