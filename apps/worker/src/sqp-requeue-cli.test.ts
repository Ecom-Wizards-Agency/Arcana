import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type {
  ContextualProposalPersistenceCounts,
  SqpWeeklyPromotionInput,
  SqpWeeklyPromotionResult,
} from '@wizard-ads/db';
import type { SqpRequestJob } from '@wizard-ads/shared';
import type { CreateReportInput, SpApiReport, SpApiReportDocument } from '@wizard-ads/sp-api';
import { SQP_PARSER_VERSION } from '@wizard-ads/sp-api';
import {
  parseSqpRequeueArgs,
  requeueDeadSqpWeek,
  sqpRequeueFailureMessage,
  SqpRequeueRefused,
} from './sqp-requeue-cli.js';
import { reofferRefusedSqpWeek, sqpParserRetryDedupeKey, sqpWeekLockKey } from './sqp-scheduler.js';
import {
  createPostgresSqpRequestHandler,
  SqpWorkflowPermanentError,
  type SqpReportApi,
  type SqpWorkflowDataStore,
} from './sqp.js';

const LEGACY_ERROR = 'SQP report refused 1 rows; canonical promotion is blocked';

describe('sqp:requeue arguments', () => {
  it('accepts the documented flags, with or without the pnpm separator', () => {
    const expected = { orgSlug: 'synthetic-org', profileLabel: 'Synthetic label', weekStart: '2026-09-13', freshReports: false };
    expect(parseSqpRequeueArgs(['--org', 'synthetic-org', '--profile', 'Synthetic label', '--week-start', '2026-09-13']))
      .toEqual(expected);
    expect(parseSqpRequeueArgs(['--', '--week-start', '2026-09-13', '--profile', 'Synthetic label', '--org', 'synthetic-org',
      '--fresh-reports'])).toEqual({ ...expected, freshReports: true });
  });

  it('refuses a missing, repeated or unknown flag and a week that does not start on Sunday', () => {
    const refusals = [
      ['--org', 'synthetic-org', '--profile', 'Synthetic label'],
      ['--org', 'a', '--org', 'b', '--profile', 'Synthetic label', '--week-start', '2026-09-13'],
      ['--org', 'a', '--profile', 'Synthetic label', '--week-start', '2026-09-13', '--profile-id', 'x'],
      ['--org', '--profile', 'Synthetic label', '--week-start', '2026-09-13'],
      ['--org', 'a', '--profile', 'Synthetic label', '--week-start', '2026-09-14'],
      ['--org', 'a', '--profile', 'Synthetic label', '--week-start', '2026-02-30'],
    ];
    for (const args of refusals) expect(() => parseSqpRequeueArgs(args)).toThrow(SqpRequeueRefused);
    expect(refusals).toHaveLength(6);
  });

  it('prints its own refusals and a fixed line for any other failure', () => {
    expect(sqpRequeueFailureMessage(new SqpRequeueRefused('no organization has that slug')))
      .toBe('no organization has that slug');
    const driver = new Error('connect failed for synthetic-user at synthetic-host.example.test');
    expect(sqpRequeueFailureMessage(driver)).toBe('sqp:requeue failed; no job was changed by a failed transaction');
    expect(sqpRequeueFailureMessage('synthetic thrown string')).toBe('sqp:requeue failed; no job was changed by a failed transaction');
  });
});

function sqpRow(shareOfClicks: number): Record<string, unknown> {
  return {
    startDate: '2026-09-13',
    endDate: '2026-09-19',
    asin: 'B000000001',
    searchQueryData: { searchQuery: 'Synthetic Requeue Query', searchQueryScore: 1, searchQueryVolume: 50 },
    impressionData: { totalQueryImpressionCount: 80, asinImpressionCount: 8, asinImpressionShare: 10 },
    clickData: { totalClickCount: 20, asinClickCount: 4, asinClickShare: shareOfClicks },
    cartAddData: { totalCartAddCount: 10, asinCartAddCount: 2, asinCartAddShare: 20 },
    purchaseData: { totalPurchaseCount: 5, asinPurchaseCount: 2, asinPurchaseShare: 40 },
  };
}

