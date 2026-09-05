// @vitest-environment jsdom
/**
 * The grid's interaction surface: keyboard navigation over virtualised rows,
 * selection through the keyboard, the density and viewport-fill contract, and
 * the header as a drag source for the group bar.
 *
 * Same jsdom scaffolding as `DataGrid.test.tsx`: no layout engine, so the
 * virtualizer is handed one viewport-sized box and everything downstream is
 * the production component.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DataGrid } from './DataGrid.js';
import type { DataGridProps } from './DataGrid.js';
import { columnsFor } from './columns.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { COLUMN_DRAG_TYPE } from './grouping.js';
import { buildGridModel } from './pipeline.js';
import { rowHeightFor } from './density.js';

const VIEWPORT = { width: 1200, height: 600 };

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => VIEWPORT.width,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => VIEWPORT.height,
});
// jsdom has no `Element.scrollTo`, which the virtualizer calls to move the
// window on Home/End; without it those keys could never bring a distant row
// into the DOM. Set the offset and fire the event the virtualizer listens for,
// asynchronously as a browser would: the virtualizer flushes synchronously on
// scroll, which React refuses from inside the key handler that started it.
// The target offset is clamped against `scrollHeight`, which jsdom also
// reports as 0, so the scroller is given a content height to scroll within.
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get: () => 10_000_000,
});
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value(this: HTMLElement, options: ScrollToOptions | number) {
    this.scrollTop = typeof options === 'number' ? options : options.top ?? 0;
    setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
  },
});

const available = columnsFor('search_terms');
const visible = ['search_term', 'campaign_name', 'match_type', 'spend', 'acos']
  .map((id) => available.find((column) => column.id === id))
  .filter((column): column is NonNullable<typeof column> => column !== undefined);

function renderGrid(
  rowCount: number,
  overrides: Partial<DataGridProps> = {},
): { model: ReturnType<typeof buildGridModel> } {
  const rows = syntheticSearchTermRows(rowCount, { seed: 20260905 });
  const model = buildGridModel(rows, { sort: [{ columnId: 'spend', direction: 'desc' }] });
  render(
    <DataGrid
      model={model}
      columns={visible}
      currencyCode="USD"
      sort={[{ columnId: 'spend', direction: 'desc' }]}
      onSortChange={() => {}}
      height={VIEWPORT.height}
      initialRect={VIEWPORT}
      {...overrides}
    />,
  );
  return { model };
}

function gridRows(): HTMLElement[] {
  return screen.getAllByTestId('grid-row');
}

function activeRow(): HTMLElement | undefined {
  return gridRows().find((row) => row.getAttribute('tabindex') === '0');
}

afterEach(cleanup);

describe('DataGrid keyboard navigation', () => {
  it('gives exactly one row the tab stop and moves it with the arrow keys', () => {
    renderGrid(200);
    const rows = gridRows();
    expect(rows.filter((row) => row.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(rows[0]?.getAttribute('tabindex')).toBe('0');
    expect(rows[1]?.getAttribute('tabindex')).toBe('-1');

    rows[0]?.focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'ArrowDown' });
    expect(activeRow()).toBe(gridRows()[1]);
    expect(document.activeElement).toBe(gridRows()[1]);

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(activeRow()).toBe(gridRows()[0]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowUp' });
    expect(activeRow()).toBe(gridRows()[0]);
  });

  it('jumps to the last and first rows with End and Home, scrolling the virtual window', async () => {
    const { model } = renderGrid(5_000);
    const first = gridRows()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'End' });
    await waitFor(() => {
      expect(activeRow()?.getAttribute('data-row-index')).toBe(String(model.rows.length - 1));
    });
    const last = activeRow();
    expect(document.activeElement).toBe(last);
    // The window moved: the first row is no longer rendered at all.
    expect(gridRows().some((row) => row.getAttribute('data-row-index') === '0')).toBe(false);

    fireEvent.keyDown(last as HTMLElement, { key: 'Home' });
    await waitFor(() => {
      expect(activeRow()?.getAttribute('data-row-index')).toBe('0');
    });
    expect(document.activeElement).toBe(activeRow());
  });

  it('keeps one tab stop in the grid after a native scroll moves the active row out of the DOM', async () => {
    renderGrid(5_000);
    expect(activeRow()?.getAttribute('data-row-index')).toBe('0');

    // A wheel or scrollbar drag, not a key: the active row (index 0) leaves
    // the virtual window and nothing has asked the grid to move the tab stop.
    const scroller = screen.getByTestId('grid-scroller');
    scroller.scrollTop = 90_000;
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(gridRows().some((row) => row.getAttribute('data-row-index') === '0')).toBe(false);
    });

    const stops = gridRows().filter((row) => row.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    const stop = stops[0] as HTMLElement;
    expect(stop.getAttribute('data-row-index')).not.toBe('0');
    expect(stop.getAttribute('data-row-index')).toBe(gridRows()[0]?.getAttribute('data-row-index'));

    // Tabbing onto the stand-in makes it the active row, and the arrows work
    // from there. (`act`: a browser flushes the focus handler's state update
    // before the next key event; jsdom outside `act` does not.)
    act(() => stop.focus());
    expect(document.activeElement).toBe(stop);
    expect(activeRow()).toBe(stop);
    fireEvent.keyDown(stop, { key: 'ArrowDown' });
    const next = Number(stop.getAttribute('data-row-index')) + 1;
    expect(activeRow()?.getAttribute('data-row-index')).toBe(String(next));
    expect(document.activeElement).toBe(activeRow());
  });

  it('opens with Enter, toggles selection with Space and clears it with Escape', () => {
    const onRowClick = vi.fn();
    const onSelectionChange = vi.fn();
    const { model } = renderGrid(50, { onRowClick, onSelectionChange, selectedRowIds: [] });
    const first = gridRows()[0] as HTMLElement;
    const firstId = model.rows[0]?.id;
    first.focus();

    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledWith(model.rows[0]);

    fireEvent.keyDown(first, { key: ' ' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([firstId]);

    cleanup();
    renderGrid(50, { onRowClick, onSelectionChange, selectedRowIds: [firstId as string] });
    const selected = gridRows()[0] as HTMLElement;
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('1 selected')).toBeTruthy();
    selected.focus();
    fireEvent.keyDown(selected, { key: ' ' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);

    fireEvent.keyDown(selected, { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it('leaves Enter and Space to a control inside the grid instead of treating them as row keys', () => {
    const onRowClick = vi.fn();
    const onSelectionChange = vi.fn();
    const onPinChange = vi.fn();
    renderGrid(50, { onRowClick, onSelectionChange, onPinChange });
    // A header button: Enter must reach the button as a click, not open the active row.
    const pin = screen.getByRole('button', { name: 'Pin Spend' });
    pin.focus();
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    pin.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(onRowClick).not.toHaveBeenCalled();
    // Likewise Space on the same button must not toggle the row's selection.
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    pin.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(onSelectionChange).not.toHaveBeenCalled();
    // The row itself still answers.
    const first = gridRows()[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(onRowClick).toHaveBeenCalledTimes(1);
  });

  it('expands and collapses a group row with the horizontal arrows', () => {
    const rows = syntheticSearchTermRows(120, { seed: 51, campaigns: 1 });
    const model = buildGridModel(rows, { groupBy: ['campaign_name', 'match_type'] });
    render(
      <DataGrid
        model={model}
        columns={visible}
        currencyCode="USD"
        sort={[]}
        onSortChange={() => {}}
        height={VIEWPORT.height}
        initialRect={VIEWPORT}
      />,
    );
    const root = gridRows()[0] as HTMLElement;
    expect(root.getAttribute('aria-expanded')).toBe('true');
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowLeft' });
    expect(gridRows()[0]?.getAttribute('aria-expanded')).toBe('false');
    expect(gridRows()).toHaveLength(1);
    fireEvent.keyDown(gridRows()[0] as HTMLElement, { key: 'ArrowRight' });
    expect(gridRows()[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(gridRows().length).toBeGreaterThan(1);
  });
});

describe('DataGrid density and viewport fill', () => {
  it('derives the row height from the density and stamps it on the shell', () => {
    renderGrid(20, { density: 'compact' });
    expect(screen.getByTestId('grid-shell').getAttribute('data-density')).toBe('compact');
    expect((gridRows()[0] as HTMLElement).style.height).toBe(`${rowHeightFor('compact')}px`);
    cleanup();
    renderGrid(20, { density: 'comfortable' });
    expect((gridRows()[0] as HTMLElement).style.height).toBe(`${rowHeightFor('comfortable')}px`);
    cleanup();
    renderGrid(20);
    expect(screen.getByTestId('grid-shell').getAttribute('data-density')).toBe('normal');
    expect((gridRows()[0] as HTMLElement).style.height).toBe(`${rowHeightFor('normal')}px`);
  });

  it('fills its flex parent when no height is given instead of a fixed 620px box', () => {
    renderGrid(20, { height: undefined });
    const shell = screen.getByTestId('grid-shell');
    const scroller = screen.getByTestId('grid-scroller');
    expect(scroller.style.height).toBe('');
    expect(shell.style.flexGrow).toBe('1');
    expect(shell.style.minHeight).toBe('0px');
    expect(scroller.style.flexGrow).toBe('1');
  });
});

describe('DataGrid header affordances', () => {
  it('hands the column id to the drag so a group bar can accept it', () => {
    renderGrid(20);
    const header = screen.getByRole('columnheader', { name: 'Match' });
    expect(header.getAttribute('draggable')).toBe('true');
    const setData = vi.fn();
    fireEvent.dragStart(header, { dataTransfer: { setData, types: [] } });
    expect(setData).toHaveBeenCalledWith(COLUMN_DRAG_TYPE, 'match_type');
  });

  it('shows a sort hint on hover for an unsorted header and the direction when sorted', () => {
    renderGrid(20);
    const acos = screen.getByRole('columnheader', { name: 'ACOS' });
    expect(within(acos).queryByTestId('sort-hint-acos')).toBeNull();
    fireEvent.mouseEnter(acos);
    expect(within(acos).getByTestId('sort-hint-acos')).toBeTruthy();
    fireEvent.mouseLeave(acos);
    expect(within(acos).queryByTestId('sort-hint-acos')).toBeNull();

    const spend = screen.getByRole('columnheader', { name: 'Spend' });
    expect(spend.getAttribute('aria-sort')).toBe('descending');
    expect(within(spend).getByTestId('sort-direction-spend').textContent).toContain('▼');
  });
});
