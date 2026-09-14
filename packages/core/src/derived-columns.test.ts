import { describe, expect, it } from 'vitest';
import { acosVsTarget, conversionPoints, grossBreakEvenBid, rankChange, shareOfSpend, topOfSearchRange } from './derived-columns.js';

describe('performance arithmetic', () => {
  it('calculates the frame gross break-even bid without percent-unit confusion', () => {
    const bid = grossBreakEvenBid(3952.78 / 1739, 25.3 / 100);
    expect(bid).toBeGreaterThanOrEqual(8.98);
    expect(bid).toBeLessThanOrEqual(9);
  });
  it('keeps measured share zero and excludes missing days from the daily range', () => {
    expect(topOfSearchRange([null, 0, 0.4, 0.2])).toEqual({ low: 0, high: 0.4 });
    expect(topOfSearchRange([null, null])).toBeNull();
  });
  it('uses positive changes for improved rank', () => {
    expect(rankChange(3, 8)).toBe(5);
    expect(rankChange(8, 3)).toBe(-5);
    expect(rankChange(null, 3)).toBeNull();
  });
  it('computes ACOS and conversion differences in points', () => {
    expect(acosVsTarget(0.253, 0.3)).toBeCloseTo(-4.7);
    expect(conversionPoints(0.14, 0.1)).toBeCloseTo(4);
    expect(acosVsTarget(null, 0.3)).toBeNull();
    expect(conversionPoints(0.14, null)).toBeNull();
  });
  it('computes spend shares over the selected population', () => {
    expect(shareOfSpend(3952.78, 7905.56)).toBe(0.5);
    expect(shareOfSpend(0, 7905.56)).toBe(0);
    expect(shareOfSpend(null, 7905.56)).toBeNull();
    expect(shareOfSpend(3952.78, 0)).toBeNull();
  });
  it('never substitutes zero for missing or undefined ratios', () => {
    for (const [cpc, acos] of [[null, 0.2], [2, null], [2, 0], [NaN, 0.2], [2, Infinity]] as const) {
      expect(grossBreakEvenBid(cpc, acos)).toBeNull();
    }
  });
});
