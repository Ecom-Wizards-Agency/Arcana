/**
 * The cron drain route's gate and its scheduled-producer ownership.
 *
 * The door: an unauthenticated caller must never be able to make this route
 * spend Amazon quota. So these check the three ways in are refused — no
 * configured secret, no header, wrong header — and that a correctly
 * authenticated call gets *past* the gate (proven by it failing later, on the
 * missing database, rather than on auth).
 *
 * The scheduler: this route composes a weekly recommendation producer only for
 * enabled lane intent, then gates it on fenced authority. The manual "Run
 * preview" legacy fallback (WP-216) must not turn that producer on. Those
 * cases swap the database handle and the tick for doubles that record what the
 * route wired, while every other function stays real.
 *
 * The Vercel lane: before the report-lane handoff this route claims
 * `creative.sync` and `report.fetch`. Those cases drain the route's real
 * SyncWorker against a spied queue and prove each claimed job reaches the SB
 * Video runtime instead of dead-lettering for a missing handler.
 */
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import type { JobPayload, JobType } from '@wizard-ads/shared';
import type * as WorkerModule from '@wizard-ads/worker';
import {
  DbAdsApiClient,
  ObservedSbVideoIngestion,
  PostgresWorkerStore,
  type SbVideoReportResult,
  type SbVideoSnapshotResult,
} from '@wizard-ads/worker';
import type { SyncTickDeps, SyncTickResult } from '../../../../src/server/sync-tick';
import { cronSyncJobTypesFromEnv } from '../../../../src/server/sync-tick';
import { GET } from './route';

const doubles = vi.hoisted(() => ({
  authorityRows: [] as unknown[],
  authoritySql: vi.fn(async () => [] as unknown[]),
  begin: vi.fn(async () => { throw new Error('scheduled producer must not open a transaction here'); }),
  closed: 0,
  creativeEnqueue: vi.fn(async () => ({ requestedProfiles: 0, eligibleProfiles: 0, ineligibleProfiles: 0, deferredPendingProfiles: 0, enqueuedJobs: 0, deduplicatedJobs: 0, observations: [] })),
  bidSeriesSync: vi.fn(async () => ({ profiles: 1, written: 2 })),
  tickDeps: [] as SyncTickDeps[],
  drainInTick: false,
  handles: [] as DbHandle[],
  sbVideoStores: [] as { handle: unknown; queue: unknown }[],
}));

vi.mock('@wizard-ads/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerModule>();
  /** The real SB Video store, recording which handle and queue the route gave it. */
  class RecordedSbVideoIngestionStore extends actual.PostgresSbVideoIngestionStore {
    constructor(...args: ConstructorParameters<typeof actual.PostgresSbVideoIngestionStore>) {
      super(...args);
      doubles.sbVideoStores.push({ handle: args[0], queue: args[1] });
    }
  }
  return {
    ...actual,
    runBidSeriesSync: doubles.bidSeriesSync,
    PostgresSbVideoIngestionStore: RecordedSbVideoIngestionStore,
  };
});

vi.mock('@wizard-ads/db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    enqueueDailyCreativeSyncJobs: doubles.creativeEnqueue,
    createDb: (): DbHandle => {
      const handle = {
        sql: Object.assign(
          (...args: unknown[]) => doubles.authoritySql(...(args as [])),
          { begin: doubles.begin },
        ) as unknown as DbHandle['sql'],
        close: async () => { doubles.closed += 1; },
      } as unknown as DbHandle;
      doubles.handles.push(handle);
      return handle;
    },
  };
});

vi.mock('../../../../src/server/sync-tick', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runSyncTick: async (deps: SyncTickDeps): Promise<SyncTickResult> => {
      doubles.tickDeps.push(deps);
      const enqueued = (await deps.recommendationSchedules?.()) ?? 0;
      // The real tick drains the route's worker; opt-in so gate cases stay inert.
      const drained = doubles.drainInTick ? await deps.worker.drainOnce() : 0;
      return {
        ok: true, provisioned: 0, repaired: 0, integrationSchedules: 0, enqueued,
        requeued: 0, drained, released: 0, budgetHit: false, ms: 0,
      };
    },
  };
});

