'use client';

/**
 * The group bar: the drop zone above the grid that reads "drag a column header
 * here to group", copied from the AdLabs chrome the operator compared against
 * (`02-data-grid.md` §0, item 5).
 *
 * Three gestures, all reducing to list edits in `grouping.ts`:
 *
 *   - drop a column header on the bar        append a level (or nest before a chip)
 *   - drag a chip onto another chip           reorder
 *   - the × on a chip                          remove
 *
 * The keyboard path is the same list: an "Add grouping level" select and
 * per-chip move up / move down / remove buttons. Nothing here is reachable by
 * mouse only. Emits the whole ordered list on every change; the pipeline
 * recomputes ratios from summed bases at each level.
 *
 * Acceptance is decided from the `DataTransfer` types alone, because that is
 * all a browser exposes during `dragover`: a header advertises
 * `DIMENSION_DRAG_TYPE` only when it can be grouped on, so a metric dragged
 * over the bar never lights it up. The id is still checked against this bar's
 * own dimensions on drop, in case the drag came from a grid of another entity.
 */
import { useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import type { GridColumn } from '../columns.js';
import {
  DIMENSION_DRAG_TYPE,
  GROUP_LEVEL_DRAG_TYPE,
  hasDragPayload,
  insertGroupLevel,
  readDragPayload,
  removeGroupLevel,
  shiftGroupLevel,
  writeDragPayload,
} from '../grouping.js';
import {
  control,
  groupBar,
  groupBarActive,
  groupChip,
  groupChipDropTarget,
  groupHint,
  groupingLabel,
  groupingList,
  levelButtonStyle,
  levelNumber,
} from './styles.js';

export interface GroupBarProps {
  dimensions: readonly GridColumn[];
  groupBy: readonly string[];
  onChange: (columnIds: string[]) => void;
}

export function GroupBar({ dimensions, groupBy, onChange }: GroupBarProps): ReactNode {
  const [barActive, setBarActive] = useState(false);
  const [chipTarget, setChipTarget] = useState<string | null>(null);
  const remaining = dimensions.filter((column) => !groupBy.includes(column.id));
  const isDimension = (id: string): boolean => dimensions.some((column) => column.id === id);

  /** What a drop carries, if it is something this bar accepts. */
  const payloadOf = (event: DragEvent): string | null => {
    const transfer = event.dataTransfer;
    if (hasDragPayload(transfer, GROUP_LEVEL_DRAG_TYPE)) {
      return readDragPayload(transfer, GROUP_LEVEL_DRAG_TYPE);
    }
    if (hasDragPayload(transfer, DIMENSION_DRAG_TYPE)) {
      const id = readDragPayload(transfer, DIMENSION_DRAG_TYPE);
      return id !== null && isDimension(id) ? id : null;
    }
    return null;
  };

  const accepts = (event: DragEvent): boolean =>
    hasDragPayload(event.dataTransfer, GROUP_LEVEL_DRAG_TYPE) ||
    hasDragPayload(event.dataTransfer, DIMENSION_DRAG_TYPE);

  const dropOn = (event: DragEvent, beforeId: string | null): void => {
    event.preventDefault();
    event.stopPropagation();
    setBarActive(false);
    setChipTarget(null);
    const id = payloadOf(event);
    if (id === null) return;
    const next = insertGroupLevel(groupBy, id, beforeId);
    if (next.length !== groupBy.length || next.some((level, index) => level !== groupBy[index])) {
      onChange(next);
    }
  };

  return (
    <div
      data-testid="grid-group-bar"
      data-drop-active={barActive ? 'true' : 'false'}
      role="group"
      aria-label="Group by"
      style={barActive ? groupBarActive : groupBar}
      onDragOver={(event) => {
        if (!accepts(event)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        setBarActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBarActive(false);
      }}
      onDrop={(event) => dropOn(event, null)}
    >
      <span style={groupingLabel}>Group by</span>
      <ol style={groupingList} aria-label="Ordered grouping levels">
        {groupBy.map((columnId, index) => {
          const label = dimensions.find((column) => column.id === columnId)?.header ?? columnId;
          const isFirst = index === 0;
          const isLast = index === groupBy.length - 1;
          return (
            <li
              key={columnId}
              data-testid="grid-group-chip"
              draggable
              onDragStart={(event) => {
                writeDragPayload(event.dataTransfer, GROUP_LEVEL_DRAG_TYPE, columnId);
                event.stopPropagation();
              }}
              onDragOver={(event) => {
                if (!accepts(event)) return;
                event.preventDefault();
                event.stopPropagation();
                setChipTarget(columnId);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setChipTarget((current) => (current === columnId ? null : current));
                }
              }}
              onDrop={(event) => dropOn(event, columnId)}
              style={chipTarget === columnId ? groupChipDropTarget : groupChip}
            >
              <span aria-hidden style={levelNumber}>{index + 1}</span>
              <span>{label}</span>
              <button
                type="button"
                aria-label={`Move ${label} up`}
                disabled={isFirst}
                onClick={() => onChange(shiftGroupLevel(groupBy, index, -1))}
                style={levelButtonStyle(isFirst)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                disabled={isLast}
                onClick={() => onChange(shiftGroupLevel(groupBy, index, 1))}
                style={levelButtonStyle(isLast)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove grouping level ${label}`}
                onClick={() => onChange(removeGroupLevel(groupBy, columnId))}
                style={levelButtonStyle(false)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
      {groupBy.length === 0 ? (
        <span style={groupHint}>Drag a column header here to group. Drop another to nest.</span>
      ) : null}
      <select
        aria-label="Add grouping level"
        value=""
        disabled={remaining.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onChange(insertGroupLevel(groupBy, event.target.value));
        }}
        style={control}
      >
        <option value="">{groupBy.length === 0 ? 'Group by…' : 'Add level…'}</option>
        {remaining.map((column) => (
          <option key={column.id} value={column.id}>
            {column.header}
          </option>
        ))}
      </select>
    </div>
  );
}
