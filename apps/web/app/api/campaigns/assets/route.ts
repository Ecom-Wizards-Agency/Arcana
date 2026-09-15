import { readAssetLibrarySnapshot, listUsedCampaignCreatives } from '@wizard-ads/db';
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
  return authenticatedMutation(request, async () => {
    const body = await mutationBody(request); mutationUuid(body['profileId'], 'profileId');
    return Response.json({ error: 'Asset-library refresh is unavailable until its ingestion job is registered.' }, { status: 503 });
  });
}
