// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { verifyScreen } from '../render-test-support';
import { descriptor } from '../cockpit/descriptor';
import SharedError from '../shared-error';
import Home, { HomeContent } from './view';
import Loading from './loading';
import { selectBudgetUsage } from '@wizard-ads/core';
import { budgetEvidence, budgetObservation, withBudget, withBudgetUsage, withoutBudget } from './fixtures';

afterEach(() => vi.unstubAllGlobals());
verifyScreen(descriptor, [
  { state: 'ready', name: 'renders the cockpit state without a budget', render: () => <HomeContent {...withoutBudget} />, text: 'The recommendations queue' },
  { state: 'ready', name: 'renders pacing and market position with a budget', render: () => <HomeContent {...withBudget} />, text: '30 places behind' },
  { state: 'loading', name: 'shows pending evidence without figures', render: () => <Loading />, text: 'Loading current account' },
  { state: 'error', name: 'shows safe failure with a reference', render: () => <SharedError error={Object.assign(new Error('private'), { digest: 'test-reference' })} reset={() => {}} />, text: 'test-reference' },
  { state: 'gated', name: 'explains unavailable context', render: () => <Home data={{ view: 'no-database', props: {} }} />, text: 'database' },
  { state: 'empty', name: 'shows no profiles', render: () => <Home data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'empty', name: 'shows no proposals', render: () => <HomeContent {...withoutBudget} home={{ ...withoutBudget.home, proposals: [] }} />, text: 'No proposals waiting' },
  { state: 'empty', name: 'shows no events', render: () => <HomeContent {...withoutBudget} home={{ ...withoutBudget.home, events: [] }} />, text: 'No events this week' },
  { state: 'not-measured', name: 'shows no budget without inventing a balance', render: () => <HomeContent {...withoutBudget} />, text: 'No monthly budget on file' },
]);

it('counts rows from both insight writers, flags, proposals and rank observations', () => {
  render(<HomeContent {...withBudget} />);
  expect(within(screen.getByRole('list', { name: 'Weekly events' })).getAllByRole('listitem')).toHaveLength(2);
  expect(screen.getByText('Keepa')).toBeTruthy();
  expect(screen.getByText('Analyst')).toBeTruthy();
  expect(within(screen.getByRole('group', { name: 'Raised flags' })).getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getByText('Noted, not flagged (1)')).toBeTruthy();
  expect(within(screen.getByRole('group', { name: 'Noted flags' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByText('Insufficient settled evidence for this finding.')).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Pending proposals' })).getAllByRole('listitem')).toHaveLength(2);
  expect(within(screen.getByRole('list', { name: 'Rank movements' })).getAllByRole('listitem')).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'View market position →' }).getAttribute('href')).toContain('/market-position?profile=');
});
it('renders campaign limit and missing market position as not measured with no numeric zero or portfolio card', () => {
  render(<HomeContent {...withBudget} />);
  for (const label of ['Campaigns near their limit']) {
    const card = screen.getByLabelText(label);
    expect(card.querySelector('[data-state="not-measured"]')).not.toBeNull();
    expect(card.textContent).not.toMatch(/\d/);
  }
  expect(screen.queryByText('Portfolio pacing')).toBeNull();
});
it('approves optimistically with the actor-bound API payload and reconciles the result', async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
  vi.stubGlobal('fetch', fetcher);
  render(<HomeContent {...withoutBudget} />);
  expect(screen.getByText('Sample keyword', { exact: true }).closest('details')?.hasAttribute('open')).toBe(false);
  fireEvent.click(screen.getByText('Sample keyword', { exact: true }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
  expect(screen.queryByText('Sample keyword', { exact: true })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]).toEqual(['/api/recommendations/decide', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [withoutBudget.home.proposals[0]!.id], decision: 'accepted', note: null }),
  }]);
  finish(Response.json({ updated: 1, offered: 1, refused: [] }));
  await waitFor(() => expect(within(screen.getByRole('list', { name: 'Pending proposals' })).getAllByRole('listitem')).toHaveLength(1));
});
it('requires a dismissal reason and dismisses the selected proposal', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ updated: 1, offered: 1, refused: [] }));
  vi.stubGlobal('fetch', fetcher);
  render(<HomeContent {...withoutBudget} />);
  fireEvent.click(screen.getByText('Sample keyword', { exact: true }));
  const button = screen.getAllByRole('button', { name: 'Dismiss' })[0]!;
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Dismissal reason for Sample keyword'), { target: { value: 'Wait for more evidence' } });
  fireEvent.click(button);
  expect(JSON.parse(fetcher.mock.calls[0]![1].body)).toEqual({ ids: [withoutBudget.home.proposals[0]!.id], decision: 'dismissed', note: 'Wait for more evidence' });
  await waitFor(() => expect(screen.queryByText('Sample keyword', { exact: true })).toBeNull());
});
it('restores refused decisions and reports failure without exposing server details', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ updated: 0, offered: 1, refused: [{ id: withoutBudget.home.proposals[0]!.id }] })));
  render(<HomeContent {...withoutBudget} />);
  expect(screen.getByText('Sample keyword', { exact: true }).closest('details')?.hasAttribute('open')).toBe(false);
  fireEvent.click(screen.getByText('Sample keyword', { exact: true }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]!);
  await screen.findByRole('alert');
  expect(screen.getByText('Sample keyword', { exact: true })).toBeTruthy();
  expect(within(screen.getByRole('list', { name: 'Pending proposals' })).getAllByRole('listitem')).toHaveLength(2);
});
it('hides every decision control from a viewer', () => {
  render(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, canDecide: false }} />);
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  expect(screen.queryByLabelText(/Dismissal reason/)).toBeNull();
});

