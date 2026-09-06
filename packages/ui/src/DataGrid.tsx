'use client';

/**
 * The data grid.
 *
 * No pagination, ever. The recon is unambiguous about why (`02-data-grid.md`
 * §6): QA-ing an optimization means sorting four thousand rows by spend,
 * filtering to one change reason and scanning, and a server-paginated grid
 * makes that workflow physically impossible. So the whole result set is in
 * memory and the DOM holds one viewport of it.
 *
 * Division of labour:
 *
 *   `pipeline.ts`            decides which rows exist and in what order
 *   `@tanstack/react-table`  holds the column model, sizing and pinning state
 *   `@tanstack/react-virtual`decides which of those rows reach the DOM
 *   this file                owns collapse state, keyboard focus, the table and the virtualizer
 *   `grid/GridHeader.tsx`    renders headers and owns sort/drag/resize/pin gestures
 *   `grid/GridTotals.tsx`    renders the sticky totals row
 *   `grid/GridBody.tsx`      renders the virtualised rows and the empty state
 *   `grid/GridCell.tsx`      formats one cell, the same way in every row
 *   `grid/GridViewport.tsx`  the flex column that lets the grid fill the viewport
 *
 * Note what TanStack Table is deliberately *not* doing: filtering, sorting or
 * grouping. Its grouped row model averages what it aggregates, which is exactly
 * the failure `metrics.ts` exists to prevent, so the row model here is `core`
 * only and the rows arrive already shaped.
 *
 * ## Keyboard
 *
 * Rows are a roving tab stop: one row is in the tab order, the arrow keys move
 * it, Home and End jump, Enter is the row click, Space toggles selection,
 * Escape clears it, and Left/Right collapse and expand a group. Selection is
 * the caller's state (`selectedRowIds` / `onSelectionChange`) so a bulk action
 * bar and this grid can never disagree about what is selected.
 *
 * ## Host-rendered cells
 *
 * `renderCell` and `renderHeader` are how a workspace puts a checkbox, a link
 * or a decision button in a column without this package learning about
 * campaigns, proposals or n-grams. They are keyed by column id and apply to
 * source rows only: a group row keeps the group-header cell, and the totals row
 * keeps the formatter, so an override can never make a cell and its total
 * disagree. A column that exists only to hold one is `kind: 'control'`, which
 * is also what takes its header out of the sort contract.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GridColumn } from './columns.js';
import { isGroupedRow } from './aggregate.js';
import type { GroupedRow } from './aggregate.js';
import { DEFAULT_DENSITY, rowHeightFor } from './density.js';
import type { GridDensity } from './density.js';
import { formatInteger } from './format.js';
import type { FormatContext } from './format.js';
import type { GridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import { resolveField } from './rows.js';
import type { SortRule } from './sort.js';
import { DEFAULT_OVERSCAN } from './virtual.js';
import { GridBody } from './grid/GridBody.js';
import { GridCell } from './grid/GridCell.js';
import type { GridCellEnvironment } from './grid/GridCell.js';
import { GridHeader } from './grid/GridHeader.js';
import { GridTotals } from './grid/GridTotals.js';
import {
  footer,
  footerNote,
  footerSelection,
  scroller,
  scrollerFill,
  shell,
  shellFill,
} from './grid/styles.js';

export interface DataGridProps {
  model: GridModel;
  /** Visible columns, in display order. */
  columns: readonly GridColumn[];
  currencyCode: string;
  locale?: string;
  sort: readonly SortRule[];
  onSortChange: (rules: SortRule[]) => void;
  /** Persisted layout callbacks. Omit and the grid is read-only chrome. */
  onWidthChange?: (columnId: string, width: number) => void;
  onPinChange?: (columnId: string, pinned: boolean) => void;
  onReorder?: (columnId: string, beforeColumnId: string | null) => void;
  onRowClick?: (row: GridRow) => void;
  /** Selected row ids are the caller's state; the grid paints them and asks to change them. */
  selectedRowIds?: readonly string[];
  /** Omit and Space does nothing: a grid without a selection consumer has no selection. */
  onSelectionChange?: (rowIds: string[]) => void;
  /**
   * Viewport height in pixels. Omit it and the grid fills the flex column it
   * sits in (see `GridViewport`), which is how a workspace fills the screen.
   */
  height?: number | undefined;
  /** Row density. Decides the row height unless `rowHeight` overrides it. */
  density?: GridDensity;
  rowHeight?: number;
  /** Test seam: react-virtual measures a real element, jsdom has none. */
  initialRect?: { width: number; height: number };
  /**
   * Cell content by column id, for source rows only. Use it for controls the
   * grid cannot know about; leave a value column to the formatter.
   */
  renderCell?: Readonly<Record<string, (row: GridRow) => ReactNode>>;
  /** Header content by column id. Pairs with `renderCell` for control columns. */
  renderHeader?: Readonly<Record<string, () => ReactNode>>;
  /** Shown when a filter matched nothing. Not the same as having no rows at all. */
  emptyMessage?: string;
  /** Shown when the period itself produced no rows. */
  noDataMessage?: string;
}

