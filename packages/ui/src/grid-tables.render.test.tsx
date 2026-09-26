// @vitest-environment jsdom
/**
 * WP-316: the table interaction and readability fixes from the walkthrough,
 * each proved on the production grid. jsdom has no layout, so the virtualizer
 * gets the same one viewport-sized box as the other DataGrid suites.
 */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  MATCH_TYPE_LABELS,
  MatchType,
  PLACEMENT_LABELS,
  Placement,
  TARGET_EXPRESSION_LABELS,
  TARGET_EXPRESSION_TYPES,
} from '@wizard-ads/shared';
import { DataGrid } from './DataGrid.js';
import { SelectAllCheckbox, selectionState } from './cells/SelectAllCheckbox.js';
import { CONTROL_MIN_WIDTH, SCALE_MIN_WIDTH, columnsFor, minimumColumnWidth, type GridColumn } from './columns.js';
import { buildCategoricalOptions } from './filter-options.js';
import { buildGridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import { tokens } from './theme.js';
import { ColumnManager } from './toolbar/ColumnManager.js';
import { MANAGER_SUBJECTS, managerColumnGroups, nestColumnVariants } from './toolbar/column-groups.js';
import { describeFilter } from './toolbar/operators.js';
import { GRID_HEADER_BACKGROUND, GRID_HEADER_RULE, GRID_RULE } from './grid/styles.js';
import type { SavedView } from './views.js';

const VIEWPORT = { width: 1600, height: 900 };
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => VIEWPORT.width });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => VIEWPORT.height });

afterEach(cleanup);

const targets = columnsFor('targets');
const column = (id: string, level = targets): GridColumn => level.find((candidate) => candidate.id === id)!;
const zero = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
const selection: GridColumn = { id: 'selection', header: 'Select', kind: 'control', cell: 'selection', scale: 'text', align: 'left', width: 28, minWidth: 28, pinned: true };

function targetRow(id: string, dimensions: GridRow['dimensions'], totals: Partial<GridRow['totals']> = {}, comparison: Partial<GridRow['totals']> | null = null): GridRow {
  return { id, currencyCode: 'USD', dimensions: { campaign_name: 'Synthetic campaign', target_state: 'enabled', ...dimensions }, totals: { ...zero, spend: 10, sales: 40, clicks: 5, impressions: 100, ...totals }, comparison: comparison === null ? null : { ...zero, ...comparison } };
}

function Grid({ rows, columns, onWidthChange, groupBy = [] }: { rows: GridRow[]; columns: GridColumn[]; onWidthChange?: (id: string, width: number) => void; groupBy?: string[] }) {
  const model = buildGridModel(rows, { groupBy });
  return <DataGrid model={model} columns={columns} currencyCode="USD" sort={[]} onSortChange={() => {}} height={VIEWPORT.height} rowHeight={30}
    initialRect={VIEWPORT} {...(onWidthChange === undefined ? {} : { onWidthChange })} onReorder={() => {}} />;
}

/** A layout host: the grid's width callback feeds the widths it renders, as a saved view does. */
function PersistingGrid({ rows, columns, saved }: { rows: GridRow[]; columns: GridColumn[]; saved: (widths: Record<string, number>) => void }) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  return <Grid rows={rows} columns={columns.map((item) => widths[item.id] === undefined ? item : { ...item, width: widths[item.id]! })}
    onWidthChange={(id, width) => setWidths((current) => { const next = { ...current, [id]: width }; saved(next); return next; })} />;
}

const header = (name: string) => screen.getByRole('columnheader', { name });

