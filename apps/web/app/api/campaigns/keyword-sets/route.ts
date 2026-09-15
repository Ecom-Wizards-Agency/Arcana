import { listCampaignKeywordSets, saveCampaignKeywordSet } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => Response.json(await listCampaignKeywordSets(context, readUuid(new URL(request.url).searchParams.get('profileId'), 'profileId'))));
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => Response.json(await saveCampaignKeywordSet(context, await mutationBody(request))));
}
