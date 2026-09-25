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
import { useCallback, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { flexRender } from '@tanstack/react-table';
import type { Column } from '@tanstack/react-table';
import type { GroupedRow } from '../aggregate.js';
import { isSelectionColumn, isSortableColumn, minimumColumnWidth } from '../columns.js';
import type { GridColumn } from '../columns.js';
import { formatValue } from '../format.js';
import type { FormatContext } from '../format.js';
import { COLUMN_DRAG_TYPE, DIMENSION_DRAG_TYPE, writeDragPayload } from '../grouping.js';
import type { GridModel } from '../pipeline.js';
import type { GridRow } from '../rows.js';
import { resolveField } from '../rows.js';
import type { SortRule } from '../sort.js';
import { toggleSort } from '../sort.js';
import { displayValue } from '../value-labels.js';
import { GridCell } from './GridCell.js';
import type { GridCellEnvironment } from './GridCell.js';
import {
  headerAggregate,
  headerCellStyle,
  headerLabelStyle,
  headerRow,
  headerStackStyle,
  pinButtonStyle,
  resizeHandleStyle,
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
  // The column whose edge is under the pointer or being dragged. The header
  // itself is an HTML drag source (reorder, group bar), and a browser starts
  // that drag from any descendant: without this, pulling the resize handle
  // turned into a column drag after four pixels and the width never followed
  // the pointer. The ref is read synchronously in `dragstart`; the state paints
  // the handle.
  const resizing = useRef<string | null>(null);
  const [activeEdge, setActiveEdge] = useState<string | null>(null);
  // Narrowing a column releases the pointer over its own header, and the
  // browser then delivers a click there, which would sort the column the
  // operator was only resizing. The click that ends a resize is swallowed; the
  // flag lives for that one event dispatch only.
  const endedResize = useRef(false);

  const handleHeaderClick = useCallback(
    (columnId: string, event: React.MouseEvent) => {
      if (endedResize.current) return;
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
                    if (resizing.current !== null) {
                      event.preventDefault();
                      return;
                    }
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
              <span style={headerLabelStyle(definition)}>
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
            {onWidthChange === undefined || isSelectionColumn(definition) ? null : (
              <ResizeHandle
                label={definition?.header ?? column.id}
                width={column.getSize()}
                minimum={definition === undefined ? 56 : minimumColumnWidth(definition)}
                active={activeEdge === column.id}
                onArm={(armed) => {
                  resizing.current = armed ? column.id : null;
                  setActiveEdge(armed ? column.id : null);
                }}
                onResize={(width) => onWidthChange(column.id, width)}
                onResizeEnd={() => {
                  endedResize.current = true;
                  setTimeout(() => { endedResize.current = false; }, 0);
                }}
                onAutoFit={() => onWidthChange(column.id, Math.max(
                  definition === undefined ? 56 : minimumColumnWidth(definition),
                  autoFitWidth(definition, model, environment.context),
                ))}
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
    const text = formatValue(displayValue(column, resolveField(row, column.id), row), column.scale, context);
    if (text.length > widest) widest = text.length;
  }
  return Math.min(480, Math.max(72, widest * 8 + 28));
}

/** Keyboard steps, in pixels: an arrow nudges, Shift+arrow strides. */
const RESIZE_STEP = 8;
const RESIZE_STRIDE = 32;

/**
 * The visible column edge: a rule the operator can see and grab, a keyboard
 * separator (arrows resize, Home fits the content), and double-click auto-fit.
 * Widths are clamped to the column's minimum here, so the width a view saves is
 * the width the grid draws.
 */
function ResizeHandle({ label, width, minimum, active, onArm, onResize, onResizeEnd, onAutoFit }: {
  label: string;
  width: number;
  minimum: number;
  active: boolean;
  onArm: (armed: boolean) => void;
  onResize: (width: number) => void;
  /** A pointer resize finished; its closing click is not a sort. */
  onResizeEnd: () => void;
  onAutoFit: () => void;
}): ReactNode {
  const clamp = (next: number): number => Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(minimum, next)));
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label}`}
      aria-valuenow={Math.round(width)}
      aria-valuemin={minimum}
      aria-valuemax={MAX_COLUMN_WIDTH}
      tabIndex={0}
      draggable={false}
      data-resize-handle
      data-active={active}
      onPointerEnter={() => onArm(true)}
      onPointerLeave={(event) => { if (event.buttons === 0) onArm(false); }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onAutoFit();
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? RESIZE_STRIDE : RESIZE_STEP;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          onResize(clamp(width + (event.key === 'ArrowRight' ? step : -step)));
        } else if (event.key === 'Home') {
          event.preventDefault();
          event.stopPropagation();
          onAutoFit();
        }
      }}
      onMouseDown={(event) => {
        if (event.button !== 0) return;
        // Cancelling the press keeps the browser from starting the header's
        // own drag (and from selecting text) while the edge moves.
        event.preventDefault();
        event.stopPropagation();
        onArm(true);
        startResize(event.clientX, width, (next) => onResize(clamp(next)), () => {
          onArm(false);
          onResizeEnd();
        });
      }}
      onFocus={() => onArm(true)}
      onBlur={() => onArm(false)}
      style={resizeHandleStyle(active)}
    />
  );
}

/** The widest a drag or a keypress may make a column. Auto-fit keeps its own cap. */
const MAX_COLUMN_WIDTH = 960;

function startResize(
  startX: number,
  startWidth: number,
  commit: (width: number) => void,
  done: () => void,
): void {
  const onMove = (move: MouseEvent): void => {
    commit(startWidth + move.clientX - startX);
  };
  const onUp = (): void => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    done();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}
