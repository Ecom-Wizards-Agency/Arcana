import { daypartingReviewEvidence, listDaypartingSchedules, DaypartingScheduleError } from '@wizard-ads/db';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from '@wizard-ads/db';
import { readDaypartingWorkspace } from './data';
export async function loadScheduleEvidence(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction, input: { profileId: string; id: string; start: string; end: string }) {
  const schedule = (await listDaypartingSchedules(context, input.profileId)).find(s => s.id === input.id);
  if (!schedule) throw new DaypartingScheduleError('Schedule not found');
  // UTC padding includes both ends of every profile-local calendar day; summarize by localDate below.
  const from = new Date(`${input.start}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${input.end}T00:00:00Z`);
  to.setUTCDate(to.getUTCDate() + 2);
  const workspace = await readDaypartingWorkspace(context, {
    orgId: context.actor.orgId,
    profileId: input.profileId,
    fromUtcHour: from.toISOString(),
    toUtcHour: to.toISOString()
  });
  return daypartingReviewEvidence({
    facts: workspace.facts,
    campaignIds: schedule.campaignIds,
    start: input.start,
    end: input.end,
    maturityPolicyConfigured: workspace.maturityPolicyConfigured
  });
}
