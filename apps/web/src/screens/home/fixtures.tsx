import { computePacing, computePortfolioPacing, selectBudgetUsage, type FlagContext } from '@wizard-ads/core';
import { BudgetUsageConfig, type BudgetUsageEvidence, type BudgetUsageObservation } from '@wizard-ads/shared';
import { kpiTiles } from '../../optimizer/view';
import { ready as cockpit } from '../cockpit/render-fixture';
import type { HomeReady } from './view';

const days = Array.from({ length: 14 }, (_, index) => ({
  date: `2026-06-${String(index + 1).padStart(2, '0')}`, impressions: 800 + index * 20,
  clicks: 40 + index, spend: 70 + index * 3, sales: 240 + index * 8, orders: 8 + index,
}));
const flagWindow = { start: '2026-06-07', end: '2026-06-14' };
const flag = {
  severity: 'warn' as const, metric: 'sales', threshold: 'Synthetic rule', message: 'Sales declined in the comparison window.',
  likelyCause: 'Fewer orders from discovery campaigns.', scope: 'Sample campaign', category: 'discovery', suppressed: false, suppressedReason: null,
};
export const flagContexts: { active: FlagContext[]; suppressed: FlagContext[] } = {
  active: [
    { family: 'zero_sales_spend', campaignId: '301', evidence: { impressions: 4200, days: 8, window: flagWindow, source: 'rows' },
      flag: { ...flag, severity: 'alert', metric: 'orders', threshold: '>= $20 trailing-7 avg spend with 0 orders',
        message: '~$24.00/day trailing-7 avg spend with 0 orders (report day spend $26.00).', likelyCause: 'Zero orders despite real spend over the trailing week.' } },
    { family: 'spend_spike', campaignId: '302', evidence: { impressions: 3100, days: 8, window: flagWindow, source: 'rows' },
      flag: { ...flag, scope: 'Second campaign', metric: 'spend', threshold: '>= +60% vs trailing-7 avg',
        message: 'Spend +90% vs trailing-7 avg ($38.00 vs $20.00 avg).', likelyCause: 'Spend spike: check for an intentional change first.' } },
    { family: 'zero_sales_spend', campaignId: '303', evidence: { impressions: 900, days: 7, window: flagWindow, source: 'rows' },
      flag: { ...flag, scope: 'Third campaign', metric: 'orders', threshold: '>= $20 trailing-7 avg spend with 0 orders',
        message: '~$21.00/day trailing-7 avg spend with 0 orders (report day spend $22.00).', likelyCause: 'Zero orders despite real spend over the trailing week.' } },
    { family: 'discovery_share', campaignId: null, evidence: { impressions: 15000, days: 8, window: flagWindow, source: 'rows' },
      flag: { ...flag, scope: 'account', metric: 'discovery_share_of_spend', threshold: '> 20% of total spend',
        message: "Discovery campaigns are 31% of today's spend (target ~20% or less).", likelyCause: 'Discovery bloat.' } },
  ],
  suppressed: [
    { family: 'acos_swing', campaignId: '304', evidence: { impressions: 2800, days: 8, window: flagWindow, source: 'rows' },
      flag: { ...flag, severity: 'info', scope: 'Rank campaign', metric: 'acos', suppressed: true,
        suppressedReason: 'Insufficient settled evidence for this finding.' } },
  ],
};
export const withoutBudget: HomeReady = {
  ...cockpit.props, slot1: <></>, slot2: <div id="operating-status">Operating status</div>, slot3: <></>,
  currentWindow: { start: '2026-06-01', end: '2026-06-14' },
  settled: { current: { start: '2026-06-01', end: '2026-06-14' }, comparison: { start: '2026-05-18', end: '2026-05-31' }, settling: { start: '2026-06-15', end: '2026-06-28' } },
  cockpitDays: days,
  tiles: kpiTiles({ impressions: 15000, clicks: 760, spend: 1253, sales: 4088, orders: 203, units: 203 },
    { impressions: 14000, clicks: 710, spend: 1170, sales: 4310, orders: 219, units: 219 }),
  pacing: null,
  home: {
    tiles: kpiTiles({ impressions: 15000, clicks: 760, spend: 1253, sales: 4088, orders: 203, units: 203 },
      { impressions: 14000, clicks: 710, spend: 1170, sales: 4310, orders: 219, units: 219 }),
    breakEvenAcos: null, comparison: { start: '2026-05-18', end: '2026-05-31' },
    pacing: null, canDecide: true, proposalsCapped: false,
    budgetUsage: { availability: 'disabled', campaigns: [], measuredCampaigns: 0, totalCampaigns: 0 }, portfolioPacing: [],
    proposals: [
      { id: '11111111-1111-4111-8111-111111111111', entityLabel: 'Sample keyword', scope: 'Sample campaign', field: 'bid', currentValue: '0.70', proposedValue: '0.75', reason: 'Review bid efficiency' },
      { id: '22222222-2222-4222-8222-222222222222', entityLabel: 'Second keyword', scope: 'Sample campaign', field: 'bid', currentValue: '0.80', proposedValue: '0.72', reason: 'Review bid efficiency' },
    ],
    events: [
      { id: 'event-one', date: '2026-06-14', kind: 'competitor_deal', title: 'Tracked competitor started a deal', body: 'A deal was observed for a tracked product.', source: 'keepa' },
      { id: 'event-two', date: '2026-06-13', kind: 'analysis', title: 'Weekly analysis published', body: 'Discovery campaigns received fewer clicks.', source: 'headless_analyst' },
    ],
    ranks: [{ asin: 'B0TEST0001', keyword: 'sample keyword', currentRank: 12, previousRank: 16, movement: 4, spend: null, currentDate: '2026-06-14', previousDate: '2026-06-07' }],
    market: [], flags: { ...flagContexts, flooredCount: 2 }, preferenceKey: 'synthetic-user',
    weekStart: '2026-06-08', weekEnd: '2026-06-14',
  },
};
const pacing = computePacing(days, '2026-06-14', 3000)!;
export const withBudget: HomeReady = { ...withoutBudget, pacing, home: { ...withoutBudget.home, pacing,
  market: [{ ourAsin: 'B0TEST0001', competitorAsin: 'B0TEST0002', category: 'Sample category', ourRank: 240, competitorRank: 210, gap: 30, observedOn: '2026-06-14' }],
} };

