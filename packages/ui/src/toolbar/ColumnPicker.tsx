'use client';

/**
 * The column picker panel: one checkbox per available column, toggling it in
 * or out of the visible order. Unchecking removes the column from wherever it
 * was; checking appends it, so the operator's order is never silently reshuffled.
 */
import type { ReactNode } from 'react';
import type { GridColumn } from '../columns.js';
import { picker, pickerItem } from './styles.js';

export interface ColumnPickerProps {
  available: readonly GridColumn[];
  /** Visible column ids, in order. */
  visible: readonly string[];
  onVisibleChange: (columnIds: string[]) => void;
}

export function ColumnPicker({ available, visible, onVisibleChange }: ColumnPickerProps): ReactNode {
  return (
    <div style={picker}>
      {available.map((column) => {
        const checked = visible.includes(column.id);
        return (
          <label key={column.id} style={pickerItem} title={column.description}>
            <input
              type="checkbox"
              checked={checked}
              onChange={() =>
                onVisibleChange(
                  checked
                    ? visible.filter((id) => id !== column.id)
                    : [...visible, column.id],
                )
              }
            />
            {column.header}
          </label>
        );
      })}
    </div>
  );
}
