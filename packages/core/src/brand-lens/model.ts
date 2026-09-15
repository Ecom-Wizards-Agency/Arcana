import type { BrandLensBucket, BrandLensKeyword, BrandLensOverride, QueryVocabularyEntry } from '@wizard-ads/shared';
import { classifyQuery } from '../query-intelligence/classification.js';
import { normalizeQuery } from '../query-intelligence/normalize.js';
export const BRAND_BUCKETS = ['branded', 'competitor', 'generic'] as const;
const bucketFor = (category: string): BrandLensBucket => category === 'own_brand' ? 'branded' : category === 'competitor' ? 'competitor' : 'generic';
export function classifyBrandKeywords(keywords: readonly BrandLensKeyword[], vocabulary: readonly QueryVocabularyEntry[], overrides: readonly BrandLensOverride[], marketplaceId: string) {
  const byKeyword = new Map(overrides.map(o => [o.normalizedKeyword, o]));
  return keywords.map(keyword => {
    const classification = classifyQuery({
      searchQuery: keyword.keyword,
      vocabulary,
      marketplaceId
    });
    const override = byKeyword.get(normalizeQuery(keyword.keyword));
    const proposed = bucketFor(classification.category);
    return {
      ...keyword,
      proposed,
      bucket: override?.bucket ?? proposed,
      decision: override?.decision ?? null,
      matchedOn: classification.matchedEntries.map(entry => `${entry.value}${entry.kind === 'own_brand_alias' ? ' (misspelling)' : entry.kind === 'core_term' ? ' → core' : ''}`).join(', ') || 'no token matched',
      category: classification.category,
      requiresReview: classification.requiresHumanApproval,
      acos: keyword.spend === null || keyword.sales === null || keyword.sales === 0 ? null : keyword.spend / keyword.sales
    };
  });
}
export type BrandClassifiedKeyword = ReturnType<typeof classifyBrandKeywords>[number];
export function brandBucketPerformance(rows: readonly BrandClassifiedKeyword[]) {
  const total = rows.length && rows.every(r => r.spend !== null) ? rows.reduce((n, r) => n + r.spend!, 0) : null;
  return BRAND_BUCKETS.map(bucket => {
    const included = rows.filter(r => r.bucket === bucket);
    const sum = (field: 'spend' | 'sales' | 'clicks') => included.length && included.every(r => r[field] !== null) ? included.reduce((n, r) => n + r[field]!, 0) : null;
    const spend = sum('spend'), sales = sum('sales'), clicks = sum('clicks');
    return {
      bucket,
      spend,
      sales,
      clicks,
      share: spend !== null && total !== null && total > 0 ? spend / total : null,
      acos: spend !== null && sales !== null && sales > 0 ? spend / sales : null,
      cpc: spend !== null && clicks !== null && clicks > 0 ? spend / clicks : null
    };
  });
}
export function dominantBrandBucket(rows: readonly BrandClassifiedKeyword[], campaignId: string): BrandLensBucket | null {
  const buckets = brandBucketPerformance(rows.filter(r => r.campaignId === campaignId)).filter(b => b.spend !== null && b.spend > 0).sort((a, b) => b.spend! - a.spend!);
  return !buckets.length || buckets[0]!.spend === buckets[1]?.spend ? null : buckets[0]!.bucket;
}
