import { describe, expect, it } from 'vitest';
import { BudgetUsageConfig, type BudgetUsageEvidence, type BudgetUsageObservation, type PortfolioSpendEvidence } from '@wizard-ads/shared';
import { campaignRemainingBudget, computePortfolioPacing, selectBudgetUsage } from './budget-usage.js';

const now = '2026-06-15T12:00:00Z';
const observation: BudgetUsageObservation = { orgId: 'org-a', profileId: 'profile-a', adProduct: 'SP', campaignId: '1',
  source: 'amazon_ads_api', sourceIdentity: 'sample', currency: 'USD', budgetAmount: 20, budgetType: 'daily',
  period: { start: '2026-06-15', end: '2026-06-15' }, usagePercent: 95, providerUpdatedAt: now, receivedAt: now, completeness: 'complete' };
const evidence = (): BudgetUsageEvidence => ({ orgId: 'org-a', profileId: 'profile-a', totalCampaigns: 1, config: BudgetUsageConfig.parse({ apiEnabled: true, maxAgeSeconds: 3600, nearLimitPercent: 90 }),
  campaigns: [{ adProduct: 'SP', campaignId: '1', campaignName: 'Sample', currency: 'USD', budgetType: 'daily', startDate: null, endDate: null }],
  observations: [observation], sources: [{ source: 'amazon_ads_api', enabled: true, complete: true, requested: 1, failed: 0 },
    { source: 'amazon_marketing_stream', enabled: false, complete: true, requested: 1, failed: 0 }] });

describe('budget usage selection', () => {
  it('keeps disabled and missing observations distinct from measured zero', () => {
    const input = evidence();
    input.config.apiEnabled = false;
    expect(selectBudgetUsage(input, now)).toMatchObject({ availability: 'disabled', measuredCampaigns: 0 });
    expect(selectBudgetUsage(input, now).campaigns[0]?.observation).toBeNull();
    input.config.apiEnabled = true;
    input.observations = [];
    expect(selectBudgetUsage(input, now).availability).toBe('unavailable');
    input.observations = [{ ...observation, usagePercent: 0 }];
    expect(selectBudgetUsage(input, now).campaigns[0]).toMatchObject({ availability: 'measured', nearLimit: false, remainingAmount: 20 });
  });
  it('classifies a fresh measured observation using only the supplied tenant policy', () => {
    expect(selectBudgetUsage(evidence(), now).campaigns[0]).toMatchObject({ nearLimit: true, observation: { source: 'amazon_ads_api', providerUpdatedAt: now } });
    const input = evidence(); input.config.nearLimitPercent = null;
    expect(selectBudgetUsage(input, now).campaigns[0]).toMatchObject({ availability: 'measured', nearLimit: null });
    input.config.maxAgeSeconds = null;
    expect(selectBudgetUsage(input, now).campaigns[0]?.availability).toBe('unavailable');
  });
  it('keeps a newly received old provider observation stale and ignores late older arrivals', () => {
    const input = evidence(); input.observations = [{ ...observation, providerUpdatedAt: '2026-06-14T12:00:00Z' }];
    expect(selectBudgetUsage(input, now).campaigns[0]).toMatchObject({ availability: 'stale', nearLimit: null });
    input.observations.push(observation);
    expect(selectBudgetUsage(input, now).campaigns[0]?.observation?.providerUpdatedAt).toBe(now);
  });
  it('requires separate Stream enablement and fallback permission, and prefers fresh API', () => {
    const input = evidence();
    const stream = { ...observation, source: 'amazon_marketing_stream' as const, usagePercent: 30, budgetAmount: null };
    input.observations.push(stream); input.sources[1]!.enabled = true;
    input.config.streamEnabled = true; input.config.allowFreshStreamFallback = true;
    expect(selectBudgetUsage(input, now).campaigns[0]?.observation?.source).toBe('amazon_ads_api');
    input.observations[0] = { ...observation, providerUpdatedAt: '2026-06-14T12:00:00Z' };
    expect(selectBudgetUsage(input, now).campaigns[0]).toMatchObject({ availability: 'measured', remainingAmount: null, observation: { source: 'amazon_marketing_stream' } });
    input.config.allowFreshStreamFallback = false;
    expect(selectBudgetUsage(input, now).campaigns[0]?.availability).toBe('stale');
    input.config.allowFreshStreamFallback = true; input.config.streamEnabled = false;
    expect(selectBudgetUsage(input, now).campaigns[0]?.availability).toBe('stale');
  });
  it('never turns a failed campaign into zero and retains partial source coverage', () => {
    const input = evidence(); input.totalCampaigns = 2; input.campaigns.push({ ...input.campaigns[0]!, campaignId: '2' });
    input.sources[0] = { source: 'amazon_ads_api', enabled: true, complete: false, requested: 2, failed: 1 };
    const result = selectBudgetUsage(input, now);
    expect(result).toMatchObject({ availability: 'partial', measuredCampaigns: 1, totalCampaigns: 2 });
    expect(result.campaigns[1]).toMatchObject({ availability: 'unavailable', observation: null, remainingAmount: null });
  });
  it('excludes identical campaign identities from other tenants, profiles and products', () => {
    const input = evidence(); input.observations = [{ ...observation, orgId: 'org-b' }, { ...observation, profileId: 'profile-b' }, { ...observation, adProduct: 'SB' }];
    expect(selectBudgetUsage(input, now).measuredCampaigns).toBe(0);
  });
  it('does not sum successive snapshots or combine sources', () => {
    const input = evidence(); input.observations.push({ ...observation, providerUpdatedAt: '2026-06-15T11:55:00Z', usagePercent: 80 });
    expect(selectBudgetUsage(input, now).campaigns[0]?.observation?.usagePercent).toBe(95);
  });
  it('does not classify future provider timestamps as current', () => {
    const input = evidence(); input.observations = [{ ...observation, providerUpdatedAt: '2026-06-16T12:00:00Z' }];
    expect(selectBudgetUsage(input, now).campaigns[0]).toMatchObject({ availability: 'stale', nearLimit: null });
  });
  it('retains the full population denominator when the reader reaches its configured cap', () => {
    const input = evidence(); input.totalCampaigns = 20;
    expect(selectBudgetUsage(input, now)).toMatchObject({ availability: 'partial', measuredCampaigns: 1, totalCampaigns: 20 });
  });
  it('reports an entirely failed run as partial while leaving every campaign usage unavailable', () => {
    const input = evidence(); input.observations = [];
    input.sources[0] = { source: 'amazon_ads_api', enabled: true, complete: false, requested: 1, failed: 1 };
    expect(selectBudgetUsage(input, now)).toMatchObject({ availability: 'partial', measuredCampaigns: 0, campaigns: [{ availability: 'unavailable', observation: null }] });
  });
  it('preserves zero and over-budget amounts but refuses incompatible money', () => {
    expect(campaignRemainingBudget({ ...observation, budgetAmount: 0, usagePercent: 0 })).toBe(0);
    expect(campaignRemainingBudget({ ...observation, budgetAmount: 0, usagePercent: 125 })).toBe(0);
    expect(campaignRemainingBudget({ ...observation, usagePercent: 125 })).toBe(-5);
    expect(campaignRemainingBudget({ ...observation, period: null })).toBeNull();
    expect(campaignRemainingBudget({ ...observation, currency: null })).toBeNull();
  });
});

