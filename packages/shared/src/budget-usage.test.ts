import { describe, expect, it } from 'vitest';
import { BudgetUsage, BudgetUsageConfig, BudgetUsageRunCounts, JobPayload } from './index.js';

describe('budget usage contracts', () => {
  it('leaves both sources off and supplies no doctrine policy', () => {
    const config = BudgetUsageConfig.parse({});
    expect(config.apiEnabled).toBe(false);
    expect(config.streamEnabled).toBe(false);
    expect(config.nearLimitPercent).toBeNull();
    expect(config.maxAgeSeconds).toBeNull();
    expect(config.allowFreshStreamFallback).toBe(false);
  });
  it('accepts zero and over-budget percentages without clipping', () => {
    for (const budgetUsagePercent of [0, 137]) expect(BudgetUsage.parse({ campaignId: 'synthetic', budget: 0, budgetUsagePercent, usageUpdatedTimestamp: '2026-09-15T01:00:00Z' }).budgetUsagePercent).toBe(budgetUsagePercent);
    expect(BudgetUsage.safeParse({ campaignId: 'synthetic', budget: 1, budgetUsagePercent: null, usageUpdatedTimestamp: '2026-09-15T01:00:00Z' }).success).toBe(false);
  });
  it('rejects missing, negative and malformed provider evidence', () => {
    const row = { campaignId: 'synthetic', budget: 2, budgetUsagePercent: 3, usageUpdatedTimestamp: '2026-09-15T01:00:00Z' };
    for (const patch of [{ budget: -1 }, { budgetUsagePercent: -1 }, { usageUpdatedTimestamp: 'not-a-time' }, { budget: Number.NaN }]) expect(BudgetUsage.safeParse({ ...row, ...patch }).success).toBe(false);
  });
  it('refuses lost source or persisted rows', () => {
    const counts = { selected: 3, requested: 3, returned: 2, failed: 1, sourceRows: 3, parsedRows: 2, refusedRows: 1, loadedRows: 2, existingRows: 0, verifiedLoadedRows: 2 };
    expect(BudgetUsageRunCounts.parse(counts)).toEqual(counts);
    for (const patch of [{ verifiedLoadedRows: 1 }, { refusedRows: 0 }, { returned: 1 }, { selected: 4 }]) expect(BudgetUsageRunCounts.safeParse({ ...counts, ...patch }).success).toBe(false);
  });
  it('registers scoped read jobs without report payloads', () => {
    for (const type of ['budget_usage.collect', 'budget_usage.stream']) expect(JobPayload.parse({ type, orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002' }).type).toBe(type);
  });
});
