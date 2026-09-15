<<<<<<< HEAD
/** Calendar dates are independent of the browser's local timezone. */
export function validShellDate(value: string | undefined): value is string {
=======
/** UTC display dates shared by the shell and server-rendered utility screens. */
function validShellDate(value: string | undefined): value is string {
>>>>>>> cf40cf4a (Undesigned routes: core export for the Timeline import, experiment-detail state adapters, dates in words, live captures for 17 routes (WP-272 round 1))
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function formatShellDate(value: string): string {
  if (!validShellDate(value)) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${value}T00:00:00Z`));
}
<<<<<<< HEAD

export function formatShellDateRange(start: string, end: string): string {
  return start === end ? formatShellDate(start) : `${formatShellDate(start)} – ${formatShellDate(end)}`;
}

export function formatShellTimestamp(value: string, timeZone = 'UTC'): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23', timeZone, timeZoneName: 'short',
  }).format(parsed);
=======
export function formatDateWindow(start: string, end: string): string {
  return start === end ? formatShellDate(start) : `${formatShellDate(start)} – ${formatShellDate(end)}`;
}
export function formatTimestamp(value: string | Date | null): string {
  if (value === null) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) return 'Date unavailable';
  const iso = date.toISOString();
  return `${formatShellDate(iso.slice(0, 10))} ${iso.slice(11, 16)} UTC`;
>>>>>>> cf40cf4a (Undesigned routes: core export for the Timeline import, experiment-detail state adapters, dates in words, live captures for 17 routes (WP-272 round 1))
}
