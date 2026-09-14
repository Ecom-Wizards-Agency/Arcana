import { queueTargetBidChange } from '@wizard-ads/db';
import { QueuedBidRequest } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export function targetQueueError(error: unknown): Response | null {
  if (error && typeof error === 'object' && 'code' in error && ['22023','55000'].includes(String(error.code))) {
    return Response.json({ error: error instanceof Error ? error.message : 'Proposal refused. Reload the target and limits.' }, { status: 409 });
  }
  return null;
}
export async function POST(request: Request, route: { params: Promise<{ id: string }> }) {
  return authenticatedMutation(request, async (context) => {
    const parsed = QueuedBidRequest.safeParse(await mutationBody(request));
    if (!parsed.success || parsed.data.targetId !== (await route.params).id) throw new MutationInputError('Invalid target bid proposal');
    const id = await queueTargetBidChange(context, parsed.data);
    return Response.json({ id }, { status: 201 });
  }, targetQueueError);
}
