'use client';

/**
 * The virtualised body: only the rows the virtualizer says are in or near the
 * viewport reach the DOM, padded above and below so the scrollbar still spans
 * the whole result set. Group rows carry their hierarchy level and an
 * accessible label; the empty state distinguishes "nothing matched the filter"
 * from "the period produced nothing".
 */
import type { ReactNode } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Row } from '@tanstack/react-table';
import type { VirtualItem } from '@tanstack/react-virtual';
import { isGroupedRow } from '../aggregate.js';
import type { GroupedRow } from '../aggregate.js';
import type { GridColumn } from '../columns.js';
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
  selected: ReadonlySet<string>;
  collapsedGroupIds: ReadonlySet<string>;
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
  selected,
  collapsedGroupIds,
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
        const groupedRow = isGroupedRow(row.original) && row.original.groupDepth >= 0
          ? row.original
          : null;
        return (
          <div
            key={row.id}
            role="row"
            aria-selected={isSelected}
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
            onClick={() => onRowClick?.(row.original)}
            style={bodyRowStyle({
              height: item.size,
              index: item.index,
              clickable: onRowClick !== undefined,
              selected: isSelected,
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

export function groupRowLabel(
  row: GroupedRow,
  columns: readonly GridColumn[],
  context: FormatContext,
): string {
  const column = columns.find((candidate) => candidate.id === row.groupColumnId);
  const label = column?.header ?? row.groupColumnId;
  const value = formatValue(resolveField(row, row.groupColumnId), column?.scale ?? 'text', context);
  return `Grouping level ${row.groupDepth + 1} of ${row.groupBy.length}: ${label} ${value}; ${formatInteger(row.groupSize, context.locale)} source rows`;
}
