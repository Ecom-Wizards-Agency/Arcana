import { describe, expect, it } from 'vitest';
import { aggregate } from '../scripts/read-path-statistics.js';

describe('read-path aggregation', () => {
  it('sorts numerically, preserves samples, and divides medians', () => {
    const samples = [100, 2, 10, 4, 6];
    expect(aggregate(samples, [12, 20, 4, 200, 8])).toEqual({ serviceMs: 6, authenticatedMs: 12, ratio: 2 });
    expect(samples).toEqual([100, 2, 10, 4, 6]);
    expect(aggregate([2, 4], [8, 4])).toEqual({ serviceMs: 3, authenticatedMs: 6, ratio: 2 });
  });
  it('rejects invalid samples and represents a zero denominator explicitly', () => {
    expect(() => aggregate([], [1])).toThrow();
    for (const value of [NaN, Infinity, -1]) expect(() => aggregate([value], [1])).toThrow();
    expect(aggregate([0], [1]).ratio).toBeNull();
  });
});
