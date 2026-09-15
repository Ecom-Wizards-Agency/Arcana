import type { DateRange } from '../views.js';

export type ComparisonMode = 'previous' | 'year' | 'custom' | 'none';
export const shiftDate = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const rangeDays = (range: DateRange): number => Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
export function validRange(range: DateRange): boolean {
  return [range.start, range.end].every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) && range.start <= range.end;
}
export function comparisonRange(range: DateRange, mode: ComparisonMode, custom: DateRange): DateRange | null {
  if (mode === 'none') return null;
  if (mode === 'custom') return custom;
  if (mode === 'previous') return { start: shiftDate(range.start, -rangeDays(range)), end: shiftDate(range.start, -1) };
  const lastYear = (value: string): string => {
    const date = new Date(`${value}T00:00:00Z`);
    const month = date.getUTCMonth();
    date.setUTCFullYear(date.getUTCFullYear() - 1);
    if (date.getUTCMonth() !== month) date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
  };
  return { start: lastYear(range.start), end: lastYear(range.end) };
}
/** Exposure difference from comparing totals at an identical daily rate. */
export function mismatchPercentage(selected: DateRange, comparison: DateRange): number {
  return Math.abs(rangeDays(selected) / rangeDays(comparison) - 1) * 100;
}
export function rangePresets(today: string, includeToday = false) {
  const end = includeToday ? today : shiftDate(today, -1);
  const start = `${end.slice(0, 8)}01`;
  const previousEnd = shiftDate(start, -1);
  return [
    ...[7, 14, 30, 60, 90].map((days) => ({ id: `last_${days}`, label: `Last ${days} days`, range: { start: shiftDate(end, 1 - days), end } })),
    { id: 'month_to_date', label: 'Month to date', range: { start, end } },
    { id: 'previous_month', label: 'Previous month', range: { start: `${previousEnd.slice(0, 8)}01`, end: previousEnd } },
  ];
}
export const dateWords = (date: string): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
export const rangeWords = (range: DateRange): string => `${dateWords(range.start)} – ${dateWords(range.end)}`;
