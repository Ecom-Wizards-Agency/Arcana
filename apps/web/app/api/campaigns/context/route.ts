import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { loadCampaignBuilderContext } from '../../../../src/campaigns/data';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => Response.json(await loadCampaignBuilderContext(context,
    readUuid(new URL(request.url).searchParams.get('profileId'), 'profileId'))));
}
