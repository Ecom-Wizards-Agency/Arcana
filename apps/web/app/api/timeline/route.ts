import { appendTimelineEvent, readManualTimelineEvents, TimelineInputError } from '@wizard-ads/db';
import { TimelineEventInput } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody } from '../../../src/server/authenticated-mutation';
import { authenticatedRead, readUuid } from '../../../src/server/authenticated-read';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticatedRead(request, async (database, actor) => {
    const query = new URL(request.url).searchParams;
    const profileId = query.get('profile') ?? ''; readUuid(profileId,'profile');
    const items = await readManualTimelineEvents(database,actor.orgId,profileId,true);
    return Response.json({items,count:items.length});
  });
}
export async function POST(request: Request) {
  return authenticatedMutation(request, async (context) => {
    const input = TimelineEventInput.safeParse(await mutationBody(request));
    if (!input.success) return Response.json({error:'Check the event fields and date order.'},{status:400});
    return Response.json(await appendTimelineEvent(context,input.data),{status:201});
  }, (error) => error instanceof TimelineInputError ? Response.json({error:error.message},{status:409}) : null);
}
