/** The existing no-body toggle remains one non-replayable, all-member command. */
import { feedbackMutationResponse } from '../../../../../src/feedback/mutation-http';
import { mutationUuid } from '../../../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ itemId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  return feedbackMutationResponse(request, async () => ({
    kind: 'toggleVote', itemId: mutationUuid((await context.params).itemId, 'itemId'),
  }));
}
