/** Display profile calendar dates without shifting them into the browser's timezone. */
const date = (value: string) => new Date(`${value}T00:00:00Z`);
const words = (value: string, year = true) => new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', ...(year ? { year: 'numeric' as const } : {}), timeZone: 'UTC',
}).format(date(value));
export function formatResearchPeriod({ start, end }: { start: string; end: string }): string {
  if (!Number.isFinite(date(start).getTime()) || !Number.isFinite(date(end).getTime())) return 'Choose a period';
  if (start === end) return words(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${date(start).getUTCDate()} – ${words(end)}`;
  return `${words(start, start.slice(0, 4) !== end.slice(0, 4))} to ${words(end)}`;
}
export function formatResearchTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone, timeZoneName: 'short',
  }).format(new Date(value));
}
export const campaignCount = (count: number) => `${count} ${count === 1 ? 'campaign' : 'campaigns'}`;
export function signedResearchPercent(value: number): string {
  const rounded = Math.round(Math.abs(value) * 1000) / 10;
  return `${rounded === 0 ? '' : value > 0 ? '+' : '−'}${rounded.toFixed(1)}%`;
}
/** Five evenly spaced ticks, ending at the measured maximum; an all-zero series has only zero. */
export function researchAxisTicks(maximum: number): number[] {
  return maximum > 0 ? Array.from({ length: 5 }, (_, index) => maximum * index / 4) : [0];
}
export const formatResearchTick = (value: number) => new Intl.NumberFormat('en-US', {
  notation: 'compact', maximumFractionDigits: 2,
}).format(value);
