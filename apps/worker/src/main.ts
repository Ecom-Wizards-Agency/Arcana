import { registerAssetLibrarySource } from './asset-library.js';
import { registerSpApiReportSources, postgresSpReportDependencies } from './spapi-report-sources.js';
import { registerProviderEvidence, postgresProviderEvidenceDependencies } from "./provider-evidence.js";
import { registerOwnCollectors, postgresOwnCollectors } from './own-collectors/index.js';
import { registerTargetTranslation } from './translation/register.js';
import { registerBudgetUsageSources } from './budget-usage/register.js';
import { createBudgetUsageStore } from './budget-usage/composition.js';
import { createBudgetUsageProvider } from './budget-usage/provider.js';
import { ProviderConnectionLoop } from './provider-connection-loop.js';
import { exchangeSpApiAuthorizationCode, runSpApiConnectionPass } from './spapi-connections.js';
import { registerIntegrationSources } from './integration-sources.js';
import { createKeywordMirrorCapability, createSpWriteWorker } from './sp-write-outbox/composition.js';
import { startSpWritePolling } from './sp-write-outbox/polling.js';
import { spWritePolicyFromEnv } from './sp-write-outbox/policy.js';
import { createDb, loadReportHealth } from '@wizard-ads/db';
import { createAdsApiClientFromEnv } from './ads-api.js';
import { AmazonConnectionLoop } from './amazon-connections.js';
import { createAmazonConnectionProvider, createAmazonConnectionStore } from './amazon-connection-adapters.js';
import { configFromEnv } from './config.js';
import { createCrosscheckIngest } from './crosscheck.js';
import { createDataDiveRankSyncHandler } from './datadive.js';
import { closeServer, startHealthServer } from './health.js';
import { PostgresBidSeriesStore } from './bid-series.js';
import { createKeepaSyncHandler } from './keepa.js';
import { createMarketingStreamSqsConsumer } from './marketing-stream-sqs.js';
import { createMarketingStreamNormalizeHandler } from './marketing-stream-normalize.js';
import { createSpApiSqpRequestHandler } from './spapi-sqp.js';
import { PostgresWeeklySqpScheduler } from './sqp-scheduler.js';
import {
  PostgresRecommendationRunStore,
  createRecommendationsRunner,
} from './recommendations-run.js';
import { RecommendationObservationPass } from './recommendation-observer.js';
import { createReadinessGatedRecommendationSchedules } from './recommendation-schedule-readiness.js';
import { PostgresWorkerStore } from './store.js';
import { WorkerUnifiedDualRun } from './unified-reporting.js';
import { PostgresUnifiedDualRunStore } from './unified-reporting-store.js';
import {
  ObservedSbVideoIngestion,
  PostgresSbVideoIngestionStore,
} from './sb-video-ingestion.js';
import { createMrpEconomicsSync } from './mrp.js';
import {
  terminateAfterFatalWorkerFailure,
  terminateAfterFinalShutdown,
} from './fatal-exit.js';
import {
  AuthHealthMonitor,
  BidSeriesSyncPass,
  QueueSettlementError,
  ScheduleProvisioner,
  shutdownExitCode,
  StaleClaimReaper,
  SyncWorker,
  type WorkerShutdownEvidence,
} from './worker.js';
import type { JobType } from '@wizard-ads/shared';

const AMAZON_JOB_TYPES: ReadonlySet<JobType> = new Set([
  'entity.sync',
  'asset-library.search',
  'report.request',
  'report.poll',
  'report.fetch',
  'report.unified.advance',
  'creative.sync',
]);

const config = configFromEnv();
const reportStaleHours = Number(process.env['WORKER_REPORT_STALE_HOURS'] ?? 6);
if (!Number.isFinite(reportStaleHours) || reportStaleHours <= 0) {
  throw new Error('WORKER_REPORT_STALE_HOURS must be positive');
}
const handle = createDb({ connectionString: config.databaseUrl, max: config.maxConcurrentJobs + 2 });
const store = new PostgresWorkerStore(handle, undefined, {
  claimProtocol: config.claimProtocol,
  ownCollectorsEnabled: config.ownCollectorsEnabled,
  ...((config.jobTypes === undefined || config.jobTypes.includes('budget_usage.collect'))
    ? { budgetUsageApiEnabled: config.budgetUsageApiEnabled } : {}),
  ...((config.spWrites.dispatchEnabled || config.spWrites.reconcileEnabled)
    ? { keywordMirror: createKeywordMirrorCapability(handle) } : {}),
});
const spWriteLoop = config.startsBackgroundPasses && (config.spWrites.dispatchEnabled || config.spWrites.reconcileEnabled)
  ? createSpWriteWorker(store, { claimantId: `${config.workerId}:sp-writes`, policy: () => spWritePolicyFromEnv(process.env) })
  : undefined;
