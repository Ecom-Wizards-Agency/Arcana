/**
 * WP-323 against a real, migrated Postgres: claim order, expiry-aware fetches,
 * automatic recovery of dead fetches inside the restatement horizon, and the
 * reconciliation CLI's `abandon-dead`. Amazon is a fake transport throughout.
 *
 * Every pipeline case asserts the ledger (rows parsed against rows loaded) and
 * the queue, not the claim count.
 */
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { listQuarantinedReports } from '@wizard-ads/db';
import type { JobPayload, JobType, Region } from '@wizard-ads/shared';
import type { AdsApiClient, AdsProfileContext, AdsReportStatus, CreateReportInput, EntityListing } from './ads-api.js';
import { RegionTokenBuckets } from './region-token-buckets.js';
import { runReconcileReportsCli } from './reconcile-reports-cli.js';
import { PostgresWorkerStore, REPORT_LANE_CLAIM_PRIORITY } from './store.js';
import { SyncWorker, type WorkerLogger } from './worker.js';

const available = await databaseAvailable();
const USER = '55555555-5555-4555-8555-555555555555';
const LANE: readonly JobType[] = ['report.request', 'report.poll', 'report.fetch', 'entity.sync'];
const quiet: WorkerLogger = { info: () => {}, error: () => {} };
const LEGACY_MISLABEL = 'report download exceeded decompressed_bytes limit';

function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function signedUrl(reportId: string, signedAt: Date): string {
  const query = new URLSearchParams({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Date': amzDate(signedAt),
    'X-Amz-Expires': '3600',
    'X-Amz-Signature': 'synthetic',
  });
  return `https://reports.invalid/${reportId}.json.gz?${query.toString()}`;
}

function addDays(date: string, amount: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86_400_000).toISOString().slice(0, 10);
}

