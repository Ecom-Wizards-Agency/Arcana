import { describe, expect, it } from 'vitest';
import { DEFAULT_DENSITY, GRID_DENSITIES, isGridDensity, rowHeightFor } from './density.js';
import { DEFAULT_ROW_HEIGHT } from './virtual.js';

describe('row density', () => {
  it('keeps the normal density at the height the grid has always used', () => {
    expect(rowHeightFor(DEFAULT_DENSITY)).toBe(DEFAULT_ROW_HEIGHT);
    // The target grid's two-line bid-corridor row was 42px before density existed.
    expect(rowHeightFor('normal', 2)).toBe(42);
  });

  it('orders the three densities from tightest to loosest, for one and two lines', () => {
    const single = GRID_DENSITIES.map((density) => rowHeightFor(density, 1));
    const double = GRID_DENSITIES.map((density) => rowHeightFor(density, 2));
    expect(single).toEqual([...single].sort((a, b) => a - b));
    expect(double).toEqual([...double].sort((a, b) => a - b));
    for (const density of GRID_DENSITIES) {
      expect(rowHeightFor(density, 2)).toBeGreaterThan(rowHeightFor(density, 1));
    }
  });

  it('accepts only the three named densities from persisted layouts', () => {
    expect(isGridDensity('compact')).toBe(true);
    expect(isGridDensity('comfortable')).toBe(true);
    expect(isGridDensity('dense')).toBe(false);
    expect(isGridDensity(30)).toBe(false);
    expect(isGridDensity(undefined)).toBe(false);
  });
});
