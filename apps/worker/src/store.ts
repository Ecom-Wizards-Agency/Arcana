import { provisionSpApiReportJobs } from './spapi-report-scheduler.js';
import { ProviderCollectionConfig } from '@wizard-ads/shared';
import { providerEvidenceSchedule } from './schedules.js';
import type { ReportCoverageObservation } from '@wizard-ads/shared';
import { mergeControlMirror, mergeKeywordMirror, readKeywordMirrorStart } from '@wizard-ads/db/sp-write-worker';
import type { ControlMirrorMergeCounts, KeywordMirrorMergeCounts, KeywordMirrorMergeRequest } from '@wizard-ads/shared/sp-write-mirror';
import { PermanentJobError } from './permanent-job-error.js';
import { isDeepStrictEqual } from 'node:util';
import {
  adGroups,
  campaigns,
  claimSyncJobs,
  claimSyncJobsFenced,
  deferSyncJobFenced,
  factSbDaily,
  factSdDaily,
  finishSyncJob,
  finishSyncJobFenced,
  ensureFactPartitions,
  keywords,
  negatives,
  portfolios,
  productAds,
  recordEntityChanges,
  reconcileEntityChangeLinks,
  reportRequests,
  recordReportCoverage,
  publishBudgetUsageCoverage,
  upsertReportCoverage,
  quarantineReportCreate,
  type ReportCreateEvidence,
  promoteReportDate as promoteDbReportDate,
  requeueStaleSyncJobs,
  targets,
  upsertMirrorRows,
  upsertPlacementFacts,
  upsertProfileFacts,
  upsertSearchTermFacts,
  upsertSpTargetFacts,
  type ClaimedJob,
  type ClaimRef,
  type DbHandle,
  type QueryHandle,
  type JobOutcome,
  type NewEntityChange,
  type ReportDatePromotionResult,
  type StagedReportDate,
} from '@wizard-ads/db';
import { MAX_REPORT_RANGE_DAYS } from '@wizard-ads/ads-api';
import { readCoreReportCapability, promoteCoreReportWindow, coreReportGrain } from '@wizard-ads/db';
import type { CoreReportConfiguration, CoreFeatureReportType, CoreReportCapability, CoreReportPromotion } from '@wizard-ads/shared';
import {
  WorkerReportAccounting,
  type ReportCoverageAccounting,
  type WorkerReportAccounting as WorkerReportAccountingShape,
  type EntityRow,
  type JobPayload,
  type JobType,
  type ReportType,
  type WorkerReportLedger,
} from '@wizard-ads/shared';
type AttributedReportCounts = WorkerReportAccountingShape;
import type { AdsProfileContext } from './ads-api.js';
import type { CampaignFactRow, ParsedFactBatch } from './parsers.js';
import { defaultSchedules, coreFamilySchedules, type ScheduleSpec } from './schedules.js';
import { ensureBudgetUsageSchedules } from './budget-usage/schedules.js';

export type ReportRequestState = Omit<
  WorkerReportLedger,
  'requestedAt' | 'creativeSyncSnapshotId'
> & {
  requestedAt: Date;
  /** Absent on base-report test adapters; production always returns null or a UUID. */
  creativeSyncSnapshotId?: string | null;
};

export interface ReportPartitionCounts {
  expectedMonths: number;
  matchedMonths: number;
  createdMonths: number;
}

/**
 * `drizzle-orm/postgres-js` replaces the shared client's timestamptz serializer
 * *and* parser with the identity function, because Drizzle does its own date
 * mapping. `createDb` builds the Drizzle instance over the same postgres.js
 * client the raw tag uses, so that override applies to every raw query in this
 * file too: binding a `Date` throws, and reading a timestamptz yields the wire
 * string rather than a `Date`.
 *
 * The two helpers below are that boundary, in both directions. Every raw
 * timestamptz this store binds goes through `iso`; every one it reads comes
 * back through `asDate`. Drizzle-built statements need neither.
 */
function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface EntitySyncOptions {
  /** Database time captured before provider listing. */
  readStartedAt?: string;
  /** Unlisted kinds are not refreshed or tombstoned; requires an ad-product scope. */
  excludedEntityTypes?: readonly EntityRow['entityType'][];
  preserveCampaignNegativeTargets?: boolean;
  adProduct?: 'SP' | 'SB' | 'SD';
  /**
   * A full pass re-lists every entity the profile has, so an id the mirror
   * holds and the listing omits really is gone and earns a tombstone. A delta
   * pass carries no such information — sweeping on one would tombstone every
   * entity type the pass did not happen to list.
   */
  full?: boolean;
}

export interface EntitySyncCounts {
  keywordMirror?: KeywordMirrorMergeCounts;
  controlMirrors?: Partial<Record<'campaign' | 'target', ControlMirrorMergeCounts>>;
  listed: number;
  upserted: number;
  /**
   * Listed rows collapsed away because another row in the same listing carried
   * the same `(profileId, amazonId)`. Real, not defensive: the negatives mirror
   * merges three Amazon endpoints (ad-group negative keywords, campaign
   * negative keywords, negative targets) into one table.
   */
  duplicates: number;
  changes: number;
  tombstoned: number;
}

/** The store's own narrow logging surface. `console` unless a caller says otherwise. */
export interface StoreLogger {
  info(message: string, details?: Record<string, unknown>): void;
}

/** How many colliding ids one log line carries. Ids only, never row contents. */
const MAX_LOGGED_DUPLICATE_IDS = 20;

