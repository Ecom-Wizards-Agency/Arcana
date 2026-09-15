import { isDeepStrictEqual } from 'node:util';
import { EvidenceRetryPendingError } from './evidence-reconciliation.js';
import { IngestionRegistry, ReportCoverageCompletion } from './ingestion-registry.js';
import { CoreFeatureReportType, CoreReportConfiguration, ReportType as DefaultReportType, JobPayload, ReportRequestJob, isProviderFailure, isPermanentProviderFailure, type EconomicsSyncJob, type CreativeSyncJob, type JobType, type KeepaSyncJob, type MarketingStreamNormalizeJob, type RankSyncJob, type Region, type ReportType, type SqpRequestJob } from '@wizard-ads/shared';
import { defaultCoreReportConfiguration, parseCoreReport, assertCoreReportAdmission, validateCoreReportWindow, parseSbAdsReportProbe, type SbAdsReportProbeParseResult, type SkippedReportRow } from '@wizard-ads/ads-api';
import { ingestionSource } from './ingestion-sources.js';
import { ControlMirrorMergeCounts, KeywordMirrorMergeCounts } from '@wizard-ads/shared/sp-write-mirror';
import { Buffer } from 'node:buffer';
import { DuplicateFactGrain, InvalidReportDatePromotion, type ClaimedJob } from '@wizard-ads/db';
import { SpApiAmbiguousOutcome } from '@wizard-ads/sp-api';
import { isPermanentCrosscheckError, type CrosscheckIngest } from './crosscheck.js';
import { AdsApiRetryableError, DownloadUrlExpiredError, ReportCreateOutcomeUnknownError, downloadUrlExpiresAt, type DownloadUrlRejection, type AdProductCode, type AdsApiClient, type AdsProfileContext, type EntityListFailure } from './ads-api.js';
import { runBidSeriesSync, type BidSeriesSyncDeps } from './bid-series.js';
import { type RecommendationsRun, type RecommendationScheduleStore } from './recommendations-run.js';
import { DEFAULT_REPORT_DOWNLOAD_LIMITS, mergeParsedFactBatches, ReportDownloadLimitError, ReportPayloadFormatError, ReportPayloadShapeError, type ParsedFactBatch, type ReportDownloadLimits, SKIP_FAILURE_RATIO, gunzipJson, parseReportRows } from './parsers.js';
import { UnsafeSponsoredProductsReport, prepareSponsoredProductsReportDatesFromCounts, sponsoredProductsSourceRowDate, type prepareSponsoredProductsReportDates, type ReportDateSourceCounts } from './report-promotion.js';
import { defaultRegionTokenBuckets, type RegionTokenBuckets } from './region-token-buckets.js';
import { ClaimOwnershipLost, MAX_REPORT_RE_REQUESTS, type ReportRequestState, type WorkerStore } from './store.js';
import type { SbVideoIngestionRuntime } from './sb-video-ingestion.js';
import { SqpWorkflowPendingError, type SqpQueuedJobContext } from './sqp.js';
import type { WeeklySqpScheduleProducer } from './sqp-scheduler.js';
import type { UnifiedDualRun } from './unified-reporting.js';
import { ClaimLoopController, isContainedClaimFailure, type ClaimLoopState } from './claim-loop.js';
import { PermanentJobError } from './permanent-job-error.js';

const MINUTE_MS = 60_000;
const FOUR_HOURS_MS = 4 * 60 * MINUTE_MS;
const POLL_DELAYS_MINUTES = [5, 10, 20, 30] as const;
const SP_REPORT_TYPES = new Set(['spCampaigns', 'spTargeting', 'spSearchTerm', 'spPlacement']);
// The streaming parser also caps source rows at 100k. Together these bounds
// keep normalized object overhead finite without retaining the raw document.
const MAX_PARENT_PARSED_BYTES = 16 * 1024 * 1024;
/**
 * A pre-signed report URL with less than this left is not downloaded. S3
 * checks expiry when the GET starts, so a started download finishes; the
 * margin absorbs clock drift between this host and storage.
 */
const DOWNLOAD_URL_MIN_REMAINING_MS = 2 * MINUTE_MS;
/** Backlog recovery runs at most this often per worker instance (once per cron tick). */
const BACKLOG_RECOVERY_INTERVAL_MS = 5 * MINUTE_MS;
/** Dead fetches examined per recovery pass; the pass repeats until none are left. */
const BACKLOG_RECOVERY_LIMIT = 2_000;
const RE_REQUESTED_LEDGER_ERROR = 'report download URL expired; report re-requested';
type BaseReportRequestState = Omit<ReportRequestState, 'reportType'> & { reportType: ReportType };

type LongLivedClaimPass =
  | { kind: 'no_capacity' }
  | { kind: 'rpc_success'; jobs: readonly ClaimedJob[] }
  | { kind: 'rpc_failure'; error: unknown };

export { PermanentJobError } from './permanent-job-error.js';

/** A provider failure that should return to the queue after a known delay. */
export class RetryableJobError extends Error {
  readonly provider = 'worker';
  readonly kind = 'retryable_job';
  readonly retryable = true;
  constructor(message: string, readonly retryAfterSeconds?: number) {
    super(message);
    this.name = 'RetryableJobError';
  }
}

/** Fixed-category failure when durable queue settlement cannot be proven. */
export class QueueSettlementError extends Error {
  override readonly name = 'QueueSettlementError';

  constructor(readonly kind: 'ownership_lost' | 'unavailable' | 'custody_quarantined') {
    super(`sync job queue settlement ${kind}`);
  }
}

/** A fenced effect is unsafe to replay and therefore remains in DB custody. */
class FencedClaimQuarantined extends Error {
  override readonly name = 'FencedClaimQuarantined';

  constructor(readonly category: 'report_create' | 'report_download_limit') {
    super(`fenced claim quarantined after ${category}`);
  }
}

export interface WorkerShutdownEvidence {
  released: number;
  /** Claims deliberately left fenced at the shutdown deadline. No identities are exposed. */
  unresolved: number;
}

export function shutdownExitCode(
  evidence: WorkerShutdownEvidence,
  settlementFailure: QueueSettlementError['kind'] | null,
): 0 | 78 {
  return evidence.unresolved === 0 && settlementFailure === null ? 0 : 78;
}

export interface WorkerLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface IntegrationHandlers {
  keepaSync?: (payload: KeepaSyncJob) => Promise<Record<string, unknown>>;
  rankSync?: (payload: RankSyncJob) => Promise<Record<string, unknown>>;
  economicsSync?: (payload: EconomicsSyncJob) => Promise<Record<string, unknown>>;
  creativeSync?: (payload: CreativeSyncJob) => Promise<Record<string, unknown>>;
  sqpRequest?: (
    payload: SqpRequestJob,
    context: SqpQueuedJobContext,
  ) => Promise<Record<string, unknown>>;
  marketingStreamNormalize?: (payload: MarketingStreamNormalizeJob) => Promise<Record<string, unknown>>;
}

const consoleLogger: WorkerLogger = {
  info: (message, details) => console.info(message, details ?? {}),
  error: (message, details) => console.error(message, details ?? {}),
};

export interface SyncWorkerOptions {
  coreReportingEnabled?: boolean;
  workerId: string;
  store: WorkerStore;
  /** Optional so an integration-only runtime needs no Amazon credentials. */
  adsApi?: AdsApiClient;
  /** Job types this runtime may atomically claim. Undefined means all. */
  jobTypes?: readonly JobType[];
  /** Provider handlers deployed in this runtime. Missing handlers dead-letter. */
  integrations?: IntegrationHandlers;
  /** New ingestions register here without extending IntegrationHandlers or the dispatcher. */
  sources?: (registry: Pick<IngestionRegistry, 'register'>) => void;
  /** WP-10's handler, bound to a database handle. Absent, the job dead-letters. */
  crosscheckIngest?: CrosscheckIngest;
  /** WP-33's preview-only recommendations runner. Absent, the job dead-letters. */
  recommendationsRun?: RecommendationsRun;
  /** Read-only current-snapshot SB Video ingestion and sbAds promotion. */
  sbVideo?: SbVideoIngestionRuntime;
  /** Default-off Unified Reporting metadata sidecar. Never promotes facts. */
  unifiedReporting?: UnifiedDualRun;
  buckets?: RegionTokenBuckets;
  claimBatchSize?: number;
  maxConcurrentJobs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  logger?: WorkerLogger;
  /** Injectable only to prove worker-level cancellation and quarantine paths. */
  reportDownloadLimits?: Readonly<ReportDownloadLimits>;
  /**
   * WP-323: before claiming, re-request dead fetches whose windows overlap the
   * restatement horizon (see `WorkerStore.recoverDeadReportFetches`). Only the
   * runtime that owns `report.request` does it; off unless composed on.
   */
  reportBacklogRecovery?: boolean;
}

export class SyncWorker {
  private readonly coreReportingEnabled: boolean;
  readonly workerId: string;
  private readonly registry: IngestionRegistry;
  private readonly store: WorkerStore;
  private readonly adsApi: AdsApiClient | undefined;
  private readonly jobTypes: readonly JobType[] | undefined;
  private readonly integrations: IntegrationHandlers;
  private readonly crosscheckIngest: CrosscheckIngest | undefined;
  private readonly recommendationsRun: RecommendationsRun | undefined;
  private readonly sbVideo: SbVideoIngestionRuntime | undefined;
  private readonly unifiedReporting: UnifiedDualRun | undefined;
  private readonly buckets: RegionTokenBuckets;
  private readonly claimBatchSize: number;
  private readonly maxConcurrentJobs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly logger: WorkerLogger;
  private readonly reportDownloadLimits: Readonly<ReportDownloadLimits>;
  private readonly reportBacklogRecovery: boolean;
  private lastBacklogRecoveryAt: number | null = null;
  private readonly claimLoop: ClaimLoopController;
  private readonly running = new Map<string, { job: ClaimedJob; promise: Promise<void> }>();
  private readonly quarantined = new Map<string, ClaimedJob>();
  private activeClaimPass: Promise<LongLivedClaimPass> | null = null;
  private shutdownPromise: Promise<WorkerShutdownEvidence> | null = null;
  private settlementFailure: QueueSettlementError | null = null;
  private stopping = false;