describe('column resize (V4, J4, D2b)', () => {
  const columns = [selection, column('targeting'), column('spend'), column('bid')];
  const rows = [targetRow('a', { targeting: 'synthetic running shoes', target_kind: 'keyword', match_type: 'exact', bid: 1.25 })];

  it('draws a visible handle on every value column and none on the selection column', () => {
    render(<Grid rows={rows} columns={columns} onWidthChange={() => {}} />);
    const handles = screen.getAllByRole('separator');
    expect(handles.map((handle) => handle.getAttribute('aria-label'))).toEqual(['Resize Target', 'Resize Spend', 'Resize Bid']);
    for (const handle of handles) {
      expect(handle.style.background).toContain(GRID_HEADER_RULE);
      expect(handle.style.cursor).toBe('col-resize');
      expect(handle.getAttribute('aria-orientation')).toBe('vertical');
      expect(handle.tabIndex).toBe(0);
    }
    expect(within(header('Select')).queryByRole('separator')).toBeNull();
  });

  it('follows the pointer, clamps to the column minimum and persists the width it draws', () => {
    const saved = vi.fn();
    render(<PersistingGrid rows={rows} columns={columns} saved={saved} />);
    const spend = header('Spend');
    const start = Number.parseFloat(spend.style.width);
    const handle = within(spend).getByRole('separator');
    fireEvent.mouseDown(handle, { button: 0, clientX: 500 });
    // A header is also the drag source for reordering and grouping; the edge
    // must not start that drag, which is what swallowed every resize.
    expect(fireEvent.dragStart(spend, { dataTransfer: { setData: vi.fn(), types: [] } })).toBe(false);
    fireEvent.mouseMove(window, { clientX: 560 });
    fireEvent.mouseMove(window, { clientX: 580 });
    fireEvent.mouseUp(window);
    expect(Number.parseFloat(header('Spend').style.width)).toBe(start + 80);
    expect(saved).toHaveBeenLastCalledWith({ spend: start + 80 });
    expect(within(header('Spend')).getByRole('separator').getAttribute('aria-valuenow')).toBe(String(start + 80));
    // Released: the header drags again, and moving the pointer no longer resizes.
    expect(fireEvent.dragStart(header('Spend'), { dataTransfer: { setData: vi.fn(), types: [] } })).toBe(true);
    fireEvent.mouseMove(window, { clientX: 900 });
    expect(Number.parseFloat(header('Spend').style.width)).toBe(start + 80);
    // A money column never narrows below the width an ordinary figure needs.
    const bid = within(header('Bid')).getByRole('separator');
    fireEvent.mouseDown(bid, { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);
    expect(Number.parseFloat(header('Bid').style.width)).toBe(SCALE_MIN_WIDTH.money);
    expect(saved).toHaveBeenLastCalledWith({ spend: start + 80, bid: SCALE_MIN_WIDTH.money });
  });

  it('starts numeric reference columns wide enough for an ordinary figure (widths cut numbers)', () => {
    const floors: Array<[string, number]> = [['bid', SCALE_MIN_WIDTH.money], ['spend', SCALE_MIN_WIDTH.money], ['suggested_bid', SCALE_MIN_WIDTH.money],
      ['acos', SCALE_MIN_WIDTH.percent], ['top_of_search_share', SCALE_MIN_WIDTH.percent], ['clicks', SCALE_MIN_WIDTH.integer], ['organic_rank', SCALE_MIN_WIDTH.integer]];
    for (const [id, floor] of floors) expect(minimumColumnWidth(column(id)), id).toBe(floor);
    // Text columns keep their narrow reference floors; the identity column still truncates, not the figures.
    expect(minimumColumnWidth(column('targeting'))).toBe(40);
    render(<Grid rows={rows} columns={[column('targeting'), column('acos'), column('clicks')]} />);
    expect(Number.parseFloat(header('ACOS').style.width)).toBe(SCALE_MIN_WIDTH.percent);
    expect(Number.parseFloat(header('Clicks').style.width)).toBe(SCALE_MIN_WIDTH.integer);
  });

  it('reorders chosen columns by dragging them within the column manager list', () => {
    const apply = vi.fn();
    const view: SavedView = { id: 'synthetic', name: 'Synthetic', entity: 'targets', columns: ['targeting', 'bid', 'spend', 'acos'], pinned: ['targeting'], widths: {}, filter: { groups: [] }, groupBy: [], sort: [], dateRange: null, updatedAt: '2026-09-25' };
    render(<ColumnManager available={targets} view={view} onApply={apply} onClose={vi.fn()} />);
    fireEvent.dragStart(document.querySelector('[data-chosen-column="acos"]')!, { dataTransfer: { setData: vi.fn() } });
    fireEvent.dragOver(document.querySelector('[data-chosen-column="bid"]')!);
    expect(document.querySelector('[data-chosen-column="bid"] [data-insertion-line]')).not.toBeNull();
    fireEvent.drop(document.querySelector('[data-chosen-column="bid"]')!);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ columns: ['targeting', 'acos', 'bid', 'spend'], pinned: ['targeting'] }));
  });

  it('does not sort the column whose edge was just released over its own header', async () => {
    const sortChange = vi.fn();
    render(<DataGrid model={buildGridModel(rows)} columns={columns} currencyCode="USD" sort={[]} onSortChange={sortChange} height={VIEWPORT.height}
      rowHeight={30} initialRect={VIEWPORT} onWidthChange={() => {}} />);
    const spend = header('Spend');
    fireEvent.mouseDown(within(spend).getByRole('separator'), { button: 0, clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 470 });
    fireEvent.mouseUp(window);
    fireEvent.click(spend);
    expect(sortChange).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(header('Spend'));
    expect(sortChange).toHaveBeenCalledTimes(1);
  });

  it('resizes from the keyboard and fits the content on Home', () => {
    const change = vi.fn();
    render(<Grid rows={rows} columns={columns} onWidthChange={change} />);
    const handle = within(header('Target')).getByRole('separator');
    const width = Number(handle.getAttribute('aria-valuenow'));
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(change.mock.calls).toEqual([['targeting', width + 8], ['targeting', width - 32], ['targeting', expect.any(Number)]]);
  });
});

