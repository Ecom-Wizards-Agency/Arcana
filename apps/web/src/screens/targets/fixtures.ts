import type { Target360Model } from './model';
import type { QueuedBidChange } from '@wizard-ads/shared';
import { targetBidChecks } from '@wizard-ads/core';
export const targetFixture: Target360Model = {
  currencyCode: 'USD',
  profileId: '00000000-0000-4000-8000-000000000001',
  payload: {
    target: { targetId: 'synthetic', targeting: 'Synthetic keyword', matchType: 'phrase', adProduct: 'SP', targetKind: 'keyword', campaignId: 'synthetic-campaign', campaignName: 'Synthetic campaign' },
    totals: { impressions: 100, clicks: 10, spend: 20, sales: 100, orders: 2, units: 2 }, window: { from: '2026-08-01', to: '2026-08-13' },
    points: Array.from({ length: 13 }, (_, i) => ({ date: `2026-08-${String(i+1).padStart(2,'0')}`, low: i < 3 ? 4 : 6, median: i < 3 ? 5.85 : 8.4, high: 11, bid: 5, cpc: 2 + i/10, maxCpc: 10, components: [{ name: 'Top of search', pct: 100 },{name:'Rest of search',pct:0},{name:'Product pages',pct:0}] })),
  },
  ranks: [{ date: '2026-08-13', asin: 'SYNTHETIC1', organicRank: 1, sponsoredRank: 3 }],
  performance: Array.from({ length:13 },(_,i) => ({ date:`2026-08-${String(i+1).padStart(2,'0')}`, impressions:100,clicks:10,spend:20+i,sales:100,orders:2,acos:(20+i)/100,cpc:(20+i)/10,topOfSearchShare:null })),
  changes: [{ id:'1',date:'2026-08-01',field:'bid',oldValue:'4',newValue:'5',source:'sync' }],
  shelf: [],
  graph: { status: 'missing', rows: [], unresolvedCount: 0 },
  bidContext: { profileId:'00000000-0000-4000-8000-000000000001',profileLabel:'Synthetic profile',targetId:'synthetic',targetLabel:'Synthetic keyword',campaignId:'synthetic-campaign',campaignLabel:'Synthetic campaign',oldBid:{amount:'5',currencyCode:'USD'},readAt:'2026-08-13T12:00:00.000000Z',
    organicRank:1,protectionRank:2,suggestedLow:4,suggestedMedian:8.4,suggestedHigh:11,maxIncrease:1,maxDecrease:0.5,bidFloor:1,bidCeiling:12,campaignBudget:100,targetAcos:0.3,placementModifiers:{topOfSearch:100,restOfSearch:0,productPages:0},
    settingSource:'Synthetic sourced settings' },
};
export const queueFixture: QueuedBidChange = {
  id:'00000000-0000-4000-8000-000000000002',orgId:'00000000-0000-4000-8000-000000000003',createdBy:'00000000-0000-4000-8000-000000000004',createdAt:'2026-08-13T12:00:00Z',
  context:targetFixture.bidContext!,request:{requestId:'00000000-0000-4000-8000-000000000002',profileId:targetFixture.profileId,targetId:'synthetic',expectedBid:{amount:'5',currencyCode:'USD'},expectedReadAt:'2026-08-13T12:00:00.000000Z',newBid:{amount:'8.4',currencyCode:'USD'},overrideReason:null},
  checks:targetBidChecks(targetFixture.bidContext!,8.4,null),approvedAt:null,approvedBy:null,
};