class ScriptedSqpApi implements SqpReportApi {
  readonly actions: string[] = [];
  constructor(public document: unknown) {}
  async createReport(_input: CreateReportInput): Promise<{ reportId: string }> {
    this.actions.push('create_report');
    return { reportId: 'report-synthetic-requeue' };
  }
  async getReport(reportId: string): Promise<SpApiReport> {
    this.actions.push('get_report');
    return {
      reportId,
      reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
      processingStatus: 'DONE',
      reportDocumentId: 'document-synthetic-requeue',
      createdTime: '2026-09-26T17:05:00Z',
    };
  }
  async getReportDocument(reportDocumentId: string): Promise<SpApiReportDocument> {
    this.actions.push('get_report_document');
    return { reportDocumentId, url: 'https://documents.example.test/requeue', compressionAlgorithm: null };
  }
  async downloadReportDocument(): Promise<unknown> {
    this.actions.push('download_report_document');
    return this.document;
  }
}

class RecordingData implements SqpWorkflowDataStore {
  readonly promotions: SqpWeeklyPromotionInput[] = [];
  async listVocabulary() { return []; }
  async verifyFacts() { return this.promotions.at(-1)?.rows.length ?? 0; }
  async promoteFacts(input: SqpWeeklyPromotionInput): Promise<SqpWeeklyPromotionResult> {
    this.promotions.push(input);
    return {
      status: 'promoted', promotionRunId: `promotion-${this.promotions.length}`, ...input.counts,
      deletedRows: 0, promotedRows: input.rows.length, upserts: input.rows.length, canonicalRows: input.rows.length,
    };
  }
  async listPpcFacts() { return []; }
  async persistProposals(): Promise<ContextualProposalPersistenceCounts> {
    return { offered: 0, upserts: 0, readBack: 0, preservedHumanDecisions: 0 };
  }
}