it('uses the selected-window tiles without rendering legacy dashboard or duplicate shell content', () => {
  const { container } = render(<HomeContent {...withoutBudget} currentWindow={{ start: '2026-06-20', end: '2026-06-14' }} />);
  expect(container.querySelector('main')?.getAttribute('data-profile-id')).toBe(withoutBudget.profile.id);
  expect(screen.getByLabelText('Performance summary').children).toHaveLength(5);
  expect(screen.getByLabelText('Sales').textContent).toContain('$4,088.00');
  for (const text of ['Operating status', 'Performance trend', 'Show the numbers', 'Home', 'Active account', 'Data current']) expect(screen.queryByText(text, { exact: true })).toBeNull();
  expect(container.querySelector('.wa-cockpit')).toBeNull();
});

it('keeps missing KPI values and comparison deltas unknown and displays break-even status', () => {
  render(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, tiles: withoutBudget.home.tiles.map((tile) => ({ ...tile, value: null, deltaPct: null })) }} />);
  for (const label of ['Spend', 'Sales', 'ACOS', 'Orders', 'Break-even ACOS']) {
    const tile = screen.getByLabelText(label);
    expect(tile.querySelector('strong')?.textContent).toBe('—');
    expect(tile.textContent).not.toMatch(/0/);
  }
  expect(screen.getByLabelText('Break-even ACOS').textContent).toContain('not measured');
});
it('shows confirmed break-even economics and directional deltas when supplied', () => {
  render(<HomeContent {...withBudget} home={{ ...withBudget.home, breakEvenAcos: 0.4 }} />);
  expect(screen.getByLabelText('Break-even ACOS').textContent).toContain('confirmed');
  expect(screen.getByLabelText('Sales').querySelector('small')?.getAttribute('data-tone')).toBe('bad');
  expect(screen.getByLabelText('Spend').querySelector('small')?.getAttribute('data-tone')).toBe('neutral');
});
it('renders four pacing figures with the derived remainder and suppresses unobserved spend', () => {
  const { rerender } = render(<HomeContent {...withBudget} />);
  const pacing = screen.getByLabelText('Pacing');
  expect(pacing.querySelectorAll('dl > div')).toHaveLength(4);
  expect(pacing.textContent).toContain('$1,747.00');
  expect(pacing.textContent).toContain('act at');
  rerender(<HomeContent {...withBudget} home={{ ...withBudget.home, pacing: { ...withBudget.home.pacing!, daysWithData: 0 } }} />);
  expect(pacing.querySelector('dl')?.textContent).toContain('Spent so far this month—');
  expect(pacing.querySelector('dl')?.textContent).toContain('Remaining · derived, not stored—');
});
it('keeps missing market and rank evidence explicit, with all three market explanations', () => {
  render(<HomeContent {...withoutBudget} home={{ ...withoutBudget.home, ranks: [] }} />);
  expect(screen.getByLabelText('Market position').querySelectorAll('.wa-home-explanation li')).toHaveLength(3);
  expect(screen.getByLabelText('Rank watch').querySelector('[data-state="not-measured"]')).not.toBeNull();
});

it('labels measured campaign usage and its provider time separately from profile MTD remaining', () => {
  render(<HomeContent {...withBudgetUsage} />);
  const usage = screen.getByLabelText('Campaigns near their limit');
  expect(usage.textContent).toContain('95% used');
  expect(usage.textContent).toContain('Near limit');
  expect(usage.textContent).toContain('Remaining at observation time: $1.00');
  expect(usage.textContent).toContain('Ads API');
  expect(usage.querySelector('time')?.getAttribute('datetime')).toBe(budgetObservation.providerUpdatedAt);
  expect(screen.getByLabelText('Pacing', { exact: true }).textContent).toContain('$1,747.00');
  expect(screen.getByLabelText('Portfolio pacing').textContent).toContain('Remaining for this period $210.00');
  expect(screen.getByLabelText('Portfolio pacing').textContent).toContain('1 profile campaigns have no portfolio assignment');
});