  constructor(options: SyncWorkerOptions) {
    this.coreReportingEnabled = options.coreReportingEnabled === true;
    this.workerId = options.workerId;
    this.store = options.store;
    this.adsApi = options.adsApi;
    this.jobTypes = options.jobTypes;
    this.integrations = options.integrations ?? {};
    this.crosscheckIngest = options.crosscheckIngest;
    this.recommendationsRun = options.recommendationsRun;
    this.sbVideo = options.sbVideo;
    this.unifiedReporting = options.unifiedReporting;
    this.buckets = options.buckets ?? defaultRegionTokenBuckets;
    this.claimBatchSize = options.claimBatchSize ?? 10;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? 10;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? consoleLogger;
    this.reportDownloadLimits = options.reportDownloadLimits ?? DEFAULT_REPORT_DOWNLOAD_LIMITS;
    this.reportBacklogRecovery = options.reportBacklogRecovery === true;
    this.claimLoop = new ClaimLoopController(this.pollIntervalMs, this.now);
    this.registry = new IngestionRegistry((observation, loaded) => {
      if (!this.store.recordCoverage) throw new Error('Worker store lacks the ingestion coverage producer');
      return this.store.recordCoverage(observation, loaded);
    }, () => new ReportCoverageCompletion(this.store));
    options.sources?.(this.registry);
    this.registerBuiltins();
  }

  status(): {
    workerId: string;
    stopping: boolean;
    running: number;
    settlementFailure: QueueSettlementError['kind'] | null;
    claimLoop: ClaimLoopState;
  } {
    return {
      workerId: this.workerId,
      stopping: this.stopping,
      running: this.running.size,
      settlementFailure: this.settlementFailure?.kind ?? null,
      claimLoop: this.claimLoop.status(),
    };
  }

  async start(): Promise<void> {
    this.claimLoop.beginStart();
    try {
      while (!this.stopping && this.claimLoop.beginClaim()) {
        if (this.settlementFailure) throw this.settlementFailure;
        const pass = this.runLongLivedClaimPass();
        this.activeClaimPass = pass;
        let outcome: LongLivedClaimPass;
        try {
          outcome = await pass;
        } finally {
          if (this.activeClaimPass === pass) this.activeClaimPass = null;
        }

        if (outcome.kind === 'rpc_failure') {
          if (!isContainedClaimFailure(outcome.error)) throw outcome.error;
          const failure = this.claimLoop.recordContainedFailure();
          this.logger.error('sync job claim temporarily unavailable', {
            failureKind: failure.failureKind,
            consecutiveFailures: failure.consecutiveFailures,
            retryInMs: failure.retryInMs,
          });
          if (
            this.stopping
            || failure.retryInMs === null
            || !(await this.claimLoop.wait(failure.retryInMs))
          ) break;
          continue;
        }

        if (outcome.kind === 'no_capacity') {
          this.claimLoop.recordNoCapacity();
          if (this.stopping || !(await this.claimLoop.wait(this.pollIntervalMs))) break;
          continue;
        }

        this.claimLoop.recordSuccess(outcome.jobs.length > 0);
        if (this.stopping) break;
        if (outcome.jobs.length === 0 && !(await this.claimLoop.wait(this.pollIntervalMs))) break;
      }
    } catch (error) {
      this.claimLoop.recordFatalFailure();
      throw error;
    }
    await Promise.allSettled([...this.running.values()].map(({ promise }) => promise));
    if (this.settlementFailure) throw this.settlementFailure;
  }

  /**
   * Claim one batch and wait until this batch finishes. Used by tests and by
   * the one-shot drivers (the Vercel-cron route) that run the worker without its
   * always-on `start()` loop.
   *
   * `maxJobs` caps how many this batch claims (defaults to the configured claim
   * batch size). `deadlineMs` is an absolute `Date.now()` budget: past it this
   * returns 0 without claiming, so a caller looping `drainOnce` under a wall
   * clock stops taking new work rather than starting a job it cannot see
   * through before the platform kills the request.
   */
  async drainOnce(maxJobs?: number, deadlineMs?: number): Promise<number> {
    if (this.settlementFailure) throw this.settlementFailure;
    if (deadlineMs !== undefined && Date.now() >= deadlineMs) return 0;
    await this.recoverReportBacklogIfDue();
    const before = new Set(this.running.keys());
    const batchSize = this.availableClaimBatchSize(maxJobs);
    if (batchSize <= 0) return 0;
    const jobs = await this.fetchClaimBatch(batchSize);
    this.startClaimedJobs(jobs);
    const batch = [...this.running.entries()]
      .filter(([claimKey]) => !before.has(claimKey))
      .map(([, active]) => active.promise);
    await Promise.allSettled(batch);
    if (this.settlementFailure) throw this.settlementFailure;
    return jobs.length;
  }

  shutdown(releaseAfterMs = 25_000): Promise<WorkerShutdownEvidence> {
    this.shutdownPromise ??= this.performShutdown(releaseAfterMs);
    return this.shutdownPromise;
  }

