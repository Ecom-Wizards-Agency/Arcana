import type { QueryCategory, QueryVocabularyEntry, SqpWeeklyFact } from '@wizard-ads/shared';
import { classifyQuery } from './classification.js';
import { normalizeQuery } from './normalize.js';
export const QUERY_CHART_GROUPS = [['own_brand', 'Branded', 'your name'], ['competitor', 'Competitor', 'their names'], ['core', 'Generic: core', 'winnable'], ['head', 'Generic: head', 'undifferentiated']] as const;
export const QUERY_RESEARCH_CATEGORIES = ['own_brand', 'core', 'head', 'competitor', 'excluded', 'unreviewed'] as const;
const divide = (a: number, b: number) => b > 0 ? a / b : null;
export function researchQueryRows(facts: readonly SqpWeeklyFact[]) {
  const grouped = new Map<string, SqpWeeklyFact[]>();
  for (const f of facts) {
    const key = f.normalizedQuery;
    grouped.set(key, [...(grouped.get(key) ?? []), f]);
  }
  return [...grouped.entries()].map(([normalizedQuery, rows]) => {
    // Market counts repeat for every ASIN. Keep one market observation per query.
    const max = (field: 'searchQueryVolume' | 'totalImpressions' | 'totalClicks' | 'totalPurchases') => Math.max(...rows.map(r => r[field]));
    const sum = (field: 'asinImpressions' | 'asinClicks' | 'asinPurchases') => rows.reduce((n, r) => n + r[field], 0);
    const categories = new Set(rows.map(r => r.category));
    const category: QueryCategory = categories.size === 1 ? rows[0]!.category : 'unreviewed';
    const impressions = sum('asinImpressions'), clicks = sum('asinClicks'), purchases = sum('asinPurchases');
    const marketImpressions = max('totalImpressions'), marketClicks = max('totalClicks'), marketPurchases = max('totalPurchases');
    const brandCtr = divide(clicks, impressions), marketCtr = divide(marketClicks, marketImpressions), brandCvr = divide(purchases, clicks), marketCvr = divide(marketPurchases, marketClicks);
    return {
      normalizedQuery,
      searchQuery: rows[0]!.searchQuery,
      category,
      searchVolume: max('searchQueryVolume'),
      impressions,
      clicks,
      purchases,
      marketImpressions,
      marketClicks,
      marketPurchases,
      impressionShare: divide(impressions, marketImpressions),
      purchaseShare: divide(purchases, marketPurchases),
      brandCtr,
      marketCtr,
      brandCvr,
      marketCvr,
      ctrGap: brandCtr === null || marketCtr === null ? null : (brandCtr - marketCtr) * 100,
      cvrGap: brandCvr === null || marketCvr === null ? null : (brandCvr - marketCvr) * 100
    };
  });
}
export function researchDemandGroups(facts: readonly SqpWeeklyFact[]) {
  const rows = researchQueryRows(facts);
  return QUERY_CHART_GROUPS.map(([category, label, caption]) => {
    const selected = rows.filter(r => r.category === category);
    const sum = (field: 'searchVolume' | 'impressions' | 'marketImpressions' | 'purchases' | 'marketPurchases') => selected.reduce((n, r) => n + r[field], 0);
    return {
      category,
      label,
      caption,
      searches: sum('searchVolume'),
      impressions: sum('impressions'),
      marketImpressions: sum('marketImpressions'),
      impressionShare: divide(sum('impressions'), sum('marketImpressions')),
      purchases: sum('purchases'),
      marketPurchases: sum('marketPurchases'),
      purchaseShare: divide(sum('purchases'), sum('marketPurchases')),
      example: selected[0]?.searchQuery ?? null
    };
  });
}
export function researchCategoryCounts(facts: readonly SqpWeeklyFact[], ppc: readonly { searchTerm: string }[], vocabulary: readonly QueryVocabularyEntry[], marketplaceId: string) {
  const categories = new Map(researchQueryRows(facts).map(r => [r.normalizedQuery, r.category]));
  for (const row of ppc) {
    const key = normalizeQuery(row.searchTerm);
    if (!categories.has(key)) categories.set(key, classifyQuery({
      searchQuery: row.searchTerm,
      vocabulary,
      marketplaceId
    }).category);
  }
  return QUERY_RESEARCH_CATEGORIES.map(category => ({
    category,
    count: [...categories.values()].filter(c => c === category).length
  }));
}
