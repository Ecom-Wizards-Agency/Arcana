import { expect, it } from 'vitest';
import { formatShellDate, formatTimestamp, formatDateWindow } from '../../ui/date-format';
it('formats UTC dates, single-day windows and multi-day windows in words', () => {
  expect(formatShellDate('2026-09-13')).toBe('13 Sept 2026');
  expect(formatDateWindow('2026-09-13', '2026-09-13')).toBe('13 Sept 2026');
  expect(formatDateWindow('2026-09-13', '2026-09-14')).toBe('13 Sept 2026 – 14 Sept 2026');
  expect(formatTimestamp('2026-09-13T23:45:00Z')).toBe('13 Sept 2026 23:45 UTC');
});
it('preserves missing and invalid dates without inventing an epoch', () => {
  expect(formatTimestamp(null)).toBe('—');
  expect(formatShellDate('2026-02-30')).toBe('Date unavailable');
  expect(formatTimestamp('invalid')).toBe('Date unavailable');
});
