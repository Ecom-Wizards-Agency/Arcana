// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SignalsLegend } from './cells/SignalsLegend.js';
import { SIGNAL_AXES } from './cells/signals.js';
import { NumericValue } from './primitives/NumericValue.js';
import { ColumnManager, moveChosenColumn } from './toolbar/ColumnManager.js';
import { GroupBar } from './toolbar/GroupBar.js';
import { columnsFor, defaultVisibleColumns, minimumColumnWidth } from './columns.js';
import { DIMENSION_DRAG_TYPE } from './grouping.js';
import type { SavedView } from './views.js';
import { managerColumnGroups } from './toolbar/column-groups.js';
import { GridCell } from './grid/GridCell.js';
import { bodyRowStyle } from './grid/styles.js';
import { buildGridModel } from './pipeline.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { isGroupedRow } from './aggregate.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const available = columnsFor('targets');
const view: SavedView = { id: 'synthetic', name: 'Synthetic view', entity: 'targets', columns: ['targeting', 'bid', 'spend'], pinned: ['targeting'], widths: {}, filter: { groups: [] }, groupBy: [], sort: [], dateRange: null, updatedAt: '2026-08-29' };
// WP-316 (V23): the legend no longer opens on hover as a large panel over the
// rows; it opens on request as a compact popover and is dismissible four ways.
it('opens the compact SIGNALS legend on request only and dismisses it without losing an explanation', () => {
  render(<SignalsLegend />);
  const trigger = screen.getByRole('button', { name: 'SIGNALS legend' });
  fireEvent.mouseEnter(trigger.parentElement!);
  fireEvent.mouseEnter(trigger);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  const legend = screen.getByRole('dialog', { name: 'SIGNALS legend' });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(legend.querySelectorAll('[data-signal-axis]')).toHaveLength(SIGNAL_AXES.length);
  for (const axis of SIGNAL_AXES) expect(legend.textContent).toContain(axis.description);
  expect(legend.textContent).toContain('unknown');
  expect(legend.textContent).toContain('never means zero');
  expect(legend.style.width).toBe('320px');
  expect(legend.style.maxHeight).toBe('360px');
  expect(legend.style.overflowY).toBe('auto');
  fireEvent.keyDown(legend, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.scroll(document);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Close legend' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('never shows an overflowing numeric prefix without its marker and full accessible value', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(40);
  render(<NumericValue value="15.3%" />);
  const value = screen.getByLabelText('15.3%');
  expect(value.getAttribute('data-truncated')).toBe('true');
  expect(value.querySelector('[data-truncation-marker]')).not.toBeNull();
  expect(value.title).toBe('15.3%');
  expect(value.firstElementChild?.textContent).toBe('15.3%');
  expect((value.firstElementChild as HTMLElement).style.textOverflow).toBe('ellipsis');
  expect(screen.queryByText('5.3%')).toBeNull();
  expect(minimumColumnWidth(available.find((column) => column.id === 'targeting')!)).toBeGreaterThan(0);
});
it('shows the grouping zone only for a dimension drag and reorders ordinal levels by keyboard', () => {
  const change = vi.fn();
  const { rerender } = render(<GroupBar dimensions={available.filter((column) => column.kind === 'dimension')} groupBy={[]} onChange={change} restingHidden />);
  const zone = screen.getByTestId('grid-group-bar');
  expect(zone.hidden).toBe(true);
  fireEvent.dragStart(document.body, { dataTransfer: { types: ['application/x-wizard-ads-column'], getData: () => 'spend' } });
  expect(zone.hidden).toBe(true);
  fireEvent.dragStart(document.body, { dataTransfer: { types: [DIMENSION_DRAG_TYPE], getData: () => 'campaign_name' } });
  expect(zone.hidden).toBe(false);
  expect(zone.textContent).toContain('Drop to group by Campaign');
  fireEvent.dragEnd(document.body);
  expect(zone.hidden).toBe(true);
  rerender(<GroupBar dimensions={available} groupBy={['campaign_name', 'match_type']} onChange={change} restingHidden />);
  expect(screen.getAllByTestId('grid-group-chip')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Move Campaign down' }));
  expect(change).toHaveBeenCalledWith(['match_type', 'campaign_name']);
});
it('column manager reconciles counts, search, selection, reset, remove, sizing, alignment and save', async () => {
  const apply = vi.fn(); const save = vi.fn().mockResolvedValue(undefined);
  render(<ColumnManager available={available.map((column) => ({ ...column, measurementStatus: column.subject === 'SQP' ? 'needs-ingestion' : 'available' }))} view={view} onApply={apply} onSave={save} onClose={vi.fn()} />);
  const chooser = screen.getByRole('region', { name: 'Available columns' });
  expect(chooser.querySelectorAll('input[type="checkbox"]')).toHaveLength(available.length);
  expect(within(screen.getByRole('navigation', { name: 'Column groups' })).getAllByRole('button')).toHaveLength(managerColumnGroups(available).length + 1);
  expect(screen.getAllByText('needs ingestion')).toHaveLength(available.filter((column) => column.subject === 'SQP').length);
  fireEvent.change(screen.getByLabelText('Search columns'), { target: { value: 'organic' } });
  const matches = chooser.querySelectorAll('input[type="checkbox"]').length;
  expect(matches).toBeGreaterThan(0); expect(matches).toBeLessThan(available.length);
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  expect([...chooser.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((input) => input.checked)).toBe(true);
  fireEvent.change(screen.getByLabelText('Width Bid'), { target: { value: '123' } });
  fireEvent.change(screen.getByLabelText('Alignment Bid'), { target: { value: 'left' } });
  fireEvent.change(screen.getByLabelText('Preset name'), { target: { value: 'Synthetic review' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '+ Save current' })));
  expect(save).toHaveBeenCalledWith('Synthetic review', expect.objectContaining({ widths: { bid: 123 }, alignments: { bid: 'left' } }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove all' }));
  expect(document.querySelectorAll('[data-chosen-column]')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
  expect(document.querySelectorAll('[data-chosen-column]')).toHaveLength(defaultVisibleColumns('targets').length);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Apply' })));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ columns: defaultVisibleColumns('targets') }));
});
it('moves columns across the pin divider with a visible insertion line', () => {
  const apply = vi.fn();
  render(<ColumnManager available={available} view={view} onApply={apply} onClose={vi.fn()} />);
  const bid = document.querySelector('[data-chosen-column="bid"]')!;
  fireEvent.dragStart(bid, { dataTransfer: { setData: vi.fn() } });
  const divider = document.querySelector('[data-pin-divider="true"]')!;
  fireEvent.dragOver(divider);
  expect(divider.querySelector('[data-insertion-line]')).not.toBeNull();
  fireEvent.drop(divider);
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  expect(apply).toHaveBeenCalledWith(expect.objectContaining({ pinned: ['targeting', 'bid'], columns: ['targeting', 'bid', 'spend'] }));
  const unpinned = moveChosenColumn({ ...view, pinned: ['targeting', 'bid'] }, 'bid', null, false);
  expect(unpinned.pinned).toEqual(['targeting']);
  expect(unpinned.columns).toEqual(['targeting', 'spend', 'bid']);
});
it('retains ancestor values and counts, tints depths, and draws a group share from the allowed total', () => {
  const rows = syntheticSearchTermRows(2).map((row, index) => ({ ...row,
    dimensions: { ...row.dimensions, campaign_name: 'Synthetic campaign', match_type: index ? 'phrase' : 'exact' },
    totals: { ...row.totals, spend: index ? 75 : 25 },
  }));
  const model = buildGridModel(rows, { groupBy: ['campaign_name', 'match_type'], totals: 'sum' });
  const child = model.rows.find((row) => isGroupedRow(row) && row.groupDepth === 1)!;
  const environment = { context: { currencyCode: 'USD' }, collapsedGroupIds: new Set<string>(), onToggleGroup: vi.fn(), totalsRow: model.totalsRow };
  render(<><GridCell row={child} column={available.find((column) => column.id === 'campaign_name')!} {...environment} /><GridCell row={child} column={available.find((column) => column.id === 'match_type')!} {...environment} /></>);
  expect(screen.getByText('Synthetic campaign').querySelector('sup')?.textContent).toBe('1');
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('25');
  expect(screen.getByText('25%')).toBeTruthy();
  const state = { height: 30, index: 0, clickable: false, selected: false, focused: false };
  expect(bodyRowStyle({ ...state, group: { depth: 0, isLeaf: false } }).background).not.toBe(bodyRowStyle({ ...state, group: { depth: 1, isLeaf: true } }).background);
  cleanup();
  render(<GridCell row={child} column={available.find((column) => column.id === 'match_type')!} {...environment} totalsRow={null} />);
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.getByLabelText('Share of total spend unavailable').textContent).toBe('—');
});

it.each(['zero', 'missing'] as const)('discloses an unavailable group share for a %s total', (measurement) => {
  const rows = syntheticSearchTermRows(2).map((row) => ({ ...row, totals: { ...row.totals, spend: 0 },
    ...(measurement === 'missing' ? { measurement: { missing: ['spend' as const], comparisonMissing: [] } } : {}),
  }));
  const model = buildGridModel(rows, { groupBy: ['campaign_name'], totals: 'sum' });
  render(<GridCell row={model.rows[0]!} column={available.find((column) => column.id === 'campaign_name')!}
    context={{ currencyCode: 'USD' }} collapsedGroupIds={new Set()} onToggleGroup={vi.fn()} totalsRow={model.totalsRow} />);
  expect(screen.getByLabelText('Share of total spend unavailable').textContent).toBe('—');
  expect(screen.queryByRole('meter')).toBeNull();
  expect(document.querySelector('[data-group-share]')?.textContent).not.toContain('0.00');
});
