'use client';

/**
 * Ordered grouping levels: the numbered list of dimensions the grid nests by,
 * each movable up or down and removable, plus a select that appends any
 * dimension not yet in the hierarchy. Emits the whole ordered list on every
 * change; the pipeline recomputes ratios from summed bases at each level.
 */
import type { ReactNode } from 'react';
import type { GridColumn } from '../columns.js';
import {
  control,
  groupingControl,
  groupingLabel,
  groupingLevel,
  groupingList,
  levelButtonStyle,
  levelNumber,
} from './styles.js';

export interface GroupingLevelsProps {
  dimensions: readonly GridColumn[];
  groupBy: readonly string[];
  onChange: (columnIds: string[]) => void;
}

export function GroupingLevels({ dimensions, groupBy, onChange }: GroupingLevelsProps): ReactNode {
  const remaining = dimensions.filter((column) => !groupBy.includes(column.id));
  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= groupBy.length) return;
    const next = [...groupBy];
    const current = next[index];
    const displaced = next[target];
    if (current === undefined || displaced === undefined) return;
    next[index] = displaced;
    next[target] = current;
    onChange(next);
  };

  return (
    <div style={groupingControl} aria-label="Grouping levels">
      <span style={groupingLabel}>Group</span>
      <ol style={groupingList} aria-label="Ordered grouping levels">
        {groupBy.map((columnId, index) => {
          const label = dimensions.find((column) => column.id === columnId)?.header ?? columnId;
          const isFirst = index === 0;
          const isLast = index === groupBy.length - 1;
          return (
            <li key={columnId} style={groupingLevel}>
              <span aria-hidden style={levelNumber}>{index + 1}</span>
              <span>{label}</span>
              <button
                type="button"
                aria-label={`Move ${label} up`}
                disabled={isFirst}
                onClick={() => move(index, -1)}
                style={levelButtonStyle(isFirst)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                disabled={isLast}
                onClick={() => move(index, 1)}
                style={levelButtonStyle(isLast)}
              >
                ↓
              </button>
              <button
                type="button"
                aria-label={`Remove grouping level ${label}`}
                onClick={() => onChange(groupBy.filter((_, level) => level !== index))}
                style={levelButtonStyle(false)}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
      <select
        aria-label="Add grouping level"
        value=""
        disabled={remaining.length === 0}
        onChange={(event) => {
          if (event.target.value !== '') onChange([...groupBy, event.target.value]);
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
