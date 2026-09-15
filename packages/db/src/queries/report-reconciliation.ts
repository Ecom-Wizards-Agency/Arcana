import { Uuid } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';
import type { ClaimedJob } from './jobs.js';

export interface ReportCreateEvidence {
  phase: string;
  status: number | null;
  amazonReportId: string | null;
}

/** Persist evidence while the failing process still owns the request claim. */
export async function quarantineReportCreate(handle: QueryHandle, job: ClaimedJob, evidence: ReportCreateEvidence) {
  const rows = await handle.sql`
    with custody as materialized (
      select id from public.sync_jobs where id = ${job.id} and org_id = ${job.orgId}
        and profile_id = ${job.profileId} and job_type = 'report.request' and status = 'running'
        and claimed_by = ${job.claimedBy}
        and claim_token is not distinct from ${job.claim?.token ?? null}::uuid for update
    )
    update public.report_requests r set reconciliation = jsonb_build_object(
      'version', 1, 'state', 'quarantined', 'recordedAt', now(),
      'evidence', ${JSON.stringify(evidence)}::jsonb),
      error = 'report create outcome unknown; attended reconciliation required'
    where r.id = ${job.id} and r.org_id = ${job.orgId} and r.profile_id = ${job.profileId}
      and r.reconciliation is null and exists (select 1 from custody)
    returning r.id
  `;
  if (rows.length !== 1) throw new Error('could not record ambiguous report create under current custody');
}

export async function listQuarantinedReports(handle: QueryHandle, orgId: string) {
  Uuid.parse(orgId);
  // Older workers did not persist a marker for fenced ambiguity. Such rows are
  // candidates only: the operator must prove the claimant stopped and inspect
  // its exit/log evidence before resolving them.
  return handle.sql<{
    id: string; profileId: string; reportType: string; startDate: string; endDate: string;
    amazonReportId: string | null; requestedAt: string; requestIdentity: unknown;
    reconciliation: unknown; lastError: string | null; classification: string;
  }[]>`
    select r.id, r.profile_id as "profileId", r.report_type::text as "reportType",
      r.start_date::text as "startDate", r.end_date::text as "endDate",
      r.amazon_report_id as "amazonReportId", r.requested_at::text as "requestedAt",
      j.payload as "requestIdentity", r.reconciliation, j.last_error as "lastError",
      case when r.reconciliation ->> 'state' = 'quarantined' then 'quarantined'
        else 'legacy candidate: verify stopped claimant and ambiguity evidence' end as classification
    from public.report_requests r join public.sync_jobs j
      on j.id = r.id and j.org_id = r.org_id and j.profile_id = r.profile_id
    where r.org_id = ${orgId} and j.job_type = 'report.request'
      and j.status in ('running', 'dead') and (
        r.reconciliation ->> 'state' = 'quarantined' or
        (r.reconciliation is null and ((j.status = 'running' and j.claim_token is not null)
          or j.last_error like 'Reporting v3 create outcome is unknown%')))
    order by r.requested_at, r.id
  `;
}

export interface ReconcileReportInput {
  orgId: string;
  requestId: string;
  actor: string;
  reason: string;
  workerStopped: true;
  action: 'adopt' | 'abandon';
  amazonReportId?: string;
}

