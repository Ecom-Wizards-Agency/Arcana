import { readFileSync } from 'node:fs';
import { JobType } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';
import { defaultSchedules } from './schedules.js';
import { INGESTION_SOURCES } from './ingestion-sources.js';

const source = (name: string): string => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('runtime job coverage', () => {
  it('accounts for every declared type in dispatch and production composition', () => {
    // These are production bindings, not injectable test-only handlers.
    const bindings = {
      'asset-library.search': 'registerAssetLibrarySource(',
      'retail.report.request': 'registerSpApiReportSources(',
      'aba.report.request': 'registerSpApiReportSources(',
      'catalogue.report.request': 'registerSpApiReportSources(',
      'provider.evidence.collect': 'registerProviderEvidence(',
      'own_bids.collect': 'registerOwnCollectors(',
      'own_listings.collect': 'registerOwnCollectors(',
      'prompts.collect': 'registerOwnCollectors(',
      'translation.request': 'registerTargetTranslation(',
      'entity.sync': 'adsApi,',
      'report.request': 'adsApi,',
      'report.poll': 'adsApi,',
      'report.fetch': 'adsApi,',
      'crosscheck.ingest': 'crosscheckIngest: createCrosscheckIngest(',
      'recommendations.run': 'recommendationsRun: createRecommendationsRunner(',
      'keepa.sync': 'keepaSync: createKeepaSyncHandler(',
      'rank.sync': 'rankSync: createDataDiveRankSyncHandler(',
      'economics.sync': 'economicsSync: createMrpEconomicsSync(',
      'creative.sync': 'new ObservedSbVideoIngestion(',
      'sqp.request': 'createSpApiSqpRequestHandler({',
      'marketing_stream.normalize': 'marketingStreamNormalize: createMarketingStreamNormalizeHandler(',
      'report.unified.advance': 'new WorkerUnifiedDualRun({',
      'sqp.categorize': null,
      'history.bootstrap': null,
      'report.promote': null,
    } satisfies Record<JobType, string | null>;
    expect(Object.keys(bindings).sort()).toEqual([...JobType.options].sort());
    const main = source('./main.ts');
    const sources = new Map(INGESTION_SOURCES.map((entry) => [entry.jobType, entry]));
    expect(sources.size).toBe(JobType.options.length);
    for (const type of JobType.options) {
      expect(sources.has(type)).toBe(true);
      const binding = bindings[type];
      if (binding !== null) expect(main).toContain(binding);
    }
    expect(INGESTION_SOURCES.filter((entry) => entry.source === 'unimplemented').map((entry) => entry.jobType).sort())
      .toEqual(['history.bootstrap', 'report.promote', 'sqp.categorize']);
    expect(defaultSchedules().filter(({ jobType }) => bindings[jobType] === null)).toEqual([]);
  });

  it('keeps the documented SQP consumer and producer reachable on the general worker', () => {
    const config = configFromEnv({
      DATABASE_URL: 'postgres://postgres:postgres@127.0.0.1:5538/postgres',
      WORKER_DEPLOYMENT_ROLE: 'general',
      WORKER_JOB_TYPES: 'keepa.sync,rank.sync,economics.sync,sqp.request',
      SP_API_LWA_CLIENT_ID: 'synthetic-client',
      SP_API_LWA_CLIENT_SECRET: 'synthetic-secret',
    });
    expect(config.startsBackgroundPasses).toBe(true);
    expect(config.jobTypes).toContain('sqp.request');
    const main = source('./main.ts');
    expect(main).toContain("config.jobTypes === undefined || config.jobTypes.includes('sqp.request')");
    expect(main).toContain('runsSqpJobs && config.spApiClientId && config.spApiClientSecret');
    expect(main).toMatch(/const sqpSchedules = sqpRequest\s*\? new PostgresWeeklySqpScheduler/);
    expect(main).toMatch(/const provisioner = config.startsBackgroundPasses\s*\? new ScheduleProvisioner\([\s\S]*?sqpSchedules,/);
    expect(source('./worker.ts')).toContain('await this.sqpSchedules?.enqueueDueSqpRequests()');
  });
});
