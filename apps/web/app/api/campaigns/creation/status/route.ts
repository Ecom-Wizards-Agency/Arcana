import { readCampaignCreationBatch } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../../../src/server/authenticated-read';

export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => {
    const query = new URL(request.url).searchParams;
    const batch = await readCampaignCreationBatch(context, readUuid(query.get('profileId'), 'profileId'), readUuid(query.get('batchId'), 'batchId'));
    return batch ? Response.json(batch) : Response.json({ code: 'not_found', error: 'Creation batch not found.' }, { status: 404 });
  });
}
