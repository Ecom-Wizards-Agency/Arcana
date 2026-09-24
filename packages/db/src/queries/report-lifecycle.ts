import {
  ReportLaneStage,
  ReportLaneStatus,
  classifyReportLaneFailure,
  reportLaneBlockingStage,
  type ReportLaneErrorClass,
  type ReportLaneJobType,
  type ReportLaneStageStatus,
} from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';

export interface ReportHealth {
  deadJobsByType: Record<string, number>;
  staleRequests: number;
  quarantinedRequests: number;
  newestCompletedReportDateByType: Record<string, string>;
}

/** Counts cover the entire ledger, independent of the operator table limits. */
export async function loadReportHealth(handle: QueryHandle, staleHours = 6): Promise<ReportHealth> {
  if (!Number.isFinite(staleHours) || staleHours <= 0) throw new Error('report stale hours must be positive');
  const [row] = await handle.sql<{ reports: ReportHealth }[]>`
    select jsonb_build_object(
      'deadJobsByType', (select coalesce(jsonb_object_agg(job_type, n), '{}'::jsonb)
        from (select job_type, count(*) as n from public.sync_jobs where status = 'dead' group by job_type) d),
      'staleRequests', (select count(*) from public.report_requests
        where status in ('pending', 'processing') and requested_at < now() - ${staleHours} * interval '1 hour'),
      'quarantinedRequests', (select count(*) from public.report_requests
        where reconciliation ->> 'state' = 'quarantined'),
      'newestCompletedReportDateByType', (select coalesce(jsonb_object_agg(report_type, newest), '{}'::jsonb)
        from (select report_type, max(end_date)::text as newest from public.report_requests
          where status = 'completed' group by report_type) c)
    ) as reports
  `;
  if (!row) throw new Error('report health aggregate returned no row');
  return row.reports;
}

export interface DeadReportJob {
  id: string;
  profileLabel: string;
  jobType: string;
  lastError: string | null;
  attempts: number;
  firstSeen: string;
  lastSeen: string;
}

export const REPORT_LIFECYCLE_STAGES = [
  'requested', 'created', 'polled', 'fetched', 'parsed', 'loaded', 'promoted', 'refused', 'dead', 'quarantined',
] as const;
export type ReportLifecycleCounts = { reportType: string } & Record<typeof REPORT_LIFECYCLE_STAGES[number], number>;

export async function loadReportLifecycle(handle: QueryHandle, orgId: string, profileId: string | null = null) {
  const deadLetters = await handle.sql<DeadReportJob[]>`
    select j.id, coalesce(p.account_name, p.amazon_profile_id) as "profileLabel",
      j.job_type::text as "jobType", j.last_error as "lastError", j.attempts,
      j.created_at::text as "firstSeen", j.updated_at::text as "lastSeen"
    from public.sync_jobs j join public.ad_profiles p on p.id = j.profile_id and p.org_id = j.org_id
    where j.org_id = ${orgId} and (${profileId}::uuid is null or j.profile_id = ${profileId}::uuid)
      and j.status = 'dead'
    order by j.updated_at desc, j.id
    limit 100
  `;
  // Each stage counts requests with durable evidence of that stage, not fact
  // rows or polling attempts. EXISTS prevents multiple child jobs multiplying it.
  const lifecycle = await handle.sql<ReportLifecycleCounts[]>`
    select r.report_type::text as "reportType", count(*)::integer as requested,
      count(*) filter (where r.amazon_report_id is not null)::integer as created,
      count(*) filter (where r.poll_attempts > 0)::integer as polled,
      count(*) filter (where r.bytes_downloaded is not null)::integer as fetched,
      count(*) filter (where r.rows_parsed is not null)::integer as parsed,
      count(*) filter (where r.rows_loaded is not null)::integer as loaded,
      count(*) filter (where r.promoted_rows > 0 or (r.status = 'completed' and r.rows_loaded > 0))::integer as promoted,
      count(*) filter (where r.refused_rows > 0 or r.error like '%refused%')::integer as refused,
      count(*) filter (where exists (select 1 from public.sync_jobs j
        where j.org_id = r.org_id and j.profile_id = r.profile_id and j.status = 'dead'
          and (j.id = r.id or j.payload ->> 'reportRequestId' = r.id::text)))::integer as dead,
      count(*) filter (where r.reconciliation ->> 'state' = 'quarantined')::integer as quarantined
    from public.report_requests r
    where r.org_id = ${orgId} and (${profileId}::uuid is null or r.profile_id = ${profileId}::uuid)
    group by r.report_type order by r.report_type
  `;
  return { deadLetters, lifecycle };
}

/** `release()` stamps this on jobs it returns to the queue; it is not a failure. */
const RELEASED_ON_SHUTDOWN = 'released during graceful shutdown';

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/**
 * WP-323 sync-status evidence for the Reporting v3 lane. Failures are read
 * from the queue ledger and reduced to bounded classes; raw provider and SQL
 * text never leaves this function. A legacy failure returns a job to `queued`
 * with its error recorded (no job rests in `failed`), so "retrying" is derived
 * from that, and every count is measured, including explicit zeros.
 *
 * Stage and profile counts follow `profileId` when one is selected; the dead
 * summary always covers the whole organisation.
 */
