'use client';

/**
 * The sticky header row and the gestures it owns: click and shift-click to
 * sort, drag a header onto another to reorder or onto the toolbar's group bar
 * to group, the pin toggle, and the resize handle with double-click auto-fit.
 * The aggregate beneath a sorted metric header is the totals row's cell for
 * that column, rendered through the same `GridCell` as the totals row itself.
 *
 * Every header is a drag source. The column id travels in the `DataTransfer`
 * under `COLUMN_DRAG_TYPE` (`grouping.ts`), and under `DIMENSION_DRAG_TYPE`
 * too when the column is a dimension, which is what lets a component with no
 * shared parent -- the group bar -- decide during `dragover` whether it will
 * take the drop; the local `dragging` state only serves header-to-header
 * reorder within this row.
 *
 * Headers are in the tab order. Enter and Space sort exactly as a click does,
 * with Shift adding a key, so `aria-sort` is reachable by the people it is
 * announced to. Keys on the pin button or the resize handle stay theirs.
 *
 * A control column (a selection checkbox, a row action) is none of that: it has
 * no value, so it carries no `aria-sort`, no sort gesture, no hover hint and no
 * drag payload, and its host renders the header content through `renderHeader`.
 * Advertising an ordering a column cannot produce is the bug this prevents.
 */
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Column } from '@tanstack/react-table';
import type { GroupedRow } from '../aggregate.js';
import { isSortableColumn } from '../columns.js';
import type { GridColumn } from '../columns.js';
import { formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import { COLUMN_DRAG_TYPE, DIMENSION_DRAG_TYPE, writeDragPayload } from '../grouping.js';
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
  sortHint,
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
  /** Header content by column id, for the control columns the host owns. */
  renderHeader?: Readonly<Record<string, () => ReactNode>> | undefined;
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
  renderHeader,
  environment,
}: GridHeaderProps): ReactNode {
  const [dragging, setDragging] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const handleHeaderClick = useCallback(
    (columnId: string, event: React.MouseEvent) => {
      onSortChange(toggleSort(sort, columnId, event.shiftKey));
    },
    [onSortChange, sort],
  );

  const handleHeaderKeyDown = useCallback(
    (columnId: string, event: React.KeyboardEvent<HTMLDivElement>) => {
      // Only the header itself sorts; a key on its pin button or resize
      // handle bubbles through here and belongs to that control.
      if (event.target !== event.currentTarget) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSortChange(toggleSort(sort, columnId, event.shiftKey));
    },
    [onSortChange, sort],
  );

  return (
    <div style={headerRow} role="row">
      {leafColumns.map((column) => {
        const definition = columns.find((candidate) => candidate.id === column.id);
        const sortable = definition === undefined || isSortableColumn(definition);
        const rule = sortable ? sort.find((entry) => entry.columnId === column.id) : undefined;
        const isPinned = column.getIsPinned() === 'left';
        const custom = renderHeader?.[column.id];
        return (
          <div
            key={column.id}
            role="columnheader"
            aria-label={definition?.header ?? column.id}
            {...(sortable
              ? {
                  'aria-sort': (rule === undefined
                    ? 'none'
                    : rule.direction === 'asc'
                      ? 'ascending'
                      : 'descending') as 'none' | 'ascending' | 'descending',
                  tabIndex: 0,
                  onClick: (event: React.MouseEvent) => handleHeaderClick(column.id, event),
                  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) =>
                    handleHeaderKeyDown(column.id, event),
                  draggable: true,
                  onDragStart: (event: React.DragEvent) => {
                    writeDragPayload(event.dataTransfer, COLUMN_DRAG_TYPE, column.id);
                    if (definition?.kind === 'dimension') {
                      writeDragPayload(event.dataTransfer, DIMENSION_DRAG_TYPE, column.id);
                    }
                    setDragging(column.id);
                  },
                  onDragEnd: () => setDragging(null),
                  onDragOver: (event: React.DragEvent) => {
                    if (onReorder !== undefined) event.preventDefault();
                  },
                  onDrop: () => {
                    if (dragging !== null && dragging !== column.id) onReorder?.(dragging, column.id);
                    setDragging(null);
                  },
                }
              : {})}
            title={definition?.description}
            onMouseEnter={() => setHovered(column.id)}
            onMouseLeave={() => setHovered((current) => (current === column.id ? null : current))}
            style={headerCellStyle(
              column.getSize(),
              definition,
              isPinned ? { left: column.getStart('left') } : null,
            )}
          >
            <span style={headerStackStyle(definition)}>
              <span style={headerLabel}>
                {custom === undefined ? flexRender(column.columnDef.header, {} as never) : custom()}
              </span>
              {rule === undefined || definition?.kind !== 'metric' || totalsRow === null ? null : (
                <span
                  data-testid={`sorted-column-aggregate-${column.id}`}
                  style={headerAggregate}
                >
                  <GridCell row={totalsRow} column={definition} {...environment} />
                </span>
              )}
            </span>
            {!sortable ? null : rule === undefined ? (
              hovered === column.id ? (
                // The affordance that says "this sorts": shown on hover only,
                // so a resting header row stays a row of names.
                <span aria-hidden data-testid={`sort-hint-${column.id}`} style={sortHint}>
                  ↕
                </span>
              ) : null
            ) : (
              // aria-sort already tells a screen reader the direction;
              // the glyph would only make the header's name read "Spend▼".
              <span aria-hidden data-testid={`sort-direction-${column.id}`} style={sortMark}>
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
function autoFitWidth(
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