const available = await databaseAvailable();
describe.skipIf(!available)('sqp:requeue against the test database', () => {
  let db: TestDatabase;
  let orgId: string;
  let orgSlug: string;
  let profileId: string;
  const label = 'Synthetic requeue profile';

  beforeAll(async () => {
    db = await createTestDatabase('wp335_sqp_requeue');
    orgSlug = `synthetic-${randomUUID()}`;
    const [org] = await db.sql<{ id: string }[]>`
      insert into public.orgs(slug,name) values (${orgSlug},'Synthetic requeue agency') returning id`;
    orgId = org!.id;
    profileId = await insertProfile(orgId, label);
    // The same label in another organization must not widen the match.
    const [other] = await db.sql<{ id: string }[]>`
      insert into public.orgs(slug,name) values (${`synthetic-${randomUUID()}`},'Synthetic other agency') returning id`;
    await insertProfile(other!.id, label);
  }, 180_000);
  afterAll(async () => { await db?.drop(); });

  async function insertProfile(org: string, accountName: string): Promise<string> {
    const [profile] = await db.sql<{ id: string }[]>`insert into public.ad_profiles
      (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,account_name,sync_enabled)
      values (${org},${randomUUID()},'NA','US','USD','UTC','seller',${accountName},true) returning id`;
    return profile!.id;
  }

  function payload(weekStart: string, weekEnd: string): SqpRequestJob {
    return {
      type: 'sqp.request', orgId, profileId, marketplaceId: 'ATVPDKIKX0DER',
      asins: ['B000000001'], weekStart, weekEnd,
    };
  }

  async function insertRunningJob(job: SqpRequestJob): Promise<string> {
    const [row] = await db.sql<{ id: string }[]>`
      insert into public.sync_jobs (org_id, profile_id, job_type, payload, status, attempts, dedupe_key, claimed_by, claimed_at, started_at)
      values (${orgId}, ${profileId}, 'sqp.request', ${JSON.stringify(job)}::jsonb, 'running', 1,
              ${['sqp.request', job.profileId, job.marketplaceId, job.weekStart].join(':')},
              'synthetic-worker', now(), now())
      returning id`;
    return row!.id;
  }

  async function jobRow(id: string) {
    const [row] = await db.sql<{
      status: string; attempts: number; last_error: string | null; result: Record<string, unknown> | null;
      claimed_by: string | null; finished_at: Date | null; due: boolean;
    }[]>`select status::text as status, attempts, last_error, result, claimed_by, finished_at,
               run_after <= now() as due
          from public.sync_jobs where id = ${id}`;
    return row!;
  }

  async function refuseAndDeadLetter(id: string, job: SqpRequestJob, api: ScriptedSqpApi): Promise<Error> {
    const handler = createPostgresSqpRequestHandler({
      handle: db, api, providerGate: { beforeCall: async () => {} }, data: new RecordingData(),
      logger: { error: () => {} },
    });
    const failure = await handler(job, { jobId: id }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(SqpWorkflowPermanentError);
    await db.sql`
      update public.sync_jobs set status = 'dead', finished_at = now(), claimed_by = null,
             last_error = ${(failure as Error).message}
       where id = ${id}`;
    return failure as Error;
  }

  it('requeues a week refused by the old parser once, reusing the produced report', async () => {
    const job = payload('2026-09-13', '2026-09-19');
    const id = await insertRunningJob(job);
    // A click share that disagrees with its counts is refused by every parser version.
    const api = new ScriptedSqpApi({ dataByAsin: [sqpRow(55)] });
    await refuseAndDeadLetter(id, job, api);
    expect(api.actions).toEqual(['create_report', 'get_report', 'get_report_document', 'download_report_document']);
    // Emulate the production row written before WP-335: legacy error, no summary.
    await db.sql`
      update public.sync_jobs set last_error = ${LEGACY_ERROR},
             result = result #- '{checkpoint,refusalSummary}'
       where id = ${id}`;

    const result = await requeueDeadSqpWeek(db, {
      orgSlug, profileLabel: label, weekStart: '2026-09-13', freshReports: false,
      now: new Date('2026-09-27T09:00:00Z'),
    });
    expect(result).toEqual({
      event: 'sqp.requeue', jobId: id, orgId, profileId, marketplaceId: 'ATVPDKIKX0DER',
      weekStart: '2026-09-13', weekEnd: '2026-09-19', previousStatus: 'dead', previousAttempts: 1,
      refusedByParserVersion: 1, currentParserVersion: SQP_PARSER_VERSION, checkpointKept: true,
      reusedReports: 1, reportsToRequest: 0, requeuedAt: '2026-09-27T09:00:00.000Z',
    });
    const requeued = await jobRow(id);
    expect(requeued).toMatchObject({ status: 'queued', attempts: 0, claimed_by: null, finished_at: null, due: true });
    expect(requeued.last_error).toBe(`requeued by sqp:requeue at 2026-09-27T09:00:00.000Z; previous error: ${LEGACY_ERROR}`);
    const checkpoint = requeued.result?.['checkpoint'] as Record<string, unknown>;
    expect((checkpoint['batches'] as Array<{ status: string }>).map((batch) => batch.status)).toEqual(['ready']);
    expect(checkpoint['refusalSummary']).toBeUndefined();
    expect(checkpoint['requeues']).toEqual([{
      requeuedAt: '2026-09-27T09:00:00.000Z', previousAttempts: 1, refusedByParserVersion: 1, previousRefusal: null,
    }]);

    // At most one requeue: the week is now covered by a queued job.
    await expect(requeueDeadSqpWeek(db, { orgSlug, profileLabel: label, weekStart: '2026-09-13', freshReports: false }))
      .rejects.toThrow('a queued sqp.request job already covers that week');

    // The claimed job reuses the produced report by document id; nothing new is requested.
    await db.sql`update public.sync_jobs set status = 'running', attempts = 1, claimed_by = 'synthetic-worker', claimed_at = now() where id = ${id}`;
    api.document = { dataByAsin: [sqpRow(20)] };
    api.actions.length = 0;
    const data = new RecordingData();
    const completed = await createPostgresSqpRequestHandler({
      handle: db, api, providerGate: { beforeCall: async () => {} }, data,
    })(job, { jobId: id });
    expect(api.actions).toEqual(['get_report_document', 'download_report_document']);
    expect(completed).toMatchObject({
      status: 'completed',
      reports: { total: 1, created: 1, reusedCompleted: 0, empty: 0 },
      ingestion: { sourceRows: 1, parsedRows: 1, refusedRows: 0, upserts: 1, canonicalRows: 1 },
    });
    expect(data.promotions).toHaveLength(1);
    expect(data.promotions[0]?.rows).toHaveLength(1);
    expect(data.promotions[0]?.rows[0]).toMatchObject({
      asinImpressionShare: 0.1, asinClickShare: 0.2, asinCartAddShare: 0.2, asinPurchaseShare: 0.4,
    });
    const saved = (await jobRow(id)).result?.['checkpoint'] as Record<string, unknown>;
    expect(saved['refusalSummary']).toBeUndefined();
    expect(saved['requeues']).toHaveLength(1);
  });

  it('refuses a week the deployed parser already refused, and leaves the dead row untouched', async () => {
    const job = payload('2026-09-06', '2026-09-12');
    const id = await insertRunningJob(job);
    const failure = await refuseAndDeadLetter(id, job, new ScriptedSqpApi({ dataByAsin: [sqpRow(55)] }));
    expect(failure.message).toMatch(/^SQP report refused 1 rows; canonical promotion is blocked; parser v2 refused 1 of 1 rows: /);
    const before = await jobRow(id);
    expect((before.result?.['checkpoint'] as Record<string, unknown>)['refusalSummary']).toMatchObject({
      parserVersion: SQP_PARSER_VERSION, refusedRows: 1,
    });

    await expect(requeueDeadSqpWeek(db, { orgSlug, profileLabel: label, weekStart: '2026-09-06', freshReports: true }))
      .rejects.toThrow(`parser v${SQP_PARSER_VERSION} already refused that week; this checkout's parser is v${SQP_PARSER_VERSION}`);
    expect(await jobRow(id)).toEqual(before);
  });

  it('drops the checkpoint only when asked for fresh reports', async () => {
    const job = payload('2026-08-30', '2026-09-05');
    const id = await insertRunningJob(job);
    await db.sql`
      update public.sync_jobs set status = 'dead', finished_at = now(), claimed_by = null,
             last_error = 'SP-API report document is no longer available',
             result = ${JSON.stringify({ kind: 'sqp_workflow_checkpoint', version: 1, checkpoint: { batches: [] } })}::jsonb
       where id = ${id}`;
    const result = await requeueDeadSqpWeek(db, {
      orgSlug, profileLabel: label, weekStart: '2026-08-30', freshReports: true, now: new Date('2026-09-27T10:00:00Z'),
    });
    expect(result).toMatchObject({ refusedByParserVersion: null, checkpointKept: false, reusedReports: 0, reportsToRequest: null });
    const row = await jobRow(id);
    expect(row).toMatchObject({ status: 'queued', attempts: 0, result: null });
    expect(row.last_error).toBe('requeued by sqp:requeue at 2026-09-27T10:00:00.000Z with fresh reports; ' +
      'previous error: SP-API report document is no longer available');
  });

  it('serializes the producer re-offer behind a requeue holding the week lock', async () => {
    const job = payload('2026-08-16', '2026-08-22');
    const id = await insertRunningJob(job);
    await db.sql`
      update public.sync_jobs set status = 'dead', finished_at = now(), claimed_by = null, last_error = ${LEGACY_ERROR}
       where id = ${id}`;
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext(${sqpWeekLockKey(profileId, '2026-08-16')}))`;
      locked();
      await released;
      // What sqp:requeue does under the same lock.
      await sql`update public.sync_jobs set status = 'queued', attempts = 0 where id = ${id}`;
    });
    await lockTaken;
    let settled = false;
    const reoffer = reofferRefusedSqpWeek(db, job, new Date('2026-09-27T11:00:00Z'))
      .finally(() => { settled = true; });
    let waiting = 0;
    for (let poll = 0; poll < 200 && waiting === 0; poll += 1) {
      const [row] = await db.sql<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_locks where locktype = 'advisory' and not granted`;
      waiting = row!.waiting;
      if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(1);
    expect(settled).toBe(false);
    release();
    await holder;
    await expect(reoffer).resolves.toBe(false);
    const week = await db.sql<{ status: string; dedupe_key: string }[]>`
      select status::text as status, dedupe_key from public.sync_jobs
       where org_id = ${orgId} and payload->>'weekStart' = '2026-08-16'`;
    expect(week).toEqual([{ status: 'queued', dedupe_key: ['sqp.request', profileId, 'ATVPDKIKX0DER', '2026-08-16'].join(':') }]);
  });

  it('lets the producer re-offer a dead week once, after which the command refuses', async () => {
    const job = payload('2026-08-09', '2026-08-15');
    const id = await insertRunningJob(job);
    await db.sql`
      update public.sync_jobs set status = 'dead', finished_at = now(), claimed_by = null, last_error = ${LEGACY_ERROR}
       where id = ${id}`;
    await expect(reofferRefusedSqpWeek(db, job, new Date('2026-09-27T12:00:00Z'))).resolves.toBe(true);
    await expect(reofferRefusedSqpWeek(db, job, new Date('2026-09-27T12:00:00Z'))).resolves.toBe(false);
    const week = await db.sql<{ status: string; dedupe_key: string }[]>`
      select status::text as status, dedupe_key from public.sync_jobs
       where org_id = ${orgId} and payload->>'weekStart' = '2026-08-09' order by created_at`;
    const baseKey = ['sqp.request', profileId, 'ATVPDKIKX0DER', '2026-08-09'].join(':');
    expect(week).toEqual([
      { status: 'dead', dedupe_key: baseKey },
      { status: 'queued', dedupe_key: sqpParserRetryDedupeKey(baseKey, SQP_PARSER_VERSION) },
    ]);
    await expect(requeueDeadSqpWeek(db, { orgSlug, profileLabel: label, weekStart: '2026-08-09', freshReports: false }))
      .rejects.toThrow('a queued sqp.request job already covers that week');
  });

  it('records a stored refusal summary only when it has the expected shape', async () => {
    const valid = {
      parserVersion: 1, sourceRows: 2, refusedRows: 2, distinctReasons: 1,
      topReasons: [{ reason: 'row is not an object', count: 2 }],
      firstRefusedRow: { index: 0, rowIsObject: false, presentFields: [], missingFields: ['asin'], unrecognizedFieldCount: 0 },
    };
    const recorded: unknown[] = [];
    for (const [weekStart, weekEnd, summary] of [
      ['2026-08-02', '2026-08-08', valid],
      ['2026-07-26', '2026-08-01', { ...valid, topReasons: [{ reason: 7, count: 'many' }] }],
    ] as const) {
      const id = await insertRunningJob(payload(weekStart, weekEnd));
      const checkpoint = { kind: 'sqp_workflow_checkpoint', version: 1, checkpoint: { batches: [], refusalSummary: summary } };
      await db.sql`
        update public.sync_jobs set status = 'dead', finished_at = now(), claimed_by = null, last_error = ${LEGACY_ERROR},
               result = ${JSON.stringify(checkpoint)}::jsonb
         where id = ${id}`;
      await expect(requeueDeadSqpWeek(db, { orgSlug, profileLabel: label, weekStart, freshReports: false }))
        .resolves.toMatchObject({ refusedByParserVersion: 1, checkpointKept: true });
      const kept = (await jobRow(id)).result?.['checkpoint'] as Record<string, unknown>;
      expect(kept['refusalSummary']).toBeUndefined();
      recorded.push(...(kept['requeues'] as Array<{ previousRefusal: unknown }>).map((entry) => entry.previousRefusal));
    }
    expect(recorded).toEqual([valid, null]);
  });

  it('refuses an unknown slug, an ambiguous label and a week with no job', async () => {
    const base = { profileLabel: label, weekStart: '2026-09-13', freshReports: false };
    await expect(requeueDeadSqpWeek(db, { ...base, orgSlug: 'synthetic-missing-org' }))
      .rejects.toThrow('no organization has that slug');
    await expect(requeueDeadSqpWeek(db, { ...base, orgSlug, weekStart: '2026-01-04' }))
      .rejects.toThrow('no sqp.request job exists for that profile and week');
    await insertProfile(orgId, 'Synthetic duplicate label');
    await insertProfile(orgId, 'Synthetic duplicate label');
    await expect(requeueDeadSqpWeek(db, { ...base, orgSlug, profileLabel: 'Synthetic duplicate label' }))
      .rejects.toThrow('the profile label matches 2 profiles in that organization; expected 1');
  });
});
