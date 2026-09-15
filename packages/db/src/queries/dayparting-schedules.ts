import { createHash } from 'node:crypto';
import { DaypartingDraftInput, DaypartingSchedule, DaypartingReviewInput, DaypartingEvidenceSummary, DaypartingReviewRecord } from '@wizard-ads/shared';
import type { MarketingStreamHourlyFact } from '@wizard-ads/shared';
import type { AuthenticatedReadSnapshot, AuthenticatedEditorTransaction } from './authenticated-actor.js';
import { readResearchProfile } from './sqp.js';
type Reader = AuthenticatedReadSnapshot | AuthenticatedEditorTransaction;
export class DaypartingScheduleError extends Error { }
const iso = (value: unknown) => value === null || value === undefined ? null : new Date(value as string | Date).toISOString();
export async function listDaypartingSchedules(context: Reader, profileId: string): Promise<DaypartingSchedule[]> {
  await readResearchProfile(context, profileId);
  const rows = await context.sql`select s.id,s.org_id as "orgId",s.profile_id as "profileId",s.name,s.timezone,s.modifiers,s.status,
    s.review_record as review,s.enabled_at as "enabledAt",s.paused_at as "pausedAt",s.source_proposal_id as "sourceProposalId",
    s.created_at as "createdAt",s.updated_at as "updatedAt",s.next_run_at as "nextRunAt",s.cadence_limits as "cadenceLimits",s.profile_kill_switch as "profileKillSwitch",
    coalesce((select jsonb_agg(a.campaign_id order by a.campaign_id) from public.dayparting_schedule_campaigns a where a.schedule_id=s.id),'[]'::jsonb) as "campaignIds"
    from public.dayparting_schedules s where s.org_id=${context.actor.orgId} and s.profile_id=${profileId} order by s.created_at,s.id`;
  return rows.map(r => DaypartingSchedule.parse({
    ...r,
    createdAt: iso(r['createdAt']),
    updatedAt: iso(r['updatedAt']),
    enabledAt: iso(r['enabledAt']),
    pausedAt: iso(r['pausedAt']),
    nextRunAt: iso(r['nextRunAt'])
  }));
}
export async function saveDaypartingDraft(context: AuthenticatedEditorTransaction, raw: DaypartingDraftInput): Promise<DaypartingSchedule> {
  const input = DaypartingDraftInput.parse(raw), { sql, actor } = context;
  const profile = await readResearchProfile(context, input.profileId);
  // Serialize schedule and campaign-set changes within a profile, including new schedules.
  await sql`select pg_advisory_xact_lock(hashtextextended(${input.profileId},266))`;
  const campaigns = await sql`select amazon_id from public.campaigns where org_id=${actor.orgId} and profile_id=${input.profileId}
    and amazon_id=any(${input.campaignIds}::text[]) and ad_product='SP' and deleted_at is null`;
  if (campaigns.length !== input.campaignIds.length) throw new DaypartingScheduleError('Campaign selection is unavailable');
  const conflicts = await sql`select campaign_id from public.dayparting_schedule_campaigns where org_id=${actor.orgId} and profile_id=${input.profileId}
    and active and campaign_id=any(${input.campaignIds}::text[]) and schedule_id is distinct from ${input.id ?? null}::uuid`;
  if (conflicts.length) throw new DaypartingScheduleError('A campaign already has an active schedule');
  let id = input.id;
  if (id) {
    const rows = await sql`update public.dayparting_schedules set name=${input.name},modifiers=${JSON.stringify(input.modifiers)}::text::jsonb,
      timezone=${profile.timezone},status='draft',reviewed_by=null,reviewed_at=null,review_record=null,source_proposal_id=${input.sourceProposalId}
      where org_id=${actor.orgId} and profile_id=${input.profileId} and id=${id} and status in ('draft','reviewed')
      and updated_at=${input.expectedUpdatedAt!}::timestamptz returning id`;
    if (rows.length !== 1) throw new DaypartingScheduleError('Schedule changed. Reload before editing.');
    await sql`delete from public.dayparting_schedule_campaigns where schedule_id=${id} and org_id=${actor.orgId}`;
  } else {
    const [row] = await sql<{ id: string }[]>`insert into public.dayparting_schedules(org_id,profile_id,name,timezone,modifiers,source_proposal_id)
      values(${actor.orgId},${input.profileId},${input.name},${profile.timezone},${JSON.stringify(input.modifiers)}::text::jsonb,${input.sourceProposalId}) returning id`;
    if (!row) throw new Error('Schedule insert count mismatch');
    id = row.id;
  }
  for (const campaign of input.campaignIds) await sql`insert into public.dayparting_schedule_campaigns(org_id,profile_id,schedule_id,campaign_id)
    values(${actor.orgId},${input.profileId},${id},${campaign})`;
  const saved = (await listDaypartingSchedules(context, input.profileId)).find(s => s.id === id);
  if (!saved || saved.campaignIds.length !== input.campaignIds.length || JSON.stringify(saved.modifiers) !== JSON.stringify(input.modifiers)) throw new Error('Schedule readback mismatch');
  return saved;
}
/** Hash all facts that informed the report; a different campaign, revision or window invalidates acknowledgement. */
export function daypartingReviewEvidence(input: { facts: readonly MarketingStreamHourlyFact[]; campaignIds: readonly string[]; start: string; end: string; maturityPolicyConfigured: boolean }): DaypartingEvidenceSummary {
  const campaignIds = [...input.campaignIds].sort();
  const facts = input.facts.filter(f => campaignIds.includes(f.campaignId) && f.localDate >= input.start && f.localDate <= input.end)
    .sort((a, b) => `${a.campaignId}|${a.utcHour}|${a.adProduct}`.localeCompare(`${b.campaignId}|${b.utcHour}|${b.adProduct}`));
  const summary = {
    start: input.start,
    end: input.end,
    campaignIds,
    factRows: facts.length,
    settledRows: facts.filter(f => f.settlingState === 'settled').length,
    settlingRows: facts.filter(f => f.settlingState === 'settling').length,
    revisedRows: facts.filter(f => f.settlingState === 'revised').length,
    coveredCampaignIds: [...new Set(facts.map(f => f.campaignId))].sort(),
    maturityPolicyConfigured: input.maturityPolicyConfigured,
    spend: facts.length ? facts.reduce((n, f) => n + f.cost, 0) : null,
    sales: facts.length ? facts.reduce((n, f) => n + f.sales, 0) : null,
    orders: facts.length ? facts.reduce((n, f) => n + f.purchases, 0) : null
  };
  return DaypartingEvidenceSummary.parse({
    ...summary,
    fingerprint: createHash('sha256').update(JSON.stringify({
      summary,
      facts
    })).digest('hex')
  });
}
export async function reviewDaypartingSchedule(context: AuthenticatedEditorTransaction, raw: DaypartingReviewInput, evidence: DaypartingEvidenceSummary): Promise<DaypartingSchedule> {
  const input = DaypartingReviewInput.parse(raw), { sql, actor } = context;
  await sql`select pg_advisory_xact_lock(hashtextextended(${input.profileId},266))`;
  const schedule = (await listDaypartingSchedules(context, input.profileId)).find(s => s.id === input.id);
  if (!schedule || !['draft', 'reviewed'].includes(schedule.status) || schedule.updatedAt !== new Date(input.expectedUpdatedAt).toISOString()) throw new DaypartingScheduleError('Schedule changed. Reload before review.');
  if (!schedule.campaignIds.length || JSON.stringify([...schedule.campaignIds].sort()) !== JSON.stringify([...evidence.campaignIds].sort()) ||
    evidence.start !== input.evidenceStart || evidence.end !== input.evidenceEnd || evidence.fingerprint !== input.evidenceFingerprint) throw new DaypartingScheduleError('Evidence changed. Review the current report.');
  if (!evidence.factRows || !evidence.maturityPolicyConfigured || evidence.settledRows !== evidence.factRows || evidence.coveredCampaignIds.length !== schedule.campaignIds.length) throw new DaypartingScheduleError('Review requires mature hourly evidence for every campaign');
  const [clock] = await sql<{ now: Date }[]>`select date_trunc('milliseconds',clock_timestamp()) as now`;
  const review = DaypartingReviewRecord.parse({
    reviewedBy: actor.userId,
    reviewedAt: new Date(clock!.now).toISOString(),
    campaignIds: schedule.campaignIds,
    modifiers: schedule.modifiers,
    evidence
  });
  const rows = await sql`update public.dayparting_schedules set status='reviewed',reviewed_by=${actor.userId},reviewed_at=${review.reviewedAt},review_record=${JSON.stringify(review)}::text::jsonb
    where org_id=${actor.orgId} and profile_id=${input.profileId} and id=${input.id} and updated_at=${input.expectedUpdatedAt}::timestamptz returning id`;
  if (rows.length !== 1) throw new DaypartingScheduleError('Schedule changed. Reload before review.');
  const result = (await listDaypartingSchedules(context, input.profileId)).find(s => s.id === input.id);
  if (!result || result.review?.reviewedBy !== actor.userId) throw new Error('Schedule review readback mismatch');
  return result;
}
