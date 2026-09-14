// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import Loading from '../../../app/market-position/loading';
import SharedError from '../shared-error';
import { rendered, verifyScreen } from '../render-test-support';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

afterEach(() => vi.unstubAllGlobals());
verifyScreen(descriptor, [
  { state: 'ready', name: 'renders tracked competitors and cause', render: () => <Screen data={ready} />, text: 'both your rank worsening and their gain' },
  { state: 'empty', name: 'points to competitor management when none are linked', render: () => <Screen data={{ ...ready, links: [] }} />, text: 'Manage competitor links' },
  { state: 'empty', name: 'renders no profiles', render: () => <Screen data={{ view: 'empty' }} />, text: 'No profiles yet' },
  { state: 'empty', name: 'renders no advertised products', render: () => <Screen data={{ ...ready, products: [] }} />, text: 'No advertised products yet' },
  { state: 'not-measured', name: 'preserves missing measurements', render: () => <Screen data={{ ...ready, series: [] }} />, text: 'BSR not measured' },
  { state: 'loading', name: 'renders the pending boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders a safe failure with reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => {}} />, text: 'synthetic-reference' },
  { state: 'gated', name: 'explains missing access', render: () => <Screen data={{ view: 'gated' }} />, text: 'organisation membership' },
]);

it('counts products, competitor alerts, options and keeps the Products grid off this page', () => {
  const host = rendered(<Screen data={ready} />);
  expect(host.querySelectorAll('[data-testid="rank-stat"]')).toHaveLength(6);
  expect(host.querySelectorAll('h1')).toHaveLength(0);
  expect(host.querySelectorAll('table')).toHaveLength(0);
  expect(host.querySelectorAll('[data-testid="proximity-alert"]')).toHaveLength(1);
  expect(host.querySelectorAll('#market-product option')).toHaveLength(2);
  expect(host.querySelector('[aria-label="Rank statistics"]')?.textContent).toContain('GAP TO #2100');
  const empty = rendered(<Screen data={{ ...ready, links: [] }} />);
  expect(empty.querySelector('a[href="/settings/integrations"]')?.textContent).toBe('Manage competitor links');
  expect(empty.querySelector('[aria-label="Rank statistics"]')?.textContent).toContain('GAP TO #2Not measured');
});

it('uses only saved thresholds and reports readback success', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ...ready.settings, thresholdPercent: 5, updatedAt: '2026-06-03T12:00:00Z' }));
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={ready} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust threshold' }));
  fireEvent.change(screen.getByLabelText('Threshold (% of your BSR)'), { target: { value: '5' } });
  expect(screen.getAllByTestId('proximity-alert')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Threshold saved.'));
  expect(screen.queryAllByTestId('proximity-alert')).toHaveLength(0);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ profileId: ready.profileId, thresholdPercent: 5 });
});

it('preserves saved alerts after a refused save and hides editing from viewers', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Resource not found' }, { status: 403 })));
  const { unmount } = render(<Screen data={ready} />);
  fireEvent.click(screen.getByRole('button', { name: 'Adjust threshold' }));
  fireEvent.change(screen.getByLabelText('Threshold (% of your BSR)'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not be confirmed'));
  expect(screen.getAllByTestId('proximity-alert')).toHaveLength(1);
  unmount();
  render(<Screen data={{ ...ready, canEdit: false }} />);
  expect(screen.queryByRole('button', { name: 'Save threshold' })).toBeNull();
});

it('renders a neutral banner outside the threshold and every measured cause', async () => {
  const { visualFixture } = await import('./render-fixture');
  for (const [state, phrase] of [
    ['no-alert', 'outside your saved proximity threshold'],
    ['own-rank-worsened', 'this is your velocity, not their gain'],
    ['competitor-improved', 'this is their gain, not your velocity'],
    ['both', 'both your rank worsening and their gain'],
  ] as const) {
    const host = rendered(<Screen data={visualFixture(state)} />);
    expect(host.textContent).toContain(phrase);
    expect(host.querySelectorAll('[data-testid="rank-stat"]')).toHaveLength(6);
    expect(host.querySelectorAll('[data-series-mark="line"]')).toHaveLength(5);
  }
});
it('distinguishes held, not held and unknown badges without deriving ownership from rank', async () => {
  const { visualFixture } = await import('./render-fixture');
  for (const [state, phrase] of [['badge-held', 'held for 21 consecutive days'], ['badge-not-held', 'not held for 21 consecutive days'], ['badge-not-measured', 'Badge evidence not collected']] as const) {
    const host = rendered(<Screen data={visualFixture(state)} />);
    expect(host.textContent).toContain(phrase);
  }
});
it('names rank endpoints, threshold and alert window while refusing pricing writes', () => {
  const host = rendered(<Screen data={ready} />);
  expect(host.querySelector('[data-testid="end-label-0"]')?.textContent).toBe('You #1,000');
  expect(host.querySelector('[data-testid="end-label-2"]')?.textContent).toBe('alert threshold #1,150');
  expect(host.querySelector('[aria-label="left axis"]')?.textContent).toContain('#1');
  expect(host.querySelector('[data-window-label]')?.getAttribute('data-window-label')).toBe('alert fires 3 Jun');
  expect(host.querySelector('button[disabled]')?.getAttribute('title')).toContain('No pricing write exists');
  expect(host.querySelector('a[href^="/grid?"]')?.getAttribute('href')).toContain(`asin=${ready.selectedAsin}`);
});
it('retains every additional proximity alert and its cause in the banner disclosure', () => {
  const extra = { ...ready.series[1]!, asin: 'B000000004', name: 'Synthetic rival' };
  const host = rendered(<Screen data={{ ...ready, links: [...ready.links, { ownAsin: ready.selectedAsin, competitorAsin: extra.asin, category: null }], series: [...ready.series, extra] }} />);
  expect(host.querySelectorAll('[data-testid="proximity-alert"]')).toHaveLength(1);
  expect(host.querySelectorAll('[aria-label="Other proximity alerts"] li')).toHaveLength(1);
  expect(host.querySelector('[aria-label="Other proximity alerts"]')?.textContent).toContain('your rank worsened and competitor improved');
});
it('does not claim a gap closed when proximity persists while the distance widens', () => {
  const data = structuredClone(ready);
  data.series[1]!.points[1]!.bsr = 900;
  const host = rendered(<Screen data={data} />);
  expect(host.querySelector('[data-testid="proximity-alert"]')).not.toBeNull();
  expect(host.textContent).toContain('Since the previous day you slipped 100');
  expect(host.textContent).not.toContain('The gap closed because you');
});