describe('selection column and select-all (J4)', () => {
  it('reports none, some and all, with the native mixed state for a partial selection', () => {
    expect(selectionState(['a', 'b'], new Set())).toBe('none');
    expect(selectionState(['a', 'b'], new Set(['b', 'x']))).toBe('some');
    expect(selectionState(['a', 'b'], new Set(['a', 'b']))).toBe('all');
    expect(selectionState([], new Set(['a']))).toBe('none');
    const change = vi.fn();
    const { rerender } = render(<SelectAllCheckbox state="none" count={2} onChange={change} />);
    const box = screen.getByRole('checkbox', { name: 'Select all 2 rows' }) as HTMLInputElement;
    expect([box.checked, box.indeterminate, box.getAttribute('aria-checked')]).toEqual([false, false, 'false']);
    fireEvent.click(box);
    rerender(<SelectAllCheckbox state="some" count={2} onChange={change} />);
    expect([box.checked, box.indeterminate, box.getAttribute('aria-checked')]).toEqual([false, true, 'mixed']);
    fireEvent.click(box);
    rerender(<SelectAllCheckbox state="all" count={2} onChange={change} />);
    expect([box.checked, box.indeterminate, box.getAttribute('aria-checked')]).toEqual([true, false, 'true']);
    fireEvent.click(box);
    expect(change.mock.calls).toEqual([[true], [true], [false]]);
    rerender(<SelectAllCheckbox state="none" count={0} onChange={change} />);
    expect(box.disabled).toBe(true);
  });

  it('draws the checkbox column centred, unpadded and wide enough for the box', () => {
    const rows = [targetRow('a', { targeting: 'synthetic', target_kind: 'keyword' })];
    render(<DataGrid model={buildGridModel(rows)} columns={[selection, column('targeting')]} currencyCode="USD" sort={[]} onSortChange={() => {}}
      height={VIEWPORT.height} rowHeight={30} initialRect={VIEWPORT}
      renderHeader={{ selection: () => <SelectAllCheckbox state="some" count={1} onChange={() => {}} /> }}
      renderCell={{ selection: (row) => <input type="checkbox" aria-label={`Select ${row.id}`} /> }} />);
    const head = header('Select');
    expect(Number.parseFloat(head.style.width)).toBe(CONTROL_MIN_WIDTH);
    expect(head.style.padding).toBe('0px');
    expect(head.style.justifyContent).toBe('center');
    const label = within(head).getByRole('checkbox').parentElement!;
    expect(label.style.overflow).toBe('visible');
    const cell = screen.getByRole('checkbox', { name: 'Select a' }).parentElement!;
    expect([cell.style.padding, cell.style.overflow, cell.style.justifyContent]).toEqual(['0px', 'visible', 'center']);
    expect(head.getAttribute('aria-sort')).toBeNull();
  });
});

