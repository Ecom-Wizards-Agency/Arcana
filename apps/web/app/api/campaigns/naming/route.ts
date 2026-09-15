import { listCampaignNamingPresets, saveCampaignNamingPreset, copyCampaignNamingPreset } from '@wizard-ads/db';
import { NamingStrategy } from '@wizard-ads/shared';
import { authenticatedRead } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => Response.json(await listCampaignNamingPresets(context)));
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const body = await mutationBody(request);
    if (body['action'] === 'copy') {
      await copyCampaignNamingPreset(context, mutationUuid(body['id'], 'id'), mutationUuid(body['profileId'], 'profileId'));
      return Response.json({ copied: 1 });
    }
    if (body['action'] !== 'save' || typeof body['name'] !== 'string') throw new MutationInputError('A naming preset is required');
    return Response.json(await saveCampaignNamingPreset(context, { name: body['name'], naming: NamingStrategy.parse(body['naming']) }));
  });
}
