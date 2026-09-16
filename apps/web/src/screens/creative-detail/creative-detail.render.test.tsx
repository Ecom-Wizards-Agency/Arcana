// @vitest-environment jsdom
import { verifyScreen } from '../render-test-support';
import Loading from '../shared-loading';
import SharedError from '../shared-error';
import { visualFixture } from '../creative/render-fixture';
import Screen from './view';
import { descriptor } from './descriptor';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders pending evidence', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders a safe read failure', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => {}} />, text: 'synthetic-reference' },
  { state: 'gated', name: 'keeps the membership gate explicit', render: () => <Screen data={visualFixture('membership-gated')} />, text: 'database' },
  { state: 'empty', name: 'keeps the absent profile roster explicit', render: () => <Screen data={visualFixture('no-profiles')} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'renders missing source evidence', render: () => <Screen data={visualFixture('quartiles-absent')} />, text: 'not measured' },
  { state: 'ready', name: 'renders its complete synthetic state', render: () => <Screen data={visualFixture('keywords-provenance')} />, text: 'Keyword source' },
]);

describe('Creative detail tabs', () => {
  it('renders all campaign keyword provenances without guessing an unresolved value', () => {
    render(<Screen data={visualFixture('keywords-provenance')} />);
    const table = screen.getByRole('region', { name: 'Creative by keyword' });
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByText('synced')).toBeTruthy();
    expect(within(table).getByText('from campaign name')).toBeTruthy();
    expect(within(table).getByText('unresolved')).toBeTruthy();
    expect(within(table).getByLabelText(/The campaign keyword is unresolved/).textContent).toBe('—');
    expect(table.textContent).toContain('3 campaigns · 2 keywords resolved');
    expect(screen.queryByRole('heading', { name: /Needs ingestion — Sponsored Brands/ })).toBeNull();
  });
  it('shows the keyword ingestion card only while the sync flag is off', () => {
    render(<Screen data={visualFixture('keywords-sync-off')} />);
    expect(screen.getByRole('heading', { name: 'Needs ingestion — Sponsored Brands keyword entities' })).toBeTruthy();
  });
  it('shows spend once per campaign with totals and share provenance', () => {
    render(<Screen data={visualFixture('spend')} />);
    const table = screen.getByRole('region', { name: 'Creative spend by campaign' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getAllByRole('columnheader')).toHaveLength(8);
    expect(screen.getByText(/Share is of this creative’s spend/)).toBeTruthy();
  });
  it('labels campaign placement facts and an absent modifier', () => {
    render(<Screen data={visualFixture('placements')} />);
    const table = screen.getByRole('region', { name: 'Campaign placement facts' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Top of search')).toBeTruthy();
    expect(within(table).getByLabelText(/Campaign placement modifier not synchronized/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'This split is the campaign’s, not this video’s' })).toBeTruthy();
  });
  it('renders the absence of placement facts without a zero-filled table', () => {
    render(<Screen data={visualFixture('placements-unmeasured')} />);
    expect(screen.getByRole('heading', { name: 'Placement facts are not measured' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Campaign placement facts' })).toBeNull();
  });
  it('renders stored exact, window and first certainty with unavailable listing evidence', () => {
    render(<Screen data={visualFixture('history')} />);
    const table = screen.getByRole('region', { name: 'Creative change history' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    for (const text of ['not observed → $1.37', 'Top of search → +17% (not observed before)', 'First seen in this ad group']) expect(within(table).getByText(text)).toBeTruthy();
    for (const text of ['exact', 'window · 4 days', 'first']) expect(within(table).getByText(text)).toBeTruthy();
    expect(within(table).queryByText('Listing')).toBeNull();
    expect(within(table).queryByText('Promotion')).toBeNull();
    const listing = screen.getByRole('region', { name: 'Listing observations' });
    expect(within(listing).getByTestId('sp-source-status').getAttribute('data-state')).toBe('unavailable');
    expect(within(listing).getByText(/No listing fields observed in this period/)).toBeTruthy();
    expect(screen.getByText('The judgement is made once when the change is recorded and stored, never recomputed on read.')).toBeTruthy();
  });
  it('renders recorded change values as prose in the profile currency, preserving unknowns and zero', () => {
    const data = visualFixture('history');
    if (data.view !== 'ready') throw new Error('Expected ready synthetic fixture');
    data.props.profile = { ...data.props.profile, currencyCode: 'EUR' };
    const cases = [
      ['Bid', 0.73, 1.37, '€0.73 → €1.37'],
      ['Bid', null, 1.37, 'not observed → €1.37'],
      ['Bid', '0', null, '€0.00 → not observed'],
      ['Bid', { unavailable: true }, { unavailable: true }, 'not observed → not observed'],
      ['Placement', { topOfSearch: 9, restOfSearch: 0 }, { topOfSearch: 17, restOfSearch: 0 }, 'Top of search +9% → +17%'],
      ['Placement', null, { topOfSearch: 17 }, 'Top of search → +17% (not observed before)'],
      ['Placement', { productPages: 0 }, { productPages: 8, restOfSearch: 0 }, 'Rest of search → +0% (not observed before); Product pages +0% → +8%'],
      ['Placement', { topOfSearch: 17 }, null, 'Top of search +17% → not observed'],
      ['Placement', null, { unsupported: true }, 'Placement change details not observed'],
      ['Creative', null, 'synthetic-asset-a', 'First seen in this ad group'],
    ] as const;
    const base = data.props.workspace.changes[0]!;
    data.props.workspace.changes = cases.map(([kind, oldValue, newValue], index) => ({ ...base, id: `synthetic-prose-${index}`, kind, oldValue, newValue }));
    render(<Screen data={data} />);
    const table = screen.getByRole('region', { name: 'Creative change history' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(cases.length);
    expect(rows.map((row) => within(row).getAllByRole('cell')[3]!.textContent)).toEqual(cases.map((row) => row[3]));
  });
});
