// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateRangePicker } from './DateRangePicker.js';
import { comparisonRange, mismatchPercentage, rangeDays, rangePresets } from './model.js';

afterEach(cleanup);
const period = { start: '2026-07-30', end: '2026-08-28' };
const comparison = { start: '2026-06-30', end: '2026-07-29' };
function mount(mode: 'previous' | 'year' | 'custom' | 'none' = 'previous') {
  const apply = vi.fn();
  render(<DateRangePicker period={period} comparison={comparison} mode={mode} today="2026-08-29" factsThrough="2026-08-28" factsComplete presetHref={(_, id) => `?preset=${id}`} onApply={apply} />);
  fireEvent.click(document.querySelector('summary')!);
  return apply;
}
describe('date and comparison picker', () => {
  for (const preset of rangePresets('2026-08-29')) for (const mode of ['previous', 'year', 'custom', 'none'] as const) it(`applies ${preset.label} immediately with ${mode} comparison`, () => {
    const apply = mount(mode);
    const link = screen.getByRole('link', { name: preset.label });
    expect(link.getAttribute('href')).toBe(`?preset=${preset.id}`);
    fireEvent.click(link);
    expect(apply).toHaveBeenCalledExactlyOnceWith({ period: preset.range, mode, preset: preset.id, comparison: comparisonRange(preset.range, mode, comparison) });
    expect(document.querySelector('details')!.open).toBe(false);
    expect(document.activeElement).toBe(document.querySelector('summary'));
  });
  it('retains the edited custom comparison when applying a preset', () => {
    const apply = mount('custom');
    fireEvent.change(screen.getByLabelText('Comparison from'), { target: { value: '2026-07-02' } });
    fireEvent.click(screen.getByRole('link', { name: 'Last 7 days' }));
    expect(apply).toHaveBeenCalledExactlyOnceWith({ period: { start: '2026-08-22', end: '2026-08-28' }, preset: 'last_7', mode: 'custom', comparison: { start: '2026-07-02', end: '2026-07-29' } });
  });
  it('stages calendar selection until Apply', () => {
    const apply = mount();
    fireEvent.click(screen.getByRole('button', { name: '2 Jul 2026' }));
    fireEvent.click(screen.getByRole('button', { name: '8 Jul 2026' }));
    expect(apply).not.toHaveBeenCalled();
    expect(document.querySelector('details')!.open).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    expect(apply).toHaveBeenCalledExactlyOnceWith({ period: { start: '2026-07-02', end: '2026-07-08' }, mode: 'previous', comparison: { start: '2026-06-25', end: '2026-07-01' } });
    expect(document.querySelector('details')!.open).toBe(false);
  });
  for (const [mode, label] of [['previous', 'Previous period'], ['year', 'Same period last year'], ['custom', 'Custom'], ['none', 'None']] as const) it(`applies comparison ${mode}`, () => {
    const apply = mount();
    const fieldset = screen.getByText('COMPARE AGAINST').closest('fieldset')!;
    fireEvent.click(within(fieldset).getByRole('button', { name: label }));
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Apply range' }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ mode, comparison: comparisonRange(period, mode, comparison) }));
  });
  it('supports custom dates, tints both windows, discloses freshness and computes mismatch', () => {
    mount();
    expect(screen.getByText(/Facts load through 28 Aug 2026/)).toBeTruthy();
    expect(document.querySelectorAll('[data-selected="true"]').length).toBe(30);
    expect(document.querySelectorAll('[data-comparison="true"]').length).toBe(29);
    fireEvent.click(within(screen.getByText('COMPARE AGAINST').closest('fieldset')!).getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Comparison from'), { target: { value: '2026-07-02' } });
    expect(screen.getByRole('status').textContent).toContain('7.1%');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-08-30' } });
    expect(screen.getByText(/Selected.*facts incomplete/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.querySelector('details')!.open).toBe(false);
  });
  it('selects calendar endpoints and rejects reversed custom input', () => {
    const apply = mount();
    fireEvent.click(screen.getByRole('button', { name: '2 Jul 2026' }));
    fireEvent.click(screen.getByRole('button', { name: '8 Jul 2026' }));
    expect(screen.getByLabelText('From')).toHaveProperty('value', '2026-07-02');
    expect(screen.getByLabelText('To')).toHaveProperty('value', '2026-07-08');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-07-09' } });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply range' })).toHaveProperty('disabled', true);
    expect(apply).not.toHaveBeenCalled();
  });
  it('uses inclusive lengths and clamps leap-day year comparisons', () => {
    expect(rangeDays(period)).toBe(30);
    expect(mismatchPercentage(period, { start: '2026-02-01', end: '2026-02-28' })).toBeCloseTo(7.142857);
    expect(mismatchPercentage(period, comparison)).toBe(0);
    expect(comparisonRange({ start: '2024-02-29', end: '2024-03-02' }, 'year', comparison)).toEqual({ start: '2023-02-28', end: '2023-03-02' });
  });
});

// Migrated from the screen wrapper: both warning assertions belong to the shared UI.
it('renders a warning for a 30-day window compared with 28 days and clears it for equal lengths', () => {
  const period = { start: '2026-04-01', end: '2026-04-30' };
  const props = { today: '2026-05-01', period, mode: 'custom' as const, presetHref: () => '/grid', onApply: vi.fn() };
  const { rerender } = render(<DateRangePicker {...props} comparison={{ start: '2026-02-01', end: '2026-02-28' }} />);
  fireEvent.click(document.querySelector('summary')!);
  expect(screen.getByRole('status').querySelector('span')?.textContent).toBe('Date ranges differ: 30 days compared with 28 days.');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  rerender(<DateRangePicker {...props} comparison={{ start: '2026-03-01', end: '2026-03-30' }} />);
  fireEvent.click(document.querySelector('summary')!);
  expect(screen.queryByRole('status')).toBeNull();
});