  private async performShutdown(releaseAfterMs: number): Promise<WorkerShutdownEvidence> {
    this.stopping = true;
    this.claimLoop.beginShutdown();
    try {
      const activeClaimPass = this.activeClaimPass;
      if (activeClaimPass) await Promise.allSettled([activeClaimPass]);
      if (this.running.size === 0) {
        return { released: 0, unresolved: this.unresolvedCustodyCount() };
      }

      let timedOut = false;
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.running.values()].map(({ promise }) => promise)),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => { timedOut = true; resolve(); }, releaseAfterMs);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!timedOut) return { released: 0, unresolved: this.unresolvedCustodyCount() };
      // A fenced provider claim is deliberately not a lease. Elapsed shutdown
      // time cannot prove the handler or its Amazon request stopped, so it is
      // left running for attended reconciliation. Evo claims only fenced work;
      // refusing a mixed release is safer than speculating about part of it.
      if ([...this.running.values()].some(({ job }) => job.claim !== null)) {
        return { released: 0, unresolved: this.unresolvedCustodyCount() };
      }
      return { released: await this.store.release(this.workerId), unresolved: 0 };
    } finally {
      this.claimLoop.finishShutdown();
    }
  }

  async runAuthHealthcheck(): Promise<{ ok: Region[]; failed: Region[] }> {
    const adsApi = this.requireAdsApi();
    const regions: Region[] = ['NA', 'EU', 'FE'];
    const ok: Region[] = [];
    const failed: Region[] = [];
    await Promise.all(regions.map(async (region) => {
      try {
        await this.buckets.run(region, () => adsApi.listProfiles(region));
        ok.push(region);
      } catch (error) {
        failed.push(region);
        this.logger.error('Amazon auth healthcheck failed', { region, error: errorMessage(error) });
      }
    }));
    return { ok, failed };
  }

  private availableClaimBatchSize(maxJobs?: number): number {
    if (this.stopping) return 0;
    const capacity = this.maxConcurrentJobs - this.running.size;
    if (capacity <= 0) return 0;
    return Math.min(maxJobs ?? this.claimBatchSize, capacity);
  }

  /**
   * WP-323 backlog recovery. Contained: a failed pass is logged and claiming
   * continues, because the queue must keep draining whatever the ledger says.
   */
  private async recoverReportBacklogIfDue(): Promise<void> {
    if (!this.reportBacklogRecovery || !this.store.recoverDeadReportFetches) return;
    if (this.jobTypes !== undefined && !this.jobTypes.includes('report.request')) return;
    const now = this.now().getTime();
    if (this.lastBacklogRecoveryAt !== null && now - this.lastBacklogRecoveryAt < BACKLOG_RECOVERY_INTERVAL_MS) return;
    this.lastBacklogRecoveryAt = now;
    try {
      const counts = await this.store.recoverDeadReportFetches({
        maxGenerations: MAX_REPORT_RE_REQUESTS,
        limit: BACKLOG_RECOVERY_LIMIT,
      });
      if (counts.scanned > 0) this.logger.info('dead report fetches recovered', { ...counts });
    } catch (error) {
      this.logger.error('dead report fetch recovery failed', { error: errorMessage(error) });
    }
  }

  private fetchClaimBatch(batchSize: number): Promise<readonly ClaimedJob[]> {
    return this.store.claim(this.workerId, batchSize, this.jobTypes);
  }

  private startClaimedJobs(jobs: readonly ClaimedJob[]): void {
    for (const job of jobs) {
      const key = job.claim?.token ?? job.id;
      if (this.running.has(key)) {
        throw new Error('claim function returned duplicate active custody');
      }
      const task = this.runClaimed(job)
        .catch((error: unknown) => {
          if (error instanceof FencedClaimQuarantined) this.quarantined.set(key, job);
          const failure = new QueueSettlementError(
            error instanceof ClaimOwnershipLost
              ? 'ownership_lost'
              : error instanceof FencedClaimQuarantined
                ? 'custody_quarantined'
                : 'unavailable',
          );
          this.settlementFailure ??= failure;
          throw failure;
        })
        .finally(() => this.running.delete(key));
      this.running.set(key, { job, promise: task });
    }
  }

  private unresolvedCustodyCount(): number {
    const keys = new Set(this.quarantined.keys());
    for (const [key, { job }] of this.running) {
      if (job.claim !== null) keys.add(key);
    }
    return keys.size;
  }

  private async runLongLivedClaimPass(): Promise<LongLivedClaimPass> {
    const batchSize = this.availableClaimBatchSize();
    if (batchSize <= 0) return { kind: 'no_capacity' };
    await this.recoverReportBacklogIfDue();
    let jobs: readonly ClaimedJob[];
    try {
      jobs = await this.fetchClaimBatch(batchSize);
    } catch (error) {
      return { kind: 'rpc_failure', error };
    }
    this.startClaimedJobs(jobs);
    return { kind: 'rpc_success', jobs };
  }

  private async runClaimed(job: ClaimedJob): Promise<void> {
    let result: Record<string, unknown>;
    try {
      result = await this.execute(job);
    } catch (error) {
      await this.handleClaimedFailure(job, error);
      return;
    }
    // Queue finalization is deliberately outside the execution catch. If this
    // write fails after the provider/loader succeeded, legacy recovery or a
    // separately attended fenced recovery may replay the idempotent job; it
    // must not misclassify successful execution as terminal and block its
    // Creative snapshot.
    await this.finishClaimed(job, 'succeeded', { result });
  }

  private async handleClaimedFailure(job: ClaimedJob, error: unknown): Promise<void> {
    if (
      job.claim !== null
      && (
        error instanceof ReportCreateOutcomeUnknownError
        || error instanceof SpApiAmbiguousOutcome
        || error instanceof ReportDownloadLimitError
      )
    ) {
      const category = error instanceof ReportCreateOutcomeUnknownError || error instanceof SpApiAmbiguousOutcome
        ? 'report_create'
        : 'report_download_limit';
      this.logger.error('fenced sync job retained for attended reconciliation', {
        jobId: job.id,
        type: job.jobType,
        category,
      });
      throw new FencedClaimQuarantined(category);
    }
    if (error instanceof SqpWorkflowPendingError || error instanceof EvidenceRetryPendingError) {
      const retryIn = `${error.retryAfterSeconds} seconds`;
      if (job.claim !== null) {
        if (!this.store.deferClaim) {
          throw new Error('worker store cannot defer fenced custody');
        }
        await this.store.deferClaim(job.claim, retryIn);
      } else if (this.store.defer) {
        await this.store.defer(job.id, retryIn);
      } else {
        // Adapter/test stores predating queue deferral retain the safe legacy
        // behavior. The production Postgres store never takes this branch.
        await this.finishClaimed(job, 'failed', {
          error: errorMessage(error).slice(0, 4_000),
          retryIn,
        });
      }
      this.logger.info('sync job deferred for provider processing', {
        jobId: job.id,
        type: job.jobType,
        retryAfterSeconds: error.retryAfterSeconds,
      });
      return;
    }
    if (isPermanentJobFailure(error)) {
      const terminalDetail = error instanceof ReportCreateOutcomeUnknownError
        ? 'report create outcome unknown; attended reconciliation required'
        : errorMessage(error).slice(0, 4_000);
      await this.failTerminalReportIfPresent(
        job,
        terminalDetail,
      );
      const detail = errorMessage(error).slice(0, 4_000);
      if (job.claim !== null) {
        if (!this.store.deadLetterClaim) {
          throw new Error('worker store cannot dead-letter fenced custody');
        }
        await this.store.deadLetterClaim(job.claim, detail);
      } else {
        await this.store.deadLetter(job.id, detail);
      }
      this.logger.error('sync job dead-lettered', {
        jobId: job.id, type: job.jobType, error: errorMessage(error),
      });
      return;
    }
    const explicitRetry = isProviderFailure(error)
      ? error.retryAfterSeconds
      : undefined;
    const retrySeconds = explicitRetry !== undefined
      ? explicitRetry
      : Math.min(60 * 2 ** Math.max(job.attempts - 1, 0), 30 * 60);
    if (job.attempts >= job.maxAttempts) {
      await this.failTerminalReportIfPresent(
        job,
        'report lifecycle stopped after exhausting its retry budget',
      );
    }
    await this.finishClaimed(job, 'failed', {
      error: errorMessage(error).slice(0, 4_000),
      retryIn: `${retrySeconds} seconds`,
    });
    this.logger.error('sync job failed', {
      jobId: job.id,
      type: job.jobType,
      error: errorMessage(error),
    });
  }

  private async finishClaimed(
    job: ClaimedJob,
    outcome: 'succeeded' | 'failed',
    options: { error?: string; result?: unknown; retryIn?: string } = {},
  ): Promise<void> {
    if (job.claim === null) {
      await this.store.finish(job.id, outcome, options);
      return;
    }
    if (!this.store.finishClaim) {
      throw new Error('worker store cannot finish fenced custody');
    }
    await this.store.finishClaim(job.claim, outcome, options);
  }

  private async failTerminalReportIfPresent(job: ClaimedJob, error: string): Promise<void> {
    const parsed = JobPayload.safeParse(job.payload);
    if (!parsed.success) return;
    const payload = parsed.data;
    if (
      payload.type !== job.jobType ||
      payload.orgId !== job.orgId ||
      payload.profileId !== job.profileId
    ) return;
    if (payload.type === 'report.unified.advance') {
      await this.unifiedReporting?.failTerminal(payload, error);
      return;
    }
    const reportRequestId = payload.type === 'report.request'
      ? job.id
      : payload.type === 'report.poll' || payload.type === 'report.fetch'
        ? payload.reportRequestId
        : undefined;
    if (reportRequestId === undefined) return;
    await this.store.failTerminalReport({
      reportRequestId,
      orgId: job.orgId,
      profileId: job.profileId,
    }, error);
  }

  private async execute(job: ClaimedJob): Promise<Record<string, unknown>> {
    const payload = JobPayload.parse(job.payload);
    if (payload.orgId !== job.orgId || payload.profileId !== job.profileId || payload.type !== job.jobType) {
      throw new Error(`job ${job.id} queue columns do not match its payload`);
    }
    const profile = await this.store.profile(payload.profileId);
    if (profile.orgId !== payload.orgId) throw new Error(`job ${job.id} profile belongs to another org`);

    return this.registry.dispatch({ job, payload, profile });
  }

  private registerBuiltins(): void {
    const registry = this.registry;
    registry.installBuiltin('entity.sync', ({ profile, payload }) => this.syncEntities(profile, payload));
    registry.installBuiltin('report.request', ({ job, profile, payload }) => this.requestReport(job, profile, payload));
    registry.installBuiltin('report.poll', ({ profile, payload }) => this.pollReport(profile, payload));
    registry.registerTransactionalSource({
      source: { ...ingestionSource('report.fetch'), jobType: 'report.fetch' },
      plan: (context, completion) => ({ context, completion }),
      execute: ({ context: { profile, payload }, completion }) => this.fetchReport(profile, payload, completion),
      counts: (_result, { completion }) => completion.accounting(),
      coverage: { kind: 'report-ledger' },
    });
    registry.installBuiltin('report.unified.advance', ({ job, profile, payload }) => {
      if (!this.unifiedReporting) throw new PermanentJobError('Unified Reporting sidecar is not configured on this worker');
      return this.unifiedReporting.advance({ jobId: job.id, attempts: job.attempts, profile, payload });
    });
    registry.installBuiltin('recommendations.run', async ({ job, payload }) => {
      if (!this.recommendationsRun) throw new PermanentJobError('recommendations runner is not configured on this worker');
      return { ...(await this.recommendationsRun(payload, { jobId: job.id })) };
    });
    registry.installBuiltin('crosscheck.ingest', ({ payload }) => this.ingestCrosscheck(payload));
    registry.installBuiltin('keepa.sync', ({ payload }) => this.runIntegration(payload.type, this.integrations.keepaSync, payload));
    registry.installBuiltin('rank.sync', ({ payload }) => this.runIntegration(payload.type, this.integrations.rankSync, payload));
    registry.installBuiltin('economics.sync', ({ payload }) => this.runIntegration(payload.type, this.integrations.economicsSync, payload));
    registry.installBuiltin('creative.sync', ({ job, profile, payload }) => {
      const sbVideo = this.sbVideo;
      if (sbVideo) return this.buckets.run(profile.region, () => sbVideo.syncSnapshot({ jobId: job.id, profile, payload }));
      return this.runIntegration(payload.type, this.integrations.creativeSync, payload);
    });
    registry.installBuiltin('sqp.request', ({ job, payload }) => {
      if (!this.integrations.sqpRequest) throw new PermanentJobError(`${payload.type} handler not deployed in this runtime`);
      return this.integrations.sqpRequest(payload, { jobId: job.id });
    });
    registry.installBuiltin('marketing_stream.normalize', ({ payload }) => this.runIntegration(payload.type, this.integrations.marketingStreamNormalize, payload));
  }

  private async runIntegration<TPayload extends JobPayload>(
    type: TPayload['type'],
    handler: ((payload: TPayload) => Promise<Record<string, unknown>>) | undefined,
    payload: TPayload,
  ): Promise<Record<string, unknown>> {
    if (!handler) throw new PermanentJobError(`${type} handler not deployed in this runtime`);
    return handler(payload);
  }

  /**
   * List and mirror entities with per-ad-product isolation.
   *
   * The first live sync lost every product's campaigns to a single Sponsored
   * Brands 400: one throw aborted the whole job before anything was committed.
   * Now each ad product is listed and mirrored on its own. A product that
   * listed cleanly is committed regardless of what the others did; a product
   * that failed leaves its mirror untouched (so a `full` pass never tombstones
   * a product it could not see).
   *
   * **A partial failure still fails the job**, after the winners are committed.
   * Reporting success would leave one product's mirror silently stale — the
   * grid would show yesterday's Sponsored Brands campaigns with nothing saying
   * so, which is worse than a retry. The re-thrown error is the most retryable
   * of the failures, so a 429 requeues on Amazon's own `Retry-After` rather
   * than on a sibling 400's flat backoff, and the re-run redoing the products
   * that already committed is harmless: every write here is an upsert.
   */
  private async syncEntities(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'entity.sync' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    const readStartedAt = await this.store.beginEntityRead?.();
    const listing = await this.buckets.run(profile.region, () => adsApi.listEntities(profile, payload.full));

    // A product-scoped job cares only about its own product; an unscoped job
    // covers all three.
    const requested: readonly AdProductCode[] = payload.adProduct
      ? [payload.adProduct]
      : ['SP', 'SB', 'SD'];
    const succeeded = requested.filter((product) => listing.succeeded.includes(product));
    const failures = listing.failures.filter((failure) => requested.includes(failure.adProduct));

    // Everything asked for failed: nothing to commit, so fail loudly and let
    // the retry policy see the real error type.
    if (succeeded.length === 0) {
      const worst = mostRetryable(failures);
      if (worst) {
        // Entity-list failures historically consume the queue retry budget, including
        // a provider 4xx. Preserve that mirror policy at its owning adapter.
        if (isProviderFailure(worst.error) && worst.error.provider === 'amazon_ads') {
          throw new RetryableJobError(errorMessage(worst.error), worst.error.retryAfterSeconds);
        }
        throw worst.error instanceof Error ? worst.error : new Error(worst.message);
      }
      throw new Error(`entity sync listed nothing for ${requested.join(', ')}`);
    }

    const totals = { listed: 0, upserted: 0, duplicates: 0, changes: 0, tombstoned: 0 };
    let keywordMirror: KeywordMirrorMergeCounts | undefined;
    const controlMirrors: Partial<Record<'campaign' | 'target', ControlMirrorMergeCounts>> = {};
    for (const product of succeeded) {
      const productRows = listing.rows.filter((row) => row.adProduct === product);
      // Scope the mirror to this product so tombstoning stays within it and a
      // sibling product that failed to list is never touched.
      const counts = await this.store.syncEntities(profile, productRows, {
        adProduct: product,
        full: payload.full,
        ...(readStartedAt === undefined ? {} : { readStartedAt }),
        ...(listing.excludedEntityTypes?.[product] === undefined ? {} : {
          excludedEntityTypes: listing.excludedEntityTypes[product],
        }),
        ...(product === 'SP' ? { preserveCampaignNegativeTargets: listing.preserveCampaignNegativeTargets ?? true } : {}),
      });
      // Program rule 4: the artifact, not the exit code. A listing that
      // upserted fewer rows than it listed lost some — unless the shortfall is
      // exactly the rows another row in the same listing already carried (the
      // negatives mirror merges three Amazon endpoints onto one key).
      if (counts.listed !== counts.upserted + counts.duplicates) {
        throw new Error(
          `${product}: listed ${counts.listed}, upserted ${counts.upserted}, duplicates ${counts.duplicates}`,
        );
      }
      totals.listed += counts.listed;
      totals.upserted += counts.upserted;
      totals.duplicates += counts.duplicates;
      totals.changes += counts.changes;
      totals.tombstoned += counts.tombstoned;
      for (const kind of ['campaign', 'target'] as const) {
        const controlCounts = counts.controlMirrors?.[kind];
        if (controlCounts === undefined) continue;
        const incoming = ControlMirrorMergeCounts.parse(controlCounts);
        const prior = controlMirrors[kind];
        if (prior === undefined) controlMirrors[kind] = incoming;
        else {
          for (const key of Object.keys(incoming) as Array<keyof ControlMirrorMergeCounts>) prior[key] += incoming[key];
          ControlMirrorMergeCounts.parse(prior);
        }
      }
      if (counts.keywordMirror !== undefined) {
        const incoming = KeywordMirrorMergeCounts.parse(counts.keywordMirror);
        if (keywordMirror === undefined) keywordMirror = incoming;
        else {
          for (const key of Object.keys(incoming) as Array<keyof KeywordMirrorMergeCounts>) keywordMirror[key] += incoming[key];
          KeywordMirrorMergeCounts.parse(keywordMirror);
        }
      }
    }

    const failureSummary = failures.map((failure) => ({ adProduct: failure.adProduct, error: failure.message }));
    if (failureSummary.length > 0) {
      this.logger.error('entity sync partial failure', {
        profileId: profile.id,
        succeeded,
        failed: failureSummary,
        ...totals,
      });
      // Committed above, thrown here: the products that listed are in the
      // mirror, and the job goes back on the queue because one is not.
      throw partialSyncError(succeeded, failures);
    }
    this.logger.info('entity sync', { profileId: profile.id, succeeded, ...totals });
    return { ...totals, succeeded, failures: failureSummary, ...(keywordMirror === undefined ? {} : { keywordMirror }),
      ...(Object.keys(controlMirrors).length === 0 ? {} : { controlMirrors }) };
  }

  /**
   * WP-10's handler, run under this worker's claim loop and retry policy.
   *
   * A `mismatch` headline is the product, not a failure: the job succeeds and
   * the verdict is the result. Only a throw fails it, and only the two
   * permanent errors skip the retries.
   */
  private async ingestCrosscheck(
    payload: Extract<JobPayload, { type: 'crosscheck.ingest' }>,
  ): Promise<Record<string, unknown>> {
    if (!this.crosscheckIngest) {
      throw new PermanentJobError('crosscheck ingest is not configured on this worker');
    }
    let result;
    try { result = await this.crosscheckIngest(payload); }
    catch (error) {
      if (isPermanentCrosscheckError(error)) throw new PermanentJobError(errorMessage(error));
      throw error;
    }
    // Program rule 4: rows offered against rows kept, verdicts against rows
    // written. `rowsParsed > rowsKept` is normal — the incumbent's export
    // carries every profile the team can see.
    this.logger.info('crosscheck ingest', {
      profileId: payload.profileId,
      date: payload.date,
      filesParsed: result.filesParsed,
      rowsParsed: result.rowsParsed,
      rowsKept: result.rowsKept,
      findings: result.findings.length,
      written: result.written,
      headline: result.summary.headline,
    });
    return {
      headline: result.summary.headline,
      filesParsed: result.filesParsed,
      rowsParsed: result.rowsParsed,
      rowsKept: result.rowsKept,
      findings: result.findings.length,
      written: result.written,
    };
  }

  private async requestReport(
    job: ClaimedJob,
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.request' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    if (payload.reportType === 'sbAds' && payload.creativeSyncSnapshotId == null) {
      throw new PermanentJobError('sbAds report request is missing creative snapshot provenance');
    }
    if (payload.reportType !== 'sbAds' && payload.creativeSyncSnapshotId != null) {
      throw new PermanentJobError('base report request must not carry creative snapshot provenance');
    }
    const coreFamily = CoreFeatureReportType.safeParse(payload.reportType);
    if (coreFamily.success) {
      if (!this.coreReportingEnabled) throw new PermanentJobError('core reporting is disabled');
      const configuration = CoreReportConfiguration.parse(payload.familyConfiguration ?? defaultCoreReportConfiguration(coreFamily.data));
      if (configuration.family !== coreFamily.data) throw new PermanentJobError('report configuration family mismatch');
      const capability = await this.store.coreReportCapability?.(payload.orgId, payload.profileId, coreFamily.data) ?? null;
      assertCoreReportAdmission(configuration, capability, payload);
      validateCoreReportWindow(configuration, payload.startDate, payload.endDate, new Intl.DateTimeFormat('en-CA', { timeZone: profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.now()));
      payload = { ...payload, familyConfiguration: configuration };
    } else if (payload.familyConfiguration !== undefined) throw new PermanentJobError('base report cannot carry family configuration');
    const ledger = await this.store.ensureReportRequest(job.id, payload);
    if (coreFamily.success && !isDeepStrictEqual(CoreReportConfiguration.parse(ledger.familyConfiguration), payload.familyConfiguration)) throw new PermanentJobError('immutable report configuration changed');
    let amazonReportId = ledger.amazonReportId;
    if (!amazonReportId) {
      try {
        const created = await this.buckets.run(profile.region, () => adsApi.createReport({
          profile,
          reportType: payload.reportType,
          startDate: payload.startDate,
          endDate: payload.endDate,
          ...(payload.familyConfiguration ? { familyConfiguration: payload.familyConfiguration } : {}),
        }));
        amazonReportId = created.reportId;
        const persistence = {
          reportRequestId: ledger.id,
          orgId: payload.orgId,
          profileId: payload.profileId,
          amazonReportId,
          nextPollAt: addMinutes(this.now(), 5),
          claim: job.claim,
        };
        try {
          await this.store.setReportCreated(persistence);
        } catch {
          // A commit followed by a lost database reply is recoverable only by an
          // exact tenant/provider-id/claim readback below.
        }
        let confirmed = false;
        try {
          confirmed = await this.store.confirmReportCreated(persistence);
        } catch {
          // Readback unavailability is an unknown provider-effect outcome too.
        }
        if (!confirmed) {
          throw new ReportCreateOutcomeUnknownError('provider-id-persistence', null);
        }
      } catch (error) {
        if (error instanceof ReportCreateOutcomeUnknownError) {
          try {
            await this.store.quarantineReportCreate(job, {
              phase: error.phase, status: error.status, amazonReportId,
            });
          } catch {
            this.logger.error('ambiguous report evidence persistence unavailable', { jobId: job.id });
          }
        }
        throw error;
      }
    }
    const pollPayload: Extract<JobPayload, { type: 'report.poll' }> = {
      type: 'report.poll', orgId: payload.orgId, profileId: payload.profileId,
      reportRequestId: ledger.id, amazonReportId, attempt: 0,
    };
    const enqueued = await this.store.enqueue(pollPayload, addMinutes(this.now(), 5), `report.poll:${ledger.id}:0`);
    let unified: Awaited<ReturnType<UnifiedDualRun['admit']>> = { kind: 'disabled' };
    if (this.unifiedReporting && !coreFamily.success) {
      try {
        unified = await this.unifiedReporting.admit({
          v3ReportRequestId: ledger.id,
          profile,
          reportType: payload.reportType,
          startDate: payload.startDate,
          endDate: payload.endDate,
        });
      } catch {
        unified = { kind: 'local_failed' };
        this.logger.error('Unified Reporting sidecar admission failed', {
          reportRequestId: ledger.id,
        });
      }
    }
    return { reportRequestId: ledger.id, amazonReportId, pollEnqueued: enqueued, unified };
  }

  private async pollReport(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.poll' }>,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    const ledger = await this.store.getReportRequest(
      payload.reportRequestId,
      payload.orgId,
      payload.profileId,
    );
    assertAmazonReportId(ledger, payload.amazonReportId);
    const coreFamily = CoreFeatureReportType.safeParse(ledger.reportType);
    if (coreFamily.success) {
      if (!this.coreReportingEnabled) throw new PermanentJobError('core reporting is disabled');
      assertCoreReportAdmission(CoreReportConfiguration.parse(ledger.familyConfiguration), await this.store.coreReportCapability?.(payload.orgId, payload.profileId, coreFamily.data) ?? null, payload);
    }
    const status = await this.buckets.run(profile.region, () => adsApi.getReport(profile, payload.amazonReportId));
    if (status.status === 'PENDING' || status.status === 'PROCESSING') {
      if (this.now().getTime() - ledger.requestedAt.getTime() >= FOUR_HOURS_MS) {
        await this.store.updateReportPoll(ledger.id, { status: 'expired', error: 'report did not complete within 4 hours' });
        return { status: 'expired', pollAttempts: payload.attempt + 1 };
      }
      const nextAttempt = payload.attempt + 1;
      const delayMinutes = POLL_DELAYS_MINUTES[Math.min(nextAttempt, POLL_DELAYS_MINUTES.length - 1)] ?? 30;
      const runAt = addMinutes(this.now(), delayMinutes);
      await this.store.updateReportPoll(ledger.id, { status: status.status === 'PENDING' ? 'pending' : 'processing', nextPollAt: runAt });
      const enqueued = await this.store.enqueue(
        { ...payload, attempt: nextAttempt }, runAt, `report.poll:${ledger.id}:${nextAttempt}`,
      );
      return { status: status.status, nextAttempt, delayMinutes, enqueued };
    }
    if (status.status === 'FAILURE' || status.status === 'CANCELLED') {
      const dbStatus = status.status === 'FAILURE' ? 'failed' : 'cancelled';
      await this.store.updateReportPoll(ledger.id, { status: dbStatus, error: status.failureReason ?? status.status });
      return { status: dbStatus, error: status.failureReason ?? null };
    }
    if (!status.downloadUrl) throw new Error(`completed report ${payload.amazonReportId} has no download URL`);
    await this.store.updateReportPoll(ledger.id, {
      status: 'processing', nextPollAt: null, downloadUrl: status.downloadUrl,
      downloadExpiresAt: status.downloadExpiresAt ?? null,
    });
    const fetchPayload: Extract<JobPayload, { type: 'report.fetch' }> = {
      type: 'report.fetch', orgId: payload.orgId, profileId: payload.profileId,
      reportRequestId: ledger.id, amazonReportId: payload.amazonReportId,
      downloadUrl: status.downloadUrl,
    };
    const enqueued = await this.store.enqueue(
      fetchPayload,
      this.now(),
      `report.fetch:${ledger.id}:${payload.attempt}`,
    );
    return { status: 'COMPLETED', fetchEnqueued: enqueued };
  }

  private async fetchReport(
    profile: AdsProfileContext,
    payload: Extract<JobPayload, { type: 'report.fetch' }>,
    coverage: ReportCoverageCompletion,
  ): Promise<Record<string, unknown>> {
    const adsApi = this.requireAdsApi();
    const ledger = await this.store.getReportRequest(
      payload.reportRequestId,
      payload.orgId,
      payload.profileId,
    );
    assertAmazonReportId(ledger, payload.amazonReportId);
    let parsedBatch: ParsedFactBatch | undefined;
    const coreFamily = CoreFeatureReportType.safeParse(ledger.reportType);
    if (coreFamily.success) {
      if (!this.coreReportingEnabled) throw new PermanentJobError('core reporting is disabled');
      assertCoreReportAdmission(CoreReportConfiguration.parse(ledger.familyConfiguration), await this.store.coreReportCapability?.(payload.orgId, payload.profileId, coreFamily.data) ?? null, payload);
    }
    // Expiry-aware fetch: a URL that is expired, or will be before a download
    // could start, is never fetched. Its report is re-requested instead.
    const urlExpiresAt = downloadUrlExpiresAt(payload.downloadUrl)
      ?? (ledger.downloadUrl === payload.downloadUrl ? ledger.downloadExpiresAt ?? null : null);
    if (urlExpiresAt !== null
      && urlExpiresAt.getTime() - this.now().getTime() < DOWNLOAD_URL_MIN_REMAINING_MS) {
      return this.reRequestExpiredReport(
        ledger,
        payload,
        coverage,
        urlExpiresAt.getTime() <= this.now().getTime() ? 'expired_before_download' : 'expiring_before_download',
      );
    }
    const coreRows: unknown[] = [];
    let sbReport: SbAdsReportProbeParseResult | undefined;
    let parentParsedBytes = 0;
    const sourceDateCounts = new Map<string, ReportDateSourceCounts>();
    const downloadController = new AbortController();
    const downloadTimer = setTimeout(
      () => downloadController.abort(new ReportDownloadLimitError(
        'total_timeout',
        this.reportDownloadLimits.totalTimeoutMs,
      )),
      this.reportDownloadLimits.totalTimeoutMs,
    );
    try {
      const source = await adsApi.downloadReport(payload.downloadUrl, downloadController.signal);
      const downloaded = await gunzipJson(
        source,
        this.reportDownloadLimits,
        {
          signal: downloadController.signal,
          abortSource: (reason) => downloadController.abort(reason),
          consumeRows: (rows, offset) => {
            if (coreFamily.success) {
              parentParsedBytes = accountParentParsedBytes(parentParsedBytes, rows);
              coreRows.push(...rows);
              return;
            }
            if (ledger.reportType === 'sbAds') {
              const chunk = parseSbAdsReportProbe(rows);
              parentParsedBytes = accountParentParsedBytes(parentParsedBytes, chunk);
              sbReport = mergeSbAdsReportChunks(
                sbReport,
                chunk,
                offset,
              );
              return;
            }
            const chunk = parseReportRows(DefaultReportType.parse(ledger.reportType), rows, profile, ledger.id);
            parentParsedBytes = accountParentParsedBytes(parentParsedBytes, chunk);
            if (SP_REPORT_TYPES.has(ledger.reportType)) {
              accountSponsoredProductsSourceChunk(rows, chunk.skipped, sourceDateCounts);
            }
            parsedBatch = mergeParsedFactBatches(parsedBatch, chunk, offset);
          },
        },
      );
      if (coreFamily.success) {
        if (coreRows.length !== downloaded.rowsParsed) throw new PermanentJobError('core report download count mismatch');
        const configuration = CoreReportConfiguration.parse(ledger.familyConfiguration);
        const parsed = parseCoreReport(configuration, coreRows, ledger.startDate, ledger.endDate);
        const accepted = parsed.refusals.length === 0 ? parsed.rows.length : 0;
        const accounting = { sourceRows: parsed.sourceRows, parsedRows: parsed.parsedRows, refusedRows: parsed.refusals.length, promotedRows: accepted, unpromotedRows: parsed.parsedRows - accepted, canonicalRows: accepted };
        const observedAt = this.now().toISOString();
        await coverage.attributed(ledger.id, accounting, {
          status: parsed.refusals.length ? 'failed' : 'completed', bytesDownloaded: downloaded.bytesDownloaded,
          ...(parsed.refusals.length ? { error: 'core report parser refused rows' } : {}),
          coverage: { sourceRows: parsed.sourceRows, parsedRows: parsed.parsedRows, refusedRows: parsed.refusals.length, observedAt, settledThrough: null },
          promotion: { orgId: ledger.orgId, profileId: ledger.profileId, reportRequestId: ledger.id, requestedAt: ledger.requestedAt.toISOString(), observedAt, startDate: ledger.startDate, endDate: ledger.endDate, parsed },
        });
        if (parsed.refusals.length) throw new PermanentJobError('core report parser refused rows');
        return { ...accounting, duplicates: parsed.duplicateRows, bytesDownloaded: downloaded.bytesDownloaded };
      }
      if (ledger.reportType === 'sbAds') {
        sbReport ??= parseSbAdsReportProbe([]);
        if (sbReport.sourceRows !== downloaded.rowsParsed) {
          throw new PermanentJobError('sbAds parser chunk accounting did not match the downloaded rows');
        }
      } else {
        parsedBatch ??= parseReportRows(DefaultReportType.parse(ledger.reportType), [], profile, ledger.id);
        if (parsedBatch.sourceRows !== downloaded.rowsParsed) {
          throw new PermanentJobError('report parser chunk accounting did not match the downloaded rows');
        }
      }
      return await this.finishFetchedReport(
        profile,
        ledger,
        downloaded.bytesDownloaded,
        parsedBatch,
        sbReport,
        [...sourceDateCounts.values()],
        coverage,
      );
    } catch (error) {
      if (error instanceof ReportDownloadLimitError) {
        downloadController.abort(error);
        throw error;
      }
      if (error instanceof ReportPayloadShapeError) {
        const detail = error.message;
        await this.store.failReport(ledger.id, detail);
        throw new PermanentJobError(detail);
      }
      if (error instanceof ReportPayloadFormatError) {
        // A corrupt or truncated gzip stream is a transport accident and keeps
        // the queue's retry budget. Empty, non-report and malformed bodies are
        // the same on every retry; say which one it was and stop.
        if (error.retryable) throw error;
        await this.store.failReport(ledger.id, error.message);
        throw new PermanentJobError(error.message);
      }
      if (!(error instanceof DownloadUrlExpiredError)) throw error;
      return await this.reRequestExpiredReport(ledger, payload, coverage, error.rejection);
    } finally {
      clearTimeout(downloadTimer);
    }
  }

  /**
   * A stale pre-signed URL is repaired by a fresh report, not by retrying the
   * same link: request the same window again through the normal request path
   * (bounded per window), mark this ledger expired, and finish the fetch
   * without a coverage observation.
   */
  private async reRequestExpiredReport(
    ledger: ReportRequestState,
    payload: Extract<JobPayload, { type: 'report.fetch' }>,
    coverage: ReportCoverageCompletion,
    reason: DownloadUrlRejection | 'expired_before_download' | 'expiring_before_download',
  ): Promise<Record<string, unknown>> {
    // A Creative snapshot is bound to exactly this ledger, and an expired
    // ledger blocks its snapshot (`block_creative_snapshot_on_report_terminal`).
    // Such a report keeps its ledger and re-polls the same Amazon report for a
    // fresh URL, within the request horizon.
    if (ledger.creativeSyncSnapshotId) return this.rePollSnapshotReport(ledger, payload, coverage, reason);
    if (!this.store.reRequestReport) {
      throw new PermanentJobError('worker store cannot re-request a report whose download URL expired');
    }
    const request = ReportRequestJob.parse({
      type: 'report.request',
      orgId: payload.orgId,
      profileId: payload.profileId,
      reportType: ledger.reportType,
      startDate: ledger.startDate,
      endDate: ledger.endDate,
      ...(ledger.familyConfiguration ? { familyConfiguration: ledger.familyConfiguration } : {}),
      ...(ledger.creativeSyncSnapshotId ? { creativeSyncSnapshotId: ledger.creativeSyncSnapshotId } : {}),
    });
    const outcome = await this.store.reRequestReport({
      reportRequestId: ledger.id,
      orgId: payload.orgId,
      profileId: payload.profileId,
      payload: request,
      error: RE_REQUESTED_LEDGER_ERROR,
      maxGenerations: MAX_REPORT_RE_REQUESTS,
    });
    if (outcome.kind === 'exhausted') {
      const detail = `report download URL expired after ${MAX_REPORT_RE_REQUESTS} re-requests of this window`;
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(detail);
    }
    coverage.deferDownload();
    this.logger.info('report re-requested because its download URL cannot be used', {
      reportRequestId: ledger.id,
      reportType: ledger.reportType,
      reason,
      generation: outcome.generation,
      requestJobId: outcome.requestJobId,
    });
    return {
      downloadExpired: true,
      reason,
      reRequested: true,
      reRequestJobId: outcome.requestJobId,
      reRequestEnqueued: outcome.enqueued,
      generation: outcome.generation,
    };
  }

  private async rePollSnapshotReport(
    ledger: ReportRequestState,
    payload: Extract<JobPayload, { type: 'report.fetch' }>,
    coverage: ReportCoverageCompletion,
    reason: DownloadUrlRejection | 'expired_before_download' | 'expiring_before_download',
  ): Promise<Record<string, unknown>> {
    if (this.now().getTime() - ledger.requestedAt.getTime() >= FOUR_HOURS_MS) {
      const detail = 'report download URL remained expired beyond the 4-hour request horizon';
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(detail);
    }
    const attempt = ledger.pollAttempts;
    const pollPayload: Extract<JobPayload, { type: 'report.poll' }> = {
      type: 'report.poll', orgId: payload.orgId, profileId: payload.profileId,
      reportRequestId: ledger.id, amazonReportId: payload.amazonReportId, attempt,
    };
    const enqueued = await this.store.enqueue(pollPayload, this.now(), `report.repoll:${ledger.id}:${attempt}`);
    coverage.deferDownload();
    return { downloadExpired: true, reason, repollEnqueued: enqueued };
  }

  private async finishFetchedReport(
    profile: AdsProfileContext,
    ledger: ReportRequestState,
    bytesDownloaded: number,
    parsedBatch: ParsedFactBatch | undefined,
    sbReport: SbAdsReportProbeParseResult | undefined,
    sourceDateCounts: readonly ReportDateSourceCounts[],
    coverage: ReportCoverageCompletion,
  ): Promise<Record<string, unknown>> {
    if (ledger.reportType === 'sbAds') {
      if (!this.sbVideo) {
        const detail = 'sbAds ingestion runtime is not configured on this worker';
        await this.store.failReport(ledger.id, detail);
        throw new PermanentJobError(detail);
      }
      const creativeSyncSnapshotId = ledger.creativeSyncSnapshotId;
      if (creativeSyncSnapshotId == null) {
        const detail = 'sbAds report ledger is missing creative snapshot provenance';
        await this.store.failReport(ledger.id, detail);
        throw new PermanentJobError(detail);
      }
      const result = await this.sbVideo.ingestReport({
        profile,
        ledger: { ...ledger, creativeSyncSnapshotId },
        parsedReport: sbReport ?? parseSbAdsReportProbe([]),
      });
      const accounting = {
        sourceRows: result.reportSourceRows,
        parsedRows: result.reportParsedRows,
        refusedRows: result.reportRefusedRows,
        promotedRows: result.mappedFactRows,
        unpromotedRows: result.unpromotedReportRows,
        canonicalRows: result.factsReadBack,
      };
      if (result.blocked) {
        const detail = `sbAds promotion blocked: ${result.reasons.join(', ') || 'contract incomplete'}`;
        await coverage.attributed(ledger.id, accounting, {
          status: 'failed',
          bytesDownloaded,
          error: detail,
        });
        throw new PermanentJobError(detail);
      }
      await coverage.attributed(ledger.id, accounting, {
        status: 'completed',
        bytesDownloaded,
        coverage: { sourceRows: result.reportSourceRows, parsedRows: result.reportParsedRows,
          refusedRows: result.reportRefusedRows, observedAt: this.now().toISOString(), settledThrough: null },
      });
      this.logger.info('Sponsored Brands Video report ingested', {
        reportRequestId: ledger.id,
        reportType: ledger.reportType,
        ...result,
      });
      return { ...result, bytesDownloaded };
    }
    const baseLedger: BaseReportRequestState = { ...ledger, reportType: DefaultReportType.parse(ledger.reportType) };
    const batch = parsedBatch ?? parseReportRows(baseLedger.reportType, [], profile, ledger.id);
    if (SP_REPORT_TYPES.has(baseLedger.reportType)) {
      return this.promoteSponsoredProductsReport(
        profile,
        baseLedger,
        sourceDateCounts,
        bytesDownloaded,
        batch,
        coverage,
      );
    }
    const parsed = batch.rows.length;
    const skipped = batch.skipped.length;
    const reasons = skipReasons(batch.skipped);
    // Rows Amazon sent must be accounted for: kept plus refused. Asserted for
    // the two delegated grains, where the parser reports both numbers and the
    // fact row grain is the report row grain. `spCampaigns` aggregates onto the
    // profile grain by design, so the identity does not hold there.
    const accounted = batch.kind === 'sp_target' || batch.kind === 'search_term';
    if (accounted && batch.sourceRows !== parsed + skipped) {
      throw new PermanentJobError(
        `report ${ledger.id}: ${batch.sourceRows} source rows but ${parsed} parsed + ${skipped} skipped`,
      );
    }
    // Deterministic schema drift, not bad luck: a parser that refused
    // everything (or nearly everything) will refuse it again on all five
    // attempts, and each retry leaves another stuck-processing ledger row. Fail
    // the ledger honestly and dead-letter instead.
    if (batch.sourceRows > 0 && (parsed === 0 || skipped / batch.sourceRows > SKIP_FAILURE_RATIO)) {
      const detail = `parser refused ${skipped} of ${batch.sourceRows} rows: ${formatReasons(reasons)}`;
      await this.store.updateReportPoll(ledger.id, { status: 'failed', error: detail });
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }
    const loaded = await this.store.loadFacts(batch);
    // Program rule 4 again: `completeReport` throws on a mismatch, so a fetch
    // that silently dropped rows fails the job instead of reporting success.
    await coverage.complete(ledger.id, { parsed, loaded, bytesDownloaded,
      coverage: {
        sourceRows: batch.sourceRows, parsedRows: batch.sourceRows - skipped, refusedRows: skipped,
        observedAt: this.now().toISOString(), settledThrough: null,
      },
    });
    this.logger.info('report fetched', {
      reportRequestId: ledger.id, reportType: ledger.reportType,
      reportRows: batch.sourceRows, parsed, loaded, skipped, skipReasons: reasons,
    });
    return {
      reportRows: batch.sourceRows, parsed, loaded, skipped, skipReasons: reasons,
      bytesDownloaded,
    };
  }

  private async promoteSponsoredProductsReport(
    profile: AdsProfileContext,
    ledger: BaseReportRequestState,
    sourceDateCounts: readonly ReportDateSourceCounts[],
    bytesDownloaded: number,
    batch: ReturnType<typeof parseReportRows>,
    coverage: ReportCoverageCompletion,
  ): Promise<Record<string, unknown>> {
    const skipped = batch.skipped.length;
    const reasons = skipReasons(batch.skipped);
    if (skipped > 0) {
      const detail = `replacement parser refused ${skipped} of ${batch.sourceRows} rows: ${formatReasons(reasons)}`;
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }

    const observedAt = this.now();
    let staged;
    try {
      staged = prepareSponsoredProductsReportDatesFromCounts({
        orgId: profile.orgId,
        profileId: profile.id,
        reportType: ledger.reportType,
        source: 'amazon_reporting_v3',
        reportRequestId: ledger.id,
        requestedAt: ledger.requestedAt,
        observedAt,
        attributionWindowDays: 7,
        batch,
        sourceDateCounts,
        startDate: ledger.startDate,
        endDate: ledger.endDate,
        profileTimeZone: profile.timezone,
      });
    } catch (error) {
      if (
        !(error instanceof UnsafeSponsoredProductsReport) &&
        !(error instanceof InvalidReportDatePromotion) &&
        !(error instanceof DuplicateFactGrain)
      ) throw error;
      const detail = errorMessage(error).slice(0, 4_000);
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }

    const partitions = await this.store.ensureReportPartitions(
      ledger.reportType,
      ledger.startDate,
      ledger.endDate,
    );
    if (partitions.expectedMonths !== partitions.matchedMonths) {
      const detail = `prepared ${partitions.matchedMonths} of ${partitions.expectedMonths} partition months`;
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }
    const sourceRows = staged.reduce((total, date) => total + date.sourceRows, 0);
    const parsedSourceRows = staged.reduce((total, date) => total + date.parsedRows, 0);
    const refusedRows = staged.reduce((total, date) => total + date.refusedRows, 0);
    const factRows = staged.reduce((total, date) => total + date.promotedRows, 0);
    if (sourceRows !== batch.sourceRows || sourceRows !== parsedSourceRows + refusedRows) {
      throw new PermanentJobError(
        `report ${ledger.id} source accounting drifted: ${sourceRows} source, ` +
        `${parsedSourceRows} parsed, ${refusedRows} refused`,
      );
    }

    let promotedDates = 0;
    let alreadyPromotedDates = 0;
    let supersededDates = 0;
    let acceptedFactRows = 0;
    let supersededFactRows = 0;
    let canonicalRows = 0;
    let deletedRows = 0;
    let observationRows = 0;
    try {
      for (const date of staged) {
        const result = await this.store.promoteReportDate(date);
        assertPromotionResult(ledger, date, result);
        deletedRows += result.deletedRows;
        observationRows += result.observationRows;
        if (result.status === 'superseded') {
          supersededDates += 1;
          supersededFactRows += date.promotedRows;
          continue;
        }
        if (result.status === 'promoted') promotedDates += 1;
        else alreadyPromotedDates += 1;
        acceptedFactRows += date.promotedRows;
        canonicalRows += result.watermark.canonicalRows;
      }
    } catch (error) {
      if (!(error instanceof InvalidReportDatePromotion) && !(error instanceof DuplicateFactGrain)) {
        throw error;
      }
      const detail = errorMessage(error).slice(0, 4_000);
      await this.store.failReport(ledger.id, detail);
      throw new PermanentJobError(`${ledger.reportType} ${detail}`);
    }

    if (staged.length !== promotedDates + alreadyPromotedDates + supersededDates) {
      throw new PermanentJobError('report date outcomes do not reconcile');
    }
    if (factRows !== acceptedFactRows + supersededFactRows) {
      throw new PermanentJobError('report fact outcomes do not reconcile');
    }
    if (acceptedFactRows !== canonicalRows) {
      throw new PermanentJobError(
        `accepted ${acceptedFactRows} fact rows but verified ${canonicalRows} canonical rows`,
      );
    }

    await coverage.complete(ledger.id, {
      parsed: acceptedFactRows,
      loaded: canonicalRows,
      bytesDownloaded,
      // A superseded request must not refresh the observation of a newer report.
      coverage: supersededDates > 0 ? null : {
        sourceRows, parsedRows: parsedSourceRows, refusedRows,
        observedAt: observedAt.toISOString(),
        settledThrough: staged.filter((date) =>
          date.attribution.eventDateAgeDays >= date.attribution.attributionWindowDays)
          .reduce<string | null>((latest, date) => latest === null || date.reportDate > latest
            ? date.reportDate : latest, null),
      },
    });
    const result = {
      reportRows: sourceRows,
      parsedSourceRows,
      refusedRows,
      factRows,
      acceptedFactRows,
      supersededFactRows,
      canonicalRows,
      reportDates: staged.length,
      promotedDates,
      alreadyPromotedDates,
      supersededDates,
      deletedRows,
      observationRows,
      partitionMonths: partitions.expectedMonths,
      partitionsCreated: partitions.createdMonths,
      bytesDownloaded,
    };
    this.logger.info('Sponsored Products report promoted', {
      reportRequestId: ledger.id,
      reportType: ledger.reportType,
      ...result,
    });
    return result;
  }

  private requireAdsApi(): AdsApiClient {
    if (!this.adsApi) throw new PermanentJobError('Amazon Ads API not deployed in this runtime');
    return this.adsApi;
  }
}

