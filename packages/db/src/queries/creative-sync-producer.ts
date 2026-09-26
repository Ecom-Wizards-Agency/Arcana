/**
 * Database-only producer for one current-day SB Video observation per eligible
 * profile with a due Creative schedule. It never claims work or calls Amazon.
 * The report lane owns both production and consumption.
 */
import { JobPayload, Uuid } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

export interface DailyCreativeSyncObservation {
  orgId: string;
  profileId: string;
  localDate: string;
  dedupeKey: string;
  jobId: string;
  enqueued: boolean;
}

export interface DailyCreativeSyncEnqueueResult {
  requestedProfiles: number;
  eligibleProfiles: number;
  ineligibleProfiles: number;
  deferredPendingProfiles: number;
  enqueuedJobs: number;
  deduplicatedJobs: number;
  observations: DailyCreativeSyncObservation[];
}

interface RawDailyCreativeSyncResult {
  requested_profiles: string | number;
  eligible_profiles: string | number;
  ineligible_profiles: string | number;
  deferred_pending_profiles: string | number;
  enqueued_jobs: string | number;
  deduplicated_jobs: string | number;
  observations: Array<{
    orgId: string;
    profileId: string;
    localDate: string;
    dedupeKey: string;
    jobId: string;
    enqueued: boolean;
    payload: unknown;
  }>;
}

/**
 * Offer due schedules for all sync-enabled profiles. An explicit profile set
 * remains available to diagnostic callers and uses the same daily deduplication.
 *
 * The queue's `(org_id, dedupe_key)` partial unique index is the retry lock.
 * The key includes the profile UUID because one organization may own many
 * advertiser profiles whose local calendar date is identical.
 */