describe('row, column and header separation (V15)', () => {
  it('paints the header as its own band and rules every row and column with grid tokens', () => {
    const rows = [targetRow('a', { targeting: 'synthetic one', target_kind: 'keyword' }), targetRow('b', { targeting: 'synthetic two', target_kind: 'keyword' })];
    render(<Grid rows={rows} columns={[column('targeting'), column('spend')]} />);
    expect(GRID_HEADER_BACKGROUND).toBe(tokens.color.surfaceHover);
    expect(GRID_HEADER_RULE).toBe(tokens.color.borderStrong);
    expect(GRID_RULE).toContain(tokens.color.borderStrong);
    expect(GRID_RULE).toContain(tokens.color.border);
    const headerRow = header('Spend').parentElement!;
    expect(headerRow.style.background).toBe(GRID_HEADER_BACKGROUND);
    expect(headerRow.style.color).toBe(tokens.color.text);
    expect(headerRow.style.borderBottom).toBe(`1px solid ${GRID_HEADER_RULE}`);
    for (const name of ['Target', 'Spend']) expect(header(name).style.borderRight).toBe(`1px solid ${GRID_HEADER_RULE}`);
    const body = screen.getAllByTestId('grid-row');
    expect(body).toHaveLength(2);
    for (const row of body) {
      expect(row.style.borderBottom).toBe(`1px solid ${GRID_RULE}`);
      for (const cell of within(row).getAllByRole('cell')) expect(cell.style.borderRight).toBe(`1px solid ${GRID_RULE}`);
    }
  });
});

/** Snake-case and Amazon upper-case codes: the shape V19, D3 and D6 found on screen. */
const CODE_SHAPE = /\b(?:[a-z]+_[a-z_]+|[A-Z]+_[A-Z_]+)\b/;
const TEXT_ATTRIBUTES = ['title', 'aria-label', 'aria-valuetext', 'placeholder'];

/** Every code must be absent from the text and every text-bearing attribute. */
function expectNoRawCode(host: HTMLElement, codes: readonly string[]): number {
  let checked = 0;
  const texts = [host.textContent ?? '', ...[...host.querySelectorAll('*')].flatMap((element) =>
    TEXT_ATTRIBUTES.map((name) => element.getAttribute(name) ?? ''))];
  for (const code of codes) {
    for (const text of texts) {
      if (/[_A-Z]/.test(code)) expect(text, code).not.toContain(code);
    }
    checked += 1;
  }
  for (const text of texts) expect(text).not.toMatch(CODE_SHAPE);
  return checked;
}

