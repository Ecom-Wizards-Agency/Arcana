import { IsoDate } from '@wizard-ads/shared';
import type { IngestionRegistry } from '../ingestion-registry.js';
import { ingestionSource } from '../ingestion-sources.js';
import { collectBudgetUsage, type BudgetUsageCollectorStore } from './collect.js';
import type { BudgetUsageProvider } from './provider.js';
import { PermanentJobError } from '../permanent-job-error.js';

/** Ordered precedence matches the reader; neither registration enables a source. */
export function registerBudgetUsageSources(registry: Pick<IngestionRegistry, 'register'>, input: {
  store: BudgetUsageCollectorStore; provider: BudgetUsageProvider;
  apiEnabled: boolean; streamEnabled: boolean; now?: () => Date;
}): void {
  for (const adapter of [
    { jobType: 'budget_usage.collect', source: 'amazon_ads_api', enabled: input.apiEnabled },
    { jobType: 'budget_usage.stream', source: 'amazon_marketing_stream', enabled: input.streamEnabled },
  ] as const) {
    registry.register({
      source: { ...ingestionSource(adapter.jobType), jobType: adapter.jobType },
      plan: (context) => {
        if (context.payload.orgId !== context.job.orgId || context.payload.profileId !== context.job.profileId) {
          throw new PermanentJobError('Budget usage payload scope mismatch');
        }
        return context;
      },
      execute: (context) => collectBudgetUsage({
        scope: { orgId: context.job.orgId, profileId: context.job.profileId }, profile: context.profile,
        runId: context.job.id, source: adapter.source, enabled: adapter.enabled, store: input.store, provider: input.provider,
        ...(input.now ? { now: input.now } : {}),
      }),
      counts: (result) => result,
      coverage: { target: (result) => ({ reportType: 'campaign_budget_usage', grain: 'campaign_budget_usage',
        earliestDate: IsoDate.parse(result.earliestDate), coveredThrough: IsoDate.parse(result.coveredThrough),
        observedAt: result.observedAt, sourceRunId: result.sourceRunId, settledThrough: null, status: result.status,
      }) },
    });
  }
}
