// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyScreen, rendered } from '../render-test-support';
import { descriptor } from './descriptor';
import { renderVisualFixture, ready, visualFixture } from './render-fixture';
import Screen from './view';
import { PromptsPresentation } from './presentation';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders loading', render: () => renderVisualFixture('loading'), text: 'Loading' },
  { state: 'error', name: 'renders its error reference', render: () => renderVisualFixture('error'), text: 'synthetic-prompts-reference' },
  { state: 'gated', name: 'explains the unavailable rollout and database', render: () => renderVisualFixture('gated'), text: 'hosted Sponsored prompts rollout' },
  { state: 'empty', name: 'renders absent profiles', render: () => renderVisualFixture('empty-profile'), text: 'No profiles yet' },
  { state: 'not-measured', name: 'renders empty before import without invented costs', render: () => renderVisualFixture('empty'), text: 'No prompt observations have been imported' },
  { state: 'ready', name: 'renders newly sponsored', render: () => renderVisualFixture('newly-sponsored'), text: 'newly sponsored' },
  { state: 'ready', name: 'renders returned with the return date', render: () => renderVisualFixture('returned'), text: 'back 2026-06-07' },
  { state: 'ready', name: 'renders unchanged collapsed', render: () => renderVisualFixture('unchanged-collapsed'), text: 'Expand', absent: ['tbody'] },
  { state: 'ready', name: 'renders unchanged expanded', render: () => renderVisualFixture('unchanged-expanded'), text: 'Synthetic prompt 3' },
  { state: 'ready', name: 'renders the observation-derived loop cost', render: () => renderVisualFixture('loop-cost'), text: '2 returns per paused prompt' },
  { state: 'ready', name: 'renders the first visit without a fabricated marker', render: () => renderVisualFixture('first-visit'), text: 'first visit; no previous visit marker' },
]);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('explains viewer access without attempting to save a visit or showing an error', () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ ...ready, canEdit: false }} />);
  expect(screen.getByText('Read-only access. An owner, admin or analyst can import observations and record a visit.')).toBeTruthy();
  expect(screen.queryByText(/The visit marker could not be saved/)).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Import observations' })).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses protected marketplace console links and disables an unknown destination', () => {
  const host = rendered(renderVisualFixture('newly-sponsored'));
  const link = host.querySelector('a[target="_blank"]'); expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  expect(link?.getAttribute('href')).toBe('https://advertising.amazon.com/cm/sb/campaigns/synthetic-campaign-1/ad-groups');
  const unavailable = rendered(<PromptsPresentation data={{ ...ready, countryCode: 'XX' }} />);
  expect(unavailable.querySelectorAll('button[disabled]')).toHaveLength(2);
  expect(unavailable.querySelector('a[target="_blank"]')).toBeNull();
});
it('expands unchanged rows and records the displayed cutoff through POST', async () => {
  const response = new Response('{}');
  const consumed = vi.spyOn(response, 'text');
  const fetcher = vi.fn(async () => response); vi.stubGlobal('fetch', fetcher);
  render(<Screen data={visualFixture('unchanged-collapsed')} />);
  expect(screen.queryByText('Synthetic prompt 3')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
  expect(screen.getByText('Synthetic prompt 3')).toBeTruthy();
  await waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/prompts/visit', expect.objectContaining({ method: 'POST', body: JSON.stringify({ profileId: ready.snapshot.profileId, viewedThrough: ready.snapshot.viewedThrough }) })));
  await waitFor(() => expect(consumed).toHaveBeenCalledOnce());
});
it('validates pasted exports before importing and shows reconciled counts', async () => {
  const fetcher = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/import') ? { offered: 1, prompts: 1, inserted: 1, alreadyPresent: 0, verified: 1 } : {})));
  vi.stubGlobal('fetch', fetcher); render(<Screen data={visualFixture('empty')} />);
  fireEvent.change(screen.getByLabelText('Prompt export JSON'), { target: { value: '{}' } });
  fireEvent.click(screen.getByRole('button', { name: 'Import observations' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBeTruthy());
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/import'))).toBe(false);
  const prompt = ready.snapshot.prompts[0]!;
  fireEvent.change(screen.getByLabelText('Prompt export JSON'), { target: { value: JSON.stringify({ metricSemantics: 'disjoint_interval_deltas', rows: [{ ...prompt.observations[0], adProduct: prompt.adProduct, campaignId: prompt.campaignId, adGroupId: prompt.adGroupId, promptText: prompt.promptText }] }) } });
  fireEvent.click(screen.getByRole('button', { name: 'Import observations' }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 observations imported; 0 already present; 1 verified'));
});