function mergeSbAdsReportChunks(
  current: SbAdsReportProbeParseResult | undefined,
  next: SbAdsReportProbeParseResult,
  sourceOffset: number,
): SbAdsReportProbeParseResult {
  const refusals = next.refusals.map((refusal) => ({
    ...refusal,
    index: refusal.index + sourceOffset,
  }));
  if (!current) return { ...next, refusals };
  current.sourceRows += next.sourceRows;
  current.parsedRows += next.parsedRows;
  current.rows.push(...next.rows);
  current.refusals.push(...refusals);
  return current;
}

export function accountParentParsedBytes(current: number, value: unknown): number {
  const serialized = JSON.stringify(value);
  const next = current + Buffer.byteLength(serialized, 'utf8');
  if (next > MAX_PARENT_PARSED_BYTES) {
    throw new ReportDownloadLimitError('parsed_bytes', MAX_PARENT_PARSED_BYTES);
  }
  return next;
}

function accountSponsoredProductsSourceChunk(
  rows: readonly unknown[],
  skippedRows: readonly SkippedReportRow[],
  counts: Map<string, ReportDateSourceCounts>,
): void {
  const skipped = new Set<number>();
  for (const refusal of skippedRows) {
    if (!Number.isSafeInteger(refusal.index) || refusal.index < 0 || refusal.index >= rows.length) {
      throw new UnsafeSponsoredProductsReport(`parser returned invalid skipped index ${refusal.index}`);
    }
    if (skipped.has(refusal.index)) {
      throw new UnsafeSponsoredProductsReport(`parser returned duplicate skipped index ${refusal.index}`);
    }
    skipped.add(refusal.index);
  }
  rows.forEach((row, index) => {
    const reportDate = sponsoredProductsSourceRowDate(row, index);
    const date = counts.get(reportDate) ?? {
      reportDate,
      sourceRows: 0,
      parsedRows: 0,
      refusedRows: 0,
    };
    date.sourceRows += 1;
    if (skipped.has(index)) date.refusedRows += 1;
    else date.parsedRows += 1;
    counts.set(reportDate, date);
  });
}

