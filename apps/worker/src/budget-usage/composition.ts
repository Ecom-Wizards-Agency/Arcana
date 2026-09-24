import {
  readBudgetUsageConfig, readBudgetUsageCampaignPage, persistBudgetUsageRun,
  readMarketingStreamBudgetUsage, readBudgetUsageRun, type DbHandle,
} from '@wizard-ads/db';
import type { BudgetUsageCollectorStore } from './collect.js';

export function createBudgetUsageStore(handle: DbHandle): BudgetUsageCollectorStore {
  return {
    config: (scope) => readBudgetUsageConfig(handle, scope),
    replay: (scope, runId) => readBudgetUsageRun(handle, { ...scope, runId }),
    campaigns: (scope, limit, cursor) => readBudgetUsageCampaignPage(handle, { ...scope, limit, cursor }),
    persist: (input) => persistBudgetUsageRun(handle, input),
    stream: (scope) => readMarketingStreamBudgetUsage(handle, { ...scope, fromProviderTime: '1970-01-01T00:00:00.000Z' }),
  };
}
