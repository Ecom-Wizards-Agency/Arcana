// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { restoreApprovalFixture, restoreOperationFixture, type RestoreResultState } from '../../writes/approval-fixtures';
import ReviewScreen from '../optimizer-review/view';
import { ready } from './render-fixture';
import Screen, { PreparedRetryReview } from './view';
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
afterEach(() => vi.unstubAllGlobals());
const states: RestoreResultState[] = ['queued', 'applying', 'partial', 'single', 'retry', 'ambiguous', 'failed', 'refused', 'conflict'];
for (const view of ['run', 'observation'] as const) it.each(states)(`renders the restore ${view} in %s with exact row and accounting counts`, (state) => {
  const operation = restoreOperationFixture(state);
  const props = { ...ready.props, operation };
  render(view === 'run' ? <Screen data={{ view: 'ready', props }} /> : <ReviewScreen data={{ view: 'observation', props }} />);
  expect(screen.getByTestId('restore-source').textContent).toBe(`Restore of batch ${ready.props.batchId} · ${operation.plan.counts.logicalChanges} rows`);
  expect(screen.getByRole('table', { name: 'Run change results' }).querySelectorAll('tbody tr')).toHaveLength(operation.plan.counts.providerRows);
  const c = operation.detail.snapshot.accounting;
  expect(screen.getByTestId('optimizer-result-counts').textContent).toBe(`Requested ${c.approvedRows} · Attempted ${c.intentCommitted} · Accepted ${c.providerAccepted} · Failed ${c.providerRejected} · Confirmed in sync ${c.observedRequested}`);
  const eligible = operation.rows.filter((row) => row.retryEligible).length;
  expect(screen.queryAllByRole('button', { name: /Review failed change/ })).toHaveLength(eligible > 0 ? 1 : 0);
  expect(screen.getByRole('link', { name: 'Review observation' }).getAttribute('href')).toContain(`execution=${operation.detail.operation.executionId}`);
  if (state === 'conflict') expect(screen.getByText('Observed state conflicts with the request')).toBeTruthy();
});
it('uses the saved restore retry endpoint without sending browser row eligibility', async () => {
  const operation = restoreOperationFixture('partial');
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'source_changed' }), { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ view: 'ready', props: { ...ready.props, retry: true, operation } }} />);
  expect(screen.getByRole('table').querySelectorAll('tbody tr')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh unresolved change' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/time-machine/restore/retry');
  const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string);
  expect(Object.keys(body).sort()).toEqual(['batchId', 'original', 'profileId', 'requestId']);
  expect(body.original).toEqual(operation.detail.operation);
});
it('reviews a fresh restore retry with its own row count and successful-row exclusions', async () => {
  const recorded = await restoreApprovalFixture();
  render(<PreparedRetryReview saved={{ preview: recorded.preview, excludedSuccessfulRows: [{ applyRowId: '22222222-2222-4222-8222-222222222222', name: 'Synthetic completed restore' }] }} onBack={() => {}} onReview={() => {}} />);
  expect(screen.getByRole('table', { name: 'Refreshed retry changes' }).querySelectorAll('tbody tr')).toHaveLength(1);
  expect(screen.getByText(/earlier successful changes are excluded: Synthetic completed restore/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Review 1 selected change' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
});