const SECRET = ['synthetic', 'cron', 'secret', 'value'].join('-');
const REVISION = 'e'.repeat(40);
const LEGACY_AUTHORITY = { protocol: 'legacy', admission: 'legacy', epoch: 0, authorized_revision: null };
const FENCED_BLOCKED_AUTHORITY = {
  protocol: 'fenced', admission: 'blocked', epoch: 2, authorized_revision: REVISION,
};
const ENV_KEYS = [
  'CRON_SECRET',
  'DATABASE_URL',
  'OPENSPELL_EVO_REPORT_LANE_READY',
  'OPENSPELL_CREATIVE_SYNC_DISABLED',
  'OPENSPELL_RECOMMENDATION_LANE_READY',
  'OPENSPELL_RECOMMENDATION_LANE_REVISION',
  'WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS',
  'LWA_CLIENT_ID',
  'LWA_CLIENT_SECRET',
  'AMAZON_LWA_CLIENT_ID',
  'AMAZON_LWA_CLIENT_SECRET',
] as const;

function request(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('https://example.test/api/cron/sync', { headers });
}

/** Everything a tick needs except the recommendation lane, which each case sets. */
function configureWiredTick(): void {
  process.env['CRON_SECRET'] = SECRET;
  process.env['DATABASE_URL'] = 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic';
  process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'] = '1';
  // The Amazon client is constructed (never used) before the tick; it only
  // needs the LWA identity to exist.
  process.env['AMAZON_LWA_CLIENT_ID'] = ['synthetic', 'lwa', 'client', 'id'].join('-');
  process.env['AMAZON_LWA_CLIENT_SECRET'] = ['synthetic', 'lwa', 'client', 'value'].join('-');
}