const marketingStream = config.startsBackgroundPasses && config.marketingStreamQueueUrl
  ? createMarketingStreamSqsConsumer({
      handle,
      queueUrl: config.marketingStreamQueueUrl,
      scheduler: {
        enqueue: ({ orgId, profileId, messageIds, runAt, dedupeKey }) => store.enqueue({
          type: 'marketing_stream.normalize',
          orgId,
          profileId,
          messageIds: [...messageIds],
        }, runAt, dedupeKey),
      },
    })
  : undefined;
// Integration-only deployments do not read ADS_* at boot. Amazon wiring exists
// only when this runtime's claim policy includes an Amazon job type (or all).
const runsAmazonJobs = config.jobTypes === undefined
  || config.jobTypes.some((jobType) => AMAZON_JOB_TYPES.has(jobType));
// One client instance serves both the queue worker and bid-corridor sync.
const adsApi = runsAmazonJobs ? createAdsApiClientFromEnv(handle) : undefined;
const amazonConnections = config.amazonConnectionsEnabled
  ? new AmazonConnectionLoop(createAmazonConnectionStore(handle), createAmazonConnectionProvider(handle))
  : undefined;
const { spApiClientSecret: clientSecret } = config;
const spApiConnections = config.spApiConnectionsEnabled
  ? new ProviderConnectionLoop((signal) => runSpApiConnectionPass({
      handle,
      enabled: () => process.env['OPENSPELL_SPAPI_CONNECTIONS_ENABLED'] === '1',
      accepts: (installation) => installation.clientId === config.spApiClientId
        && installation.applicationId === config.spApiApplicationId && installation.region === config.spApiConsentRegion
        && config.spApiConnectionRedirects.includes(installation.redirectUri),
      exchange: (installation, code, signal) => exchangeSpApiAuthorizationCode(installation, code, signal,
        config.spApiClientId && clientSecret ? { clientId: config.spApiClientId, clientSecret } : undefined),
    }, signal))
  : undefined;
const unifiedReporting = adsApi && config.unifiedReporting.enabled
  ? new WorkerUnifiedDualRun({
      policy: config.unifiedReporting,
      store: new PostgresUnifiedDualRunStore(handle),
      provider: adsApi,
    })
  : undefined;
const recommendationRuns = new PostgresRecommendationRunStore(handle);
const gatedRecommendationSchedules = createReadinessGatedRecommendationSchedules(
  handle,
  recommendationRuns,
);
const sbVideo = adsApi
  ? new ObservedSbVideoIngestion(
      adsApi,
      new PostgresSbVideoIngestionStore(handle, store),
    )
  : undefined;
const runsSqpJobs = config.jobTypes === undefined || config.jobTypes.includes('sqp.request');
const sqpRequest = runsSqpJobs && config.spApiClientId && config.spApiClientSecret
  ? createSpApiSqpRequestHandler({
      handle,
      lwaClientId: config.spApiClientId,
      lwaClientSecret: config.spApiClientSecret,
      minimumProviderIntervalMs: config.spApiReportMinIntervalMs,
    })
  : undefined;
const sqpSchedules = sqpRequest
  ? new PostgresWeeklySqpScheduler(handle, store)
  : undefined;
const budgetUsageStore = createBudgetUsageStore(handle);
const integrations = {
    economicsSync: createMrpEconomicsSync(handle),
    rankSync: createDataDiveRankSyncHandler({ handle }),
    keepaSync: createKeepaSyncHandler(handle, { ownListingsEnabled: config.ownCollectorsEnabled }),
    ...(sqpRequest === undefined ? {} : { sqpRequest }),
    marketingStreamNormalize: createMarketingStreamNormalizeHandler({ handle, queue: store,
      ...(config.budgetUsageStreamEnabled ? { onBudgetNormalized: async (scope: { orgId: string; profileId: string }, observedAt: Date) => {
        const settings = await budgetUsageStore.config(scope);
        if (!settings.streamEnabled) return;
        await store.enqueue({ ...scope, type: 'budget_usage.stream' }, observedAt,
          ['budget-usage', 'stream', scope.profileId, observedAt.toISOString()].join(':'));
      } } : {}),
    }),
  };
