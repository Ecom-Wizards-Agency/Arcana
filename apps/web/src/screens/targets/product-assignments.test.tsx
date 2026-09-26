// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProductAssignmentBanner } from '../grid/performance-chrome';
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('from=2026-09-01&to=2026-09-02') }));
const profileId = '00000000-0000-4000-8000-000000000001';
const item = { adGroupId: 'synthetic-group', campaignId: 'synthetic-campaign', name: 'Synthetic group', asins: ['B000000001','B000000002'], spend: 20, assignedAsin: null, source: 'unassigned', derivedAt: '2026-09-01T00:00:00.000Z', derived: { asin: null, source: 'unassigned' }, ambiguous: false, reason: null, candidates: [] };
const list = { profileId, start: '2026-09-01', end: '2026-09-02', days: 2, canAssign: true, items: [item], count: 1, unassignedCount: 1, unassignedSpend: 20 };
afterEach(() => vi.unstubAllGlobals());
it('lists every candidate, saves the chosen ASIN, and recounts from the server', async () => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open',''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(list)).mockResolvedValueOnce(Response.json({ assigned: 1 })).mockResolvedValueOnce(Response.json({ ...list, items: [{ ...item, assignedAsin: item.asins[0], source: 'manual' }], unassignedCount: 0, unassignedSpend: 0 }));
  vi.stubGlobal('fetch',fetcher);
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  fireEvent.click(await screen.findByRole('button',{ name: 'Link them' }));
  const notice = screen.getByTestId('grid-unattributed').textContent;
  expect(notice).toContain('1 ad group needs a product check · $20.00 of spend over 2 days');
  expect(notice).toContain('Arcana reads each target’s organic rank, search query share and rank verdict against its ad group’s product');
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getAllByTestId('product-assignment-row')).toHaveLength(list.count);
  expect(within(dialog).getByText('1 ad group · 1 Sept 2026 – 2 Sept 2026')).toBeTruthy();
  expect(within(dialog).getByText('$20.00')).toBeTruthy();
  fireEvent.change(within(dialog).getByRole('combobox'),{ target: { value: item.asins[0] } });
  fireEvent.click(within(dialog).getByRole('button',{ name: 'Save assignment' }));
  await waitFor(() => expect(screen.queryByTestId('grid-unattributed')).toBeNull());
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({ action: 'assign', profileId, adGroupId: item.adGroupId, asin: item.asins[0] });
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
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({ ...list, canAssign: false, items: [item, { ...item, adGroupId: 'synthetic-other', name: 'Other group', spend: null }], count: 2, unassignedCount: 2 })));
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button',{name:'Link them'}));
  expect(screen.getByText('Not measured')).toBeTruthy();
  expect(screen.getByText('2 ad groups · 1 Sept 2026 – 2 Sept 2026')).toBeTruthy();
  expect(screen.getAllByRole('combobox').every((select) => select.hasAttribute('disabled'))).toBe(true);
});