describe('readable target, match and placement labels (V19, D3, D6)', () => {
  it('names every match type, expression type and target kind in words in the targets grid', () => {
    const rows = [
      ...MatchType.options.map((matchType, index) => targetRow(`match-${index}`, { targeting: `synthetic phrase ${index}`, target_kind: 'keyword', match_type: matchType })),
      ...TARGET_EXPRESSION_TYPES.map((type, index) => targetRow(`expression-${index}`, { targeting: index % 2 ? type : `${type}="B000SYN${String(index).padStart(3, '0')}"`, target_kind: 'target', match_type: null })),
    ];
    render(<Grid rows={rows} columns={[column('targeting'), column('target_kind'), column('match_type'), column('spend')]} />);
    const grid = screen.getByTestId('grid-scroller');
    const cellsOf = (index: number) => screen.getAllByTestId('grid-row').map((row) => within(row).getAllByRole('cell')[index]!.textContent);
    expect(screen.getAllByTestId('grid-row')).toHaveLength(rows.length);
    const matchCells = cellsOf(2);
    MatchType.options.forEach((matchType, index) => expect(matchCells[index]).toBe(MATCH_TYPE_LABELS[matchType]));
    const targetCells = cellsOf(0);
    TARGET_EXPRESSION_TYPES.forEach((type, index) => expect(targetCells[MatchType.options.length + index]).toContain(TARGET_EXPRESSION_LABELS[type]));
    const kinds = new Set(cellsOf(1));
    expect([...kinds].sort()).toEqual(['Audience target', 'Automatic target', 'Keyword', 'Product target', 'Theme target']);
    expect(expectNoRawCode(grid, [...MatchType.options, ...TARGET_EXPRESSION_TYPES, 'target', 'keyword'])).toBe(MatchType.options.length + TARGET_EXPRESSION_TYPES.length + 2);
  });

  it('names every placement in words, in cells, group headers, filter options and chips', () => {
    const placements = columnsFor('placements');
    const rows = Placement.options.map((placement, index) => ({ ...targetRow(`placement-${index}`, { placement, campaign_name: 'Synthetic campaign' }) }));
    render(<Grid rows={rows} columns={[column('placement', placements), column('campaign_name', placements), column('spend', placements)]} />);
    const cells = screen.getAllByTestId('grid-row').map((row) => within(row).getAllByRole('cell')[0]!.textContent);
    expect(cells).toEqual(Placement.options.map((placement) => PLACEMENT_LABELS[placement]));
    expect(expectNoRawCode(screen.getByTestId('grid-scroller'), Placement.options)).toBe(Placement.options.length);
    cleanup();
    render(<Grid rows={rows} columns={[column('placement', placements), column('spend', placements)]} groupBy={['placement']} />);
    const groups = screen.getAllByTestId('grid-row');
    expect(groups.map((row) => row.getAttribute('aria-label'))).toEqual(Placement.options.map((placement) =>
      `Grouping level 1 of 1: Placement ${PLACEMENT_LABELS[placement]}; 1 source rows`));
    expectNoRawCode(screen.getByTestId('grid-scroller'), Placement.options);
    const options = buildCategoricalOptions(rows, 'placement', (value) => describeFilter({ key: 'PLACEMENT', conditions: [{ operator: 'IN', values: [value] }] }, placements).replace('Placement is one of ', ''));
    expect(options.map((option) => option.value).sort()).toEqual([...Placement.options].sort());
    expect(options.map((option) => option.label).sort()).toEqual(Object.values(PLACEMENT_LABELS).sort());
    expect(describeFilter({ key: 'PLACEMENT', conditions: [{ operator: 'IN', values: ['top_of_search', 'product_pages'] }] }, placements))
      .toBe('Placement is one of Top of search, Product pages');
    // Typed search text is the operator's own words and stays as typed.
    expect(describeFilter({ key: 'PLACEMENT', conditions: [{ operator: 'LIKE', values: ['top'] }] }, placements)).toBe('Placement contains top');
  });
});

describe('grouped grid accessible name', () => {
  it('names the grouping levels by column header, never by column id', () => {
    const rows = [targetRow('a', { targeting: 'synthetic one', target_kind: 'keyword', match_type: 'exact' }), targetRow('b', { targeting: 'synthetic two', target_kind: 'keyword', match_type: 'broad' })];
    render(<Grid rows={rows} columns={[column('match_type'), column('campaign_name'), column('spend')]} groupBy={['match_type', 'campaign_name']} />);
    const tree = screen.getByRole('treegrid');
    expect(tree.getAttribute('aria-label')).toBe(`Results grouped by ${column('match_type').header}, ${column('campaign_name').header}`);
    expect(tree.getAttribute('aria-label')).toBe('Results grouped by Match, Campaign');
    expect(tree.getAttribute('aria-label')).not.toMatch(/match_type|campaign_name/);
  });
});