export const budgetObservation: BudgetUsageObservation = {
  orgId: '11111111-1111-4111-8111-111111111111', profileId: withoutBudget.profile.id,
  adProduct: 'SP', campaignId: '101', source: 'amazon_ads_api', sourceIdentity: 'fixture-api-observation',
  currency: 'USD', budgetAmount: 20, budgetType: 'daily', period: { start: '2026-06-14', end: '2026-06-14' },
  usagePercent: 95, providerUpdatedAt: '2026-06-14T12:00:00Z', receivedAt: '2026-06-14T12:01:00Z', completeness: 'complete',
};
export const budgetEvidence: BudgetUsageEvidence = {
  orgId: budgetObservation.orgId, profileId: budgetObservation.profileId, totalCampaigns: 1,
  config: BudgetUsageConfig.parse({ apiEnabled: true, maxAgeSeconds: 3600, nearLimitPercent: 90 }),
  campaigns: [{ adProduct: 'SP', campaignId: '101', campaignName: 'Sample budget campaign', currency: 'USD', budgetType: 'daily', startDate: null, endDate: null }],
  observations: [budgetObservation], sources: [{ source: 'amazon_ads_api', enabled: true, complete: true, requested: 1, failed: 0 }],
};
export const withBudgetUsage: HomeReady = { ...withBudget, home: { ...withBudget.home,
  budgetUsage: selectBudgetUsage(budgetEvidence, '2026-06-14T12:01:00Z'),
  portfolioPacing: [computePortfolioPacing({ portfolioId: '201', name: 'Sample portfolio', currency: 'USD', budgetAmount: 300,
    budgetPolicy: 'monthlyRecurring', period: { start: '2026-06-01', end: '2026-06-30' }, asOf: '2026-06-14', memberCampaigns: 2,
    expectedCampaignDays: 28, observedCampaignDays: 28, unassignedCampaigns: 1, spend: 90, oldestLoadedAt: '2026-06-14T12:00:00Z', membershipComplete: true })],
} };