for (const source of ['derived', 'derived_parent', 'proposed', 'manual', 'unassigned'] as const) {
  it(`renders ${source} with the appropriate controls and banner`, async () => {
    const unresolved = source === 'proposed' || source === 'unassigned';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...list,
      items: [{ ...item, source, assignedAsin: source === 'unassigned' ? null : item.asins[0], ambiguous: source === 'proposed',
        derived: source === 'manual' ? { asin: null, source: 'unassigned' } : { asin: source === 'unassigned' ? null : item.asins[0], source } }],
      unassignedCount: unresolved ? 1 : 0, unassignedSpend: unresolved ? 20 : 0,
    })));
    render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
    fireEvent.click(await screen.findByRole('button', { name: unresolved ? 'Link them' : 'Product assignments' }));
    expect(screen.getAllByTestId('product-assignment-row')).toHaveLength(1);
    const label = { derived: 'Derived', derived_parent: 'Derived parent', proposed: 'Proposed', manual: 'Manual', unassigned: 'Unassigned' }[source];
    expect(screen.getByText(label).getAttribute('data-assignment-source')).toBe(source);
    expect(screen.queryAllByRole('combobox')).toHaveLength(unresolved ? 1 : 0);
    expect(screen.queryAllByRole('button', { name: 'Save assignment' })).toHaveLength(unresolved ? 1 : 0);
    expect(screen.queryAllByRole('button', { name: 'Revert to derived' })).toHaveLength(source === 'manual' ? 1 : 0);
    expect(screen.queryByTestId('grid-unattributed') !== null).toBe(unresolved);
  });
}
it('reverts a manual choice and displays the refreshed derived result', async () => {
  const baseline={asin:'B000000099',source:'derived_parent'};
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json({...list,items:[{...item,source:'manual',assignedAsin:item.asins[0],derived:baseline}],unassignedCount:0,unassignedSpend:0}))
    .mockResolvedValueOnce(Response.json({assigned:1}))
    .mockResolvedValueOnce(Response.json({...list,items:[{...item,source:'derived_parent',assignedAsin:'B000000099',derived:baseline}],unassignedCount:0,unassignedSpend:0}));
  vi.stubGlobal('fetch',fetcher);
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button',{name:'Product assignments'}));
  expect(screen.getByText('Derived: B000000099 (derived parent)')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Revert to derived'}));
  expect(await screen.findByText('Assigned: B000000099')).toBeTruthy();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({action:'revert',profileId,adGroupId:item.adGroupId});
  expect(screen.queryByRole('combobox')).toBeNull();
});
it('shows an unassigned group with zero spend and disables saving when no product exists',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...list,items:[{...item,asins:[],spend:0,reason:'No enabled or paused product ads.'}],unassignedSpend:0})));
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button',{name:'Link them'}));
  expect(screen.getByText('No enabled or paused product ads.')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Save assignment'}).hasAttribute('disabled')).toBe(true);
});
it('shows a manual choice made before any derivation and never shows unmeasured unresolved spend as zero', async () => {
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({...list,items:[{...item,spend:null},{...item,adGroupId:'synthetic-manual',name:'Manual group',source:'manual',assignedAsin:item.asins[1],derived:null,derivedAt:null}],count:2,unassignedSpend:0})));
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button',{name:'Link them'}));
  expect(screen.getByTestId('grid-unattributed').textContent).toContain('1 ad group needs a product check · spend not measured over 2 days');
  expect(screen.getByTestId('grid-unattributed').textContent).not.toContain('$0.00');
  expect(screen.getByText('Not derived yet')).toBeTruthy();
  expect(screen.getAllByTestId('product-assignment-row')).toHaveLength(2);
});
it('shows a group awaiting its first derivation without counting it in the notice', async () => {
  const awaiting = { ...item, derived: null, derivedAt: null, spend: 40 };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...list, items: [awaiting], unassignedCount: 0, unassignedSpend: 0 })));
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button', { name: 'Product assignments' }));
  expect(screen.queryByTestId('grid-unattributed')).toBeNull();
  expect(screen.getByText('Awaiting first derivation')).toBeTruthy();
  expect(screen.getByText('Awaiting derivation').getAttribute('data-assignment-source')).toBe('awaiting');
});
it('explains a refusal to assign over a product Arcana has since derived', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ ...list, items: [{ ...item, source: 'proposed', assignedAsin: item.asins[0], ambiguous: true, derived: { asin: item.asins[0], source: 'proposed' } }] }))
    .mockResolvedValueOnce(Response.json({ error: 'Derived.', code: 'assignment_derived' }, { status: 409 }));
  vi.stubGlobal('fetch', fetcher);
  render(<ProductAssignmentBanner profileId={profileId} currencyCode="USD" enabled />);
  fireEvent.click(await screen.findByRole('button', { name: 'Link them' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save assignment' }));
  const message = 'Arcana has derived this ad group’s product since the list loaded, so there is nothing to confirm. Reload the list.';
  expect(await within(screen.getByRole('dialog')).findByText(message)).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
