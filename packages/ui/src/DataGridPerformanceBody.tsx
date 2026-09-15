'use client';

/**
 * Performance rows virtualize both axes. Off-screen columns occupy one spacer
 * per contiguous run; their cells and content mount when scrolled into view.
 * Row focus, selection and group navigation match the shared GridBody contract.
 */
import type { ReactNode } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Row } from '@tanstack/react-table';
import type { VirtualItem } from '@tanstack/react-virtual';
import { isGroupedRow } from './aggregate.js';
import type { GroupedRow } from './aggregate.js';
import type { GridColumn } from './columns.js';
import type { GridDensity } from './density.js';
import { formatInteger, formatValue } from './format.js';
import type { FormatContext } from './format.js';
import type { GridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import { resolveField } from './rows.js';
import { bodyCellStyle, bodyRowStyle, emptyState } from './grid/styles.js';

export interface DataGridPerformanceBodyProps {
  rows: readonly Row<GridRow>[];
  renderedColumnIds: ReadonlySet<string>;
  items: readonly VirtualItem[];
  paddingTop: number;
  paddingBottom: number;
  columns: readonly GridColumn[];
  model: GridModel;
  context: FormatContext;
  density: GridDensity;
  selected: ReadonlySet<string>;
  collapsedGroupIds: ReadonlySet<string>;
  /** Index of the row holding the roving tab stop. */
  activeIndex: number;
  /** Whether keyboard focus is inside the grid, which decides whether the ring shows. */
  focusWithin: boolean;
  onActivate: (index: number) => void;
  onRowClick?: ((row: GridRow) => void) | undefined;
  emptyMessage: string;
  noDataMessage: string;
}

export function DataGridPerformanceBody({
  rows,
  renderedColumnIds,
  items,
  paddingTop,
  paddingBottom,
  columns,
  model,
  context,
  density,
  selected,
  collapsedGroupIds,
  activeIndex,
  focusWithin,
  onActivate,
  onRowClick,
  emptyMessage,
  noDataMessage,
}: DataGridPerformanceBodyProps): ReactNode {
  if (rows.length === 0) {
    return <div style={emptyState}>{model.total === 0 ? noDataMessage : emptyMessage}</div>;
  }

  const firstCells = rows[items[0]?.index ?? 0]?.getVisibleCells() ?? [];
  const layout: Array<{ index: number; gap: number }> = [];
  firstCells.forEach((cell, index) => {
    if (cell.column.getIsPinned() === 'left' || renderedColumnIds.has(cell.column.id)) layout.push({ index, gap: 0 });
    else {
      const prior = layout.at(-1);
      if (prior !== undefined && prior.gap > 0) prior.gap += cell.column.getSize();
      else layout.push({ index, gap: cell.column.getSize() });
    }
  });
  const byId = new Map(columns.map((column) => [column.id, column]));
  const tabStopIndex = items.some((item) => item.index === activeIndex)
    ? activeIndex
    : items[0]?.index;

  return (
    <div style={{ paddingTop, paddingBottom }}>
      {items.map((item) => {
        const row = rows[item.index];
        if (row === undefined) return null;
        const isSelected = selected.has(row.id);
        const isActive = item.index === activeIndex;
        const groupedRow = isGroupedRow(row.original) && row.original.groupDepth >= 0
          ? row.original
          : null;
        return (
          <div
            key={row.id}
            role="row"
            aria-selected={isSelected}
            tabIndex={item.index === tabStopIndex ? 0 : -1}
            data-row-index={item.index}
            {...(groupedRow !== null && !groupedRow.isLeafGroup
              ? { 'aria-expanded': !collapsedGroupIds.has(groupedRow.id) }
              : {})}
            {...(groupedRow === null
              ? {}
              : {
                  'aria-level': groupedRow.groupDepth + 1,
                  'aria-label': groupRowLabel(groupedRow, columns, context),
                  'data-group-level': String(groupedRow.groupDepth + 1),
                })}
            data-testid="grid-row"
            onFocus={(event) => {
              if (event.target === event.currentTarget) onActivate(item.index);
            }}
            onClick={() => {
              onActivate(item.index);
              onRowClick?.(row.original);
            }}
            style={bodyRowStyle({
              height: item.size,
              index: item.index,
              clickable: onRowClick !== undefined,
              selected: isSelected,
              focused: isActive && focusWithin,
              group: groupedRow === null
                ? null
                : { depth: groupedRow.groupDepth, isLeaf: groupedRow.isLeafGroup },
            })}
          >
            {layout.map(({ index, gap }) => {
              if (gap > 0) return <div key={`gap:${index}`} aria-hidden="true" style={{ width: gap, flexShrink: 0 }} />;
              const cell = row.getVisibleCells()[index]!;
              const definition = byId.get(cell.column.id);
              const isPinned = cell.column.getIsPinned() === 'left';
              return (
                <div
                  key={cell.id}
                  role="cell"
                  aria-colindex={index + 1}
                  style={bodyCellStyle(
                    cell.column.getSize(),
                    definition,
                    isPinned ? { left: cell.column.getStart('left') } : null,
                    density,
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function groupRowLabel(
  row: GroupedRow,
  columns: readonly GridColumn[],
  context: FormatContext,
): string {
  const column = columns.find((candidate) => candidate.id === row.groupColumnId);
  const label = column?.header ?? row.groupColumnId;
  const value = formatValue(resolveField(row, row.groupColumnId), column?.scale ?? 'text', context);
  return `Grouping level ${row.groupDepth + 1} of ${row.groupBy.length}: ${label} ${value}; ${formatInteger(row.groupSize, context.locale)} source rows`;
}
