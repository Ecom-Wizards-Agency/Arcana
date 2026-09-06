/**
 * Row density.
 *
 * Three settings, one number each. The grid's virtualizer needs a fixed row
 * height up front (it sizes the scrollbar from `count × height` before any row
 * has rendered), so density cannot be "whatever the content needs"; it is a
 * table of heights the operator picks from, persisted with the rest of the
 * layout. `normal` is the height the grid has always had, so a saved layout
 * written before density existed renders exactly as it did.
 */
export type GridDensity = 'compact' | 'normal' | 'comfortable';

export const GRID_DENSITIES: readonly GridDensity[] = ['compact', 'normal', 'comfortable'];

export const DEFAULT_DENSITY: GridDensity = 'normal';

export const DENSITY_LABELS: Record<GridDensity, string> = {
  compact: 'Compact',
  normal: 'Normal',
  comfortable: 'Comfortable',
};

/**
 * Row heights in pixels, by density and by the number of text lines a row
 * carries. The two-line variant exists for the target grid's bid-corridor
 * cell, which prints the median over its range.
 */
const ROW_HEIGHTS: Record<GridDensity, { 1: number; 2: number }> = {
  compact: { 1: 26, 2: 36 },
  normal: { 1: 30, 2: 42 },
  comfortable: { 1: 38, 2: 52 },
};

export function rowHeightFor(density: GridDensity, lines: 1 | 2 = 1): number {
  return ROW_HEIGHTS[density][lines];
}

export function isGridDensity(value: unknown): value is GridDensity {
  return typeof value === 'string' && (GRID_DENSITIES as readonly string[]).includes(value);
}
