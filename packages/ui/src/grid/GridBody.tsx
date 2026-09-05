'use client';

/**
 * The virtualised body: only the rows the virtualizer says are in or near the
 * viewport reach the DOM, padded above and below so the scrollbar still spans
 * the whole result set. Group rows carry their hierarchy level and an
 * accessible label; the empty state distinguishes "nothing matched the filter"
 * from "the period produced nothing".
 *
 * Keyboard focus is a roving tab stop: exactly one row (the active one) is in
 * the tab order and the rest are reachable with the arrow keys the grid
 * handles above this component. The body only reports which row took focus
 * and paints the ring; it never decides where focus goes.
 */
import type { ReactNode } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Row } from '@tanstack/react-table';
import type { VirtualItem } from '@tanstack/react-virtual';
import { isGroupedRow } from '../aggregate.js';
import type { GroupedRow } from '../aggregate.js';
import type { GridColumn } from '../columns.js';
import type { GridDensity } from '../density.js';
import { formatInteger, formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import type { GridModel } from '../pipeline.js';
import type { GridRow } from '../rows.js';
import { resolveField } from '../rows.js';
import { bodyCellStyle, bodyRowStyle, emptyState } from './styles.js';

export interface GridBodyProps {
  rows: readonly Row<GridRow>[];
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

export function GridBody({
  rows,
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
}: GridBodyProps): ReactNode {
  if (rows.length === 0) {
    return <div style={emptyState}>{model.total === 0 ? noDataMessage : emptyMessage}</div>;
  }

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
            tabIndex={isActive ? 0 : -1}
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
            {row.getVisibleCells().map((cell) => {
              const definition = columns.find((candidate) => candidate.id === cell.column.id);
              const isPinned = cell.column.getIsPinned() === 'left';
              return (
                <div
                  key={cell.id}
                  role="cell"
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