function assertAmazonReportId(ledger: ReportRequestState, amazonReportId: string): void {
  if (ledger.source !== 'amazon_api') {
    throw new PermanentJobError('Reporting v3 job references a non-Amazon report request');
  }
  if (ledger.amazonReportId !== amazonReportId) {
    throw new PermanentJobError('job Amazon report id does not match its report request ledger');
  }
}

function assertPromotionResult(
  ledger: ReportRequestState,
  staged: ReturnType<typeof prepareSponsoredProductsReportDates>[number],
  result: Awaited<ReturnType<WorkerStore['promoteReportDate']>>,
): void {
  const watermark = result.watermark;
  if (
    watermark.profileId !== ledger.profileId ||
    watermark.reportType !== ledger.reportType ||
    watermark.date !== staged.reportDate
  ) {
    throw new InvalidReportDatePromotion('promotion result watermark is outside the report scope');
  }
  if (result.status === 'superseded') {
    if (result.deletedRows !== 0 || result.insertedRows !== 0 || result.observationRows !== 0) {
      throw new InvalidReportDatePromotion('a superseded promotion must not mutate canonical facts');
    }
    const watermarkRequestedAt = Date.parse(watermark.requestedAt);
    if (
      !Number.isFinite(watermarkRequestedAt) ||
      watermarkRequestedAt <= ledger.requestedAt.getTime()
    ) {
      throw new InvalidReportDatePromotion('a superseded promotion did not return newer evidence');
    }
    return;
  }
  if (
    watermark.reportRequestId !== ledger.id ||
    watermark.source !== staged.source ||
    watermark.sourceRows !== staged.sourceRows ||
    watermark.parsedRows !== staged.parsedRows ||
    watermark.refusedRows !== staged.refusedRows ||
    watermark.promotedRows !== staged.promotedRows ||
    watermark.canonicalRows !== staged.promotedRows
  ) {
    throw new InvalidReportDatePromotion('accepted promotion counts do not match the staged date');
  }
  if (result.status === 'promoted') {
    if (result.insertedRows !== staged.promotedRows || result.observationRows !== 1) {
      throw new InvalidReportDatePromotion('promoted date write counts do not match the staged date');
    }
    return;
  }
  if (result.deletedRows !== 0 || result.insertedRows !== 0 || result.observationRows !== 0) {
    throw new InvalidReportDatePromotion('an idempotent promotion retry must not mutate canonical facts');
  }
}

