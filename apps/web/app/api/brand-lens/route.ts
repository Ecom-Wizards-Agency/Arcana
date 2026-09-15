import { readBrandLens } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../src/server/authenticated-read';
import { periodFromParams, todayIso } from '../../_lib/periods';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticatedRead(request, async context => {
    const query = new URL(request.url).searchParams, profileId = readUuid(query.get('profileId'), 'profileId');
    const period = periodFromParams({
      from: query.get('from') ?? undefined,
      to: query.get('to') ?? undefined
    }, todayIso());
    return Response.json(await readBrandLens(context, profileId, period));
  });
}