export async function enqueueDailyCreativeSyncJobs(
  handle: Pick<DbHandle, 'sql'>,
  profileIds: readonly string[] | undefined = undefined,
  observedAt: Date = new Date(),
  expectedProtocol?: 'legacy' | 'fenced',
): Promise<DailyCreativeSyncEnqueueResult> {
  if (profileIds !== undefined) assertBoundedProfileIds(profileIds);
  return handle.sql.begin(async (sql) => {
    const rows = await sql<RawDailyCreativeSyncResult[]>`
      with scheduled as materialized (
        select schedule.id, schedule.profile_id
          from public.sync_schedules schedule
          join public.ad_profiles p on p.id = schedule.profile_id and p.org_id = schedule.org_id
         where ${profileIds === undefined} and schedule.job_type = 'creative.sync'
           and schedule.variant = 'default' and schedule.report_type is null
           and schedule.enabled and p.sync_enabled
           and schedule.next_run_at <= ${observedAt.toISOString()}::timestamptz
           and (${expectedProtocol ?? null}::text is null or
             (select protocol::text from public.get_report_worker_claim_authority()) = ${expectedProtocol ?? null})
         order by schedule.profile_id
         for update of schedule skip locked
      ), requested as materialized (
        select requested.profile_id, null::uuid as schedule_id
          from unnest(${profileIds === undefined ? [] : [...profileIds]}::uuid[]) as requested(profile_id)
         where ${expectedProtocol ?? null}::text is null or
           (select protocol::text from public.get_report_worker_claim_authority()) = ${expectedProtocol ?? null}
        union all
        select profile_id, id as schedule_id from scheduled
      ), enabled as materialized (
        select p.org_id,
               r.schedule_id,
               p.id as profile_id,
               (${observedAt.toISOString()}::timestamptz at time zone p.timezone)::date::text as local_date,
               'creative.sync:SB:' || p.id::text || ':' ||
                 ((${observedAt.toISOString()}::timestamptz at time zone p.timezone)::date::text) as dedupe_key,
               exists (
                 select 1
                   from public.creative_sync_snapshots snapshot
                  where snapshot.org_id = p.org_id
                    and snapshot.profile_id = p.id
                    and snapshot.status = 'report_pending'
               ) as report_pending
          from requested r
          join public.ad_profiles p on p.id = r.profile_id
         where p.sync_enabled
      ), eligible as materialized (
        select org_id, profile_id, schedule_id, local_date, dedupe_key
          from enabled
         where not report_pending
      ), inserted as (
        insert into public.sync_jobs
          (org_id, profile_id, schedule_id, job_type, payload, run_after, dedupe_key)
        select e.org_id,
               e.profile_id,
               e.schedule_id,
               'creative.sync'::public.sync_job_type,
               jsonb_build_object(
                 'type', 'creative.sync',
                 'orgId', e.org_id,
                 'profileId', e.profile_id,
                 'startDate', e.local_date,
                 'endDate', e.local_date,
                 'adProduct', 'SB',
                 'allowObservedAttributionFacts', true
               ),
               ${observedAt.toISOString()}::timestamptz,
               e.dedupe_key
          from eligible e
        on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
        returning id, org_id, profile_id, dedupe_key, payload
      ), resolved as (
        select e.org_id,
               e.profile_id,
               e.local_date,
               e.dedupe_key,
               i.id as job_id,
               true as enqueued,
               i.payload
          from eligible e
          join inserted i
            on i.org_id = e.org_id
           and i.profile_id = e.profile_id
           and i.dedupe_key = e.dedupe_key
        union all
        select e.org_id,
               e.profile_id,
               e.local_date,
               e.dedupe_key,
               j.id as job_id,
               false as enqueued,
               j.payload
          from eligible e
          join public.sync_jobs j
            on j.org_id = e.org_id
           and j.profile_id = e.profile_id
           and j.dedupe_key = e.dedupe_key
         where not exists (
           select 1 from inserted i
            where i.org_id = e.org_id
              and i.profile_id = e.profile_id
              and i.dedupe_key = e.dedupe_key
         )
      ), advanced as (
        update public.sync_schedules schedule
           set next_run_at = ((r.local_date::timestamp + schedule.cadence) at time zone p.timezone),
               last_enqueued_at = ${observedAt.toISOString()}::timestamptz
          from resolved r, public.ad_profiles p
         where schedule.profile_id = r.profile_id and p.id = r.profile_id
           and schedule.id in (select schedule_id from eligible where schedule_id is not null)
        returning schedule.id
      )
      select (select count(*) from requested) as requested_profiles,
             (select count(*) from eligible) as eligible_profiles,
             (select count(*) from requested) - (select count(*) from enabled) as ineligible_profiles,
             (select count(*) from enabled where report_pending) as deferred_pending_profiles,
             count(*) filter (where enqueued) as enqueued_jobs,
             count(*) filter (where not enqueued) as deduplicated_jobs,
             coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'orgId', org_id,
                   'profileId', profile_id,
                   'localDate', local_date,
                   'dedupeKey', dedupe_key,
                   'jobId', job_id,
                   'enqueued', enqueued,
                   'payload', payload
                 ) order by org_id, profile_id
               ) filter (where job_id is not null),
               '[]'::jsonb
             ) as observations
        from resolved
    `;
    const row = rows[0];
    if (row === undefined) throw new Error('daily Creative queue query returned no accounting row');
    const observations = row.observations.map((observation): DailyCreativeSyncObservation => {
      const payload = JobPayload.parse(observation.payload);
      if (
        payload.type !== 'creative.sync' ||
        payload.orgId !== observation.orgId ||
        payload.profileId !== observation.profileId ||
        payload.startDate !== observation.localDate ||
        payload.endDate !== observation.localDate ||
        payload.adProduct !== 'SB' ||
        payload.allowObservedAttributionFacts !== true
      ) {
        throw new Error('daily Creative queue row did not reconcile with its profile-local offer');
      }
      return {
        orgId: observation.orgId,
        profileId: observation.profileId,
        localDate: observation.localDate,
        dedupeKey: observation.dedupeKey,
        jobId: observation.jobId,
        enqueued: observation.enqueued,
      };
    });
    const result = {
      requestedProfiles: Number(row.requested_profiles),
      eligibleProfiles: Number(row.eligible_profiles),
      ineligibleProfiles: Number(row.ineligible_profiles),
      deferredPendingProfiles: Number(row.deferred_pending_profiles),
      enqueuedJobs: Number(row.enqueued_jobs),
      deduplicatedJobs: Number(row.deduplicated_jobs),
      observations,
    };
    if (
      result.requestedProfiles !==
        result.eligibleProfiles + result.deferredPendingProfiles + result.ineligibleProfiles ||
      result.eligibleProfiles !== result.enqueuedJobs + result.deduplicatedJobs ||
      result.eligibleProfiles !== result.observations.length
    ) {
      throw new Error('daily Creative queue counts did not reconcile');
    }
    return result;
  });
}

function assertBoundedProfileIds(profileIds: readonly string[]): void {
  if (
    profileIds.length === 0 ||
    profileIds.some((profileId) => !Uuid.safeParse(profileId).success) ||
    new Set(profileIds.map((profileId) => profileId.toLowerCase())).size !== profileIds.length
  ) {
    throw new Error('daily Creative queue requires a non-empty unique UUID pilot cohort');
  }
}

/** Backfill the daily schedule for every sync-enabled profile, without changing operator edits. */
export async function ensureCreativeSyncSchedules(handle: Pick<DbHandle, 'sql'>): Promise<number> {
  const rows = await handle.sql<{ id: string }[]>`
    insert into public.sync_schedules (org_id, profile_id, job_type, variant, cadence, payload)
    select org_id, id, 'creative.sync', 'default', '1 day'::interval,
           '{"adProduct":"SB","allowObservedAttributionFacts":true}'::jsonb
      from public.ad_profiles where sync_enabled
    on conflict (profile_id, job_type, report_type, variant) do nothing
    returning id
  `;
  return rows.length;
}