/** A timer that runs one async pass and never lets a rejection reach the loop. */
abstract class PeriodicPass {
  private timer: NodeJS.Timeout | undefined;
  protected constructor(private readonly intervalMs: number, private readonly logger: WorkerLogger) {}
  protected abstract pass(): Promise<unknown>;
  protected abstract get name(): string;

  start(): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    void this.pass().catch((error: unknown) => {
      this.logger.error(`${this.name} failed`, { error: errorMessage(error) });
    });
  }
}

/**
 * The hourly `/v2/profiles` probe per region.
 *
 * **Deliberately not a queue job**, and the manager accepted it as such. A
 * queued `auth.healthcheck` cannot answer the question the probe exists to
 * answer: if the queue is the thing that is broken, the check that would have
 * told you never runs. It also needs no per-profile scope, no dedupe slot and
 * no retry policy — it is a liveness probe, and a liveness probe that depends
 * on the subsystem it monitors is decoration. It runs in-process, on its own
 * timer, and logs failure loudly. See `apps/worker/README.md`.
 */
export class AuthHealthMonitor extends PeriodicPass {
  constructor(
    private readonly worker: SyncWorker,
    intervalMs = 60 * MINUTE_MS,
    logger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, logger);
  }
  protected get name(): string { return 'auth healthcheck'; }
  protected pass(): Promise<unknown> { return this.worker.runAuthHealthcheck(); }
}

