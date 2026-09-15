import { expect, it } from 'vitest';
import { formatShellDate, formatShellDateRange, formatShellTimestamp } from './date-format';

it('formats calendar dates and ranges in the shell’s day-first style', () => {
  expect(formatShellDate('2026-06-07')).toBe('7 Jun 2026');
  expect(formatShellDateRange('2026-08-01', '2026-08-29')).toBe('1 Aug 2026 – 29 Aug 2026');
  expect(formatShellDateRange('2026-07-30', '2026-08-02')).toBe('30 Jul 2026 – 2 Aug 2026');
  expect(formatShellDateRange('2026-12-31', '2027-01-01')).toBe('31 Dec 2026 – 1 Jan 2027');
  expect(formatShellDateRange('2026-06-07', '2026-06-07')).toBe('7 Jun 2026');
});

it('formats timestamps with an explicit timezone and minute precision', () => {
  expect(formatShellTimestamp('2026-06-07T00:00:00.000Z')).toBe('7 Jun 2026, 00:00 UTC');
  expect(formatShellTimestamp('2026-06-07T00:30:45+02:00')).toBe('6 Jun 2026, 22:30 UTC');
  expect(formatShellTimestamp('2026-06-07T00:30:00.000Z', 'Asia/Bangkok')).toBe('7 Jun 2026, 07:30 GMT+7');
});

it('keeps invalid or absent dates unavailable', () => {
  expect(formatShellDate('2026-02-30')).toBe('Date unavailable');
  expect(formatShellDate('')).toBe('Date unavailable');
  expect(formatShellTimestamp('not-a-timestamp')).toBe('Date unavailable');
});
