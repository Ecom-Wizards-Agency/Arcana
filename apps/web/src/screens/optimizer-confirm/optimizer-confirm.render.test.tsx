// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SpWriteConfirmedApprovalRequest, SpWriteRecordedPreview, spWriteConfirmation } from '@wizard-ads/shared/sp-write-application';
import { spWriteApprovalFixtures } from '../../writes/approval-fixtures';
import { verifyScreen } from '../render-test-support';
import SharedLoading from '../shared-loading';
import SharedError from '../shared-error';
import { profile } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { confirmationProposals } from './render-fixture';
import Screen, { ConfirmContent } from './view';
const fixtures = await spWriteApprovalFixtures();
const batchId = '77777777-7777-4777-8777-777777777777';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders confirmation loading', render: () => <SharedLoading />, text: '' },
  { state: 'error', name: 'renders recoverable confirmation failure', render: () => <SharedError error={new Error('Synthetic error')} reset={() => {}} />, text: 'Try again' },
  { state: 'gated', name: 'explains the database gate', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'keeps missing profiles explicit', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles' },
  { state: 'not-measured', name: 'refuses absent current synchronized state', render: () => <ConfirmContent recorded={fixtures.unavailable} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />, text: 'Fresh preview required' },
  { state: 'stale', name: 'requires refreshed values', render: () => <ConfirmContent recorded={fixtures.stale} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />, text: 'Refresh this preview' },
  { state: 'refused', name: 'refuses unsupported approval', render: () => <ConfirmContent recorded={fixtures.unavailable} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />, text: 'Fresh preview required' },
  { state: 'ready', name: 'renders the immutable preview', render: () => <ConfirmContent recorded={fixtures.ready} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />, text: spWriteConfirmation(fixtures.ready.preview.plan.counts.logicalChanges) },
]);
it('shows the contract label and sends that exact text in the approval request', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixtures.queued.admission), { status: 200 }));
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ view: 'ready', props: { profile, batchId, proposals: [], recorded: fixtures.ready, applyBatchId: null } }} />);
  const text = spWriteConfirmation(fixtures.ready.preview.plan.counts.logicalChanges);
  fireEvent.click(screen.getByRole('button', { name: text }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/writes/approve');
  const request = SpWriteConfirmedApprovalRequest.parse(JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string));
  expect(request.confirmation).toBe(text);
  expect(request.approval.plan).toEqual(fixtures.ready.preview.binding);
});
it('renders stale refusal with no confirmation control', () => {
  render(<ConfirmContent recorded={fixtures.stale} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Refresh this preview' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh unresolved change' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Current values changed after this preview was prepared' })).toBeTruthy();
});
it.each([
  ['expired', 'This preview has expired.'],
  ['profile_changed', 'The profile changed after this preview was prepared.'],
  ['grant_changed', 'Write permissions changed after this preview was prepared.'],
  ['gate_disabled', 'The write gate is disabled.'],
  ['source_changed', 'The saved source changed after this preview was prepared.'],
  ['entity_unavailable', 'Current entity state is unavailable.'],
  ['unsupported_action', 'This action is not supported by the current write gateway.'],
] as const)('names %s without inventing a changed bid', (reason, message) => {
  const recorded = SpWriteRecordedPreview.parse({ ...fixtures.ready, freshness: {
    checkedAt: fixtures.ready.freshness.checkedAt, reasons: [reason], status: ['entity_unavailable', 'unsupported_action'].includes(reason) ? 'unavailable' : 'stale',
  } });
  render(<ConfirmContent recorded={recorded} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.getByRole('heading', { name: message })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: /Current values changed/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
});
it('never renders an approval control for a shadow batch', () => {
  const recorded = structuredClone(fixtures.ready);
  if (!recorded.preview.evidence || recorded.preview.evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v2') throw new Error('Expected synthetic recommendation evidence');
  for (const row of recorded.preview.evidence.provenance.rows) row.method = { methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1', traceSha256: 'a'.repeat(64), settingSourcesSha256: 'b'.repeat(64) };
  render(<ConfirmContent recorded={recorded} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
  expect((screen.getByRole('button', { name: 'Send to Amazon unavailable in shadow' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows campaign scope from the recorded source identities and formats the immutable money', () => {
  const proposals = confirmationProposals(fixtures.ready);
  render(<ConfirmContent recorded={fixtures.ready} batchId={batchId} proposals={[...proposals, { ...proposals[0]!, id: 'unrelated-recommendation', campaignId: 'unrelated-campaign' }]} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.getByText('These changes affect 1 target in 1 campaign.')).toBeTruthy();
  expect(screen.getByText('Synthetic campaign 1')).toBeTruthy();
  expect(screen.getByRole('cell', { name: '$0.90' })).toBeTruthy();
  expect(screen.getByRole('cell', { name: '$0.70' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Review limits and settings' }).className).toContain('action');
  expect(screen.getByRole('heading', { name: 'Apply 1 bid change to Amazon' }).parentElement?.className).toContain('card');
});
