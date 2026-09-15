import { setCampaignOptimizationExclusion } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, MutationInputError, mutationUuid } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return authenticatedMutation(request, async context => {
    const body = await mutationBody(request), profileId = mutationUuid(body['profileId'], 'profileId');
    if (typeof body['campaignId'] !== 'string' || typeof body['excluded'] !== 'boolean') throw new MutationInputError('Campaign and exclusion state are required');
    return Response.json(await setCampaignOptimizationExclusion(context, {
      profileId,
      campaignId: body['campaignId'],
      excluded: body['excluded']
    }));
  });
}
