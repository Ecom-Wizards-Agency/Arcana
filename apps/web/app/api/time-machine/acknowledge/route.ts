import { acknowledgeObservedChange } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const body = await mutationBody(request);
    const profileId = mutationUuid(body['profileId'], 'profileId');
    if (typeof body['changeId'] !== 'string' || !/^[1-9][0-9]*$/.test(body['changeId'])) throw new MutationInputError('changeId must name an observed change');
    await acknowledgeObservedChange(context, { profileId, changeId: body['changeId'] });
    return Response.json({ acknowledged: 1 });
  });
}
