// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CampaignEndDateInput, calendarDateFromWords } from './date-input';

it('shows month names and preserves calendar dates for the existing bulk update validator', () => {
  const change = vi.fn();
  render(<label>End date<CampaignEndDateInput id="end-date" value="2026-06-10" disabled={false} onChange={change} /></label>);
  expect((screen.getByLabelText('End date') as HTMLInputElement).value).toBe('10 Jun 2026');
  fireEvent.change(screen.getByLabelText('End date'), { target: { value: '12 Jul 2026' } });
  expect(change).toHaveBeenCalledWith('2026-07-12');
  expect(calendarDateFromWords('31 Feb 2026')).toBe('31 Feb 2026');
  expect(calendarDateFromWords('')).toBe('');
});