export interface WorkerStore {
  coreReportCapability?(orgId: string, profileId: string, family: CoreFeatureReportType): Promise<CoreReportCapability | null>;
  /** WP-256 source-neutral producer. Required when installing additional ingestion sources. */
  recordCoverage?(observation: ReportCoverageObservation, verifiedLoadedRows: number): Promise<{ offered: number; written: number; unchanged: number }>;
  claim(workerId: string, limit: number, jobTypes?: readonly JobType[]): Promise<ClaimedJob[]>;
  finish(
    jobId: string,
    outcome: JobOutcome,
    options?: { error?: string; result?: unknown; retryIn?: string },
  ): Promise<void>;
  /** Settle exactly one opaque fenced claim. Required for every fenced job. */
  finishClaim?(
    claim: ClaimRef,
    outcome: JobOutcome,
    options?: { error?: string; result?: unknown; retryIn?: string },
  ): Promise<void>;
  /**
   * Return a healthy, unfinished provider job to the queue without consuming
   * its failure budget. Optional for test/adaptor stores; the Postgres runtime
   * implements it. A provider poll is waiting, not a failed attempt.
   */
  defer?(jobId: string, retryIn: string): Promise<void>;
  /** Defer exactly one opaque fenced claim without spending its attempt. */
  deferClaim?(claim: ClaimRef, retryIn: string): Promise<void>;
  /**
   * Finish a job as `dead` without spending its remaining attempts. For
   * failures no retry can fix — a malformed export, a payload naming a profile
   * that does not exist — retrying five times only delays the human.
   */
  deadLetter(jobId: string, error: string): Promise<void>;
  quarantineReportCreate(job: ClaimedJob, evidence: ReportCreateEvidence): Promise<void>;
  /** Permanently finish exactly one opaque fenced claim. */
  deadLetterClaim?(claim: ClaimRef, error: string): Promise<void>;
  release(workerId: string): Promise<number>;
  /**
   * Requeue jobs still `running` on a worker that died without releasing them.
   * Nothing else does this: `claim_sync_jobs` only ever sees `queued`, so a
   * SIGKILLed worker's jobs are lost until somebody sweeps them back.
   */
  requeueStale(olderThan: string): Promise<number>;
  profile(profileId: string): Promise<AdsProfileContext>;
  beginEntityRead?(): Promise<string | undefined>;
  syncEntities(
    profile: AdsProfileContext,
    entities: readonly EntityRow[],
    options?: EntitySyncOptions,
  ): Promise<EntitySyncCounts>;
  ensureReportRequest(jobId: string, payload: Extract<JobPayload, { type: 'report.request' }>): Promise<ReportRequestState>;
  setReportCreated(input: {
    reportRequestId: string;
    orgId: string;
    profileId: string;
    amazonReportId: string;
    nextPollAt: Date;
    claim: ClaimRef | null;
  }): Promise<boolean>;
  /** Exact readback used when the provider-id persistence reply is ambiguous. */
  confirmReportCreated(input: {
    reportRequestId: string;
    orgId: string;
    profileId: string;
    amazonReportId: string;
    claim: ClaimRef | null;
  }): Promise<boolean>;
  getReportRequest(reportRequestId: string, orgId: string, profileId: string): Promise<ReportRequestState>;
  updateReportPoll(
    reportRequestId: string,
    values: {
      status: 'pending' | 'processing' | 'failed' | 'cancelled' | 'expired';
      nextPollAt?: Date | null;
      error?: string | null;
      downloadUrl?: string | null;
      downloadExpiresAt?: Date | null;
    },
  ): Promise<void>;
  enqueue(payload: JobPayload, runAt: Date, dedupeKey: string): Promise<boolean>;
  /** Install the default cadences for a profile. Idempotent on the scope key. */
  provisionSchedules(
    orgId: string,
    profileId: string,
    specs?: readonly ScheduleSpec[],
  ): Promise<number>;
  /**
   * Sync-enabled profiles with no schedule rows at all. Deliberately not "every
   * enabled profile": a profile whose schedules an operator pruned should stay
   * pruned, and only one that has never been provisioned gets the defaults.
   */
  unscheduledProfiles(): Promise<{ orgId: string; profileId: string }[]>;
  /**
   * Clamp report schedules whose lookback exceeds what Amazon will generate.
   * Every profile when none is named. Idempotent, and cheap enough to run on
   * every tick — which is the point: the profiles that need it are exactly the
   * ones already provisioned, and those are the ones no provisioning pass
   * visits.
   */
  repairOverlongLookbacks(profileId?: string): Promise<number>;
  /** Reconcile provider schedules from active integration connections. */
  ensureIntegrationSchedules(): Promise<number>;
  ensureReportPartitions(
    reportType: ReportType,
    startDate: string,
    endDate: string,
  ): Promise<ReportPartitionCounts>;
  promoteReportDate(input: StagedReportDate): Promise<ReportDatePromotionResult>;
  failReport(reportRequestId: string, error: string): Promise<void>;
  /** Fail an unfinished ledger only inside the claimed job's tenant scope. */
  failTerminalReport(scope: {
    reportRequestId: string;
    orgId: string;
    profileId: string;
  }, error: string): Promise<boolean>;
  loadFacts(batch: ParsedFactBatch): Promise<number>;
  completeReport(
    reportRequestId: string,
    counts: { parsed: number; loaded: number; bytesDownloaded: number; coverage?: ReportCoverageAccounting | null },
  ): Promise<void>;
  finishAttributedReport(
    reportRequestId: string,
    counts: AttributedReportCounts,
    options: { status: 'completed' | 'failed'; bytesDownloaded: number; error?: string | null; coverage?: ReportCoverageAccounting; promotion?: CoreReportPromotion },
  ): Promise<void>;
}

export class ParsedLoadedMismatch extends PermanentJobError {
  constructor(readonly parsed: number, readonly loaded: number) {
    super(`report parsed ${parsed} rows but loaded ${loaded}`);
    this.name = 'ParsedLoadedMismatch';
  }
}

/** A stale process presented a capability which no longer owns the queue row. */
export class ClaimOwnershipLost extends Error {
  override readonly name = 'ClaimOwnershipLost';

  constructor() {
    super('sync job claim ownership was lost');
  }
}

export interface PostgresWorkerStoreOptions {
  ownCollectorsEnabled?: boolean;
  claimProtocol?: 'legacy' | 'fenced';
  budgetUsageApiEnabled?: boolean;
  keywordMirror?: KeywordMirrorCapability;
}

/** Field-fenced keyword synchronization shared by every entity-sync owner. */
export interface KeywordMirrorCapability {
  readStartedAt(): Promise<string>;
  merge(request: KeywordMirrorMergeRequest): Promise<KeywordMirrorMergeCounts>;
}

/** `deletedAt` arrives as the wire string, not a `Date` — see the note on `asDate`. */
type ExistingEntity = { amazonId: string; deletedAt: Date | string | null; snapshot: Record<string, unknown> };

export class PostgresWorkerStore implements WorkerStore {
  private readonly logger: StoreLogger;
  private readonly ownCollectorsEnabled: boolean;
  private readonly keywordMirror: KeywordMirrorCapability | undefined;
  private readonly reportedDisabledSbKeywords = new Set<string>();
  private readonly claimProtocol: 'legacy' | 'fenced';
  private readonly budgetUsageApiEnabled: boolean | undefined;

  constructor(
    readonly handle: DbHandle,
    logger?: StoreLogger,
    options: PostgresWorkerStoreOptions = {},
  ) {
    this.logger = logger ?? { info: (message, details) => console.info(message, details ?? {}) };
    this.claimProtocol = options.claimProtocol ?? 'legacy';
    this.budgetUsageApiEnabled = options.budgetUsageApiEnabled;
    this.keywordMirror = options.keywordMirror;
    this.ownCollectorsEnabled = options.ownCollectorsEnabled === true;
  }

  /** Activation requires explicit composition; construction never queries the DB. */
  assertKeywordMirrorConfigured(): void {
    if (this.keywordMirror === undefined) throw new Error('SP write worker requires keyword mirror configuration');
  }

  async beginEntityRead(): Promise<string | undefined> {
    if (this.keywordMirror) return this.keywordMirror.readStartedAt();
    // Cron and other default stores acquire the same fence after migration. A
    // worker deployed before the migration keeps the historical sync protocol.
    const [schema] = await this.handle.sql<{ ready: boolean }[]>`
      select to_regprocedure('app.reconcile_sp_write_mirror(uuid,text)') is not null as ready`;
    if (schema?.ready !== true) return undefined;
    return readKeywordMirrorStart(this.handle);
  }

  claim(workerId: string, limit: number, jobTypes?: readonly JobType[]): Promise<ClaimedJob[]> {
    return this.claimProtocol === 'fenced'
      ? claimSyncJobsFenced(this.handle, workerId, limit, jobTypes)
      : claimSyncJobs(this.handle, workerId, limit, jobTypes);
  }

