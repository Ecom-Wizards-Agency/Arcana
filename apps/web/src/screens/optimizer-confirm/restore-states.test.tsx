// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpWriteConfirmedApprovalRequest, SpWriteRestoreExportRequest } from '@wizard-ads/shared/sp-write-application';
import { profile } from '../synthetic-render-fixtures';
import { restoreApprovalFixture, restoreExportFixture } from '../../writes/approval-fixtures';
import Screen, { ConfirmContent } from './view';
import { RestoreExportContent } from './restore-export';
import { optimizerBatchHref } from '../optimizer/navigation';
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigation.push, replace: vi.fn(), refresh: vi.fn() }) }));
const recorded = await restoreApprovalFixture();
const fallback = await restoreExportFixture();
const source = recorded.preview.plan.source;
if (source.kind !== 'apply_batch' || !source.restoreProposal) throw new Error('Synthetic restore missing');
const batchId = source.restoreProposal.sourceBatchId;
afterEach(() => vi.unstubAllGlobals());

it('keeps the live Amazon confirmation disabled in server HTML until its handler mounts', () => {
  const view = <Screen data={{ view: 'ready', props: { profile, batchId, proposals: [], recorded, applyBatchId: null } }} />;
  const server = document.createElement('div');
  server.innerHTML = renderToStaticMarkup(view);
  const terminal = [...server.querySelectorAll('button')].find((button) => button.textContent === 'Yes, apply 1 changes to Amazon');
  expect(terminal).toBeDefined();
  expect(terminal!.disabled).toBe(true);
  render(view);
  expect(screen.getByRole('button', { name: 'Yes, apply 1 changes to Amazon' }).hasAttribute('disabled')).toBe(false);
});
it('keeps the live export note and confirmation disabled until their handlers mount', () => {
  const view = <Screen data={{ view: 'export-only', props: { profile, restoreExport: fallback } }} />;
  const server = document.createElement('div');
  server.innerHTML = renderToStaticMarkup(view);
  const terminal = [...server.querySelectorAll('button')].find((button) => button.textContent === 'Export restore proposal (1 changes)');
  expect(terminal).toBeDefined();
  expect(terminal!.disabled).toBe(true);
  expect(server.querySelector('textarea')!.disabled).toBe(true);
  render(view);
  expect(screen.getByRole('button', { name: 'Export restore proposal (1 changes)' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByLabelText('Restore note').hasAttribute('disabled')).toBe(false);
});

it('shows every immutable restore row, field, current read time, destination and source count', () => {
  render(<ConfirmContent recorded={recorded} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.getByTestId('restore-source').textContent).toBe(`Restore of batch ${batchId} · 1 rows`);
  expect(screen.getByRole('table', { name: 'Immutable restore preview' }).querySelectorAll('tbody tr')).toHaveLength(recorded.preview.plan.counts.providerRows);
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Row', 'Field', 'Current', 'Restore to']);
  expect(screen.getByText(`Read at ${recorded.preview.plan.frozenAt}`)).toBeTruthy();
  expect(screen.getByRole('cell', { name: '$0.70' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Yes, apply 1 changes to Amazon' }).hasAttribute('disabled')).toBe(false);
});
it.each(['gate_disabled', 'grant_changed'] as const)('disables the restore terminal control for %s and names the missing gate', (reason) => {
  render(<ConfirmContent recorded={{ ...recorded, gates: { environmentEnabled: reason !== 'gate_disabled', profileAllowlisted: reason !== 'grant_changed' }, freshness: { checkedAt: recorded.freshness.checkedAt, status: 'stale', reasons: [reason] } }} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.getByRole('button', { name: 'Yes, apply 1 changes to Amazon' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(reason === 'gate_disabled' ? 'Environment write gate is disabled' : 'Profile allowlist is not enabled')).toBeTruthy();
  if (reason === 'grant_changed') expect(screen.getByRole('link', { name: 'Review export proposal' }).getAttribute('href')).toContain('restoreExport=1');
  else expect(screen.queryByRole('link', { name: 'Review export proposal' })).toBeNull();
});
it('requires fresh approval for a newer enabled grant without claiming that profile writes are disabled', () => {
  render(<ConfirmContent recorded={{ ...recorded, gates: { environmentEnabled: true, profileAllowlisted: true }, freshness: { checkedAt: recorded.freshness.checkedAt, status: 'stale', reasons: ['grant_changed'] } }} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.getByRole('button', { name: 'Refresh unresolved change' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Review export proposal' })).toBeNull();
  expect(screen.queryByText('Profile allowlist is not enabled')).toBeNull();
});
it.each(['current_value_changed', 'source_changed', 'entity_unavailable'] as const)('requires a new restore approval for %s', (reason) => {
  render(<ConfirmContent recorded={{ ...recorded, freshness: { checkedAt: recorded.freshness.checkedAt, status: reason === 'entity_unavailable' ? 'unavailable' : 'stale', reasons: [reason] } }} batchId={batchId} onConfirm={() => {}} onRefresh={() => {}} />);
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
  expect(screen.getByRole('button', { name: 'Refresh unresolved change' })).toBeTruthy();
  expect(screen.getAllByText('Fresh preview required')).toHaveLength(recorded.preview.plan.counts.providerRows);
});
it('sends restore approval through the existing authenticated write endpoint with the immutable binding', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'source_changed' }), { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  render(<Screen data={{ view: 'ready', props: { profile, batchId, proposals: [], recorded, applyBatchId: null } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Yes, apply 1 changes to Amazon' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/writes/approve');
  const request = SpWriteConfirmedApprovalRequest.parse(JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string));
  expect(request.approval.plan).toEqual(recorded.preview.binding);
  expect(request.confirmation).toBe('Yes, apply 1 changes to Amazon');
  expect(request.approval.approvalMode).toBe('manual');
});
it('refreshes a stale restore retry from its parent operation so the active child does not block reconstruction', () => {
  const stale = structuredClone(recorded);
  if (stale.preview.plan.source.kind !== 'apply_batch') throw new Error('Synthetic apply source missing');
  const origin = { executionId: '33333333-3333-4333-8333-333333333333', planId: '44444444-4444-4444-8444-444444444444', planFingerprint: 'b'.repeat(64) };
  stale.preview.plan.source.retryOrigin = origin;
  stale.freshness = { ...stale.freshness, status: 'stale', reasons: ['expired'] };
  render(<Screen data={{ view: 'ready', props: { profile, batchId, proposals: [], recorded: stale, applyBatchId: null } }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh unresolved change' }));
  expect(navigation.push).toHaveBeenLastCalledWith(optimizerBatchHref('run', batchId, profile.id, { execution: origin.executionId, plan: origin.planId, retry: '1' }));
});
it('exports only after the truthful terminal action and reconciles the saved export count', async () => {
  const output = { batchId: '11111111-1111-4111-8111-111111111111', sourceBatchId: fallback.batchId, tag: 'Synthetic restore export', rows: 1, artifactSha256: 'a'.repeat(64), files: { rows: 'synthetic.json' }, downloads: { rows: '/api/recommendations/export/synthetic?format=rows' }, amazonUpdated: false, guardrail: 'This is a review file only. Arcana did not update Amazon.' };
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(output), { status: 201 }));
  vi.stubGlobal('fetch', fetcher);
  render(<RestoreExportContent data={fallback} currencyCode="USD" />);
  expect(screen.getByRole('heading', { name: 'Amazon writes are not enabled for this profile' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Yes, apply/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Export restore proposal (1 changes)' }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('Add a note');
  fireEvent.change(screen.getByLabelText('Restore note'), { target: { value: 'Synthetic restore review' } });
  fireEvent.click(screen.getByRole('button', { name: 'Export restore proposal (1 changes)' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/time-machine/restore/export');
  const request = SpWriteRestoreExportRequest.parse(JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string));
  expect(request).toMatchObject({ profileId: fallback.profileId, batchId: fallback.batchId, fingerprint: fallback.fingerprint, expectedRows: 1 });
  await waitFor(() => expect(screen.getByTestId('reversion-result').textContent).toContain('Amazon was not updated.'));
  expect(screen.getByRole('link', { name: 'Download inverse rows JSON' }).getAttribute('href')).toBe(output.downloads.rows);
  expect(screen.getByRole('button', { name: 'Export restore proposal (1 changes)' }).hasAttribute('disabled')).toBe(true);
});
it('does not turn unknown synchronized values into zero in export preview', () => {
  const unknown = structuredClone(fallback);
  unknown.preview.rows[0]!.currentValue = null;
  unknown.preview.rows[0]!.currentSyncedAt = null;
  render(<RestoreExportContent data={unknown} currencyCode="EUR" />);
  expect(screen.getByRole('cell', { name: '— Read at —' })).toBeTruthy();
  expect(screen.queryByText('€0.00')).toBeNull();
});
it('shows only the ready export row and counts an excluded conflict with a source review link', () => {
  const mixed = structuredClone(fallback);
  mixed.preview.rows.push({ ...mixed.preview.rows[0]!, rowId: '55555555-5555-4555-8555-555555555555', entityId: 'synthetic-conflicting-keyword', entityName: 'Synthetic conflicting restore', currentValue: '1.20', state: 'conflict', conflict: true, exportAllowed: false, reason: 'Someone changed it after us' });
  mixed.preview.exportedProposals = 2;
  mixed.preview.reversibleRows = 2;
  mixed.preview.blockedRows = 1;
  mixed.preview.exportAllowed = false;
  render(<RestoreExportContent data={mixed} currencyCode="USD" />);
  expect(screen.getByRole('table', { name: 'Immutable restore preview' }).querySelectorAll('tbody tr')).toHaveLength(mixed.preview.readyRows);
  expect(screen.getByRole('cell', { name: 'Synthetic restore keyword' })).toBeTruthy();
  expect(screen.queryByRole('cell', { name: 'Synthetic conflicting restore' })).toBeNull();
  expect(screen.getByTestId('restore-export-excluded').textContent).toBe('1 row excluded from this export. Review excluded rows');
  const destination = new URL(screen.getByRole('link', { name: 'Review excluded rows' }).getAttribute('href')!, 'https://example.test');
  expect(destination.pathname).toBe('/change-queue');
  expect(destination.searchParams.get('profile')).toBe(mixed.profileId);
  expect(destination.searchParams.get('batch')).toBe(mixed.batchId);
  expect(screen.getByRole('button', { name: 'Export restore proposal (1 changes)' }).hasAttribute('disabled')).toBe(true);
});