function datesIn(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let date = start; date <= end; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** Fake Reporting v3: every report completes on its first poll with a fresh URL. */
class FakeReportingApi implements AdsApiClient {
  readonly created: CreateReportInput[] = [];
  readonly downloaded: string[] = [];
  private readonly windows = new Map<string, { start: string; end: string }>();

  async listEntities(): Promise<EntityListing> { return { rows: [], succeeded: ['SP', 'SB', 'SD'], failures: [] }; }
  async listProfiles(_region: Region): Promise<readonly string[]> { return []; }
  async createReport(input: CreateReportInput): Promise<{ reportId: string }> {
    this.created.push(input);
    const reportId = `synthetic-report-${this.created.length}`;
    this.windows.set(reportId, { start: input.startDate, end: input.endDate });
    return { reportId };
  }
  async getReport(_profile: AdsProfileContext, reportId: string): Promise<AdsReportStatus> {
    return { status: 'COMPLETED', downloadUrl: signedUrl(reportId, new Date()) };
  }
  async downloadReport(url: string): Promise<AsyncIterable<Uint8Array>> {
    this.downloaded.push(url);
    const reportId = /reports\.invalid\/([^.]+)\.json\.gz/.exec(url)?.[1] ?? '';
    const window = this.windows.get(reportId);
    if (!window) throw new Error('synthetic storage does not know this report');
    const rows = datesIn(window.start, window.end).flatMap((date) => [
      { date, campaignId: 'synthetic-c-1', impressions: 100, clicks: 10, cost: 3, purchases7d: 1, sales7d: 20, unitsSoldClicks7d: 1 },
      { date, campaignId: 'synthetic-c-2', impressions: 50, clicks: 5, cost: 2, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 },
    ]);
    const bytes = gzipSync(JSON.stringify(rows));
    return (async function* stream() { yield bytes.subarray(0, 100); yield bytes.subarray(100); })();
  }
}

describe.skipIf(!available)('WP-323 report fetch reliability + real Postgres', () => {
  let database: TestDatabase;
  let store: PostgresWorkerStore;
  let orgId: string;
  let profileId: string;
  let yesterday: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp323_fetch');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('wp323', ${USER}, 'owner') as id`;
    orgId = org!.id;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} order by id limit 1`;
    profileId = profile!.id;
    await database.sql`update public.ad_profiles set sync_enabled = true where id = ${profileId}`;
    store = new PostgresWorkerStore(database);
    await store.provisionSchedules(orgId, profileId);
    const [clock] = await database.sql<{ yesterday: string }[]>`
      select ((now() at time zone timezone)::date - 1)::text as yesterday from public.ad_profiles where id = ${profileId}`;
    yesterday = clock!.yesterday;
  }, 120_000);

  beforeEach(async () => {
    await database.sql`delete from public.unified_report_runs where org_id = ${orgId}`;
    await database.sql`delete from public.recommendation_preview_batches where org_id = ${orgId}`;
    await database.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
    await database.sql`delete from public.sync_jobs where org_id = ${orgId}`;
    await database.sql`delete from public.report_requests where org_id = ${orgId}`;
    await database.sql`delete from public.fact_profile_daily where profile_id = ${profileId}`;
    await database.sql`update public.sync_schedules set enabled = true where org_id = ${orgId}`;
  });

  afterAll(async () => { await database?.drop(); }, 30_000);

  const requestPayload = (reportType: string, startDate: string, endDate: string) =>
    ({ type: 'report.request', orgId, profileId, reportType, startDate, endDate }) as JobPayload;

  /** A request ledger with its (finished) request job, as the lane leaves them. */
  async function ledger(reportType: string, start: string, end: string, options: {
    status?: string; error?: string | null; requestDedupeKey?: string; requestStatus?: string;
    requestError?: string | null; requestedAt?: string; claimToken?: string | null; amazonReportId?: string | null;
  } = {}): Promise<string> {
    const id = randomUUID();
    await database.sql`
      insert into public.sync_jobs (id, org_id, profile_id, job_type, payload, status, attempts, dedupe_key,
        last_error, claimed_by, claim_token, finished_at)
      values (${id}, ${orgId}, ${profileId}, 'report.request',
        ${JSON.stringify(requestPayload(reportType, start, end))}::jsonb,
        ${options.requestStatus ?? 'succeeded'}::public.sync_job_status, 1,
        ${options.requestDedupeKey ?? `synthetic-schedule:${id}`}, ${options.requestError ?? null},
        ${options.claimToken ? 'synthetic-claimer' : null}, ${options.claimToken ?? null}::uuid,
        ${options.requestStatus === 'running' ? null : new Date().toISOString()}::timestamptz)`;
    await database.sql`
      insert into public.report_requests (id, org_id, profile_id, report_type, start_date, end_date, status,
        amazon_report_id, error, requested_at)
      values (${id}, ${orgId}, ${profileId}, ${reportType}::public.report_type, ${start}, ${end},
        ${options.status ?? 'failed'}::public.report_status,
        ${options.amazonReportId === undefined ? 'synthetic-amazon-report' : options.amazonReportId}, ${options.error ?? null},
        ${options.requestedAt ?? new Date(Date.now() - 86_400_000).toISOString()}::timestamptz)`;
    return id;
  }

  async function deadFetch(reportType: string, start: string, end: string, lastError: string, requestDedupeKey?: string) {
    const ledgerId = await ledger(reportType, start, end, {
      error: lastError, ...(requestDedupeKey ? { requestDedupeKey } : {}),
    });
    const fetchId = randomUUID();
    await database.sql`
      insert into public.sync_jobs (id, org_id, profile_id, job_type, payload, status, attempts, last_error, finished_at)
      values (${fetchId}, ${orgId}, ${profileId}, 'report.fetch', ${JSON.stringify({
        type: 'report.fetch', orgId, profileId, reportRequestId: ledgerId,
        amazonReportId: 'synthetic-amazon-report', downloadUrl: 'https://reports.invalid/dead.json.gz',
      })}::jsonb, 'dead', 1, ${lastError}, now() - interval '1 day')`;
    return { ledgerId, fetchId };
  }

  async function drainAll(worker: SyncWorker): Promise<void> {
    for (let pass = 0; pass < 40; pass += 1) {
      await database.sql`update public.sync_jobs set run_after = now() where org_id = ${orgId} and status = 'queued'`;
      if (await worker.drainOnce() === 0) return;
    }
    throw new Error('the pipeline did not settle');
  }

  async function unsettled(): Promise<unknown[]> {
    return (await database.sql<{ job_type: string; status: string; last_error: string | null }[]>`
      select job_type::text, status::text, last_error from public.sync_jobs
       where org_id = ${orgId} and status not in ('succeeded', 'dead') order by job_type`).map((row) => ({ ...row }));
  }

  it('claims every due fetch before polls and polls before requests, whatever their age', async () => {
    const old = new Date(Date.now() - 3 * 3_600_000);
    await store.enqueue(requestPayload('spCampaigns', yesterday, yesterday), old, 'synthetic-old-request');
    await store.enqueue({ type: 'entity.sync', orgId, profileId, full: true }, old, 'synthetic-old-entity');
    await store.enqueue({
      type: 'report.poll', orgId, profileId, reportRequestId: randomUUID(), amazonReportId: 'synthetic-poll', attempt: 0,
    }, new Date(Date.now() - 60_000), 'synthetic-poll');
    // Signed 58 minutes ago: two minutes from expiry, queued last.
    await store.enqueue({
      type: 'report.fetch', orgId, profileId, reportRequestId: randomUUID(), amazonReportId: 'synthetic-fetch',
      downloadUrl: signedUrl('synthetic-fetch', new Date(Date.now() - 58 * 60_000)),
    }, new Date(), 'synthetic-fetch');

    const priorities = await database.sql<{ job_type: string; priority: number }[]>`
      select job_type::text, priority from public.sync_jobs where org_id = ${orgId} order by priority desc, job_type`;
    expect(priorities.map((row) => [row.job_type, row.priority])).toEqual([
      ['report.fetch', REPORT_LANE_CLAIM_PRIORITY['report.fetch']],
      ['report.poll', REPORT_LANE_CLAIM_PRIORITY['report.poll']],
      ['entity.sync', 100],
      ['report.request', 100],
    ]);
    const order: string[] = [];
    for (let claim = 0; claim < 4; claim += 1) {
      const [job] = await store.claim('synthetic-claimer', 1, LANE);
      order.push(job?.jobType ?? 'none');
    }
    expect(order).toEqual(['report.fetch', 'report.poll', 'report.request', 'entity.sync']);
    expect(await store.release('synthetic-claimer')).toBe(4);
  });

  it('re-requests an expired fetch queued behind a request backlog, then loads it with parsed equal to loaded', async () => {
    const start = addDays(yesterday, -2);
    const original = await ledger('spCampaigns', start, yesterday, { status: 'processing', error: null });
    const backlog = ['a', 'b', 'c'].map((key, index) => store.enqueue(
      requestPayload('spCampaigns', addDays(yesterday, -10 - index), addDays(yesterday, -10 - index)),
      new Date(Date.now() - 2 * 3_600_000), `synthetic-backlog-${key}`));
    await Promise.all(backlog);
    // Its URL was signed two hours ago, while it waited.
    await store.enqueue({
      type: 'report.fetch', orgId, profileId, reportRequestId: original, amazonReportId: 'synthetic-amazon-report',
      downloadUrl: signedUrl('synthetic-amazon-report', new Date(Date.now() - 2 * 3_600_000)),
    }, new Date(), `report.fetch:${original}:1`);
    const api = new FakeReportingApi();
    const worker = new SyncWorker({
      workerId: 'wp323-lane', store, adsApi: api, jobTypes: LANE, claimBatchSize: 1, maxConcurrentJobs: 1,
      buckets: new RegionTokenBuckets(2), logger: quiet,
    });

    expect(await worker.drainOnce()).toBe(1);
    const [fetch] = await database.sql<{ status: string; result: Record<string, unknown> }[]>`
      select status::text, result from public.sync_jobs where org_id = ${orgId} and job_type = 'report.fetch'`;
    expect(fetch).toMatchObject({ status: 'succeeded', result: { downloadExpired: true, reason: 'expired_before_download', reRequested: true, generation: 1 } });
    expect(api.downloaded).toEqual([]);
    expect(api.created).toEqual([]);
    const [old] = await database.sql<{ status: string; error: string }[]>`
      select status::text, error from public.report_requests where id = ${original}`;
    expect({ ...old }).toEqual({ status: 'expired', error: 'report download URL expired; report re-requested' });
    const replacement = await database.sql<{ id: string; payload: Record<string, unknown> }[]>`
      select id, payload from public.sync_jobs where org_id = ${orgId} and dedupe_key = ${`report.rerequest:1:${original}`}`;
    expect(replacement).toHaveLength(1);
    expect(replacement[0]!.payload).toEqual({
      type: 'report.request', orgId, profileId, reportType: 'spCampaigns', startDate: start, endDate: yesterday,
    });

    await drainAll(worker);
    expect(await unsettled()).toEqual([]);
    expect(await database.sql`select id from public.sync_jobs where org_id = ${orgId} and status = 'dead'`).toHaveLength(0);
    const [loaded] = await database.sql<{ status: string; rows_parsed: string; rows_loaded: string; counts_match: boolean }[]>`
      select status::text, rows_parsed, rows_loaded, counts_match from public.report_requests where id = ${replacement[0]!.id}`;
    expect({ status: loaded!.status, parsed: Number(loaded!.rows_parsed), loaded: Number(loaded!.rows_loaded), match: loaded!.counts_match })
      .toEqual({ status: 'completed', parsed: 3, loaded: 3, match: true });
    const facts = await database.sql<{ date: string }[]>`
      select date::text from public.fact_profile_daily where profile_id = ${profileId} and date between ${start} and ${yesterday} order by date`;
    expect(facts.map((row) => row.date)).toEqual(datesIn(start, yesterday));
    expect(api.created).toHaveLength(4);
  }, 60_000);

  it('gives every dead fetch in the restatement horizon one verdict and re-requests each window once', async () => {
    const [schedule] = await database.sql<{ lookback_days: number }[]>`
      select lookback_days from public.sync_schedules where org_id = ${orgId} and profile_id = ${profileId}
         and report_type = 'spCampaigns' and variant = 'restatement'`;
    const horizonStart = addDays(yesterday, -(schedule!.lookback_days - 1));
    const window = { startDate: horizonStart, endDate: yesterday };
    const sp = [
      await deadFetch('spCampaigns', addDays(yesterday, -2), yesterday, LEGACY_MISLABEL),
      await deadFetch('spCampaigns', addDays(yesterday, -3), addDays(yesterday, -1), 'report download URL expired'),
      // Starts before the horizon but overlaps it.
      await deadFetch('spCampaigns', addDays(horizonStart, -9), addDays(horizonStart, 22), LEGACY_MISLABEL),
    ];
    const sb = await deadFetch('sbCampaigns', addDays(yesterday, -2), yesterday, LEGACY_MISLABEL);
    const load = await deadFetch('spSearchTerm', addDays(yesterday, -2), yesterday, 'Failed query: insert into fact_search_term_daily (synthetic)');
    const exhausted = await deadFetch('spTargeting', addDays(yesterday, -2), yesterday, LEGACY_MISLABEL,
      ['report.recover', 3, profileId, 'spTargeting', horizonStart, yesterday].join(':'));
    const outside = await deadFetch('spPlacement', addDays(horizonStart, -12), addDays(horizonStart, -10), LEGACY_MISLABEL);
    const joinedFetch = await deadFetch('sdCampaigns', addDays(yesterday, -2), yesterday, LEGACY_MISLABEL);
    await store.enqueue(requestPayload('sdCampaigns', window.startDate, window.endDate), new Date(), 'synthetic-live-sd-restatement');
    const [live] = await database.sql<{ id: string }[]>`select id from public.sync_jobs where dedupe_key = 'synthetic-live-sd-restatement'`;

    expect(await store.recoverDeadReportFetches({ maxGenerations: 3, limit: 100 })).toEqual({
      scanned: 7, reRequested: 4, joined: 1, unrecoverable: 1, exhausted: 1, windows: 3, requestsEnqueued: 2,
    });
    const requests = await database.sql<{ id: string; dedupe_key: string; payload: Record<string, unknown> }[]>`
      select id, dedupe_key, payload from public.sync_jobs
       where org_id = ${orgId} and job_type = 'report.request' and dedupe_key like 'report.recover:1:%' order by dedupe_key`;
    const recoverKey = (reportType: string) => ['report.recover', 1, profileId, reportType, horizonStart, yesterday].join(':');
    expect(requests.map((row) => [row.dedupe_key, row.payload])).toEqual([
      [recoverKey('sbCampaigns'), requestPayload('sbCampaigns', horizonStart, yesterday)],
      [recoverKey('spCampaigns'), requestPayload('spCampaigns', horizonStart, yesterday)],
    ]);
    const spRequest = requests.find((row) => row.dedupe_key.includes(':spCampaigns:'))!.id;
    const sbRequest = requests.find((row) => row.dedupe_key.includes(':sbCampaigns:'))!.id;
    const verdicts = new Map((await database.sql<{ id: string; recovery: Record<string, unknown> | null }[]>`
      select id, result -> 'recovery' as recovery from public.sync_jobs
       where org_id = ${orgId} and job_type = 'report.fetch'`).map((row) => [row.id, row.recovery]));
    for (const { fetchId } of sp) {
      expect(verdicts.get(fetchId)).toMatchObject({ state: 're-requested', requestJobId: spRequest, generation: 1, window });
    }
    expect(verdicts.get(sb.fetchId)).toMatchObject({ state: 're-requested', requestJobId: sbRequest, generation: 1 });
    expect(verdicts.get(joinedFetch.fetchId)).toMatchObject({ state: 'joined', requestJobId: live!.id, window });
    expect(verdicts.get(load.fetchId)).toMatchObject({ state: 'unrecoverable', errorClass: 'load_failed' });
    expect(verdicts.get(exhausted.fetchId)).toMatchObject({ state: 'exhausted', maxGenerations: 3 });
    expect(verdicts.get(outside.fetchId)).toBeNull();
    const deadCount = await database.sql`select id from public.sync_jobs where org_id = ${orgId} and status = 'dead'`;
    expect(deadCount).toHaveLength(8);

    // Idempotent: nothing is re-examined and nothing is enqueued twice.
    expect(await store.recoverDeadReportFetches({ maxGenerations: 3, limit: 100 })).toEqual({
      scanned: 0, reRequested: 0, joined: 0, unrecoverable: 0, exhausted: 0, windows: 0, requestsEnqueued: 0,
    });
    expect(await database.sql`select id from public.sync_jobs where org_id = ${orgId} and dedupe_key like 'report.recover:1:%'`).toHaveLength(2);
  });

  it('does not recover a report type whose restatement schedule is disabled or a profile that does not sync', async () => {
    await deadFetch('spCampaigns', addDays(yesterday, -2), yesterday, LEGACY_MISLABEL);
    await database.sql`update public.sync_schedules set enabled = false
      where org_id = ${orgId} and profile_id = ${profileId} and report_type = 'spCampaigns' and variant = 'restatement'`;
    expect((await store.recoverDeadReportFetches({ maxGenerations: 3, limit: 100 })).scanned).toBe(0);
    await database.sql`update public.sync_schedules set enabled = true where org_id = ${orgId}`;
    await database.sql`update public.ad_profiles set sync_enabled = false where id = ${profileId}`;
    try {
      expect((await store.recoverDeadReportFetches({ maxGenerations: 3, limit: 100 })).scanned).toBe(0);
    } finally {
      await database.sql`update public.ad_profiles set sync_enabled = true where id = ${profileId}`;
    }
  });

  it('recovers the dead backlog from the lane itself and loads the restatement window with parsed equal to loaded', async () => {
    const dead = await Promise.all([0, 1, 2].map((offset) =>
      deadFetch('spCampaigns', addDays(yesterday, -2 - offset), addDays(yesterday, -offset), LEGACY_MISLABEL)));
    const api = new FakeReportingApi();
    const worker = new SyncWorker({
      workerId: 'wp323-recovering-lane', store, adsApi: api, jobTypes: LANE, reportBacklogRecovery: true,
      buckets: new RegionTokenBuckets(2), logger: quiet,
    });

    await drainAll(worker);
    expect(await unsettled()).toEqual([]);
    expect(api.created).toHaveLength(1);
    const [request] = await database.sql<{ id: string; payload: { startDate: string; endDate: string } }[]>`
      select id, payload from public.sync_jobs where org_id = ${orgId} and dedupe_key like 'report.recover:1:%'`;
    const { startDate, endDate } = request!.payload;
    expect(endDate).toBe(yesterday);
    expect(api.created[0]).toMatchObject({ reportType: 'spCampaigns', startDate, endDate });
    const [ledgerRow] = await database.sql<{ status: string; rows_parsed: string; rows_loaded: string; counts_match: boolean }[]>`
      select status::text, rows_parsed, rows_loaded, counts_match from public.report_requests where id = ${request!.id}`;
    const dates = datesIn(startDate, endDate);
    expect({ status: ledgerRow!.status, parsed: Number(ledgerRow!.rows_parsed), loaded: Number(ledgerRow!.rows_loaded), match: ledgerRow!.counts_match })
      .toEqual({ status: 'completed', parsed: dates.length, loaded: dates.length, match: true });
    const facts = await database.sql<{ n: string }[]>`
      select count(*) as n from public.fact_profile_daily where profile_id = ${profileId} and date between ${startDate} and ${endDate}`;
    expect(Number(facts[0]!.n)).toBe(dates.length);
    const verdicts = await database.sql<{ state: string }[]>`
      select result -> 'recovery' ->> 'state' as state from public.sync_jobs
       where id = any(${database.sql.array(dead.map((row) => row.fetchId))}::uuid[])`;
    expect(verdicts.map((row) => row.state)).toEqual(['re-requested', 're-requested', 're-requested']);
  }, 60_000);

  describe('reconcile-reports abandon-dead', () => {
    const unknown = 'Reporting v3 create outcome is unknown after transport';
    const args = (before: string) => ['abandon-dead', '--org-id', orgId, '--before', before,
      '--actor', 'synthetic operator', '--reason', 'covered by the weekly restatement', '--worker-stopped'];
    async function cli(input: readonly string[]): Promise<Record<string, unknown>> {
      const written: string[] = [];
      await runReconcileReportsCli(input, { DATABASE_URL: database.connectionString }, (line: string) => { written.push(line); });
      expect(written).toHaveLength(1);
      return JSON.parse(written[0]!) as Record<string, unknown>;
    }
    const legacy = (reportType: string, start: string, end: string, extra: Parameters<typeof ledger>[3] = {}) => ledger(reportType, start, end, {
      status: 'pending', amazonReportId: null, requestStatus: 'dead', requestError: unknown,
      requestedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), ...extra,
    });

    it('abandons only candidates covered by the restatement, counts every refusal and is idempotent', async () => {
      const today = addDays(yesterday, 1);
      const inside = await Promise.all([0, 1, 2].map((offset) => legacy('spCampaigns', addDays(yesterday, -3 - offset), addDays(yesterday, -1 - offset))));
      const outside = await legacy('spCampaigns', addDays(yesterday, -40), addDays(yesterday, -38));
      await database.sql`update public.sync_schedules set enabled = false
        where org_id = ${orgId} and profile_id = ${profileId} and report_type = 'sdCampaigns' and variant = 'restatement'`;
      const unscheduled = await legacy('sdCampaigns', addDays(yesterday, -3), addDays(yesterday, -1));
      const downstream = await legacy('sbCampaigns', addDays(yesterday, -3), addDays(yesterday, -1));
      await database.sql`insert into public.sync_jobs (org_id, profile_id, job_type, payload, status)
        values (${orgId}, ${profileId}, 'report.poll', ${JSON.stringify({ reportRequestId: downstream })}::jsonb, 'dead')`;
      const recent = await legacy('spCampaigns', addDays(yesterday, -3), addDays(yesterday, -1), { requestedAt: new Date().toISOString() });
      const running = await legacy('spCampaigns', addDays(yesterday, -3), addDays(yesterday, -1), {
        requestStatus: 'running', requestError: null, claimToken: randomUUID(),
      });

      expect(await cli(args(today))).toEqual({
        action: 'abandon-dead', before: today, candidates: 6, abandoned: 3,
        refusedOutsideRestatement: 1, refusedWithoutRestatement: 1, refusedDownstream: 1, running: 1,
      });
      const states = new Map((await database.sql<{ id: string; status: string; state: string | null; command: string | null; error: string | null }[]>`
        select id, status::text, reconciliation ->> 'state' as state,
               reconciliation -> 'resolution' ->> 'command' as command, error
          from public.report_requests where org_id = ${orgId}`).map((row) => [row.id, { ...row }]));
      for (const id of inside) {
        expect(states.get(id)).toMatchObject({ status: 'failed', state: 'abandoned', command: 'abandon-dead', error: 'covered by the weekly restatement' });
      }
      for (const id of [outside, unscheduled, downstream, recent, running]) {
        expect(states.get(id)).toMatchObject({ status: 'pending', state: null });
      }
      const listed = (await listQuarantinedReports(database, orgId)).map((row) => row.id).sort();
      expect(listed).toEqual([outside, unscheduled, downstream, recent, running].sort());

      // Idempotent: a second run resolves nothing new and refuses the same three.
      expect(await cli(args(today))).toEqual({
        action: 'abandon-dead', before: today, candidates: 3, abandoned: 0,
        refusedOutsideRestatement: 1, refusedWithoutRestatement: 1, refusedDownstream: 1, running: 1,
      });
      // The cut-off excludes newer candidates; the per-request commands remain.
      expect((await cli(args(addDays(today, 2)))).candidates).toBe(4);
      expect(await cli(['abandon', '--org-id', orgId, '--request-id', outside, '--actor', 'synthetic operator',
        '--reason', 'outside the restatement; verified by hand', '--worker-stopped']))
        .toEqual({ requests: 1, jobs: 1, polls: 0, action: 'abandon' });
    });
  });
});
