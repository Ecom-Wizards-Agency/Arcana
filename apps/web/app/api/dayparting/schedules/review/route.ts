import { DaypartingScheduleError, reviewDaypartingSchedule } from '@wizard-ads/db';
import { DaypartingReviewInput } from '@wizard-ads/shared';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../../../src/server/authenticated-mutation';
import { loadScheduleEvidence } from '../../../../../src/dayparting/review-evidence';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  return authenticatedMutation(request, async context => {
    const parsed = DaypartingReviewInput.safeParse(await mutationBody(request));
    if (!parsed.success) throw new MutationInputError('Check the schedule revision and evidence window');
    const input = parsed.data;
    const evidence = await loadScheduleEvidence(context, {
      profileId: input.profileId,
      id: input.id,
      start: input.evidenceStart,
      end: input.evidenceEnd
    });
    return Response.json({ schedule: await reviewDaypartingSchedule(context, input, evidence) });
  }, error => error instanceof DaypartingScheduleError ? Response.json({ error: error.message }, { status: 409 }) : null);
}
