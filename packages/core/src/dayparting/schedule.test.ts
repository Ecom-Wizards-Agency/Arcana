import { expect, it } from 'vitest';
import { daypartingReviewRanges, daypartingGridFromBlocks, daypartingPreset, emptyDaypartingGrid, paintDaypartingGrid } from './schedule.js';
it('paints a range without changing other cells or the original and resets all 168 hours', () => {
  const original = emptyDaypartingGrid(), grid = paintDaypartingGrid(original, [1, 2], 18, 21, 37);
  expect(grid.flat().filter(v => v === 37)).toHaveLength(6);
  expect(original.flat().filter(v => v !== 0)).toHaveLength(0);
  expect(daypartingPreset(original, 'weekend', -31).flat().filter(v => v === -31)).toHaveLength(48);
  expect(daypartingPreset(original, 'working-hours', 12).flat().filter(v => v === 12)).toHaveLength(40);
  expect(daypartingPreset(original, 'weekdays', 12).flat().filter(v => v === 12)).toHaveLength(120);
  expect(emptyDaypartingGrid().flat()).toEqual(Array(168).fill(0));
});
it('refuses fractional, out-of-range and overlapping proposal hours', () => {
  const block = {
    dayOfWeek: 1,
    startHour: 2,
    endHour: 4,
    adjustmentPercent: 18,
    confidence: 0.8
  };
  expect(daypartingGridFromBlocks([block]).flat().filter(v => v === 18)).toHaveLength(2);
  for (const adjustmentPercent of [-100, 301, 1.5]) expect(() => daypartingGridFromBlocks([{
    ...block,
    adjustmentPercent
  }])).toThrow();
  expect(() => daypartingGridFromBlocks([block, block])).toThrow('overlapping');
});

it('compresses the review without losing or duplicating an hourly instruction', () => {
  const grid = daypartingPreset(emptyDaypartingGrid(), 'working-hours', 37), ranges = daypartingReviewRanges(grid);
  expect(ranges).toEqual([{
    label: 'Mon–Fri 09:00–17:00',
    value: 37,
    hours: 40
  }]);
  expect(ranges.reduce((n, r) => n + r.hours, 0)).toBe(grid.flat().filter(v => v !== 0).length);
});