describe('GET /api/cron/sync', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    doubles.authorityRows = [];
    doubles.authoritySql.mockReset();
    doubles.authoritySql.mockImplementation(async () => doubles.authorityRows);
    doubles.begin.mockClear();
    doubles.closed = 0;
    doubles.creativeEnqueue.mockClear();
    doubles.tickDeps = [];
    doubles.drainInTick = false;
    doubles.handles = [];
    doubles.sbVideoStores = [];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('is 401 when no CRON_SECRET is configured, even with a bearer', async () => {
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(401);
  });

  it('is 401 with the secret set but no Authorization header', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request());
    expect(response.status).toBe(401);
  });

  it('is 401 with a wrong bearer token', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request('Bearer not-the-secret'));
    expect(response.status).toBe(401);
  });

  it('gets past the gate with the right bearer, then fails on the missing database', async () => {
    process.env['CRON_SECRET'] = SECRET;
    const response = await GET(request(`Bearer ${SECRET}`));
    // Not 401: the gate opened. 500 naming the database is the next failure, and
    // it happens before any Amazon call, proving the auth check is what guards
    // the expensive work.
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toMatch(/DATABASE_URL/);
  });

  it('fails closed before the database or Amazon wiring for a malformed lane handoff', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_EVO_REPORT_LANE_READY'] = 'true';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'cron queue ownership is not configured safely',
    });
  });

  it('fails closed before database or Amazon wiring for malformed recommendation intent', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'cron queue ownership is not configured safely',
    });
  });

  it('composes the creative producer by default for the Vercel report lane', async () => {
    configureWiredTick();
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(doubles.tickDeps).toHaveLength(1);
    expect(doubles.tickDeps[0]?.creativeSyncSchedules).toBeTypeOf('function');
    await expect(doubles.tickDeps[0]?.creativeSyncSchedules?.()).resolves.toMatchObject({
      requestedProfiles: 0, enqueuedJobs: 0, observations: [],
    });
    expect(doubles.creativeEnqueue).toHaveBeenCalledExactlyOnceWith(expect.anything(), undefined, expect.any(Date), 'legacy');
  });

  it('stops Vercel production when Evo owns the report lane', async () => {
    configureWiredTick();
    process.env['OPENSPELL_EVO_REPORT_LANE_READY'] = '1';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(doubles.tickDeps[0]?.creativeSyncSchedules).toBeUndefined();
  });

  it('honors the deployment kill switch before producing any observations', async () => {
    configureWiredTick();
    process.env['OPENSPELL_CREATIVE_SYNC_DISABLED'] = '1';
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    expect(doubles.tickDeps[0]?.creativeSyncSchedules).toBeUndefined();
    expect(doubles.authoritySql).not.toHaveBeenCalled();
  });

  it('refuses a malformed creative kill switch before database wiring', async () => {
    process.env['CRON_SECRET'] = SECRET;
    process.env['OPENSPELL_CREATIVE_SYNC_DISABLED'] = 'true';
    expect((await GET(request(`Bearer ${SECRET}`))).status).toBe(503);
    expect(doubles.tickDeps).toHaveLength(0);
  });

  it('passes the cron logger and deadline into the bid-series producer', async () => {
    configureWiredTick();
    doubles.bidSeriesSync.mockClear();
    const response = await GET(request(`Bearer ${SECRET}`));
    expect(response.status).toBe(200);
    const deps = doubles.tickDeps[0];
    await expect(deps?.bidSeries?.(123)).resolves.toEqual({ profiles: 1, written: 2 });
    expect(doubles.bidSeriesSync).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      logger: console, deadlineMs: 123,
    }));
    expect(deps?.logger).toBe(console);
  });

  describe('SB Video runtime on the Vercel lane', () => {
    const ORG_ID = '21212121-2121-4121-8121-212121212121';
    const PROFILE_ID = '31313131-3131-4131-8131-313131313131';
    const JOB_ID = '41414141-4141-4141-8141-414141414141';
    const REPORT_REQUEST_ID = '51515151-5151-4151-8151-515151515151';
    const SNAPSHOT_ID = '61616161-6161-4161-8161-616161616161';
    const AMAZON_REPORT_ID = ['synthetic', 'sb', 'ads', 'report'].join('-');
    const profile = {
      id: PROFILE_ID, orgId: ORG_ID, amazonProfileId: 'synthetic-amazon-profile',
      region: 'NA', currencyCode: 'USD', timezone: 'UTC',
    } as const;
    const creativeSync: JobPayload = {
      type: 'creative.sync', orgId: ORG_ID, profileId: PROFILE_ID, adProduct: 'SB',
      startDate: '2026-09-24', endDate: '2026-09-24', allowObservedAttributionFacts: true,
    };
    type ClaimedJob = Awaited<ReturnType<PostgresWorkerStore['claim']>>[number];

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function claimed(payload: JobPayload): ClaimedJob {
      return {
        id: JOB_ID, orgId: ORG_ID, profileId: PROFILE_ID, jobType: payload.type, payload,
        attempts: 1, maxAttempts: 5, dedupeKey: null, claimedBy: null, claim: null,
      };
    }

    /** One queued job, handed only to a claimant whose claim set includes its type. */
    function queueOne(job: ClaimedJob) {
      const claims: { store: PostgresWorkerStore; jobTypes: readonly JobType[] | undefined }[] = [];
      vi.spyOn(PostgresWorkerStore.prototype, 'claim').mockImplementation(
        async function (this: PostgresWorkerStore, _workerId, _limit, jobTypes) {
          claims.push({ store: this, jobTypes });
          return claims.length === 1 && jobTypes?.includes(job.jobType) ? [job] : [];
        },
      );
      vi.spyOn(PostgresWorkerStore.prototype, 'profile').mockResolvedValue(profile);
      return {
        claims,
        finish: vi.spyOn(PostgresWorkerStore.prototype, 'finish').mockResolvedValue(),
        deadLetter: vi.spyOn(PostgresWorkerStore.prototype, 'deadLetter').mockResolvedValue(),
        failReport: vi.spyOn(PostgresWorkerStore.prototype, 'failReport').mockResolvedValue(),
        failTerminalReport: vi.spyOn(PostgresWorkerStore.prototype, 'failTerminalReport')
          .mockResolvedValue(false),
      };
    }

    it('dispatches a claimed creative.sync job to the SB Video runtime instead of dead-lettering it', async () => {
      configureWiredTick();
      doubles.drainInTick = true;
      const queue = queueOne(claimed(creativeSync));
      const snapshot: SbVideoSnapshotResult = {
        status: 'completed', sourceAssets: 2, parsedAssets: 2, sourceAds: 2, parsedAds: 2,
        mapped: 2, legacy: 0, unsupported: 0, ambiguous: 0, unmapped: 0,
        assetsUpserted: 2, mappingsUpserted: 2, snapshotsUpserted: 1,
        assetsReadBack: 2, mappingsReadBack: 2, snapshotsReadBack: 1,
        reportEnqueued: true, amazonWriteCalls: 0, reasons: [],
      };
      const runtimes: ObservedSbVideoIngestion[] = [];
      const syncSnapshot = vi.spyOn(ObservedSbVideoIngestion.prototype, 'syncSnapshot')
        .mockImplementation(async function (this: ObservedSbVideoIngestion) {
          runtimes.push(this);
          return snapshot;
        });

      const response = await GET(request(`Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, drained: 1 });
      expect(queue.claims).toHaveLength(1);
      expect(queue.claims[0]?.jobTypes).toContain('creative.sync');
      expect(syncSnapshot).toHaveBeenCalledExactlyOnceWith({ jobId: JOB_ID, profile, payload: creativeSync });
      expect(runtimes).toHaveLength(1);
      expect(runtimes[0]).toBeInstanceOf(ObservedSbVideoIngestion);
      // Composed as in the Evo worker: this request's handle and the claiming queue store.
      expect(doubles.handles).toHaveLength(1);
      expect(doubles.sbVideoStores).toHaveLength(1);
      expect(doubles.sbVideoStores[0]?.handle).toBe(doubles.handles[0]);
      expect(doubles.sbVideoStores[0]?.queue).toBe(queue.claims[0]?.store);
      expect(queue.finish).toHaveBeenCalledExactlyOnceWith(JOB_ID, 'succeeded', { result: snapshot });
      expect(queue.deadLetter).not.toHaveBeenCalled();
    });

    it('ingests a claimed sbAds report.fetch through the same runtime with counted rows', async () => {
      configureWiredTick();
      doubles.drainInTick = true;
      const fetch: JobPayload = {
        type: 'report.fetch', orgId: ORG_ID, profileId: PROFILE_ID,
        reportRequestId: REPORT_REQUEST_ID, amazonReportId: AMAZON_REPORT_ID,
        downloadUrl: 'https://reports.invalid/synthetic-sb-ads',
      };
      const queue = queueOne(claimed(fetch));
      const ledger = {
        id: REPORT_REQUEST_ID, orgId: ORG_ID, profileId: PROFILE_ID, reportType: 'sbAds',
        startDate: '2026-09-24', endDate: '2026-09-24', source: 'amazon_api',
        amazonReportId: AMAZON_REPORT_ID, requestedAt: new Date(), pollAttempts: 1,
        creativeSyncSnapshotId: SNAPSHOT_ID,
      } satisfies Awaited<ReturnType<PostgresWorkerStore['getReportRequest']>>;
      vi.spyOn(PostgresWorkerStore.prototype, 'getReportRequest').mockResolvedValue(ledger);
      // Two source rows: one valid ad row and one Amazon row the parser refuses.
      const rows = [
        { date: '2026-09-24', campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group',
          adId: 'synthetic-ad', impressions: 10, clicks: 1, cost: 0.5 },
        { date: '2026-09-24' },
      ];
      const download = vi.spyOn(DbAdsApiClient.prototype, 'downloadReport')
        .mockImplementation(async () => (async function* body() { yield gzipSync(JSON.stringify(rows)); })());
      const ingestReport = vi.spyOn(ObservedSbVideoIngestion.prototype, 'ingestReport')
        .mockImplementation(async (input): Promise<SbVideoReportResult> => {
          if (!input.parsedReport) throw new Error('expected the streamed parse');
          const parsed = input.parsedReport;
          return {
            blocked: false, idempotentReplay: false,
            reportSourceRows: parsed.sourceRows, reportParsedRows: parsed.parsedRows,
            reportRefusedRows: parsed.refusals.length, mappedFactRows: parsed.parsedRows,
            unpromotedReportRows: 0, factsUpserted: parsed.parsedRows,
            factsReadBack: parsed.parsedRows, amazonWriteCalls: 0, reasons: [],
          };
        });
      const finishAttributed = vi.spyOn(PostgresWorkerStore.prototype, 'finishAttributedReport')
        .mockResolvedValue();
      vi.spyOn(console, 'info').mockImplementation(() => {});

      const response = await GET(request(`Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, drained: 1 });
      expect(queue.claims[0]?.jobTypes).toContain('report.fetch');
      expect(download).toHaveBeenCalledExactlyOnceWith(fetch.downloadUrl, expect.any(AbortSignal));
      expect(ingestReport).toHaveBeenCalledTimes(1);
      expect(ingestReport.mock.calls[0]?.[0]).toMatchObject({
        profile,
        ledger: { id: REPORT_REQUEST_ID, creativeSyncSnapshotId: SNAPSHOT_ID },
        parsedReport: { sourceRows: 2, parsedRows: 1 },
      });
      expect(finishAttributed).toHaveBeenCalledExactlyOnceWith(REPORT_REQUEST_ID, {
        sourceRows: 2, parsedRows: 1, refusedRows: 1,
        promotedRows: 1, unpromotedRows: 0, canonicalRows: 1,
      }, expect.objectContaining({ status: 'completed' }));
      expect(queue.failReport).not.toHaveBeenCalled();
      expect(queue.failTerminalReport).not.toHaveBeenCalled();
      expect(queue.deadLetter).not.toHaveBeenCalled();
      expect(queue.finish).toHaveBeenCalledExactlyOnceWith(JOB_ID, 'succeeded', expect.anything());
    });

    it('leaves creative.sync unclaimed on Vercel once Evo owns the report lane', async () => {
      configureWiredTick();
      process.env['OPENSPELL_EVO_REPORT_LANE_READY'] = '1';
      doubles.drainInTick = true;
      const queue = queueOne(claimed(creativeSync));
      const syncSnapshot = vi.spyOn(ObservedSbVideoIngestion.prototype, 'syncSnapshot');

      const response = await GET(request(`Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, drained: 0 });
      expect(queue.claims).toHaveLength(1);
      expect(queue.claims[0]?.jobTypes).not.toContain('creative.sync');
      expect(queue.claims[0]?.jobTypes).not.toContain('report.fetch');
      expect(syncSnapshot).not.toHaveBeenCalled();
      expect(queue.finish).not.toHaveBeenCalled();
      expect(queue.deadLetter).not.toHaveBeenCalled();
    });
  });

  describe('recommendation ownership', () => {
    it('keeps Vercel cron as the recommendations.run claimant in legacy mode and hands it off only with enabled intent', () => {
      // Deployed job sets, not a producer flag, decide who claims manual previews.
      expect(cronSyncJobTypesFromEnv({})).toContain('recommendations.run');
      expect(cronSyncJobTypesFromEnv({ OPENSPELL_RECOMMENDATION_LANE_READY: '0' }))
        .toContain('recommendations.run');
      expect(cronSyncJobTypesFromEnv({
        OPENSPELL_RECOMMENDATION_LANE_READY: '1',
        OPENSPELL_RECOMMENDATION_LANE_REVISION: REVISION,
      })).not.toContain('recommendations.run');
    });

    it('composes no scheduled recommendation producer from legacy manual readiness', async () => {
      // The exact authority state under which the manual routes answer 202 legacy.
      doubles.authorityRows = [LEGACY_AUTHORITY];
      for (const ready of [undefined, '0']) {
        doubles.tickDeps = [];
        doubles.authoritySql.mockClear();
        configureWiredTick();
        if (ready === undefined) delete process.env['OPENSPELL_RECOMMENDATION_LANE_READY'];
        else process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = ready;

        const response = await GET(request(`Bearer ${SECRET}`));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, enqueued: 0 });
        expect(doubles.tickDeps).toHaveLength(1);
        expect(doubles.tickDeps[0]?.recommendationSchedules).toBeUndefined();
        // Not even consulted: the scheduler decision never reads legacy authority.
        expect(doubles.authoritySql).not.toHaveBeenCalled();
        expect(doubles.begin).not.toHaveBeenCalled();
      }
    });

    it('composes the producer only for enabled intent and still gates it on fenced authority', async () => {
      configureWiredTick();
      process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
      process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'] = REVISION;

      for (const authority of [LEGACY_AUTHORITY, FENCED_BLOCKED_AUTHORITY]) {
        doubles.authorityRows = [authority];
        doubles.tickDeps = [];
        doubles.authoritySql.mockClear();
        const response = await GET(request(`Bearer ${SECRET}`));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ ok: true, enqueued: 0 });
        expect(doubles.tickDeps[0]?.recommendationSchedules).toBeTypeOf('function');
        // The hook ran, read fresh authority once, and refused before minting.
        expect(doubles.authoritySql).toHaveBeenCalledTimes(1);
        expect(doubles.begin).not.toHaveBeenCalled();
      }
    });

    it('never composes the producer without the weekly-runs operator approval', async () => {
      configureWiredTick();
      delete process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'];
      process.env['OPENSPELL_RECOMMENDATION_LANE_READY'] = '1';
      process.env['OPENSPELL_RECOMMENDATION_LANE_REVISION'] = REVISION;
      doubles.authorityRows = [{
        protocol: 'fenced', admission: 'scoped', epoch: 3, authorized_revision: REVISION,
      }];
      const response = await GET(request(`Bearer ${SECRET}`));
      expect(response.status).toBe(200);
      expect(doubles.tickDeps[0]?.recommendationSchedules).toBeUndefined();
      expect(doubles.authoritySql).not.toHaveBeenCalled();
    });
  });
});
