import { readAssetLibrarySnapshot, listUsedCampaignCreatives, requestAssetLibraryRefresh } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, mutationUuid } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => {
    const profileId = readUuid(new URL(request.url).searchParams.get('profileId'), 'profileId');
    return Response.json({ snapshot: await readAssetLibrarySnapshot(context, profileId), used: await listUsedCampaignCreatives(context, profileId) });
  });
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const body = await mutationBody(request); const profileId = mutationUuid(body['profileId'], 'profileId');
    return Response.json(await requestAssetLibraryRefresh(context, profileId), { status: 202 });
  });
}
