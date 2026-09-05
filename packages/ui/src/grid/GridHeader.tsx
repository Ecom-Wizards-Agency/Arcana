'use client';

/**
 * The sticky header row and the gestures it owns: click and shift-click to
 * sort, drag a header onto another to reorder, the pin toggle, and the resize
 * handle with double-click auto-fit. The aggregate beneath a sorted metric
 * header is the totals row's cell for that column, rendered through the same
 * `GridCell` as the totals row itself.
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Column } from '@tanstack/react-table';
import type { GroupedRow } from '../aggregate.js';
import type { GridColumn } from '../columns.js';
import { formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import type { GridModel } from '../pipeline.js';
import type { GridRow } from '../rows.js';
import { resolveField } from '../rows.js';
import type { SortRule } from '../sort.js';
import { toggleSort } from '../sort.js';
import { GridCell } from './GridCell.js';
import type { GridCellEnvironment } from './GridCell.js';
import {
  headerAggregate,
  headerCellStyle,
  headerLabel,
  headerRow,
  headerStackStyle,
  pinButtonStyle,
  resizeHandle,
  sortMark,
} from './styles.js';

export interface GridHeaderProps {
  leafColumns: readonly Column<GridRow, unknown>[];
  columns: readonly GridColumn[];
  model: GridModel;
  totalsRow: GroupedRow | null;
  sort: readonly SortRule[];
  onSortChange: (rules: SortRule[]) => void;
  onWidthChange?: ((columnId: string, width: number) => void) | undefined;
  onPinChange?: ((columnId: string, pinned: boolean) => void) | undefined;
  onReorder?: ((columnId: string, beforeColumnId: string | null) => void) | undefined;
  environment: GridCellEnvironment;
}

export function GridHeader({
  leafColumns,
  columns,
  model,
  totalsRow,
  sort,
  onSortChange,
  onWidthChange,
  onPinChange,
  onReorder,
  environment,
}: GridHeaderProps): ReactNode {
  const [dragging, setDragging] = useState<string | null>(null);

  const handleHeaderClick = useCallback(
    (columnId: string, event: React.MouseEvent) => {
      onSortChange(toggleSort(sort, columnId, event.shiftKey));
    },
    [onSortChange, sort],
  );

  return (
    <div style={headerRow} role="row">
      {leafColumns.map((column) => {
        const definition = columns.find((candidate) => candidate.id === column.id);
        const rule = sort.find((entry) => entry.columnId === column.id);
        const isPinned = column.getIsPinned() === 'left';
        return (
          <div
            key={column.id}
            role="columnheader"
            aria-label={definition?.header ?? column.id}
            aria-sort={rule === undefined ? 'none' : rule.direction === 'asc' ? 'ascending' : 'descending'}
            title={definition?.description}
            onClick={(event) => handleHeaderClick(column.id, event)}
            draggable={onReorder !== undefined}
            onDragStart={() => setDragging(column.id)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragging !== null && dragging !== column.id) onReorder?.(dragging, column.id);
              setDragging(null);
            }}
            style={headerCellStyle(
              column.getSize(),
              definition,
              isPinned ? { left: column.getStart('left') } : null,
            )}
          >
            <span style={headerStackStyle(definition)}>
              <span style={headerLabel}>{flexRender(column.columnDef.header, {} as never)}</span>
              {rule === undefined || definition?.kind !== 'metric' || totalsRow === null ? null : (
                <span
                  data-testid={`sorted-column-aggregate-${column.id}`}
                  style={headerAggregate}
                >
                  <GridCell row={totalsRow} column={definition} {...environment} />
                </span>
              )}
            </span>
            {rule === undefined ? null : (
              // aria-sort already tells a screen reader the direction;
              // the glyph would only make the header's name read "Spend▼".
              <span aria-hidden style={sortMark}>
                {rule.direction === 'asc' ? '▲' : '▼'}
                {sort.length > 1 ? sort.indexOf(rule) + 1 : ''}
              </span>
            )}
            {onPinChange === undefined ? null : (
              <button
                type="button"
                aria-label={isPinned ? `Unpin ${definition?.header ?? column.id}` : `Pin ${definition?.header ?? column.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onPinChange(column.id, !isPinned);
                }}
                style={pinButtonStyle(isPinned)}
              >
                ⌷
              </button>
            )}
            {onWidthChange === undefined ? null : (
              <span
                role="separator"
                aria-label={`Resize ${definition?.header ?? column.id}`}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onWidthChange(column.id, autoFitWidth(definition, model, environment.context));
                }}
                onMouseDown={(event) => {
                  event.stopPropagation();
                  startResize(event, column.getSize(), (width) => onWidthChange(column.id, width));
                }}
                style={resizeHandle}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Double-click auto-fit, copied from AdLabs' own walkthrough. Width is measured
 * from the widest rendered string rather than from the data, because that is
 * what the operator can see.
 */
export function autoFitWidth(
  column: GridColumn | undefined,
  model: GridModel,
  context: FormatContext,
): number {
  if (column === undefined) return 120;
  let widest = column.header.length;
  const sample = model.rows.slice(0, 200);
  for (const row of sample) {
    const text = formatValue(resolveField(row, column.id), column.scale, context);
    if (text.length > widest) widest = text.length;
  }
  return Math.min(480, Math.max(72, widest * 8 + 28));
}

function startResize(
  event: React.MouseEvent,
  startWidth: number,
  commit: (width: number) => void,
): void {
  const startX = event.clientX;
  const onMove = (move: MouseEvent): void => {
    commit(Math.max(56, startWidth + move.clientX - startX));
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
