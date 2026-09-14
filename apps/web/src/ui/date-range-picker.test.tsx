// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DateRangePicker } from './date-range-picker.js';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

it('renders a warning for a 30-day window compared with 28 days and clears it for equal lengths', () => {
  const period = { start: '2026-04-01', end: '2026-04-30' };
  const props = { path: '/grid', today: '2026-05-01', period };
  const { rerender } = render(<DateRangePicker {...props} comparison={{ start: '2026-02-01', end: '2026-02-28' }} />);
  expect(screen.getByRole('status').textContent).toBe('Date ranges differ: 30 days compared with 28 days.');
  rerender(<DateRangePicker {...props} comparison={{ start: '2026-03-01', end: '2026-03-30' }} />);
  expect(screen.queryByRole('status')).toBeNull();
});
