import { saveTimelineSettings } from '@wizard-ads/db';
import { TimelineEvidenceSettings, Uuid } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody } from '../../../../src/server/authenticated-mutation';
export async function PUT(request: Request) {
  return authenticatedMutation(request,async (context) => {
    const raw = await mutationBody(request);
    const profile = Uuid.safeParse(raw['profileId']); const settings = TimelineEvidenceSettings.safeParse(raw['settings']);
    if(!profile.success||!settings.success) return Response.json({error:'Check the evidence settings.'},{status:400});
    return Response.json(await saveTimelineSettings(context,profile.data,settings.data));
  });
}
