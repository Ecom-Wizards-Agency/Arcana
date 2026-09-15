import { saveBrandLensOverride, removeBrandLensOverride } from '@wizard-ads/db';
import { BrandLensOverrideInput, normalizeResearchQuery } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, MutationInputError, mutationUuid } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return authenticatedMutation(request, async context => {
    const body = await mutationBody(request);
    if (body['action'] === 'remove') {
      const profileId = mutationUuid(body['profileId'], 'profileId');
      if (typeof body['keyword'] !== 'string') throw new MutationInputError('Keyword required');
      return Response.json(await removeBrandLensOverride(context, profileId, normalizeResearchQuery(body['keyword'])));
    }
    const parsed = BrandLensOverrideInput.safeParse(body);
    if (!parsed.success) throw new MutationInputError('Check the keyword decision');
    return Response.json(await saveBrandLensOverride(context, parsed.data));
  });
}
