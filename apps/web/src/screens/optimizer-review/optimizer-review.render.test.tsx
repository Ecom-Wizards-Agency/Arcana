// @vitest-environment jsdom
import Loading from '../../../app/optimizer/review/[batchId]/loading';
import { afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OneTimeRpcSnapshot } from '@wizard-ads/shared';
afterEach(() => vi.unstubAllGlobals());
import { rendered, verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';
import { ready as operationReady } from '../optimizer-run/render-fixture';
import { restoreOperationFixture } from '../../writes/approval-fixtures';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders review loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders shared error evidence', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-review' })} reset={() => {}} />, text: 'synthetic-review' },
  { state: 'gated', name: 'explains unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'explains absent profiles', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'keeps absent immutable evidence unavailable', render: () => <Screen data={{ ...ready, props: { ...ready.props, details: true } }} />, text: 'Unavailable' },
  { state: 'stale', name: 'renders a restore observation conflict', render: () => <Screen data={{ view: 'observation', props: { ...operationReady.props, operation: restoreOperationFixture('conflict') } }} />, text: 'Observed state conflicts with the request' },
  { state: 'refused', name: 'renders a restore refusal without an apply claim', render: () => <Screen data={{ view: 'observation', props: { ...operationReady.props, operation: restoreOperationFixture('refused') } }} />, text: 'Refused · Fresh preview required' },
  { state: 'ready', name: 'renders two saved suggestions with zero selected', render: () => <Screen data={ready} />, text: 'Select changes to continue' },
]);

it.each(['queued', 'running', 'failed'])('does not claim an empty %s preview completed', (status) => {
  const host = rendered(<Screen data={{ ...ready, props: { ...ready.props, review: { ...ready.props.review, status, proposals: [] } } }} />);
  expect(host.textContent).toContain(`Saved preview: ${status}`);
  expect(host.textContent).not.toContain('Preview completed.');
  expect(host.textContent).not.toContain('No changes were recommended.');
});
it('reports an empty completed preview only after saved success', () => {
  const host = rendered(<Screen data={{ ...ready, props: { ...ready.props, review: { ...ready.props.review, status: 'succeeded', proposals: [] } } }} />);
  expect(host.textContent).toContain('Preview completed. No changes were recommended.');
});

it('recovers a lost export response without accepting the already exported selection again', async () => {
  const snapshot = OneTimeRpcSnapshot.parse({ version: 1,
    configuration: { version: 1, method: 'sp.reference-efficiency', targetAcos: 0.27, bidFloor: 0.13, bidCeiling: 3.1,
      bidIncreaseCap: 0.17, bidDecreaseCap: 0.31, window: { start: '2026-07-01', end: '2026-07-28' } },
    profileTimezone: 'UTC', admittedAt: '2026-07-30T00:00:00Z', profileToday: '2026-07-30' });
  let decisions = 0; let exports = 0;
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (url === '/api/recommendations/decide') {
      decisions += 1;
      if (decisions > 1) return Response.json({ error: 'Rows are already exported' }, { status: 409 });
      return Response.json({ offered: 2, updated: 2, refused: [] });
    }
    expect(url).toBe('/api/optimizer/exports');
    exports += 1;
    if (exports === 1) throw new Error('Lost export response');
    const request = JSON.parse(init.body as string);
    return Response.json({ requestId: request.requestId, batchId: request.batchId,
      applyBatchId: '22222222-2222-4222-8222-222222222222',
      forwardRowIds: ['33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444'],
      counts: { offered: 2, accepted: 2, exported: 2, applyRows: 2 } });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ ...ready, props: { ...ready.props, exportFingerprint: 'a'.repeat(64),
    review: { ...ready.props.review, executionSnapshot: snapshot } } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Select both changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review 2 selected changes' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Lost export response'));
  fireEvent.click(screen.getByRole('button', { name: 'Review 2 selected changes' }));
  await waitFor(() => expect(exports).toBe(2));
  expect(decisions).toBe(1);
  expect(fetcher.mock.calls.map((call) => call[0])).toEqual(['/api/recommendations/decide','/api/optimizer/exports','/api/optimizer/exports']);
  expect(fetcher.mock.calls[1]?.[1].body).toEqual(fetcher.mock.calls[2]?.[1].body);
});
