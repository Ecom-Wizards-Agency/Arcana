import { describe, expect, it } from 'vitest';
import type { TargetCorridorPoint } from '@wizard-ads/shared';
import { corridorMaxCpc, corridorReading, corridorSummary } from './bid-corridor.js';
const point = (overrides: Partial<TargetCorridorPoint> = {}): TargetCorridorPoint => ({ date: '2026-08-01', bid: 5, cpc: 2, low: 4, median: 8.4, high: 11, maxCpc: 10, components: [{ name: 'Top of search', pct: 100 }], ...overrides });
describe('corridor evidence', () => {
  it('counts below-band days only where both edges and bid are measured', () => {
    const points = Array.from({ length: 13 }, (_, i) => point({ low: i < 10 ? 6 : 4 }));
    expect(corridorSummary([...points, point({ bid: null })]).bandPosition).toBe('Below on 10 of 13');
  });
  it('composes the highest placement exposure, without adding mutually exclusive placements', () => {
    expect(corridorMaxCpc(5, [{ name: 'Top of search', pct: 100 }, { name: 'Rest of search', pct: 0 }, { name: 'Product pages', pct: 0 }])).toBe(10);
    expect(corridorMaxCpc(5, [])).toBeNull();
    expect(corridorMaxCpc(null, [{ name: 'Top of search', pct: 100 }])).toBeNull();
  });
  it('computes average and highest day from measured CPC only and retains median history', () => {
    const s = corridorSummary([point({ cpc: 1, median: 5.85 }), point({ date: '2026-08-02', cpc: 3.13 }), point({ cpc: null })]);
    expect(s.cpcAverage).toBeCloseTo(2.065);
    expect(s.highestCpc).toBe(3.13); expect(s.highestDate).toBe('2026-08-02');
    expect(s.previousMedian?.median).toBe(5.85);
  });
  const cases: [string, TargetCorridorPoint[], string][] = [
    ['empty', [], 'No corridor series'],
    ['missing CPC', [point({ cpc: null })], 'Realised CPC is not measured'],
    ['missing median', [point({ median: null })], 'suggested median is not measured'],
    ['suggestion exceeds CPC', [point()], 'Review placement exposure'],
    ['above band', [point({ bid: 15, cpc: 9 })], 'Above on 1 of 1'],
    ['within band', [point({ cpc: 9 })], 'Within on 1 of 1'],
  ];
  it.each(cases)('reads %s using measured evidence', (_name, points, expected) => {
    expect(corridorReading(points, (n) => `$${n.toFixed(2)}`)).toContain(expected);
  });
});
it('does not invent numerical claims in a reading with no numerical evidence', () => {
  const empty = point({bid:null,cpc:null,low:null,median:null,high:null,maxCpc:null,components:[]});
  expect(corridorReading([empty],String)).not.toMatch(/\d/);
  expect(corridorSummary([empty]).cpcAverage).toBeNull();
});