describe('grouped column chooser (V20)', () => {
  const view: SavedView = { id: 'synthetic', name: 'Synthetic view', entity: 'targets', columns: ['targeting', 'spend'], pinned: ['targeting'], widths: {}, filter: { groups: [] }, groupBy: [], sort: [], dateRange: null, updatedAt: '2026-09-25' };

  it('groups by subject in reading order and nests each metric’s comparison columns under it', () => {
    const groups = managerColumnGroups(targets);
    expect(groups.map((group) => group.id)).toEqual([...MANAGER_SUBJECTS]);
    const placed = groups.flatMap((group) => group.columns.map((item) => item.id));
    expect(placed.sort()).toEqual(targets.map((item) => item.id).sort());
    const byId = Object.fromEntries(groups.map((group) => [group.id, group.columns.map((item) => item.id)]));
    expect(byId['Delivery']).toEqual(expect.arrayContaining(['impressions', 'clicks', 'ctr', 'top_of_search_share']));
    expect(byId['Spend and bids']).toEqual(expect.arrayContaining(['spend', 'cpc', 'bid', 'suggested_bid']));
    expect(byId['Sales']).toEqual(expect.arrayContaining(['sales', 'orders', 'units']));
    expect(byId['Efficiency']).toEqual(expect.arrayContaining(['acos', 'roas', 'cvr']));
    expect(byId['Rank']).toEqual(expect.arrayContaining(['organic_rank', 'rank_grid']));
    expect(byId['SQP & Brand Analytics']).toEqual(targets.filter((item) => item.subject === 'SQP' || item.subject === 'BRAND ANALYTICS').map((item) => item.id));
    expect(byId['Comparison']).toEqual(expect.arrayContaining(['rank_change', 'acos_vs_target', 'diff_from_suggested_bid']));
    const efficiency = nestColumnVariants(groups.find((group) => group.id === 'Efficiency')!.columns);
    expect(efficiency.find((entry) => entry.column.id === 'acos')?.variants.map((item) => item.id)).toEqual(['acos_comparison', 'acos_delta_absolute', 'acos_delta_percent']);
    expect(efficiency.some((entry) => entry.column.id.endsWith('_comparison'))).toBe(false);

    render(<ColumnManager available={targets} view={view} onApply={vi.fn()} onClose={vi.fn()} />);
    const chooser = screen.getByRole('region', { name: 'Available columns' });
    expect(chooser.querySelectorAll('input[type="checkbox"]')).toHaveLength(targets.length);
    expect([...chooser.querySelectorAll('[data-column-subject]')].map((set) => set.getAttribute('data-column-subject'))).toEqual([...MANAGER_SUBJECTS]);
    const acos = within(chooser.querySelector<HTMLElement>('[data-column-entry="acos"]')!);
    const variants = acos.getByRole('group', { name: 'ACOS comparison columns' });
    expect(within(variants).getAllByRole('checkbox').map((box) => box.getAttribute('aria-label'))).toEqual(['ACOS (prev)', 'ACOS Δ', 'ACOS Δ%']);
    expect(variants.textContent).toBe('PreviousChangeChange %');
    fireEvent.click(within(variants).getByRole('checkbox', { name: 'ACOS (prev)' }));
    expect((within(variants).getByRole('checkbox', { name: 'ACOS (prev)' }) as HTMLInputElement).checked).toBe(true);
    expect(within(screen.getByRole('navigation', { name: 'Column groups' })).getAllByRole('button').map((button) => button.textContent))
      .toEqual([`All (${targets.length})`, ...groups.map((group) => `${group.label} (${group.columns.length})`)]);
  });
});

describe('grouped subtotals on the reporting-rows rule (WP-321 → WP-316)', () => {
  it('shows a group comparison from the members that reported, and keeps an unreported window unknown', () => {
    const rows = [
      targetRow('a', { targeting: 'one', target_kind: 'keyword', campaign_name: 'Synthetic A' }, { spend: 30 }, { spend: 20, sales: 40 }),
      targetRow('b', { targeting: 'two', target_kind: 'keyword', campaign_name: 'Synthetic A' }, { spend: 10 }, null),
      targetRow('c', { targeting: 'three', target_kind: 'keyword', campaign_name: 'Synthetic B' }, { spend: 5 }, null),
    ];
    const columns = [column('campaign_name'), column('spend'), column('spend_comparison')];
    render(<Grid rows={rows} columns={columns} groupBy={['campaign_name']} />);
    const [first, second] = screen.getAllByTestId('grid-row');
    expect(within(first!).getAllByRole('cell').map((cell) => cell.textContent?.replace(/of total.*/, '').trim()).slice(1))
      .toEqual([expect.stringContaining('$40.00'), expect.stringContaining('$20.00')]);
    expect(within(second!).getAllByRole('cell')[2]!.textContent).toBe('—');
    expect(screen.getByText(/^Total · 3 source rows$/).closest('[role="row"]')!.textContent).toContain('$20.00');
  });
});
