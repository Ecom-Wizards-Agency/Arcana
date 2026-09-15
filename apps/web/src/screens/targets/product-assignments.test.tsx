// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductAssignmentBanner } from '../grid/performance-chrome';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('from=2026-09-01&to=2026-09-02') }));
const profileId = '00000000-0000-4000-8000-000000000001';
const item = { adGroupId: 'synthetic-group', campaignId: 'synthetic-campaign', name: 'Synthetic group', asins: ['B000000001','B000000002'], spend: 20, assignedAsin: null };
const list = { profileId, start: '2026-09-01', end: '2026-09-02', days: 2, canAssign: true, items: [item], count: 1, unassignedCount: 1, unassignedSpend: 20 };
afterEach(() => vi.unstubAllGlobals());
it('lists every candidate, saves the chosen ASIN, and recounts from the server', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({ assigned: 1 })).mockResolvedValueOnce(Response.json({ ...list, items: [{ ...item, assignedAsin: item.asins[0] }], unassignedCount: 0, unassignedSpend: 0 }));
  vi.stubGlobal('fetch',fetcher);
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  fireEvent.click(await screen.findByRole('button',{ name: 'Link them' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getAllByTestId('product-assignment-row')).toHaveLength(list.count);
  expect(within(dialog).getByText('$20.00')).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('combobox'),{ target: { value: item.asins[0] } });
  fireEvent.click(within(dialog).getByRole('button',{ name: 'Save assignment' }));
  await waitFor(() => expect(screen.queryByTestId('grid-unattributed')).toBeNull());
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ profileId, adGroupId: item.adGroupId, asin: item.asins[0] });
  expect(within(dialog).getByText('Assigned: B000000001')).toBeTruthy();
});
it('does not show a failed read as zero unresolved ad groups', async () => {
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('Synthetic failure')));
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.queryByTestId('grid-unattributed')).toBeNull();
  expect(screen.getByRole('button',{name:'Reload assignments'})).toBeTruthy();
});
it('keeps viewer pickers disabled and missing spend unmeasured', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({ ...list, canAssign: false, items: [item, { ...item, adGroupId: 'synthetic-other', name: 'Other group', spend: null }], count: 2 })));
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button',{name:'Link them'}));
  expect(screen.getByText('Not measured')).toBeTruthy();
  expect(screen.getAllByRole('combobox').every((select) => select.hasAttribute('disabled'))).toBe(true);
});
