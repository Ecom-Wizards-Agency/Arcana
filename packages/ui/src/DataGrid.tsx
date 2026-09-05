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
 *   this file                owns collapse state, the table and the virtualizer
 *   `grid/GridHeader.tsx`    renders headers and owns sort/drag/resize/pin gestures
 *   `grid/GridTotals.tsx`    renders the sticky totals row
 *   `grid/GridBody.tsx`      renders the virtualised rows and the empty state
 *   `grid/GridCell.tsx`      formats one cell, the same way in every row
 *
 * Note what TanStack Table is deliberately *not* doing: filtering, sorting or
 * grouping. Its grouped row model averages what it aggregates, which is exactly
 * the failure `metrics.ts` exists to prevent, so the row model here is `core`
 * only and the rows arrive already shaped.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createColumnHelper, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GridColumn } from './columns.js';
import { isGroupedRow } from './aggregate.js';
import type { GroupedRow } from './aggregate.js';
import { formatInteger } from './format.js';
import type { FormatContext } from './format.js';
import type { GridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import { resolveField } from './rows.js';
import type { SortRule } from './sort.js';
import { DEFAULT_OVERSCAN, DEFAULT_ROW_HEIGHT } from './virtual.js';
import { GridBody } from './grid/GridBody.js';
import { GridCell } from './grid/GridCell.js';
import type { GridCellEnvironment } from './grid/GridCell.js';
import { GridHeader } from './grid/GridHeader.js';
import { GridTotals } from './grid/GridTotals.js';
import { footer, footerNote, scroller, shell } from './grid/styles.js';

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
  /** Selected row ids are presentation state; selection interaction stays with the caller. */
  selectedRowIds?: readonly string[];
  /** Viewport height in pixels. The grid scrolls inside it; the page does not. */
  height?: number;
  rowHeight?: number;
  /** Test seam: react-virtual measures a real element, jsdom has none. */
  initialRect?: { width: number; height: number };
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
  height = 620,
  rowHeight = DEFAULT_ROW_HEIGHT,
  initialRect,
  emptyMessage = 'No rows match this filter.',
  noDataMessage = 'Nothing was reported at this level for this period. Amazon omits zero-impression rows, so this is either a period with no activity or a report that has not loaded — the freshness banner says which.',
}: DataGridProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);
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

  const toggleGroup = useCallback((groupId: string) => {
    setCollapseState((current) => {
      const ids = current.groupingKey === groupingKey
        ? current.ids
        : EMPTY_COLLAPSED_GROUPS;
      const next = new Set(ids);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return { groupingKey, ids: next };
    });
  }, [groupingKey]);

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
      columns.map((column) =>
        helper.accessor((row) => resolveField(row, column.id), {
          id: column.id,
          header: column.header,
          size: column.width,
          cell: (info) => <GridCell row={info.row.original} column={column} {...environment} />,
        }),
      ) as ColumnDef<GridRow, unknown>[],
    [columns, environment],
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
    estimateSize: () => rowHeight,
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
   * stops meaning anything.
   */
  const orderKey = `${sort.map((rule) => `${rule.columnId}:${rule.direction}`).join(',')}|${model.matched}|${model.groupBy.join(',')}`;
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = 0;
  }, [orderKey]);

  const leafColumns = table.getVisibleLeafColumns();
  const totalWidth = leafColumns.reduce((sum, column) => sum + column.getSize(), 0);
  const totalsRow = model.totalsRow;

  return (
    <div style={shell}>
      <div
        ref={scrollRef}
        className="wa-grid-scroller"
        style={{ ...scroller, height }}
        data-testid="grid-scroller"
        role={model.grouped ? 'treegrid' : 'grid'}
        aria-label={model.grouped ? `Results grouped by ${model.groupBy.join(', ')}` : 'Results'}
        aria-rowcount={model.shown + (totalsRow === null ? 1 : 2)}
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
            selected={selected}
            collapsedGroupIds={collapsedGroupIds}
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
