// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DateRangePicker } from './date-range-picker.js';
const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

it('routes shared picker Apply with both periods and preserves screen scope; Cancel leaves the URL alone', () => {
  render(<DateRangePicker path="/grid" today="2026-05-01" period={{ start: '2026-04-01', end: '2026-04-30' }}
    preserved={{ profile: 'profile-synthetic', entity: 'targets', compareFrom: '2026-02-01', compareTo: '2026-02-28' }} />);
  fireEvent.click(document.querySelector('summary')!);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(document.querySelector('summary')!);
  fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
  expect(push).toHaveBeenLastCalledWith(`/grid?${new URLSearchParams({ profile: 'profile-synthetic', entity: 'targets', compareFrom: '2026-02-01', compareTo: '2026-02-28', comparison: 'custom', from: '2026-04-01', to: '2026-04-30' })}`);
  fireEvent.click(document.querySelector('summary')!);
  fireEvent.click(screen.getByRole('button', { name: 'None' }));
  fireEvent.click(screen.getByRole('link', { name: 'Last 7 days' }));
  expect(push).toHaveBeenLastCalledWith(`/grid?${new URLSearchParams({ profile: 'profile-synthetic', entity: 'targets', preset: 'last_7', comparison: 'none', from: '2026-04-24', to: '2026-04-30' })}`);
});
