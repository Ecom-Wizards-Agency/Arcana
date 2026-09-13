import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { loadReportHealth, loadReportLifecycle } from './queries/report-lifecycle.js';
import { listQuarantinedReports, quarantineReportCreate, reconcileReport } from './queries/report-reconciliation.js';
import { withAuthenticatedActor } from './queries/authenticated-actor.js';
import { finishSyncJobFenced } from './queries/jobs.js';
import type { ClaimToken, ClaimedJob } from './queries/jobs.js';

describe('report lifecycle and attended reconciliation', () => {
  let db: TestDatabase;
  let orgId: string;
  let profileId: string;
  const userId = randomUUID();
  beforeAll(async () => {
    db = await createTestDatabase('report_lifecycle');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner', '2026-08-29') as id`;
    orgId = org!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  it('counts every fixture request once, with tenant-scoped authenticated reads', async () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    for (const [index, id] of ids.entries()) {
      await db.sql`insert into public.report_requests
        (id, org_id, profile_id, report_type, start_date, end_date, status, requested_at,
          amazon_report_id, poll_attempts, bytes_downloaded, rows_parsed, rows_loaded, refused_rows, reconciliation)
        values (${id}, ${orgId}, ${profileId}, 'sdCampaigns', '2026-08-28', '2026-08-29',
          ${['pending', 'processing', 'completed', 'failed'][index]!}::public.report_status,
          now() - ${index < 2 ? 8 : 1} * interval '1 hour',
          ${index ? `synthetic-${index}` : null}, ${index ? index : 0},
          ${index >= 2 ? 100 : null}, ${index >= 2 ? 2 : null}, ${index >= 2 ? 2 : null},
          ${index === 3 ? 1 : null}, ${index === 0 ? '{"version":1,"state":"quarantined"}' : null}::jsonb)`;
    }
    // Two dead child jobs belong to one request: dead must remain one.
    for (const type of ['report.fetch', 'report.poll']) {
      await db.sql`insert into public.sync_jobs (org_id, profile_id, job_type, payload, status, attempts, last_error)
        values (${orgId}, ${profileId}, ${type}::public.sync_job_type,
          ${JSON.stringify({ reportRequestId: ids[3] })}::jsonb, 'dead', 1, 'synthetic refusal')`;
    }
    const result = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadReportLifecycle({ sql }, orgId, profileId));
    expect(result.lifecycle.find((row) => row.reportType === 'sdCampaigns')).toEqual({
      reportType: 'sdCampaigns', requested: ids.length, created: 3, polled: 3, fetched: 2,
      parsed: 2, loaded: 2, promoted: 1, refused: 1, dead: 1, quarantined: 1,
    });
    expect(result.deadLetters).toHaveLength(2);
    expect(result.deadLetters.map((row) => row.attempts)).toEqual([1, 1]);
    const hidden = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadReportLifecycle({ sql }, randomUUID()));
    expect(hidden).toEqual({ deadLetters: [], lifecycle: [] });
    expect(await loadReportHealth(db)).toEqual({
      deadJobsByType: { 'report.fetch': 1, 'report.poll': 1 }, staleRequests: 2, quarantinedRequests: 1,
      newestCompletedReportDateByType: { spCampaigns: '2026-08-29', sdCampaigns: '2026-08-29' },
    });
    expect((await loadReportHealth(db, 9)).staleRequests).toBe(0);
    await expect(loadReportHealth(db, 0)).rejects.toThrow('positive');
  });

  async function candidate(record = true) {
    const id = randomUUID();
    const token = randomUUID() as ClaimToken;
    const payload = { type: 'report.request' as const, orgId, profileId, reportType: 'sbCampaigns' as const,
      startDate: '2026-08-28', endDate: '2026-08-29' };
    await db.sql`insert into public.sync_jobs
      (id, org_id, profile_id, job_type, payload, status, claimed_by, claim_token, attempts)
      values (${id}, ${orgId}, ${profileId}, 'report.request', ${JSON.stringify(payload)}::jsonb,
        'running', 'synthetic-worker', ${token}::uuid, 1)`;
    await db.sql`insert into public.report_requests (id, org_id, profile_id, report_type, start_date, end_date)
      values (${id}, ${orgId}, ${profileId}, 'sbCampaigns', '2026-08-28', '2026-08-29')`;
    const claim = { jobId: id, workerId: 'synthetic-worker', token };
    const job: ClaimedJob = { id, orgId, profileId, jobType: 'report.request', payload, claim,
      claimedBy: 'synthetic-worker', attempts: 1, maxAttempts: 5, dedupeKey: null };
    if (record) await quarantineReportCreate(db, job, { phase: 'server-response', status: 503, amazonReportId: null });
    return { id, claim, job };
  }
  const resolution = (requestId: string) => ({ orgId, requestId, actor: 'synthetic operator',
    reason: 'verified stopped process and provider request window', workerStopped: true as const });

  it('adopts one exact report, keeps evidence, queues one poll and rejects stale custody or a second resolution', async () => {
    const { id, claim } = await candidate();
    const listed = (await listQuarantinedReports(db, orgId)).filter((row) => row.id === id);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ requestIdentity: { type: 'report.request' }, reconciliation: {
      state: 'quarantined', evidence: { phase: 'server-response', status: 503, amazonReportId: null },
    } });
    const input = { ...resolution(id), action: 'adopt' as const, amazonReportId: 'synthetic-adopted-report' };
    expect(await reconcileReport(db, input)).toEqual({ requests: 1, jobs: 1, polls: 1, action: 'adopt' });
    const [ledger] = await db.sql`select amazon_report_id, status, reconciliation from public.report_requests where id = ${id}`;
    expect(ledger).toMatchObject({ amazon_report_id: input.amazonReportId, status: 'pending', reconciliation: {
      state: 'adopted', evidence: { status: 503 }, resolution: { actor: input.actor, reason: input.reason, at: expect.any(String) },
    } });
    const polls = await db.sql`select job_type, payload from public.sync_jobs where payload ->> 'reportRequestId' = ${id}`;
    expect(polls).toEqual([{ job_type: 'report.poll', payload: { type: 'report.poll', orgId, profileId,
      reportRequestId: id, amazonReportId: input.amazonReportId, attempt: 0 } }]);
    expect(await finishSyncJobFenced(db, claim, 'succeeded')).toMatchObject({ decision: 'stale_claim' });
    await expect(reconcileReport(db, input)).rejects.toThrow('not an unresolved');
    expect((await listQuarantinedReports(db, orgId)).filter((row) => row.id === id)).toHaveLength(0);
  });

  it('abandons one request without a follow-up job, preserves attempts and records actor/time/reason', async () => {
    const { id } = await candidate();
    const input = { ...resolution(id), action: 'abandon' as const };
    expect(await reconcileReport(db, input)).toEqual({ requests: 1, jobs: 1, polls: 0, action: 'abandon' });
    const [job] = await db.sql`select status, attempts, last_error, claim_token from public.sync_jobs where id = ${id}`;
    expect(job).toEqual({ status: 'dead', attempts: 1, last_error: input.reason, claim_token: null });
    const [ledger] = await db.sql`select status, error, reconciliation from public.report_requests where id = ${id}`;
    expect(ledger).toMatchObject({ status: 'failed', error: input.reason, reconciliation: {
      state: 'abandoned', evidence: { status: 503 }, resolution: { actor: input.actor, reason: input.reason, at: expect.any(String) },
    } });
    expect(await db.sql`select id from public.sync_jobs where payload ->> 'reportRequestId' = ${id}`).toHaveLength(0);
  });

  it('fails closed on foreign scope, known-id conflict, stale evidence custody and poll-key collision', async () => {
    const { id, job } = await candidate(false);
    await quarantineReportCreate(db, job, { phase: 'provider-id-persistence', status: null, amazonReportId: 'known-report' });
    const input = { ...resolution(id), action: 'adopt' as const, amazonReportId: 'other-report' };
    await expect(reconcileReport(db, { ...input, orgId: randomUUID() })).rejects.toThrow('not an unresolved');
    await expect(reconcileReport(db, input)).rejects.toThrow('conflicts');
    await expect(quarantineReportCreate(db, { ...job, claimedBy: 'stale-worker' }, { phase: 'transport', status: null, amazonReportId: null }))
      .rejects.toThrow('current custody');
    await db.sql`insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      values (${orgId}, ${profileId}, 'report.poll', '{}'::jsonb, ${`report.poll:${id}:0`})`;
    await expect(reconcileReport(db, { ...input, amazonReportId: 'known-report' })).rejects.toThrow();
    const [row] = await db.sql`select status, reconciliation ->> 'state' as state from public.report_requests where id = ${id}`;
    expect(row).toEqual({ status: 'pending', state: 'quarantined' });
    await db.sql`update public.sync_jobs set payload = ${JSON.stringify({ reportRequestId: id })}::jsonb
      where org_id = ${orgId} and dedupe_key = ${`report.poll:${id}:0`}`;
    await expect(reconcileReport(db, { ...resolution(id), action: 'abandon' })).rejects.toThrow('downstream work');
    expect(await db.sql`select id from public.sync_jobs where id = ${id} and status = 'running'`).toHaveLength(1);

  });

  it('labels historical unmarked fenced claims as candidates and allows attended abandonment', async () => {
    const { id } = await candidate(false);
    const row = (await listQuarantinedReports(db, orgId)).find((item) => item.id === id);
    expect(row?.classification).toContain('legacy candidate');
    expect(row?.reconciliation).toBeNull();
    expect(await reconcileReport(db, { ...resolution(id), action: 'abandon' })).toMatchObject({ requests: 1, jobs: 1, polls: 0 });
  });
});
