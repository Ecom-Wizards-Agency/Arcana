import type { QueryHandle } from '@wizard-ads/db';
import { describe, expect, it } from 'vitest';
import { loadQueryIntelligenceSource } from './data';

const PROFILE = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';
const SCOPE = {
  orgId: ORG,
  profileId: PROFILE,
  marketplaceId: 'marketplace-1',
  weekStart: '2026-08-16',
  weekEnd: '2026-08-22',
};

/** One fact_sqp_weekly row as postgres returns it: numeric columns arrive as strings. */
function factRow(overrides: Record<string, string | null> = {}): Record<string, unknown> {
  return {
    profile_id: PROFILE,
    marketplace_id: 'marketplace-1',
    asin: 'B000000001',
    week_start: '2026-08-16',
    week_end: '2026-08-22',
    search_query: 'Synthetic Quiet Query',
    normalized_query: 'synthetic quiet query',
    category: 'core',
    search_query_score: null,
    search_volume: '40',
    total_impressions: '50',
    asin_impressions: '5',
    impression_share: '0.100000',
    total_clicks: '4',
    asin_clicks: '1',
    click_share: '0.250000',
    total_cart_adds: '0',
    asin_cart_adds: '0',
    asin_cart_add_share: null,
    total_purchases: '0',
    asin_purchases: '0',
    purchase_share: null,
    ...overrides,
  };
}

function handle(facts: Record<string, unknown>[]): QueryHandle {
  const sql = async (strings: TemplateStringsArray) => {
    const statement = strings.join(' ');
    return statement.includes('from public.fact_sqp_weekly') ? facts : [];
  };
  return { sql } as unknown as QueryHandle;
}

describe('Queries SQP reader', () => {
  it('keeps a null share null and converts present values unchanged', async () => {
    const source = await loadQueryIntelligenceSource(handle([factRow()]), SCOPE);
    expect(source.facts).toHaveLength(1);
    expect(source.facts[0]).toMatchObject({
      searchQueryScore: null,
      searchQueryVolume: 40,
      totalImpressions: 50,
      asinImpressionShare: 0.1,
      totalClicks: 4,
      asinClickShare: 0.25,
      totalCartAdds: 0,
      asinCartAddShare: null,
      totalPurchases: 0,
      asinPurchases: 0,
      asinPurchaseShare: null,
    });
  });

  it('refuses a null count and a null share of a nonzero total rather than reading either as 0', async () => {
    await expect(loadQueryIntelligenceSource(handle([factRow({ total_clicks: null })]), SCOPE))
      .rejects.toThrow();
    await expect(loadQueryIntelligenceSource(handle([factRow({ click_share: null })]), SCOPE))
      .rejects.toThrow(/asinClickShare/);
  });
});