/** Attended recovery only. No provider client and no report.request enqueue. */
export async function reconcileReport(handle: DbHandle, input: ReconcileReportInput) {
  Uuid.parse(input.orgId); Uuid.parse(input.requestId);
  if (input.workerStopped !== true || !input.actor.trim() || !input.reason.trim()
    || input.actor.length > 200 || input.reason.length > 4000
    || !['adopt', 'abandon'].includes(input.action)) throw new Error('explicit stopped-worker attestation, actor and reason required');
  if (input.action === 'adopt' && (!input.amazonReportId?.trim() || input.amazonReportId.length > 512)) {
    throw new Error('adopt requires an Amazon report id');
  }
  if (input.action === 'abandon' && input.amazonReportId !== undefined) throw new Error('abandon does not accept an Amazon report id');
  return handle.sql.begin(async (sql) => {
    const [row] = await sql<{
      profile_id: string; amazon_report_id: string | null; reconciliation: { evidence?: ReportCreateEvidence } | null;
    }[]>`
      select r.profile_id, r.amazon_report_id, r.reconciliation
      from public.sync_jobs j join public.report_requests r
        on r.id = j.id and r.org_id = j.org_id and r.profile_id = j.profile_id
      where r.id = ${input.requestId} and r.org_id = ${input.orgId} and r.source = 'amazon_api'
        and j.job_type = 'report.request' and j.status in ('running', 'dead')
        and r.status in ('pending', 'processing', 'failed')
        and (r.reconciliation ->> 'state' = 'quarantined' or
          (r.reconciliation is null and ((j.status = 'running' and j.claim_token is not null)
            or j.last_error like 'Reporting v3 create outcome is unknown%')))
      for update of j, r
    `;
    if (!row) throw new Error('request is not an unresolved ambiguous-create candidate in this organisation');
    const downstream = await sql`
      select id from public.sync_jobs where org_id = ${input.orgId} and profile_id = ${row.profile_id}
        and job_type in ('report.poll', 'report.fetch') and payload ->> 'reportRequestId' = ${input.requestId}
      limit 1 for update
    `;
    if (downstream.length > 0) throw new Error('request already has downstream work; inspect its poll/fetch jobs');
    const knownIds = [row.amazon_report_id, row.reconciliation?.evidence?.amazonReportId].filter(Boolean);
    if (input.action === 'adopt' && knownIds.some((id) => id !== input.amazonReportId)) {
      throw new Error('supplied Amazon report id conflicts with recorded evidence');
    }
    const ledger = await sql`
      update public.report_requests set
        amazon_report_id = case when ${input.action} = 'adopt' then ${input.amazonReportId ?? null} else amazon_report_id end,
        status = ${input.action === 'adopt' ? 'pending' : 'failed'}::public.report_status,
        next_poll_at = case when ${input.action} = 'adopt' then now() else null end,
        completed_at = case when ${input.action} = 'abandon' then now() else null end,
        error = ${input.action === 'abandon' ? input.reason : null},
        reconciliation = coalesce(reconciliation, jsonb_build_object('version', 1, 'evidence', null)) ||
          jsonb_build_object('state', ${input.action === 'adopt' ? 'adopted' : 'abandoned'}::text,
            'resolution', jsonb_build_object('actor', ${input.actor}::text, 'reason', ${input.reason}::text,
              'at', now(), 'workerStopped', true, 'amazonReportId', ${input.amazonReportId ?? null}::text))
      where id = ${input.requestId} and org_id = ${input.orgId} returning id
    `;
    const jobs = await sql`
      update public.sync_jobs set status = ${input.action === 'adopt' ? 'succeeded' : 'dead'}::public.sync_job_status,
        finished_at = now(), claimed_by = null, claimed_at = null, claim_token = null,
        last_error = ${input.action === 'abandon' ? input.reason : null}
      where id = ${input.requestId} and org_id = ${input.orgId} returning id
    `;
    let polls = 0;
    if (input.action === 'adopt') {
      const payload = { type: 'report.poll', orgId: input.orgId, profileId: row.profile_id,
        reportRequestId: input.requestId, amazonReportId: input.amazonReportId, attempt: 0 };
      const inserted = await sql`
        insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
        values (${input.orgId}, ${row.profile_id}, 'report.poll', ${JSON.stringify(payload)}::jsonb,
          ${`report.poll:${input.requestId}:0`}) returning id
      `;
      polls = inserted.length;
      if (polls !== 1) throw new Error('reconciliation did not enqueue exactly one poll');
    }
    if (ledger.length !== 1 || jobs.length !== 1) throw new Error('reconciliation row count mismatch');
    return { requests: ledger.length, jobs: jobs.length, polls, action: input.action };
  });
}
