import { expect, it } from 'vitest';
import type { BrandLensKeyword, BrandLensOverride, QueryVocabularyEntry } from '@wizard-ads/shared';
import { brandBucketPerformance, classifyBrandKeywords } from './model.js';
const id = '11111111-1111-4111-8111-111111111111';
const keyword: BrandLensKeyword = {
  id: 'synthetic-target',
  campaignId: 'synthetic-campaign',
  keyword: 'synthetik component',
  matchType: 'exact',
  spend: 18,
  sales: 0,
  clicks: 9,
  orders: 0
};
const token: QueryVocabularyEntry = {
  orgId: id,
  marketplaceId: 'synthetic-market',
  kind: 'own_brand_alias',
  value: 'synthetik',
  normalizedValue: 'synthetik',
  source: 'operator',
  approved: true,
  reviewedAt: '2026-07-01T00:00:00Z'
};
it('matches an approved misspelling, preserves overrides and repeats deterministically', () => {
  const first = classifyBrandKeywords([keyword], [token], [], 'synthetic-market');
  expect(first[0]).toMatchObject({
    bucket: 'branded',
    matchedOn: 'synthetik (misspelling)',
    acos: null
  });
  expect(classifyBrandKeywords([keyword], [token], [], 'synthetic-market')).toEqual(first);
  const override: BrandLensOverride = {
    orgId: id,
    profileId: id,
    normalizedKeyword: keyword.keyword,
    bucket: 'competitor',
    decision: 'changed',
    decidedBy: id,
    decidedAt: token.reviewedAt!
  };
  expect(classifyBrandKeywords([keyword], [token], [override], 'synthetic-market')[0]?.bucket).toBe('competitor');
});
it('keeps undefined ratios absent while reconciling measured spend', () => {
  const rows = classifyBrandKeywords([keyword, {
    ...keyword,
    id: 'other',
    keyword: 'plain part',
    spend: 12,
    sales: 48
  }], [token], [], 'synthetic-market');
  const buckets = brandBucketPerformance(rows);
  expect(buckets.reduce((n, r) => n + (r.spend ?? 0), 0)).toBe(30);
  expect(buckets[0]).toMatchObject({
    share: 0.6,
    acos: null
  });
  expect(buckets[1]?.spend).toBeNull();
  expect(buckets[2]?.acos).toBe(0.25);
});

it('does not turn partially missing keyword metrics into bucket totals or share',()=>{
 const rows=classifyBrandKeywords([keyword,{...keyword,id:'missing',sales:null,spend:null}], [token], [], 'synthetic-market');
 expect(brandBucketPerformance(rows)[0]).toMatchObject({spend:null,sales:null,share:null,acos:null});
});