const portfolio: PortfolioSpendEvidence = { portfolioId: '10', name: 'Portfolio A', currency: 'USD', budgetAmount: 300,
  budgetPolicy: 'monthlyRecurring', period: { start: '2026-06-01', end: '2026-06-30' }, asOf: '2026-06-15', memberCampaigns: 2,
  expectedCampaignDays: 30, observedCampaignDays: 30, unassignedCampaigns: 1, spend: 90, oldestLoadedAt: now, membershipComplete: true };
describe('portfolio interval pacing', () => {
  it('uses each portfolio allocation and spend, independent of campaign usage or unequal daily budgets', () => {
    expect(computePortfolioPacing(portfolio)).toMatchObject({ availability: 'measured', budgetToDate: 150, pace: 0.6, remainingAmount: 210 });
    expect(computePortfolioPacing({ ...portfolio, portfolioId: '11', budgetAmount: 600, spend: 210 })).toMatchObject({ budgetToDate: 300, pace: 0.7, remainingAmount: 390 });
  });
  it('withholds pace and remaining allocation for incomplete spend or membership', () => {
    for (const change of [{ observedCampaignDays: 29 }, { membershipComplete: false }, { oldestLoadedAt: null }]) {
      expect(computePortfolioPacing({ ...portfolio, ...change })).toMatchObject({ availability: 'partial', pace: null, remainingAmount: null });
    }
  });
  it('does not invent periods, currency, spend, members or budgets', () => {
    for (const change of [{ period: null }, { currency: null }, { spend: null }, { memberCampaigns: 0 }, { budgetAmount: null }]) {
      expect(computePortfolioPacing({ ...portfolio, ...change })).toMatchObject({ availability: 'unavailable', pace: null, remainingAmount: null });
    }
  });
  it('preserves overspend and avoids dividing by a zero allocation', () => {
    expect(computePortfolioPacing({ ...portfolio, spend: 400 }).remainingAmount).toBe(-100);
    expect(computePortfolioPacing({ ...portfolio, budgetAmount: 0 })).toMatchObject({ pace: null, remainingAmount: -90 });
  });
});