/**
 * Gives a newly connected profile the default cadences, and repairs the ones
 * every profile already has.
 *
 * A profile with no schedules syncs nothing, and an always-on worker noticing
 * that is better than an onboarding step somebody forgets. It only ever fills
 * an empty set — a profile whose schedules an operator pruned stays pruned.
 *
 * The lookback repair runs unconditionally, on every profile, every tick. It
 * used to run inside `provisionSchedules`, which only ever visits profiles that
 * have no schedules — so the profiles carrying an illegal lookback, all of
 * which are provisioned by definition, were the exact set it never reached.
 */
export class ScheduleProvisioner extends PeriodicPass {
  constructor(
    private readonly store: WorkerStore,
    intervalMs = 15 * MINUTE_MS,
    private readonly provisionLogger: WorkerLogger = consoleLogger,
    private readonly recommendationSchedules?: Pick<
      RecommendationScheduleStore,
      'enqueueDueRecommendationRuns'
    >,
    private readonly sqpSchedules?: WeeklySqpScheduleProducer,
  ) {
    super(intervalMs, provisionLogger);
  }
  protected get name(): string { return 'schedule provisioning'; }
  protected async pass(): Promise<unknown> {
    const profiles = await this.store.unscheduledProfiles();
    let written = 0;
    for (const profile of profiles) {
      written += await this.store.provisionSchedules(profile.orgId, profile.profileId);
    }
    // Operator rule (2026-08-27): no automation without approval. Scheduled
    // weekday-scheduled recommendation runs stay off until explicitly opted in; the
    // on-demand "Run now" path is unaffected.
    const weeklyRunsApproved = process.env['WIZARD_ADS_WEEKLY_RECOMMENDATION_RUNS'] === '1';
    const recommendations = weeklyRunsApproved
      ? ((await this.recommendationSchedules?.enqueueDueRecommendationRuns()) ?? 0)
      : 0;
    const repaired = await this.store.repairOverlongLookbacks();
    const integrations = await this.store.ensureIntegrationSchedules();
    const catalogue = await this.store.ensureCatalogueSchedules?.() ?? 0;
    const sqp = await this.sqpSchedules?.enqueueDueSqpRequests();
    if (written > 0) {
      this.provisionLogger.info('provisioned default schedules', { profiles: profiles.length, schedules: written });
    }
    if (repaired > 0) {
      this.provisionLogger.info('clamped overlong report lookbacks', { schedules: repaired });
    }
    if (recommendations > 0) {
      this.provisionLogger.info('enqueued scheduled recommendation runs', { jobs: recommendations });
    }
    if (integrations > 0) {
      this.provisionLogger.info('reconciled integration schedules', { schedules: integrations });
    }
    if (catalogue > 0) this.provisionLogger.info('reconciled disabled catalogue schedules', { schedules: catalogue });
    if (sqp && sqp.enqueuedJobs > 0) {
      this.provisionLogger.info('enqueued weekly SQP requests', {
        jobs: sqp.enqueuedJobs,
        scopes: sqp.scopes,
        sourceAsinRows: sqp.sourceAsinRows,
        uniqueAsins: sqp.uniqueAsins,
        refusedAsinRows: sqp.refusedAsinRows,
      });
    }
    return { written, repaired, recommendations, integrations, sqp };
  }
}