it('renders source-off and enabled-without-observations states without inventing usage', () => {
  const { rerender } = render(<HomeContent {...withoutBudget} />);
  const usage = screen.getByLabelText('Campaigns near their limit');
  expect(usage.textContent).toContain('sources are off');
  const budgetUsage = selectBudgetUsage({ ...budgetEvidence, observations: [] }, budgetObservation.receivedAt);
  rerender(<HomeContent {...withBudget} home={{ ...withBudget.home, budgetUsage }} />);
  expect(usage.textContent).toContain('Usage not measured');
  expect(usage.textContent).not.toContain('0% used');
});

it('shows measured zero while leaving a missing near-limit policy unmeasured', () => {
  const budgetUsage = selectBudgetUsage({ ...budgetEvidence, config: { ...budgetEvidence.config, nearLimitPercent: null },
    observations: [{ ...budgetObservation, usagePercent: 0 }] }, budgetObservation.receivedAt);
  render(<HomeContent {...withBudget} home={{ ...withBudget.home, budgetUsage }} />);
  const usage = screen.getByLabelText('Campaigns near their limit');
  expect(usage.textContent).toContain('0% used');
  expect(usage.textContent).toContain('Near-limit classification not measured');
  expect(usage.textContent).toContain('Remaining at observation time: $20.00');
});

it('reports partial API responses and preserves failed campaigns as unavailable', () => {
  const budgetUsage = selectBudgetUsage({ ...budgetEvidence,
    totalCampaigns: 2,
    campaigns: [...budgetEvidence.campaigns, { ...budgetEvidence.campaigns[0]!, campaignId: '102', campaignName: 'Failed campaign' }],
    sources: [{ source: 'amazon_ads_api', enabled: true, complete: false, requested: 2, failed: 1 }],
  }, budgetObservation.receivedAt);
  render(<HomeContent {...withBudget} home={{ ...withBudget.home, budgetUsage }} />);
  const usage = screen.getByLabelText('Campaigns near their limit');
  expect(usage.textContent).toContain('1 of 2 campaigns have current usage evidence · partial');
  expect(screen.getByText('Failed campaign').closest('li')?.textContent).toContain('Usage not measured');
  expect(screen.getByText('Failed campaign').closest('li')?.textContent).not.toContain('0%');
});

it('labels stale evidence and switches to separately enabled fresh Stream fallback', () => {
  const stale = { ...budgetObservation, providerUpdatedAt: '2026-06-13T12:00:00Z' };
  const { rerender } = render(<HomeContent {...withBudget} home={{ ...withBudget.home,
    budgetUsage: selectBudgetUsage({ ...budgetEvidence, observations: [stale] }, budgetObservation.receivedAt) }} />);
  const usage = screen.getByLabelText('Campaigns near their limit');
  expect(usage.textContent).toContain('stale observation');
  expect(usage.textContent).toContain('Near-limit classification not measured');
  const budgetUsage = selectBudgetUsage({ ...budgetEvidence,
    config: { ...budgetEvidence.config, streamEnabled: true, allowFreshStreamFallback: true },
    observations: [stale, { ...budgetObservation, source: 'amazon_marketing_stream', budgetAmount: null }],
    sources: [...budgetEvidence.sources, { source: 'amazon_marketing_stream', enabled: true, complete: true, requested: 1, failed: 0 }],
  }, budgetObservation.receivedAt);
  rerender(<HomeContent {...withBudget} home={{ ...withBudget.home, budgetUsage }} />);
  expect(within(usage).getByRole('list').textContent).toContain('Marketing Stream');
  expect(within(usage).getByRole('list').textContent).not.toContain('stale observation');
  expect(usage.textContent).toContain('Remaining at observation time: —');
});

it('keeps unsupported and partial portfolio amounts unmeasured within the existing Pacing card', () => {
  const row = withBudgetUsage.home.portfolioPacing[0]!;
  render(<HomeContent {...withBudgetUsage} home={{ ...withBudgetUsage.home, portfolioPacing: [
    { ...row, availability: 'partial', pace: null, remainingAmount: null, evidence: { ...row.evidence, membershipComplete: false, observedCampaignDays: 27 } },
    { ...row, availability: 'unavailable', pace: null, remainingAmount: null, evidence: { ...row.evidence, portfolioId: '202', name: 'Unsupported portfolio', period: null } },
  ] }} />);
  const portfolios = screen.getByLabelText('Portfolio pacing');
  expect(within(portfolios).getAllByRole('listitem')).toHaveLength(2);
  expect(portfolios.textContent).toContain('Partial evidence');
  expect(portfolios.textContent).toContain('Budget period unavailable');
  expect(portfolios.textContent).not.toContain('$210.00');
});
