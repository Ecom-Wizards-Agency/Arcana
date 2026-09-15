import { describe, expect, it } from 'vitest';
import { marketPositionAlerts, marketPositionGap, marketRankWindow } from './market-position.js';
import type { MarketRankSeries } from '@wizard-ads/shared';
const series = (asin: string, values: (number | null)[]): MarketRankSeries => ({ asin, category: 'Synthetic category', points: values.map((bsr, i) => ({ date: `2026-06-0${i + 1}`, bsr })) });

describe('market proximity', () => {
  it('includes the exact threshold in either direction, ties and excludes the next rank', () => {
    const own = series('OWN', [1000, 1000]);
    for (const rank of [850, 1000, 1150]) expect(marketPositionAlerts(own, series('OTHER', [1300, rank]), 15)).toHaveLength(1);
    for (const rank of [849, 1151]) expect(marketPositionAlerts(own, series('OTHER', [1300, rank]), 15)).toHaveLength(0);
    expect(marketPositionAlerts(series('OWN', [1042, 1042]), series('OTHER', [1300, 1198]), 15)).toHaveLength(1);
    expect(marketPositionAlerts(series('OWN', [1042, 1042]), series('OTHER', [1300, 1199]), 15)).toHaveLength(0);
  });
  it('attributes own worsening, competitor improvement and both independently', () => {
    expect(marketPositionAlerts(series('OWN', [900, 1000]), series('OTHER', [1100, 1100]), 15)[0]?.cause).toBe('own_rank_worsened');
    expect(marketPositionAlerts(series('OWN', [1000, 1000]), series('OTHER', [1300, 1100]), 15)[0]?.cause).toBe('competitor_improved');
    expect(marketPositionAlerts(series('OWN', [900, 1000]), series('OTHER', [1300, 1100]), 15)[0]?.cause).toBe('both');
    expect(marketPositionAlerts(series('OWN', [1000, 1000]), series('OTHER', [1100, 1100]), 15)[0]?.cause).toBeNull();
  });
  it('refuses missing current or previous evidence on either side, including omitted days', () => {
    for (const values of [[null, 1000], [1000, null]] as const) {
      expect(marketPositionAlerts(series('OWN', [...values]), series('OTHER', [1100, 1100]), 15)).toEqual([]);
      expect(marketPositionAlerts(series('OWN', [1100, 1100]), series('OTHER', [...values]), 15)).toEqual([]);
    }
    const own = series('OWN', [1000, 1000, 1000]);
    own.points.splice(1, 1);
    expect(marketPositionAlerts(own, series('OTHER', [1100, 1100, 1100]), 15)).toEqual([]);
  });
  it('never compares categories or unknown categories', () => {
    for (const category of ['', 'Different category']) expect(marketPositionAlerts(series('OWN', [1000, 1000]), { ...series('OTHER', [1100, 1100]), category }, 15)).toEqual([]);
  });
  it('fills missing days with null and calculates signed gap without fabricating ranks', () => {
    expect(marketRankWindow([{ date: '2026-06-02', bsr: 1 }], '2026-06-01', '2026-06-03').map((p) => p.bsr)).toEqual([null, 1, null]);
    const own = series('OWN', [1000, null]);
    expect(marketPositionGap(own, [], '2026-06-01')).toBeNull();
    expect(marketPositionGap(own, [series('OTHER', [900, 1100])], '2026-06-01')).toBe(-100);
    expect(marketPositionGap(own, [series('OTHER', [900, 1100])], '2026-06-02')).toBeNull();
  });
});
