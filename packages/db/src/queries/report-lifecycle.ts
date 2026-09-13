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