const helper = createColumnHelper<GridRow>();
const EMPTY_COLLAPSED_GROUPS: ReadonlySet<string> = new Set();

export function DataGrid({
  model,
  columns,
  currencyCode,
  locale,
  sort,
  onSortChange,
  onWidthChange,
  onPinChange,
  onReorder,
  onRowClick,
  selectedRowIds = [],
  onSelectionChange,
  height,
  density = DEFAULT_DENSITY,
  rowHeight,
  initialRect,
  renderCell,
  renderHeader,
  emptyMessage = 'No rows match this filter.',
  noDataMessage = 'Nothing was reported at this level for this period. Amazon omits zero-impression rows, so this is either a period with no activity or a report that has not loaded — the freshness banner says which.',
}: DataGridProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const resolvedRowHeight = rowHeight ?? rowHeightFor(density);
  const groupingKey = model.groupBy.join('\u0000');
  const [collapseState, setCollapseState] = useState<{
    groupingKey: string;
    ids: ReadonlySet<string>;
  }>(() => ({ groupingKey, ids: EMPTY_COLLAPSED_GROUPS }));
  const collapsedGroupIds =
    collapseState.groupingKey === groupingKey
      ? collapseState.ids
      : EMPTY_COLLAPSED_GROUPS;
  const formatContext = useMemo<FormatContext>(
    () => ({ currencyCode, ...(locale === undefined ? {} : { locale }) }),
    [currencyCode, locale],
  );
  const selected = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const collapsibleGroupIds = useMemo(
    () => {
      if (!model.grouped) return EMPTY_COLLAPSED_GROUPS;
      return new Set(
        model.rows
          .filter((row): row is GroupedRow => isGroupedRow(row) && !row.isLeafGroup)
          .map((row) => row.id),
      );
    },
    [model.grouped, model.rows],
  );

  useEffect(() => {
    setCollapseState((current) =>
      current.groupingKey === groupingKey
        ? current
        : { groupingKey, ids: EMPTY_COLLAPSED_GROUPS },
    );
  }, [groupingKey]);

  useEffect(() => {
    setCollapseState((current) => {
      if (current.groupingKey !== groupingKey) return current;
      const next = new Set([...current.ids].filter((id) => collapsibleGroupIds.has(id)));
      return next.size === current.ids.size ? current : { ...current, ids: next };
    });
  }, [collapsibleGroupIds, groupingKey]);

  const setGroupCollapsed = useCallback((groupId: string, collapsed: boolean | 'toggle') => {
    setCollapseState((current) => {
      const ids = current.groupingKey === groupingKey
        ? current.ids
        : EMPTY_COLLAPSED_GROUPS;
      const has = ids.has(groupId);
      const want = collapsed === 'toggle' ? !has : collapsed;
      if (want === has) return current.groupingKey === groupingKey ? current : { groupingKey, ids };
      const next = new Set(ids);
      if (want) next.add(groupId);
      else next.delete(groupId);
      return { groupingKey, ids: next };
    });
  }, [groupingKey]);

  const toggleGroup = useCallback(
    (groupId: string) => setGroupCollapsed(groupId, 'toggle'),
    [setGroupCollapsed],
  );

  const visibleRows = useMemo(() => {
    if (!model.grouped || collapsedGroupIds.size === 0) return model.rows;
    const hiddenGroupIds = new Set<string>();
    const visible: GridRow[] = [];
    for (const row of model.rows) {
      if (!isGroupedRow(row) || row.parentGroupId === null) {
        visible.push(row);
        continue;
      }
      const parentHidden =
        collapsedGroupIds.has(row.parentGroupId) || hiddenGroupIds.has(row.parentGroupId);
      if (parentHidden) hiddenGroupIds.add(row.id);
      else visible.push(row);
    }
    return visible;
  }, [collapsedGroupIds, model.grouped, model.rows]);

  const environment = useMemo<GridCellEnvironment>(
    () => ({ context: formatContext, collapsedGroupIds, onToggleGroup: toggleGroup }),
    [collapsedGroupIds, formatContext, toggleGroup],
  );

  const columnDefs = useMemo<ColumnDef<GridRow, unknown>[]>(
    () =>
      columns.map((column) => {
        const override = renderCell?.[column.id];
        return helper.accessor((row) => resolveField(row, column.id), {
          id: column.id,
          header: column.header,
          size: column.width,
          cell: (info) => {
            const row = info.row.original;
            // A group row is an aggregate of many source rows; a checkbox or a
            // link on one would have to pick a member arbitrarily, so the
            // override is offered source rows only.
            if (override !== undefined && !isGroupedRow(row)) return override(row);
            return <GridCell row={row} column={column} {...environment} />;
          },
        });
      }) as ColumnDef<GridRow, unknown>[],
    [columns, environment, renderCell],
  );

  const pinnedIds = useMemo(
    () => columns.filter((column) => column.pinned).map((column) => column.id),
    [columns],
  );

  const table = useReactTable({
    data: visibleRows,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    state: { columnPinning: { left: pinnedIds, right: [] } },
    getRowId: (row) => row.id,
    enableColumnResizing: true,
    columnResizeMode: 'onEnd',
  });

  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => resolvedRowHeight,
    overscan: DEFAULT_OVERSCAN,
    ...(initialRect === undefined ? {} : { initialRect }),
  });

  const items = virtualizer.getVirtualItems();
  const paddingTop = items.length > 0 ? (items[0]?.start ?? 0) : 0;
  const paddingBottom =
    items.length > 0 ? virtualizer.getTotalSize() - (items[items.length - 1]?.end ?? 0) : 0;

  /**
   * Re-sorting or re-filtering returns you to the top.
   *
   * Sorting by spend descending and staying at row 12,000 shows you an
   * arbitrary slice of the answer you just asked for. The scroll offset is only
   * meaningful relative to an ordering, so when the ordering changes the offset
   * stops meaning anything -- and so does the row that held the tab stop.
   */
  const orderKey = `${sort.map((rule) => `${rule.columnId}:${rule.direction}`).join(',')}|${model.matched}|${model.groupBy.join(',')}`;
  const [activeIndex, setActiveIndex] = useState(0);
  const [focusWithin, setFocusWithin] = useState(false);
  const pendingFocus = useRef<number | null>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = 0;
    setActiveIndex(0);
  }, [orderKey]);

  // A collapse can remove the active row from the visible set; clamp rather
  // than leaving the tab stop on a row that no longer exists.
  const clampedActive = rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1);

  const moveActive = useCallback(
    (index: number) => {
      if (rows.length === 0) return;
      const next = Math.max(0, Math.min(rows.length - 1, index));
      setActiveIndex(next);
      pendingFocus.current = next;
      virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [rows.length, virtualizer],
  );

  // Focus follows the tab stop once the virtualizer has put the row in the
  // DOM, which may be a render or two after the key press for a distant row.
  useEffect(() => {
    const target = pendingFocus.current;
    const element = scrollRef.current;
    if (target === null || element === null) return;
    const row = element.querySelector<HTMLElement>(`[data-row-index="${target}"]`);
    if (row === null) return;
    pendingFocus.current = null;
    row.focus({ preventScroll: true });
  });

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return;
      const target = event.target as HTMLElement;
      // Only a row is a grid key target. A key pressed on anything else inside
      // the scroller -- a header's pin button, a group toggle, a future inline
      // editor -- belongs to that control; Enter on "Pin Spend" must pin, not
      // open the active row.
      if (target.getAttribute('role') !== 'row') return;
      const current = rows[clampedActive];
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveActive(clampedActive + 1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          moveActive(clampedActive - 1);
          return;
        case 'PageDown':
          event.preventDefault();
          moveActive(clampedActive + pageSize(scrollRef.current, resolvedRowHeight));
          return;
        case 'PageUp':
          event.preventDefault();
          moveActive(clampedActive - pageSize(scrollRef.current, resolvedRowHeight));
          return;
        case 'Home':
          event.preventDefault();
          moveActive(0);
          return;
        case 'End':
          event.preventDefault();
          moveActive(rows.length - 1);
          return;
        case 'Enter':
          if (current !== undefined && onRowClick !== undefined) {
            event.preventDefault();
            onRowClick(current.original);
          }
          return;
        case ' ':
          if (current !== undefined && onSelectionChange !== undefined) {
            event.preventDefault();
            onSelectionChange(
              selected.has(current.id)
                ? selectedRowIds.filter((id) => id !== current.id)
                : [...selectedRowIds, current.id],
            );
          }
          return;
        case 'Escape':
          if (onSelectionChange !== undefined && selectedRowIds.length > 0) {
            event.preventDefault();
            onSelectionChange([]);
          }
          return;
        case 'ArrowRight':
        case 'ArrowLeft': {
          if (current === undefined) return;
          const original = current.original;
          if (!isGroupedRow(original) || original.isLeafGroup) return;
          event.preventDefault();
          setGroupCollapsed(original.id, event.key === 'ArrowLeft');
          return;
        }
        default:
          return;
      }
    },
    [
      clampedActive,
      moveActive,
      onRowClick,
      onSelectionChange,
      resolvedRowHeight,
      rows,
      selected,
      selectedRowIds,
      setGroupCollapsed,
    ],
  );

  const leafColumns = table.getVisibleLeafColumns();
  const totalWidth = leafColumns.reduce((sum, column) => sum + column.getSize(), 0);
  const totalsRow = model.totalsRow;
  const fill = height === undefined;

  return (
    <div style={fill ? shellFill : shell} data-testid="grid-shell" data-density={density}>
      <div
        ref={scrollRef}
        className="wa-grid-scroller"
        style={fill ? scrollerFill : { ...scroller, height }}
        data-testid="grid-scroller"
        role={model.grouped ? 'treegrid' : 'grid'}
        aria-label={model.grouped ? `Results grouped by ${model.groupBy.join(', ')}` : 'Results'}
        aria-rowcount={model.shown + (totalsRow === null ? 1 : 2)}
        aria-multiselectable={onSelectionChange === undefined ? undefined : true}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocusWithin(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusWithin(false);
        }}
      >
        <div style={{ width: totalWidth, minWidth: '100%' }}>
          <GridHeader
            leafColumns={leafColumns}
            columns={columns}
            model={model}
            totalsRow={totalsRow}
            sort={sort}
            onSortChange={onSortChange}
            onWidthChange={onWidthChange}
            onPinChange={onPinChange}
            onReorder={onReorder}
            renderHeader={renderHeader}
            environment={environment}
          />

          {totalsRow === null ? null : (
            <GridTotals
              leafColumns={leafColumns}
              columns={columns}
              model={model}
              row={totalsRow}
              locale={locale}
              environment={environment}
            />
          )}

          <GridBody
            rows={rows}
            items={items}
            paddingTop={paddingTop}
            paddingBottom={paddingBottom}
            columns={columns}
            model={model}
            context={formatContext}
            density={density}
            selected={selected}
            collapsedGroupIds={collapsedGroupIds}
            activeIndex={clampedActive}
            focusWithin={focusWithin}
            onActivate={setActiveIndex}
            onRowClick={onRowClick}
            emptyMessage={emptyMessage}
            noDataMessage={noDataMessage}
          />
        </div>
      </div>

      <div style={footer}>
        <span>
          {model.grouped
            ? `${visibleRows.length === model.shown ? formatInteger(model.shown, locale) : `${formatInteger(visibleRows.length, locale)} visible of ${formatInteger(model.shown, locale)}`} hierarchy rows · ${formatInteger(model.exported, locale)} deepest groups · ${formatInteger(model.matched, locale)} matched source rows of ${formatInteger(model.total, locale)}`
            : `${formatInteger(model.shown, locale)} of ${formatInteger(model.total, locale)} rows`}
          {selected.size === 0 ? null : (
            <>
              {' · '}
              <span style={footerSelection}>{formatInteger(selected.size, locale)} selected</span>
            </>
          )}
        </span>
        {model.grouped ? (
          <span style={footerNote}>
            Ratio metrics recomputed from summed bases, never averaged.
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Rows per PageUp/PageDown: one viewport, less one row of overlap. */
function pageSize(element: HTMLElement | null, rowHeight: number): number {
  if (element === null) return 10;
  return Math.max(1, Math.floor(element.clientHeight / Math.max(1, rowHeight)) - 1);
}
