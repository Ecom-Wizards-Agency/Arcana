import type { OptimizerCampaignRow } from '../../optimizer/campaigns';
import { ready as base } from './render-fixture';

export const chooserRows: OptimizerCampaignRow[] = [1, 2].map((index) => ({
  campaignId: `synthetic-campaign-${index}`, name: `Synthetic campaign ${index}`, adProduct: 'SP', state: 'enabled', dailyBudget: null, biddingStrategy: 'fixed', startDate: null,
  groupId: '55555555-5555-4555-8555-555555555555', groupName: 'Synthetic review group', groupRole: 'profit', currentRows: 0, impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, comparisonRows: 0, comparisonSpend: 0,
  eligibilityReason: null, lastRunAt: null, proposals: 0, selectable: true,
  oneTimeSettings: { targetAcos: 0.37, bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41 },
}));
export const chooserReady = { ...base, props: { ...base.props, campaignRows: chooserRows, mayRunOptimizer: true } };
