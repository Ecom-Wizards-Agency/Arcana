// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import Loading from '../../../app/optimizer/run/[batchId]/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready, operationFixture } from './render-fixture';
import Screen, { PreparedRetryReview } from './view';
import { spWriteApprovalFixtures } from '../../writes/approval-fixtures';
import { confirmationProposals } from '../optimizer-confirm/render-fixture';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders results loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders shared error evidence', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-results' })} reset={() => {}} />, text: 'synthetic-results' },
  { state: 'gated', name: 'explains unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'explains absent profiles', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'keeps outcome questions unanswered before sync', render: () => <Screen data={ready} />, text: 'Not yet answerable' },
  { state: 'stale', name: 'requires fresh unresolved values', render: () => <Screen data={{ ...ready, props: { ...ready.props, retry: true, operation: operationFixture('partial') } }} />, text: 'Fresh preview required' },
  { state: 'refused', name: 'requires evaluation when original values changed', render: () => <Screen data={{ ...ready, props: { ...ready.props, retry: true, operation: operationFixture('partial') } }} />, text: 'A changed bid requires a fresh evaluation.' },
  { state: 'ready', name: 'renders partial results from saved operation evidence', render: () => <Screen data={{ ...ready, props: { ...ready.props, operation: operationFixture('partial') } }} />, text: '1 change applied. 1 needs attention.' },
]);

it('requests retry eligibility from the saved operation without sending browser row eligibility', async () => {
  const operation = operationFixture('partial');
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'source_changed' }), { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ ...ready, props: { ...ready.props, retry: true, operation } }} />);
  expect(screen.getByText(/successful changes are excluded/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh unresolved change' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/optimizer/retry');
  const body = JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['batchId','original','profileId','requestId']);
  expect(body['original']).toEqual(operation.detail.operation);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('fresh evaluation'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh unresolved change' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(JSON.parse((fetcher.mock.calls[1]?.[1] as RequestInit).body as string)).toEqual(body);
});
it('renders retry results from its own operation and the saved excluded-success lineage', () => {
  const operation = operationFixture('single');
  render(<Screen data={{ ...ready, props: { ...ready.props, operation, retryDetails: { excludedSuccessfulNames: ['Synthetic earlier success'] } } }} />);
  expect(screen.getByRole('heading', { name: 'Retry results' })).toBeTruthy();
  expect(screen.getByTestId('optimizer-result-counts').textContent).toBe('Requested 1 · Attempted 1 · Accepted 1 · Failed 0 · Confirmed in sync 0');
  expect(screen.getByText(/Synthetic earlier success was not sent again/)).toBeTruthy();
});

it('reviews the refreshed retry source and its own count before offering confirmation', async () => {
  const fixtures = await spWriteApprovalFixtures();
  const onReview = vi.fn();
  render(<PreparedRetryReview saved={{ preview: fixtures.ready.preview,
    excludedSuccessfulRows: [{ applyRowId: '77777777-7777-4777-8777-777777777777', name: 'Synthetic earlier success' }] }}
    proposals={confirmationProposals(fixtures.ready)} onBack={() => {}} onReview={onReview} />);
  expect(screen.getByRole('table', { name: 'Refreshed retry changes' }).querySelectorAll('tbody tr')).toHaveLength(1);
  expect(screen.getByRole('cell', { name: '$0.90' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: '$0.70' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: 'ACOS above target' })).toBeTruthy();
  expect(screen.getByText(/earlier successful changes are excluded: Synthetic earlier success/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review 1 selected change' }));
  expect(onReview).toHaveBeenCalledOnce();
});