export async function loadReportLaneStatus(
  handle: QueryHandle,
  orgId: string,
  profileId: string | null = null,
): Promise<ReportLaneStatus> {
  const failures = await handle.sql<{
    jobType: ReportLaneJobType; state: 'dead' | 'retrying'; lastError: string | null;
    jobs: string | number; lastAt: Date | string; inScope: boolean; resolution: 're-requested' | 'resolved' | null;
  }[]>`
    select j.job_type::text as "jobType",
           case when j.status = 'dead' then 'dead' else 'retrying' end as state,
           j.last_error as "lastError",
           count(*) as jobs,
           max(coalesce(j.finished_at, j.updated_at)) as "lastAt",
           (${profileId}::uuid is null or j.profile_id = ${profileId}::uuid) as "inScope",
           case when j.status <> 'dead' then null
                when j.result -> 'recovery' ->> 'state' in ('re-requested', 'joined') then 're-requested'
                when exists (select 1 from public.report_requests r
                  where r.id = j.id and r.org_id = j.org_id and r.profile_id = j.profile_id
                    and r.reconciliation ->> 'state' in ('abandoned', 'adopted')) then 'resolved'
           end as resolution
      from public.sync_jobs j
     where j.org_id = ${orgId}
       and j.job_type in ('report.request', 'report.poll', 'report.fetch')
       and (j.status in ('failed', 'dead')
         or (j.status = 'queued' and j.attempts > 0 and j.last_error is not null
           and j.last_error <> ${RELEASED_ON_SHUTDOWN}))
     group by 1, 2, 3, 6, 7
  `;
  const successes = await handle.sql<{ jobType: ReportLaneJobType; lastAt: Date | string }[]>`
    select j.job_type::text as "jobType", max(coalesce(j.finished_at, j.updated_at)) as "lastAt"
      from public.sync_jobs j
     where j.org_id = ${orgId}
       and (${profileId}::uuid is null or j.profile_id = ${profileId}::uuid)
       and j.job_type in ('report.request', 'report.poll', 'report.fetch')
       and j.status = 'succeeded'
       -- A fetch that re-requested its report downloaded nothing.
       and coalesce(j.result ->> 'downloadExpired', 'false') <> 'true'
     group by 1
  `;
  const profiles = await handle.sql<{ profileId: string; retrying: string | number; dead: string | number }[]>`
    select p.id as "profileId",
           count(j.id) filter (where j.status = 'failed' or (j.status = 'queued' and j.attempts > 0
             and j.last_error is not null and j.last_error <> ${RELEASED_ON_SHUTDOWN})) as retrying,
           count(j.id) filter (where j.status = 'dead') as dead
      from public.ad_profiles p
      left join public.sync_jobs j on j.org_id = p.org_id and j.profile_id = p.id
     where p.org_id = ${orgId}
       and (${profileId}::uuid is null or p.id = ${profileId}::uuid)
     group by p.id
     order by p.id
  `;

  const stages = new Map<ReportLaneStage, ReportLaneStageStatus>(ReportLaneStage.options.map((stage) => [stage, {
    stage, lastSucceededAt: null, lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0,
  }]));
  const successStages: Record<ReportLaneJobType, readonly ReportLaneStage[]> = {
    'report.request': ['request'], 'report.poll': ['poll'], 'report.fetch': ['fetch', 'load'],
  };
  for (const row of successes) {
    for (const stage of successStages[row.jobType]) stages.get(stage)!.lastSucceededAt = isoOrNull(row.lastAt);
  }
  const dead = { total: 0, byStage: { request: 0, poll: 0, fetch: 0, load: 0 }, reRequested: 0, resolved: 0 };
  for (const row of failures) {
    const jobs = Number(row.jobs);
    const failure = classifyReportLaneFailure(row.jobType, row.lastError);
    if (row.state === 'dead') {
      dead.total += jobs;
      dead.byStage[failure.stage] += jobs;
      if (row.resolution === 're-requested') dead.reRequested += jobs;
      if (row.resolution === 'resolved') dead.resolved += jobs;
    }
    if (!row.inScope) continue;
    const stage = stages.get(failure.stage)!;
    if (row.state === 'dead') stage.dead += jobs;
    else stage.retrying += jobs;
    const lastAt = isoOrNull(row.lastAt)!;
    if (stage.lastFailedAt === null || Date.parse(lastAt) > Date.parse(stage.lastFailedAt)) {
      stage.lastFailedAt = lastAt;
      stage.lastErrorClass = failure.errorClass satisfies ReportLaneErrorClass;
    }
  }
  const ordered = ReportLaneStage.options.map((stage) => stages.get(stage)!);
  return ReportLaneStatus.parse({
    scope: profileId === null ? 'organisation' : 'profile',
    stages: ordered,
    blocking: reportLaneBlockingStage(ordered),
    organisationDead: dead,
    profiles: profiles.map((row) => ({ profileId: row.profileId, retrying: Number(row.retrying), dead: Number(row.dead) })),
  });
}