const worker = new SyncWorker({
  coreReportingEnabled: process.env['OPENSPELL_CORE_REPORTING_ENABLED'] === '1',
  workerId: config.workerId,
  store,
  adsApi,
  jobTypes: config.jobTypes,
  crosscheckIngest: createCrosscheckIngest(handle, { inboxDir: config.crosscheckInboxDir }),
  recommendationsRun: createRecommendationsRunner(recommendationRuns),
  sbVideo,
  unifiedReporting,
  integrations: { marketingStreamNormalize: integrations.marketingStreamNormalize },
  sources: (registry) => {
    if (adsApi) registerAssetLibrarySource(registry, handle, adsApi);
    registerIntegrationSources(registry, integrations);
    const { spApiClientId, spApiClientSecret: lwaKey } = config;
    if (spApiClientId && lwaKey) registerSpApiReportSources(registry, postgresSpReportDependencies({ handle, clientId: spApiClientId, clientSecret: lwaKey }));
    registerOwnCollectors(registry, postgresOwnCollectors(handle, config.ownCollectorDropRoot, config.ownCollectorsEnabled));
    registerTargetTranslation(registry, handle);
    registerProviderEvidence(registry, postgresProviderEvidenceDependencies(handle));
    registerBudgetUsageSources(registry, { store: budgetUsageStore, provider: createBudgetUsageProvider(handle),
      apiEnabled: config.budgetUsageApiEnabled, streamEnabled: config.budgetUsageStreamEnabled });
  },
  claimBatchSize: config.claimBatchSize,
  maxConcurrentJobs: config.maxConcurrentJobs,
  pollIntervalMs: config.pollIntervalMs,
});
const spWritePolling = spWriteLoop ? startSpWritePolling(spWriteLoop, config.pollIntervalMs) : undefined;
marketingStream?.start();
amazonConnections?.start();
spApiConnections?.start();
const health = await startHealthServer(worker, config.port, {
  reports: () => loadReportHealth(handle, reportStaleHours),
  deployment: {
    revision: config.revision,
    role: config.deploymentRole,
    claimProtocol: config.claimProtocol,
    jobTypes: config.jobTypes ?? 'all',
  },
  marketingStream,
  amazonConnections,
}, config.healthHost);
const authHealth = config.startsBackgroundPasses && adsApi
  ? new AuthHealthMonitor(worker, config.authHealthcheckIntervalMs)
  : undefined;
const reaper = config.startsBackgroundPasses
  ? new StaleClaimReaper(store, config.staleClaimAfter)
  : undefined;
const provisioner = config.startsBackgroundPasses
  ? new ScheduleProvisioner(
      store,
      undefined,
      undefined,
      gatedRecommendationSchedules,
      sqpSchedules,
    )
  : undefined;
const bidSeries = config.startsBackgroundPasses && adsApi
  ? new BidSeriesSyncPass({ store: new PostgresBidSeriesStore(handle), client: adsApi })
  : undefined;
const recommendationObserver = config.startsBackgroundPasses
  ? new RecommendationObservationPass(handle, console)
  : undefined;
authHealth?.start();
reaper?.start();
provisioner?.start();
bidSeries?.start();
recommendationObserver?.start();

const CUSTODY_EXIT_CODE = 78;
let shutdownPromise: Promise<WorkerShutdownEvidence> | null = null;

function shutdown(): Promise<WorkerShutdownEvidence> {
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<WorkerShutdownEvidence> {
  authHealth?.stop();
  reaper?.stop();
  provisioner?.stop();
  bidSeries?.stop();
  recommendationObserver?.stop();
  await spWritePolling?.stop();
  await marketingStream?.stop();
  await amazonConnections?.stop();
  await spApiConnections?.stop();
  const evidence = await worker.shutdown();
  await closeServer(health);
  await handle.close();
  return evidence;
}

async function shutdownForSignal(): Promise<void> {
  let evidence: WorkerShutdownEvidence = { released: 0, unresolved: 1 };
  let evidenceAvailable = false;
  try {
    evidence = await shutdown();
    evidenceAvailable = true;
  } catch {
    console.error('report worker shutdown evidence unavailable');
  }
  const settlementFailure = worker.status().settlementFailure;
  const exitCode = evidenceAvailable
    ? shutdownExitCode(evidence, settlementFailure)
    : CUSTODY_EXIT_CODE;
  await terminateAfterFinalShutdown({
    trigger: 'signal',
    exitCode,
    evidence,
    settlementFailure,
    evidenceAvailable,
  });
}

process.once('SIGTERM', () => void shutdownForSignal());
process.once('SIGINT', () => void shutdownForSignal());

try {
  await worker.start();
} catch (error) {
  const failureKind = error instanceof QueueSettlementError ? error.kind : 'unexpected';
  await terminateAfterFatalWorkerFailure({
    failureKind,
    custodyFailure: error instanceof QueueSettlementError,
    shutdown,
    logger: console,
  });
}