  async finish(
    jobId: string,
    outcome: JobOutcome,
    options: { error?: string; result?: unknown; retryIn?: string } = {},
  ): Promise<void> {
    await finishSyncJob(this.handle, jobId, outcome, options);
  }

  async finishClaim(
    claim: ClaimRef,
    outcome: JobOutcome,
    options: { error?: string; result?: unknown; retryIn?: string } = {},
  ): Promise<void> {
    const decision = await finishSyncJobFenced(this.handle, claim, outcome, options);
    if (decision.decision === 'stale_claim') throw new ClaimOwnershipLost();
  }

  async defer(jobId: string, retryIn: string): Promise<void> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.sync_jobs
         set status = 'queued'::public.sync_job_status,
             attempts = greatest(attempts - 1, 0),
             last_error = null,
             claimed_by = null,
             claimed_at = null,
             run_after = now() + ${retryIn}::interval
       where id = ${jobId}
         and status = 'running'::public.sync_job_status
         and claim_token is null
      returning id
    `;
    if (rows.length !== 1 || rows[0]?.id !== jobId) {
      throw new Error(`could not defer running sync job ${jobId}`);
    }
  }

  async deferClaim(claim: ClaimRef, retryIn: string): Promise<void> {
    const decision = await deferSyncJobFenced(this.handle, claim, retryIn);
    if (decision.decision === 'stale_claim') throw new ClaimOwnershipLost();
  }

  quarantineReportCreate(job: ClaimedJob, evidence: ReportCreateEvidence): Promise<void> {
    return quarantineReportCreate(this.handle, job, evidence);
  }

  async deadLetter(jobId: string, error: string): Promise<void> {
    // `finish_sync_job` only derives `dead` from exhausted attempts, so a
    // permanent failure says the word itself and takes the function's
    // pass-through branch.
    await this.handle.sql`
      select public.finish_sync_job(
        ${jobId}, 'dead'::public.sync_job_status, ${error}, null::jsonb, null::interval
      )
    `;
  }

  async deadLetterClaim(claim: ClaimRef, error: string): Promise<void> {
    const decision = await finishSyncJobFenced(this.handle, claim, 'dead', { error });
    if (decision.decision === 'stale_claim') throw new ClaimOwnershipLost();
  }

  async release(workerId: string): Promise<number> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.sync_jobs
         set status = 'queued', claimed_by = null, claimed_at = null,
             run_after = now(), last_error = coalesce(last_error, 'released during graceful shutdown')
       where status = 'running' and claimed_by = ${workerId}
         and claim_token is null
      returning id
    `;
    return rows.length;
  }

  requeueStale(olderThan: string): Promise<number> {
    return requeueStaleSyncJobs(this.handle, olderThan);
  }

  async profile(profileId: string): Promise<AdsProfileContext> {
    const rows = await this.handle.sql<{
      id: string;
      org_id: string;
      amazon_profile_id: string;
      region: 'NA' | 'EU' | 'FE';
      currency_code: string;
      timezone: string;
    }[]>`
      select id, org_id, amazon_profile_id, region, currency_code, timezone
        from public.ad_profiles where id = ${profileId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`profile ${profileId} does not exist`);
    return {
      id: row.id,
      orgId: row.org_id,
      amazonProfileId: row.amazon_profile_id,
      region: row.region,
      currencyCode: row.currency_code,
      timezone: row.timezone,
    };
  }

  async syncEntities(
    profile: AdsProfileContext,
    entities: readonly EntityRow[],
    options: EntitySyncOptions = {},
  ): Promise<EntitySyncCounts> {
    const { adProduct, full = false } = options;
    if (this.keywordMirror && options.readStartedAt === undefined) throw new Error('keyword mirror requires the provider read-start time');
    const keywordCapability = this.keywordMirror ?? (options.readStartedAt === undefined ? undefined : {
      merge: (request: KeywordMirrorMergeRequest) => mergeKeywordMirror(this.handle, request),
    });
    let keywordMirror: KeywordMirrorMergeCounts | undefined;
    const controlMirrors: Partial<Record<'campaign' | 'target', ControlMirrorMergeCounts>> = {};
    const [controlSchema] = await this.handle.sql<{ ready: boolean }[]>`
      select to_regprocedure('app.guard_campaign_control_observation()') is not null as ready`;
    if (controlSchema?.ready && options.readStartedAt === undefined) {
      throw new Error('control mirror requires the provider read-start time');
    }
    const excluded = new Set(options.excludedEntityTypes ?? []);
    if (excluded.size > 0 && adProduct === undefined) {
      throw new Error('Excluded entity kinds require an ad-product scope');
    }
    if (entities.some((entity) => excluded.has(entity.entityType))) {
      throw new Error('Entity listing contains an excluded kind');
    }
    for (const entity of entities) {
      if (entity.profileId !== profile.id) {
        throw new Error(`entity ${entity.amazonId} belongs to profile ${entity.profileId}, expected ${profile.id}`);
      }
    }
    const now = new Date();
    let upserted = 0;
    let tombstoned = 0;
    let duplicates = 0;
    const changes: NewEntityChange[] = [];
    const entityTypes = ['portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative'] as const;

    for (const entityType of entityTypes) {
      if (excluded.has(entityType)) {
        if (adProduct === 'SB' && entityType === 'keyword'
          && !this.reportedDisabledSbKeywords.has(profile.id)) {
          const [stored] = await this.handle.sql<{ present: boolean }[]>`
            select exists (
              select 1 from public.keywords
               where org_id = ${profile.orgId} and profile_id = ${profile.id}
                 and ad_product = 'SB' and deleted_at is null
            ) as present
          `;
          if (stored?.present) {
            this.logger.info('SB keywords are present but sync is disabled', { profileId: profile.id });
            this.reportedDisabledSbKeywords.add(profile.id);
          }
        }
        continue;
      }
      // Collapse before diffing or writing. The negatives mirror merges three
      // Amazon endpoints into one `(profile_id, amazon_id)` key, so a listing
      // can legitimately carry the same id twice — and Postgres refuses to let
      // one `ON CONFLICT DO UPDATE` touch a row a second time. Last wins,
      // deterministically by listing order, and the collision is counted rather
      // than hidden: `listed` still means rows Amazon sent.
      const collapsed = collapseByAmazonId(entities.filter((entity) => entity.entityType === entityType));
      const incoming = collapsed.rows;
      if (collapsed.duplicateIds.length > 0) {
        duplicates += collapsed.duplicateIds.length;
        this.logger.info('entity listing carried duplicate amazon ids', {
          profileId: profile.id,
          entityType,
          duplicates: collapsed.duplicateIds.length,
          ids: collapsed.duplicateIds.slice(0, MAX_LOGGED_DUPLICATE_IDS),
        });
      }
      if ((entityType === 'campaign' || entityType === 'target') && controlSchema?.ready) {
        const scope = { orgId: profile.orgId, profileId: profile.id,
          ...(adProduct === undefined ? {} : { adProduct }), full, readStartedAt: options.readStartedAt! };
        const counts = await mergeControlMirror(this.handle, entityType === 'campaign'
          ? { ...scope, entityType, rows: incoming.filter(isType('campaign')) }
          : { ...scope, entityType, rows: incoming.filter(isType('target')) });
        controlMirrors[entityType] = counts;
        upserted += counts.upserted;
        tombstoned += counts.tombstoned;
        continue;
      }
      if (entityType === 'keyword' && keywordCapability) {
        keywordMirror = await keywordCapability.merge({ orgId: profile.orgId, profileId: profile.id,
          ...(adProduct === undefined ? {} : { adProduct }), full, readStartedAt: options.readStartedAt!,
          rows: incoming.filter(isType('keyword')) });
        upserted += keywordMirror.upserted;
        tombstoned += keywordMirror.tombstoned;
        continue;
      }
      const allExisting = await this.existingEntities(profile.id, entityType);
      const priorById = new Map(allExisting.map((row) => [row.amazonId, row]));
      for (const row of incoming) {
        const prior = priorById.get(row.amazonId);
        if (prior && prior.snapshot['adProduct'] !== row.adProduct) throw new Error('entity mirror product identity changed');
        if (prior && row.entityType === 'negative' && (prior.snapshot['keywordText'] == null) !== (row.keywordText === null)) throw new Error('negative mirror identity kind changed');
      }
      const existing = adProduct ? allExisting.filter((row) => row.snapshot['adProduct'] === adProduct) : allExisting;
      const byId = new Map(existing.map((row) => [row.amazonId, row]));
      const seen = new Set<string>();

      for (const entity of incoming) {
        seen.add(entity.amazonId);
        const prior = byId.get(entity.amazonId);
        const nextSnapshot = entitySnapshot(entity);
        if (!prior) {
          changes.push(change(profile, entity, 'entity', null, nextSnapshot));
        } else {
          for (const [field, value] of Object.entries(nextSnapshot)) {
            const oldValue = prior.snapshot[field];
            if (!isDeepStrictEqual(oldValue, value)) {
              changes.push(change(profile, entity, field, oldValue ?? null, value ?? null));
            }
          }
          if (prior.deletedAt) {
            changes.push(change(profile, entity, 'deletedAt', asDate(prior.deletedAt).toISOString(), null));
          }
        }
      }

      const missing = full ? existing.filter((row) => !row.deletedAt && !seen.has(row.amazonId) && !(options.preserveCampaignNegativeTargets && entityType === 'negative' && row.snapshot['scope'] === 'campaign' && row.snapshot['keywordText'] == null)) : [];
      tombstoned += missing.length;
      if (missing.length > 0) {
        const ids = missing.map((row) => row.amazonId);
        await this.markDeleted(profile.id, entityType, ids, now);
        for (const row of missing) {
          changes.push({
            orgId: profile.orgId,
            profileId: profile.id,
            entityType,
            amazonId: row.amazonId,
            entityName: typeof row.snapshot['name'] === 'string' ? row.snapshot['name'] : null,
            field: 'deletedAt',
            oldValue: null,
            newValue: now.toISOString(),
            source: 'sync',
          });
        }
      }

      upserted += await this.upsertType(profile, entityType, incoming, now);
    }

    const writtenChanges = await recordEntityChanges(this.handle, changes);
    // If a prior pass persisted the change ledger but failed during evidence
    // attribution, the mirror already contains the new value and a retry will
    // produce no fresh diff. Reconcile every pass so that failure is recoverable.
    await reconcileEntityChangeLinks(this.handle, {
      orgId: profile.orgId,
      profileId: profile.id,
    });
    // Program rule 4: every listed row is accounted for, as a write or as a
    // collision with a row that was written.
    if (entities.length !== upserted + duplicates) {
      throw new Error(
        `entity sync listed ${entities.length} rows but upserted ${upserted} (${duplicates} duplicates)`,
      );
    }
    return { listed: entities.length, upserted, duplicates, changes: writtenChanges + (keywordMirror?.changes ?? 0)
        + Object.values(controlMirrors).reduce((sum, counts) => sum + counts.changes, 0), tombstoned,
      ...(keywordMirror === undefined ? {} : { keywordMirror }),
      ...(Object.keys(controlMirrors).length === 0 ? {} : { controlMirrors }) };
  }

  async ensureReportRequest(
    jobId: string,
    payload: Extract<JobPayload, { type: 'report.request' }>,
  ): Promise<ReportRequestState> {
    await this.handle.db.insert(reportRequests).values({
      id: jobId,
      orgId: payload.orgId,
      profileId: payload.profileId,
      reportType: payload.reportType,
      startDate: payload.startDate,
      endDate: payload.endDate,
      creativeSyncSnapshotId: payload.creativeSyncSnapshotId ?? null,
      familyConfiguration: payload.familyConfiguration ?? null,
    }).onConflictDoNothing();
    return this.getReportRequest(jobId, payload.orgId, payload.profileId);
  }

  async setReportCreated(input: {
    reportRequestId: string;
    orgId: string;
    profileId: string;
    amazonReportId: string;
    nextPollAt: Date;
    claim: ClaimRef | null;
  }): Promise<boolean> {
    const rows = input.claim === null
      ? await this.handle.sql<{ id: string }[]>`
          update public.report_requests
             set amazon_report_id = ${input.amazonReportId},
                 status = 'pending',
                 next_poll_at = ${iso(input.nextPollAt)}
           where id = ${input.reportRequestId}
             and org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and (amazon_report_id is null or amazon_report_id = ${input.amazonReportId})
          returning id
        `
      : await this.handle.sql<{ id: string }[]>`
          with custody as materialized (
            select j.id
              from public.sync_jobs as j
             where j.id = ${input.claim.jobId}
               and j.org_id = ${input.orgId}
               and j.profile_id = ${input.profileId}
               and j.status = 'running'
               and j.claimed_by = ${input.claim.workerId}
               and j.claim_token = ${input.claim.token}::uuid
             for update
          )
          update public.report_requests as r
             set amazon_report_id = ${input.amazonReportId},
                 status = 'pending',
                 next_poll_at = ${iso(input.nextPollAt)}
           where r.id = ${input.reportRequestId}
             and r.org_id = ${input.orgId}
             and r.profile_id = ${input.profileId}
             and (r.amazon_report_id is null or r.amazon_report_id = ${input.amazonReportId})
             and exists (select 1 from custody where custody.id = r.id)
          returning r.id
        `;
    if (rows.length > 1) throw new Error('report create persistence updated multiple rows');
    return rows.length === 1;
  }

  async confirmReportCreated(input: {
    reportRequestId: string;
    orgId: string;
    profileId: string;
    amazonReportId: string;
    claim: ClaimRef | null;
  }): Promise<boolean> {
    const rows = input.claim === null
      ? await this.handle.sql<{ id: string }[]>`
          select id
            from public.report_requests
           where id = ${input.reportRequestId}
             and org_id = ${input.orgId}
             and profile_id = ${input.profileId}
             and amazon_report_id = ${input.amazonReportId}
        `
      : await this.handle.sql<{ id: string }[]>`
          select r.id
            from public.report_requests as r
            join public.sync_jobs as j
              on j.id = r.id
             and j.org_id = r.org_id
             and j.profile_id = r.profile_id
           where r.id = ${input.reportRequestId}
             and r.org_id = ${input.orgId}
             and r.profile_id = ${input.profileId}
             and r.amazon_report_id = ${input.amazonReportId}
             and j.status = 'running'
             and j.claimed_by = ${input.claim.workerId}
             and j.claim_token = ${input.claim.token}::uuid
           for share of j
        `;
    if (rows.length > 1) throw new Error('report create readback returned multiple rows');
    return rows.length === 1;
  }

  async getReportRequest(
    reportRequestId: string,
    orgId: string,
    profileId: string,
  ): Promise<ReportRequestState> {
    const rows = await this.handle.sql<{
      id: string;
      org_id: string;
      profile_id: string;
      report_type: WorkerReportLedger['reportType'];
      start_date: string;
      end_date: string;
      source: string;
      amazon_report_id: string | null;
      requested_at: Date | string;
      poll_attempts: number;
      creative_sync_snapshot_id: string | null;
      family_configuration: CoreReportConfiguration | null;
    }[]>`
      select id, org_id, profile_id, report_type, start_date::text, end_date::text,
             source, amazon_report_id, requested_at, poll_attempts,
             creative_sync_snapshot_id, family_configuration
        from public.report_requests
       where id = ${reportRequestId}
         and org_id = ${orgId}
         and profile_id = ${profileId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`report request ${reportRequestId} does not exist`);
    return {
      id: row.id,
      orgId: row.org_id,
      profileId: row.profile_id,
      reportType: row.report_type,
      startDate: row.start_date,
      endDate: row.end_date,
      source: row.source,
      amazonReportId: row.amazon_report_id,
      requestedAt: asDate(row.requested_at),
      pollAttempts: Number(row.poll_attempts),
      creativeSyncSnapshotId: row.creative_sync_snapshot_id,
      familyConfiguration: row.family_configuration,
    };
  }

  async updateReportPoll(
    reportRequestId: string,
    values: {
      status: 'pending' | 'processing' | 'failed' | 'cancelled' | 'expired';
      nextPollAt?: Date | null;
      error?: string | null;
      downloadUrl?: string | null;
      downloadExpiresAt?: Date | null;
    },
  ): Promise<void> {
    await this.handle.sql`
      update public.report_requests
         set status = ${values.status}::public.report_status,
             poll_attempts = poll_attempts + 1,
             last_polled_at = now(),
             next_poll_at = ${iso(values.nextPollAt)},
             error = ${values.error ?? null},
             download_url = coalesce(${values.downloadUrl ?? null}, download_url),
             download_expires_at = coalesce(${iso(values.downloadExpiresAt)}::timestamptz, download_expires_at)
       where id = ${reportRequestId}
    `;
  }

  async enqueue(payload: JobPayload, runAt: Date, dedupeKey: string): Promise<boolean> {
    const rows = await this.handle.sql<{ id: string }[]>`
      insert into public.sync_jobs
        (org_id, profile_id, job_type, payload, run_after, dedupe_key)
      values
        (${payload.orgId}, ${payload.profileId}, ${payload.type}::public.sync_job_type,
         ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}::timestamptz, ${dedupeKey})
      on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
      returning id
    `;
    return rows.length === 1;
  }

  async provisionSchedules(
    orgId: string,
    profileId: string,
    specs: readonly ScheduleSpec[] = defaultSchedules(),
  ): Promise<number> {
    let written = 0;
    for (const spec of specs) {
      const rows = await this.handle.sql<{ id: string }[]>`
        insert into public.sync_schedules
          (org_id, profile_id, job_type, report_type, variant, cadence, lookback_days,
           window_offset_days, payload)
        values
          (${orgId}, ${profileId}, ${spec.jobType}::public.sync_job_type,
           ${spec.reportType}::public.report_type, ${spec.variant},
           ${spec.cadence}::interval, ${spec.lookbackDays}, ${spec.windowOffsetDays},
           ${JSON.stringify(spec.payload)}::jsonb)
        on conflict (profile_id, job_type, report_type, variant) do nothing
        returning id
      `;
      written += rows.length;
    }
    await this.repairOverlongLookbacks(profileId);
    return written;
  }

  async provisionCoreFamilySchedules(orgId: string, profileId: string): Promise<{ offered: number; written: number; existing: number }> {
    const capabilities = await this.handle.sql<{ family: string }[]>`select family from public.report_family_capabilities where org_id=${orgId} and profile_id=${profileId} and enabled=true`;
    const enabled = new Set(capabilities.map((row) => row.family));
    const schedules = coreFamilySchedules().filter((spec) => enabled.has(spec.reportType));
    if (!schedules.length) return { offered: 0, written: 0, existing: 0 };
    let written = 0;
    for (const spec of schedules) {
      const rows = await this.handle.sql`insert into public.sync_schedules (org_id,profile_id,job_type,report_type,variant,cadence,lookback_days,window_offset_days,payload,enabled) values (${orgId},${profileId},'report.request',${spec.reportType}::public.report_type,${spec.variant},${spec.cadence}::interval,${spec.lookbackDays},${spec.windowOffsetDays},${JSON.stringify(spec.payload)}::jsonb,false) on conflict (profile_id,job_type,report_type,variant) do nothing returning id`;
      written += rows.length;
    }
    const persisted = await this.handle.sql<{ report_type: string; variant: string }[]>`select report_type::text,variant from public.sync_schedules where org_id=${orgId} and profile_id=${profileId} and report_type::text=any(${schedules.map((spec) => spec.reportType)}) and variant in ('default','restatement','comparison')`;
    const expected = new Set(schedules.map((spec) => `${spec.reportType}:${spec.variant}`));
    if (persisted.length !== expected.size || persisted.some((row) => !expected.has(`${row.report_type}:${row.variant}`))) throw new Error('family schedule readback mismatch');
    return { offered: schedules.length, written, existing: persisted.length - written };
  }

  /**
   * Clamp any already-provisioned schedule whose window Amazon will not accept.
   *
   * `provisionSchedules` is `do nothing` on conflict, so a profile provisioned
   * before the 35-day restatement bug was found keeps asking for a 34-day span
   * and keeps getting HTTP 400 forever. Only rows that exceed Amazon's hard
   * maximum are touched, so a deliberate operator preference within the legal
   * range is never overwritten.
   *
   * Called with no profile it repairs every one. That is how the periodic
   * passes call it, because the profiles that need repairing are precisely the
   * already-provisioned ones — running it only inside `provisionSchedules`, on
   * the profiles that have no schedules at all, meant it never repaired
   * anything in a deployment that had already provisioned.
   */
  async repairOverlongLookbacks(profileId?: string): Promise<number> {
    const maxLookback = MAX_REPORT_RANGE_DAYS + 1;
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.sync_schedules
         set lookback_days = ${maxLookback}
       where (${profileId ?? null}::uuid is null or profile_id = ${profileId ?? null}::uuid)
         and job_type = 'report.request'
         and lookback_days > ${maxLookback}
      returning id
    `;
    return rows.length;
  }

  /**
   * Reconcile the schedules owned by external integrations.
   *
   * WP-40 may not have landed in a deployment yet, so the relation probe is a
   * real compatibility seam, not error swallowing. Once the table exists, only
   * active connections participate. A connection-level `config.profile_id`
   * selects one valid sync-enabled profile; otherwise the first profile in each
   * org/country (the marketplace key currently present on `ad_profiles`) is used.
   *
   * DataDive owns both the daily rank read and the weekly SQP categorization
   * pass. Revoked/error connections disable schedules already provisioned for
   * them, while a later reactivation enables the same rows again.
   */
  async ensureIntegrationSchedules(): Promise<number> {
    await this.ensureProviderEvidenceSchedules();
    // Other runtimes also reconcile integrations. Only explicit budget composition owns these schedules.
    const budgetSchedules = this.budgetUsageApiEnabled === undefined ? 0
      : await ensureBudgetUsageSchedules(this.handle, this.budgetUsageApiEnabled);
    const [relation] = await this.handle.sql<{ relation: string | null }[]>`
      select to_regclass('public.integration_connections')::text as relation
    `;
    if (!relation?.relation) return budgetSchedules;

    const ownSources = this.ownCollectorsEnabled ? this.handle.sql`
        union select p.org_id,p.id,'own_bids.collect'::public.sync_job_type,interval '1 day','{}'::jsonb from public.ad_profiles p where p.sync_enabled
        union select s.org_id,s.profile_id,'own_listings.collect'::public.sync_job_type,interval '1 day','{}'::jsonb from selected_profiles s where s.provider='keepa'
        union select r.org_id,r.profile_id,(case when r.family='prompts' then 'prompts.collect' else 'own_listings.collect' end)::public.sync_job_type,interval '1 day','{}'::jsonb
          from public.collector_export_references r join public.ad_profiles p on p.org_id=r.org_id and p.id=r.profile_id
          where r.enabled and p.sync_enabled and r.marketplace=p.country_code` : this.handle.sql``;
    const [result] = await this.handle.sql<{ changed: string }[]>`
      with active_connections as (
        select c.org_id, c.provider::text as provider, c.config
          from public.integration_connections c
         where c.status::text = 'active'
      ),
      default_profiles as (
        select distinct on (p.org_id, p.country_code)
               p.org_id, p.country_code, p.id as profile_id
          from public.ad_profiles p
         where p.sync_enabled
         order by p.org_id, p.country_code, p.created_at, p.id
      ),
      selected_profiles as (
        select c.org_id, c.provider, p.profile_id
          from active_connections c
          join default_profiles p on p.org_id = c.org_id
         where nullif(btrim(c.config ->> 'profile_id'), '') is null
        union
        select c.org_id, c.provider, p.id as profile_id
          from active_connections c
          join public.ad_profiles p
            on p.org_id = c.org_id
           and p.sync_enabled
           and p.id::text = nullif(btrim(c.config ->> 'profile_id'), '')
      ),
      expected as (
        select distinct s.org_id, s.profile_id,
               m.job_type::public.sync_job_type as job_type,
               m.cadence::interval as cadence,
               m.payload
          from selected_profiles s
          join (values
            ('keepa',   'keepa.sync',       '1 day',  '{"includeCompetitors":true}'::jsonb),
            ('datadive','rank.sync',        '1 day',  '{}'::jsonb),
            ('mrp',     'economics.sync',   '1 day',  '{}'::jsonb)
          ) as m(provider, job_type, cadence, payload)
            on m.provider = s.provider
        ${ownSources}
      ),
      disabled as (
        update public.sync_schedules schedule
           set enabled = false
         where schedule.variant = 'integration'
           and schedule.job_type::text in (
             'keepa.sync', 'rank.sync', 'economics.sync', 'sqp.categorize', 'own_bids.collect', 'own_listings.collect', 'prompts.collect'
           )
           and schedule.enabled
           and not exists (
             select 1 from expected e
              where e.profile_id = schedule.profile_id
                and e.job_type = schedule.job_type
           )
        returning schedule.id
      ),
      upserted as (
        insert into public.sync_schedules
          (org_id, profile_id, job_type, variant, cadence, payload, enabled)
        select e.org_id, e.profile_id, e.job_type, 'integration', e.cadence, e.payload, true
          from expected e
        on conflict (profile_id, job_type, report_type, variant) do update
          set cadence = excluded.cadence,
              payload = excluded.payload,
              enabled = true
        where sync_schedules.cadence is distinct from excluded.cadence
           or sync_schedules.payload is distinct from excluded.payload
           or not sync_schedules.enabled
        returning id
      )
      select ((select count(*) from disabled) + (select count(*) from upserted))::text as changed
    `;
    const spapi = await provisionSpApiReportJobs(this.handle);
    return budgetSchedules + Number(result?.changed ?? 0) + spapi.enqueued + spapi.disabledScopes;
  }

  private async ensureProviderEvidenceSchedules(): Promise<void> {
    if (process.env['OPENSPELL_PROVIDER_EVIDENCE_SCHEDULE_OWNER'] !== '1') return;
    const [relation] = await this.handle.sql<{ relation: string | null }[]>`select to_regclass('public.provider_evidence_configs')::text as relation`;
    if (!relation?.relation) return;
    const enabled = process.env['OPENSPELL_PROVIDER_EVIDENCE_ENABLED'] === '1';
    const rows = await this.handle.sql<{ config: unknown; enabled: boolean }[]>`select config,enabled from public.provider_evidence_configs`;
    const keep: string[] = [];
    for (const row of rows) {
      const config = ProviderCollectionConfig.parse(row.config);
      const spec = providerEvidenceSchedule(config, enabled && row.enabled);
      if (!spec) continue;
      keep.push(spec.variant);
      const written = await this.handle.sql`insert into public.sync_schedules(org_id,profile_id,job_type,report_type,variant,cadence,payload,enabled)
        values(${config.scope.orgId},${config.scope.profileId},'provider.evidence.collect',null,${spec.variant},${spec.cadence}::interval,${JSON.stringify(spec.payload)}::jsonb,true)
        on conflict(profile_id,job_type,report_type,variant) do update set cadence=excluded.cadence,payload=excluded.payload,enabled=true returning id`;
      if (written.length !== 1) throw new Error('Provider collection schedule count mismatch');
    }
    await this.handle.sql`update public.sync_schedules set enabled=false where job_type='provider.evidence.collect' and enabled and not (variant=any(${keep}))`;
    const verified = await this.handle.sql<{ variant: string }[]>`select variant from public.sync_schedules where job_type='provider.evidence.collect' and enabled`;
    if (verified.length !== keep.length || verified.some((row) => !keep.includes(row.variant))) throw new Error('Provider collection schedule readback mismatch');
  }

  async unscheduledProfiles(): Promise<{ orgId: string; profileId: string }[]> {
    const rows = await this.handle.sql<{ org_id: string; id: string }[]>`
      select p.org_id, p.id
        from public.ad_profiles p
       where p.sync_enabled
         and not exists (select 1 from public.sync_schedules s where s.profile_id = p.id)
    `;
    return rows.map((row) => ({ orgId: row.org_id, profileId: row.id }));
  }

  async ensureReportPartitions(
    reportType: ReportType,
    startDate: string,
    endDate: string,
  ): Promise<ReportPartitionCounts> {
    const expectedMonths = monthRange(startDate, endDate);
    const actions = await ensureFactPartitions(this.handle, expectedMonths[0] as string, expectedMonths.length - 1);
    const table = reportFactTable(reportType);
    const matched = actions.filter((action) => action.tableName === table);
    const matchedMonths = new Set(matched.map((action) => action.month));
    if (
      matched.length !== expectedMonths.length ||
      expectedMonths.some((month) => !matchedMonths.has(month))
    ) {
      throw new Error(
        `${reportType} partition preparation expected ${expectedMonths.length} months, matched ${matched.length}`,
      );
    }
    return {
      expectedMonths: expectedMonths.length,
      matchedMonths: matched.length,
      createdMonths: matched.filter((action) => action.created).length,
    };
  }

  promoteReportDate(input: StagedReportDate): Promise<ReportDatePromotionResult> {
    return promoteDbReportDate(this.handle, input);
  }

  async failReport(reportRequestId: string, error: string): Promise<void> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.report_requests
         set status = 'failed'::public.report_status,
             completed_at = now(), next_poll_at = null, error = ${error}
       where id = ${reportRequestId}
       returning id
    `;
    if (rows.length !== 1) throw new Error(`failed report update matched ${rows.length} rows`);
  }

  async failTerminalReport(scope: {
    reportRequestId: string;
    orgId: string;
    profileId: string;
  }, error: string): Promise<boolean> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.report_requests
         set status = 'failed'::public.report_status,
             completed_at = now(),
             next_poll_at = null,
             error = ${error}
       where id = ${scope.reportRequestId}
         and org_id = ${scope.orgId}
         and profile_id = ${scope.profileId}
         and status in ('pending'::public.report_status, 'processing'::public.report_status)
      returning id
    `;
    if (rows.length > 1) {
      throw new Error(`terminal report update matched ${rows.length} rows`);
    }
    return rows.length === 1;
  }

  async loadFacts(batch: ParsedFactBatch): Promise<number> {
    switch (batch.kind) {
      case 'sp_target': return (await upsertSpTargetFacts(this.handle, batch.rows)).written;
      case 'search_term': return (await upsertSearchTermFacts(this.handle, batch.rows)).written;
      case 'placement': return (await upsertPlacementFacts(this.handle, batch.rows)).written;
      case 'profile': return (await upsertProfileFacts(this.handle, batch.rows)).written;
      case 'sb': return this.upsertCampaignFacts('sb', batch.rows);
      case 'sd': return this.upsertCampaignFacts('sd', batch.rows);
    }
  }

  async recordCoverage(observation: ReportCoverageObservation, verifiedLoadedRows: number) {
    if (observation.reportType === 'campaign_budget_usage') {
      return publishBudgetUsageCoverage(this.handle, observation, verifiedLoadedRows);
    }
    return upsertReportCoverage(this.handle, observation, verifiedLoadedRows);
  }

  async completeReport(
    reportRequestId: string,
    counts: { parsed: number; loaded: number; bytesDownloaded: number; coverage?: ReportCoverageAccounting | null },
  ): Promise<void> {
    await this.handle.sql.begin(async (sql) => {
      const rows = await sql<{ id: string }[]>`
        update public.report_requests
           set status = ${counts.parsed === counts.loaded ? 'completed' : 'failed'}::public.report_status,
               completed_at = now(), next_poll_at = null,
               rows_parsed = ${counts.parsed}, rows_loaded = ${counts.loaded},
               bytes_downloaded = ${counts.bytesDownloaded},
               error = ${counts.parsed === counts.loaded ? null : `parsed ${counts.parsed}, loaded ${counts.loaded}`}
         where id = ${reportRequestId}
         returning id
      `;
      if (rows.length !== 1) throw new Error(`complete report update matched ${rows.length} rows`);
      if (counts.parsed === counts.loaded && counts.coverage !== null) {
        await recordReportCoverage({ sql }, reportRequestId, counts.coverage);
      }
    });
    if (counts.parsed !== counts.loaded) throw new ParsedLoadedMismatch(counts.parsed, counts.loaded);
  }

  async coreReportCapability(orgId: string, profileId: string, family: CoreFeatureReportType): Promise<CoreReportCapability | null> {
    return readCoreReportCapability(this.handle, orgId, profileId, family);
  }

  async finishAttributedReport(
    reportRequestId: string,
    input: AttributedReportCounts,
    options: { status: 'completed' | 'failed'; bytesDownloaded: number; error?: string | null; coverage?: ReportCoverageAccounting; promotion?: CoreReportPromotion },
  ): Promise<void> {
    const counts = WorkerReportAccounting.parse(input);
    let superseded = false;
    const finish = async (sql: QueryHandle['sql']) => {
      const promoted = options.promotion ? await promoteCoreReportWindow({ sql }, options.promotion) : null;
      superseded = promoted?.superseded === true;
      if (superseded) {
        counts.promotedRows = 0;
        counts.canonicalRows = 0;
        counts.unpromotedRows = counts.parsedRows;
      }
      if (promoted && promoted.loadedRows !== counts.canonicalRows) throw new Error('report family completion readback mismatch');
      const rows = await sql<{ id: string; accounting_complete: boolean }[]>`
        update public.report_requests
           set status = ${superseded ? 'failed' : options.status}::public.report_status,
               completed_at = now(), next_poll_at = null,
               source_rows = ${counts.sourceRows},
               rows_parsed = ${counts.parsedRows},
               refused_rows = ${counts.refusedRows},
               promoted_rows = ${counts.promotedRows},
               unpromoted_rows = ${counts.unpromotedRows},
               rows_loaded = ${counts.canonicalRows},
               bytes_downloaded = ${options.bytesDownloaded},
               error = ${superseded ? 'report family superseded by newer facts' : options.error ?? null}
         where id = ${reportRequestId}
         returning id, accounting_complete
      `;
      if (rows.length !== 1) {
        throw new Error(`attributed report completion matched ${rows.length} rows`);
      }
      if (rows[0]?.accounting_complete !== true) {
        throw new Error('attributed report durable accounting did not reconcile');
      }
      if (!superseded && options.status === 'completed' && options.coverage !== undefined) {
        if (options.promotion && promoted) {
          const p = options.promotion;
          await upsertReportCoverage({ sql }, {
            orgId: p.orgId, profileId: p.profileId, reportType: p.parsed.configuration.family,
            grain: coreReportGrain(p.parsed.configuration), source: 'amazon_reporting_v3', status: 'complete',
            earliestDate: p.startDate, coveredThrough: p.endDate, settledThrough: null,
            observedAt: promoted.observedAt, sourceRows: counts.sourceRows, parsedRows: counts.parsedRows,
            loadedRows: promoted.loadedRows, refusedRows: counts.refusedRows, countsMatch: true,
          }, promoted.loadedRows);
        } else await recordReportCoverage({ sql }, reportRequestId, options.coverage);
      }
    };
    // Existing callers retain ledger-only completion; the ingestion hook supplies coverage.
    if (options.coverage === undefined && options.promotion === undefined) await finish(this.handle.sql);
    else await this.handle.sql.begin(finish);
    if (superseded) throw new PermanentJobError('report family superseded by newer facts');
  }

  private async upsertCampaignFacts(kind: 'sb' | 'sd', rows: readonly CampaignFactRow[]): Promise<number> {
    let written = 0;
    for (const row of rows) {
      const result = kind === 'sb'
        ? await this.handle.db.insert(factSbDaily).values(row).onConflictDoUpdate({
            target: [factSbDaily.profileId, factSbDaily.date, factSbDaily.campaignId, factSbDaily.adGroupId],
            set: campaignFactSet(row),
          }).returning({ profileId: factSbDaily.profileId })
        : await this.handle.db.insert(factSdDaily).values(row).onConflictDoUpdate({
            target: [factSdDaily.profileId, factSdDaily.date, factSdDaily.campaignId, factSdDaily.adGroupId],
            set: campaignFactSet(row),
          }).returning({ profileId: factSdDaily.profileId });
      written += result.length;
    }
    return written;
  }

  private async existingEntities(
    profileId: string,
    entityType: EntityRow['entityType'],
    adProduct?: 'SP' | 'SB' | 'SD',
  ): Promise<ExistingEntity[]> {
    const table = tableName(entityType);
    const product = adProduct ? ` and ad_product = '${adProduct}'` : '';
    const rows = await this.handle.sql.unsafe<ExistingEntity[]>(
      `select amazon_id as "amazonId", deleted_at as "deletedAt", to_jsonb(t) - array['id','org_id','profile_id','first_seen_at','synced_at','deleted_at']::text[] as snapshot from public.${table} t where profile_id = $1${product}`,
      [profileId],
    );
    return rows.map((row) => ({ ...row, snapshot: normalizeDbSnapshot(row.snapshot) }));
  }

  private async markDeleted(
    profileId: string,
    entityType: EntityRow['entityType'],
    amazonIds: readonly string[],
    at: Date,
  ): Promise<void> {
    await this.handle.sql.unsafe(
      `update public.${tableName(entityType)} set deleted_at = $1, synced_at = $1 where profile_id = $2 and amazon_id = any($3::text[])`,
      [at.toISOString(), profileId, amazonIds],
    );
  }

  private async upsertType(
    profile: AdsProfileContext,
    entityType: EntityRow['entityType'],
    rows: readonly EntityRow[],
    syncedAt: Date,
  ): Promise<number> {
    switch (entityType) {
      case 'portfolio': return (await upsertMirrorRows(this.handle, portfolios, rows.filter(isType('portfolio')).map((row) => ({ ...baseMirror(profile, row, syncedAt), budgetAmount: row.budgetAmount, budgetPolicy: row.budgetPolicy })))).upserted;
      case 'campaign': return (await upsertMirrorRows(this.handle, campaigns, rows.filter(isType('campaign')).map((row) => ({ ...baseMirror(profile, row, syncedAt), portfolioAmazonId: row.portfolioId, budgetAmount: row.budgetAmount, budgetType: row.budgetType, targetingType: row.targetingType, biddingStrategy: row.biddingStrategy, placementBidding: row.placementBidding, startDate: row.startDate, endDate: row.endDate })))).upserted;
      case 'ad_group': return (await upsertMirrorRows(this.handle, adGroups, rows.filter(isType('ad_group')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, defaultBid: row.defaultBid })))).upserted;
      case 'product_ad': return (await upsertMirrorRows(this.handle, productAds, rows.filter(isType('product_ad')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, asin: row.asin, sku: row.sku })))).upserted;
      case 'keyword': return (await upsertMirrorRows(this.handle, keywords, rows.filter(isType('keyword')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, keywordText: row.keywordText, matchType: row.matchType, bid: row.bid })))).upserted;
      case 'target': return (await upsertMirrorRows(this.handle, targets, rows.filter(isType('target')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, expression: row.expression, resolvedExpression: row.resolvedExpression, bid: row.bid })))).upserted;
      case 'negative': return (await upsertMirrorRows(this.handle, negatives, rows.filter(isType('negative')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, scope: row.scope, keywordText: row.keywordText, expression: row.expression, matchType: row.matchType })))).upserted;
    }
  }
}

const REPORT_FACT_TABLE: Readonly<Record<ReportType, string>> = {
  spCampaigns: 'fact_profile_daily',
  spTargeting: 'fact_sp_target_daily',
  spSearchTerm: 'fact_search_term_daily',
  spPlacement: 'fact_placement_daily',
  sbCampaigns: 'fact_sb_daily',
  sdCampaigns: 'fact_sd_daily',
};

function reportFactTable(reportType: ReportType): string {
  return REPORT_FACT_TABLE[reportType];
}

function monthRange(startDate: string, endDate: string): string[] {
  const start = calendarDate(startDate, 'startDate');
  const end = calendarDate(endDate, 'endDate');
  if (start > end) throw new Error('startDate must not be after endDate');
  const months: string[] = [];
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= last) {
    months.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

function calendarDate(value: string, name: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${name} must be YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a real calendar date`);
  }
  return date;
}

