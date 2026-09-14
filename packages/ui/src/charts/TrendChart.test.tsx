// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { TrendChart } from './TrendChart.js';

afterEach(cleanup);
it('retains each series mark, scale and axis when additive days become weeks', () => {
  const points = [{ date: '2026-04-01', value: 10 }, { date: '2026-04-02', value: 20 }];
  const expectedWeeks = ['2026-03-30'];
  const series = [{ label: 'Spend', points, mark: 'bar' as const, axis: 'right' as const, scale: 'money' as const }];
  const { container } = render(<TrendChart title="Spend" ariaLabel="Spend trend" series={series}
    scale="integer" currencyCode="USD" aggregatable />);
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
  expect(container.querySelectorAll('[data-series-mark="bar"] rect')).toHaveLength(expectedWeeks.length);
  expect(container.querySelector('[aria-label="right axis"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="left axis"]')).toBeNull();
  fireEvent.click(screen.getByText('Show the numbers'));
  expect(screen.getByRole('cell', { name: '$30.00' })).toBeTruthy();
});
