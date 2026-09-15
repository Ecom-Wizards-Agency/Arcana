import { DaypartingModifiers } from '@wizard-ads/shared';
import type { DaypartingScheduleBlock } from '@wizard-ads/shared';
export const DAYPARTING_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export function emptyDaypartingGrid(): DaypartingModifiers {
  return Array.from({ length: 7 }, () => Array<number>(24).fill(0));
}
export function paintDaypartingGrid(grid: DaypartingModifiers, days: readonly number[], startHour: number, endHour: number, value: number): DaypartingModifiers {
  const copy = DaypartingModifiers.parse(grid).map(day => [...day]);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || endHour <= startHour || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Invalid paint range');
  for (const day of days) for (let hour = startHour;hour < endHour;hour++) copy[day]![hour] = value;
  return DaypartingModifiers.parse(copy);
}
export function daypartingPreset(grid: DaypartingModifiers, preset: 'weekdays' | 'weekend' | 'working-hours', value: number) {
  return paintDaypartingGrid(grid, preset === 'weekend' ? [0, 6] : [1, 2, 3, 4, 5], preset === 'working-hours' ? 9 : 0, preset === 'working-hours' ? 17 : 24, value);
}
export function daypartingGridFromBlocks(blocks: readonly DaypartingScheduleBlock[]): DaypartingModifiers {
  let grid = emptyDaypartingGrid();
  const occupied = new Set<string>();
  for (const block of blocks) {
    for (let h = block.startHour;h < block.endHour;h++) {
      const key = `${block.dayOfWeek}:${h}`;
      if (occupied.has(key)) throw new Error('Proposal has overlapping hours');
      occupied.add(key);
    }
    grid = paintDaypartingGrid(grid, [block.dayOfWeek], block.startHour, block.endHour, block.adjustmentPercent);
  }
  return grid;
}
export function daypartingBlockLabel(block: DaypartingScheduleBlock): string {
  return `${DAYPARTING_DAYS[block.dayOfWeek]} ${String(block.startHour).padStart(2, '0')}:00–${String(block.endHour).padStart(2, '0')}:00 ${block.adjustmentPercent > 0 ? '+' : ''}${block.adjustmentPercent}%`;
}

/** Adjacent hours and days with identical instructions share one review row. */
export function daypartingReviewRanges(modifiers: DaypartingModifiers) {
  const grid = DaypartingModifiers.parse(modifiers);
  const grouped = new Map<string, { start: number; end: number; value: number; days: number[] }>();
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    for (let start = 0;start < 24;) {
      const value = grid[day]![start]!;
      let end = start + 1;
      while (end < 24 && grid[day]![end] === value) end++;
      if (value !== 0) {
        const key = `${start}:${end}:${value}`, range = grouped.get(key) ?? {
          start,
          end,
          value,
          days: []
        };
        range.days.push(day);
        grouped.set(key, range);
      }
      start = end;
    }
  }
  return [...grouped.values()].map(range => {
    const order = [1, 2, 3, 4, 5, 6, 0], contiguous = range.days.every((day, i) => i === 0 || order.indexOf(day) === order.indexOf(range.days[i - 1]!) + 1);
    const days = contiguous && range.days.length > 1 ? `${DAYPARTING_DAYS[range.days[0]!]}–${DAYPARTING_DAYS[range.days.at(-1)!]}` : range.days.map(day => DAYPARTING_DAYS[day]).join(', ');
    return {
      label: `${days} ${String(range.start).padStart(2, '0')}:00–${String(range.end).padStart(2, '0')}:00`,
      value: range.value,
      hours: range.days.length * (range.end - range.start)
    };
  });
}