/**
 * One row per `amazonId`, last occurrence winning, in first-appearance order.
 *
 * Last wins because the endpoints are listed in a fixed order and the later one
 * is the more specific scope; first-appearance order because a stable output
 * order is what makes the same listing produce the same statement twice.
 */
function collapseByAmazonId(rows: readonly EntityRow[]): { rows: EntityRow[]; duplicateIds: string[] } {
  const byId = new Map<string, EntityRow>();
  const duplicateIds: string[] = [];
  for (const row of rows) {
    if (byId.has(row.amazonId)) duplicateIds.push(row.amazonId);
    byId.set(row.amazonId, row);
  }
  return { rows: [...byId.values()], duplicateIds };
}

function tableName(entityType: EntityRow['entityType']): string {
  return { portfolio: 'portfolios', campaign: 'campaigns', ad_group: 'ad_groups', product_ad: 'product_ads', keyword: 'keywords', target: 'targets', negative: 'negatives' }[entityType];
}

function isType<T extends EntityRow['entityType']>(type: T): (row: EntityRow) => row is Extract<EntityRow, { entityType: T }> {
  return (row): row is Extract<EntityRow, { entityType: T }> => row.entityType === type;
}

function baseMirror(profile: AdsProfileContext, row: EntityRow, syncedAt: Date) {
  return { orgId: profile.orgId, profileId: profile.id, amazonId: row.amazonId, adProduct: row.adProduct, name: row.name, state: row.state, syncedAt, deletedAt: null };
}

function entitySnapshot(entity: EntityRow): Record<string, unknown> {
  const { profileId: _profileId, syncedAt: _syncedAt, entityType: _entityType, ...snapshot } = entity;
  return snapshot;
}

function change(
  profile: AdsProfileContext,
  entity: EntityRow,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): NewEntityChange {
  return { orgId: profile.orgId, profileId: profile.id, entityType: entity.entityType, amazonId: entity.amazonId, entityName: entity.name, field, oldValue, newValue, source: 'sync' };
}

function campaignFactSet(row: CampaignFactRow) {
  return { impressions: row.impressions, clicks: row.clicks, cost: row.cost, purchases7d: row.purchases7d, sales7d: row.sales7d, unitsSold7d: row.unitsSold7d, metrics: row.metrics, reportRequestId: row.reportRequestId, loadedAt: new Date() };
}

function normalizeDbSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const numeric = new Set(['budgetAmount', 'defaultBid', 'bid']);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const contractKey = camel === 'portfolioAmazonId' ? 'portfolioId' : camel;
    result[contractKey] = numeric.has(contractKey) && typeof value === 'string' ? Number(value) : value;
  }
  return result;
}
