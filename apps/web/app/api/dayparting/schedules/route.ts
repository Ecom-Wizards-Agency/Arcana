import { listDaypartingSchedules, saveDaypartingDraft, DaypartingScheduleError } from '@wizard-ads/db';
import { DaypartingDraftInput } from '@wizard-ads/shared';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../src/server/authenticated-mutation';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticatedRead(request, async context => {
    const schedules = await listDaypartingSchedules(context, readUuid(new URL(request.url).searchParams.get('profileId'), 'profileId'));
    return Response.json({
      schedules,
      count: schedules.length
    });
  });
}
export async function POST(request: Request) {
  return authenticatedMutation(request, async context => {
    const parsed = DaypartingDraftInput.safeParse(await mutationBody(request));
    if (!parsed.success) throw new MutationInputError('Check the name, campaigns and all 168 whole-percent modifiers.');
    return Response.json({ schedule: await saveDaypartingDraft(context, parsed.data) }, { status: 201 });
  }, error => error instanceof DaypartingScheduleError ? Response.json({ error: error.message }, { status: 409 }) : null);
}