/**
 * Sweeps jobs whose worker died mid-claim back onto the queue. Without it a
 * SIGKILL loses the job permanently: `claim_sync_jobs` only ever sees `queued`.
 */
export class StaleClaimReaper extends PeriodicPass {
  constructor(
    private readonly store: WorkerStore,
    private readonly olderThan = '30 minutes',
    intervalMs = 5 * MINUTE_MS,
    private readonly reaperLogger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, reaperLogger);
  }
  protected get name(): string { return 'stale claim sweep'; }
  protected async pass(): Promise<unknown> {
    const requeued = await this.store.requeueStale(this.olderThan);
    if (requeued > 0) this.reaperLogger.info('requeued stale jobs', { requeued, olderThan: this.olderThan });
    return requeued;
  }
}

/**
 * Syncs the per-target bid corridor once a day (WP-28).
 *
 * A `PeriodicPass` rather than a queue job, and deliberately so: the `sync_jobs`
 * queue is driven by `@wizard-ads/shared`'s `JobPayload`, which this WP does not
 * own, so a queue job would need a cross-package contract change (see
 * `bid-series.ts`). The corridor is market evidence retrieved daily on the same
 * footing as spend and clicks — a daily in-process pass is exactly the shape,
 * and it sits beside the auth healthcheck and the reaper for the same reason.
 */
export class BidSeriesSyncPass extends PeriodicPass {
  constructor(
    private readonly deps: BidSeriesSyncDeps,
    intervalMs = 24 * 60 * MINUTE_MS,
    private readonly passLogger: WorkerLogger = consoleLogger,
  ) {
    super(intervalMs, passLogger);
  }
  protected get name(): string { return 'bid series sync'; }
  protected async pass(): Promise<unknown> {
    const counts = await runBidSeriesSync({ logger: this.passLogger, ...this.deps });
    if (counts.written > 0) {
      this.passLogger.info('bid series sync pass', { ...counts });
    }
    return counts;
  }
}

/**
 * The failure a retry should be scheduled from: a throttle or 5xx if one is
 * there, otherwise the first. A 429 next to a 400 must not be retried on the
 * 400's flat backoff — Amazon told us when to come back.
 */
function mostRetryable(
  failures: readonly EntityListFailure[],
): EntityListFailure | undefined {
  return failures.find((failure) => failure.error instanceof AdsApiRetryableError) ?? failures[0];
}

/**
 * The error a partially-failed entity sync throws, once the products that did
 * list are committed. Retryable typing is preserved so `runClaimed` still backs
 * off on Amazon's own interval.
 */
function partialSyncError(
  succeeded: readonly AdProductCode[],
  failures: readonly EntityListFailure[],
): Error {
  const worst = mostRetryable(failures);
  const detail =
    `entity sync committed ${succeeded.join('+')} but ` +
    `${failures.map((failure) => failure.adProduct).join('+')} failed: ` +
    `${worst?.message ?? 'unknown error'}`;
  if (worst?.error instanceof AdsApiRetryableError) {
    return new AdsApiRetryableError(detail, worst.error.retryAfterSeconds);
  }
  return new Error(detail, worst?.error instanceof Error ? { cause: worst.error } : undefined);
}

/** How many distinct skip reasons a log line or job result carries. */
const MAX_SKIP_REASONS = 5;

/**
 * A bounded histogram of why rows were refused.
 *
 * Bounded because this lands in `sync_jobs.result` and in a log line: a report
 * that refused sixty thousand rows must not write sixty thousand reasons, and
 * the first few distinct ones already say which column Amazon stopped sending.
 */
function skipReasons(skipped: readonly SkippedReportRow[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const row of skipped) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return Object.fromEntries(
    [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SKIP_REASONS),
  );
}

function formatReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons);
  if (entries.length === 0) return 'no reason recorded';
  return entries.map(([reason, count]) => `${reason} (${count})`).join(', ');
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isPermanentJobFailure(error: unknown): boolean {
  return isPermanentProviderFailure(error);
}
