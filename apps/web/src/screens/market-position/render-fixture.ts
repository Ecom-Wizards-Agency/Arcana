import type { MarketPositionData } from './load';

export const ready: Extract<MarketPositionData, { view: 'ready' }> = {
  view: 'ready', profileId: '00000000-0000-4000-8000-000000000001', countryCode: 'US', canEdit: true,
  start: '2026-06-01', end: '2026-06-03', selectedAsin: 'B000000001',
  settings: { profileId: '00000000-0000-4000-8000-000000000001', thresholdPercent: 15, updatedAt: null },
  products: [{ asin: 'B000000001', name: 'Synthetic product' }, { asin: 'B000000003', name: null }],
  links: [{ ownAsin: 'B000000001', competitorAsin: 'B000000002', category: null }],
  series: [
    { asin: 'B000000001', category: 'Synthetic category', points: [{ date: '2026-06-01', bsr: null }, { date: '2026-06-02', bsr: 900 }, { date: '2026-06-03', bsr: 1000 }] },
    { asin: 'B000000002', category: 'Synthetic category', points: [{ date: '2026-06-01', bsr: null }, { date: '2026-06-02', bsr: 1300 }, { date: '2026-06-03', bsr: 1100 }] },
  ],
};

/** Every visual state uses the same synthetic 21-day window and shell. */
export const visualStates = ['loading', 'error', 'not-measured', 'untracked', 'no-alert', 'own-rank-worsened', 'competitor-improved', 'both', 'badge-held', 'badge-not-held', 'badge-not-measured'] as const;
export type VisualState = typeof visualStates[number];
export function visualFixture(state: VisualState): typeof ready {
  const ownAsin = ready.selectedAsin;
  const competitors = ['B000000002', 'B000000004', 'B000000005'];
  const both = state === 'both';
  const theirGain = state === 'competitor-improved';
  const data: typeof ready = {
    ...ready, start: '2026-08-18', end: '2026-09-07',
    products: [{ asin: ownAsin, name: 'Synthetic daily serum' }, ready.products[1]!],
    links: competitors.map((competitorAsin) => ({ ownAsin, competitorAsin, category: null })),
    series: [ownAsin, ...competitors].map((asin, seriesIndex) => ({
      asin, category: 'Personal Care › Daily Treatments', name: ['You', 'Competitor One', 'Competitor Two', 'Competitor Three'][seriesIndex]!,
      points: Array.from({ length: 21 }, (_, day) => {
        const date = new Date(Date.UTC(2026, 7, 18 + day)).toISOString().slice(0, 10);
        const finalOwn = 1042;
        const own = theirGain ? finalOwn : day === 20 ? finalOwn : 828 + Math.round(day * 214 / 20);
        const rival = state === 'no-alert' ? 1450 : day === 20 ? 1136 : theirGain || both ? 1350 : 1105 + Math.round(day * 31 / 20);
        return { date, observedAt: `${date}T06:12:00.000Z`, bsr: seriesIndex === 0 ? own : seriesIndex === 1 ? rival : seriesIndex === 2 ? 1600 + day * 9 + (day % 3 - 1) * 14 : 1930 + day * 7 + (day % 2) * 20,
          ...(seriesIndex === 0 && (state === 'badge-held' || state === 'badge-not-held') ? { bestSellerBadge: state === 'badge-held', subcategory: { rank: 1, name: 'Daily Treatments' } } : {}) };
      }),
    })),
  };
  if (state === 'untracked') data.links = [];
  if (state === 'not-measured') data.series = [];
  return data;
}
