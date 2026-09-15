import type { BrandLensData } from './view';
import { profile } from '../synthetic-render-fixtures';
const id = '11111111-1111-4111-8111-111111111111';
export const brandReady = {
  view: 'ready',
  profile: {
    ...profile,
    id
  },
  period: {
    start: '2026-06-01',
    end: '2026-06-07'
  },
  source: {
    profile: {
      id,
      marketplaceId: 'synthetic-market',
      countryCode: 'US',
      timezone: 'UTC',
      currencyCode: 'USD'
    },
    vocabulary: [{
      id,
      orgId: id,
      marketplaceId: 'synthetic-market',
      kind: 'own_brand_alias',
      value: 'synthetik',
      normalizedValue: 'synthetik',
      source: 'ai_suggestion',
      approved: true,
      reviewedAt: '2026-06-01T00:00:00Z'
    }],
    keywords: [{
      id: 'synthetic-keyword-one',
      campaignId: 'synthetic-campaign-one',
      keyword: 'synthetik component',
      matchType: 'exact',
      spend: 18,
      sales: 0,
      clicks: 9,
      orders: 0
    }, {
      id: 'synthetic-keyword-two',
      campaignId: 'synthetic-campaign-two',
      keyword: 'plain component',
      matchType: 'phrase',
      spend: 15,
      sales: 54,
      clicks: 6,
      orders: 2
    }],
    overrides: [],
    campaigns: [{
      id: 'synthetic-campaign-one',
      name: 'Synthetic campaign one',
      groupId: id,
      groupRole: 'shield',
      excluded: false
    }, {
      id: 'synthetic-campaign-two',
      name: 'Synthetic campaign two',
      groupId: null,
      groupRole: null,
      excluded: false
    }]
  }
} satisfies BrandLensData;
