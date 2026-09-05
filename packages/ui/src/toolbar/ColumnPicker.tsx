'use client';

/**
 * The column picker panel: one checkbox per available column, grouped by
 * family (attributes, then the four metric families) with one search box
 * that narrows every group. Unchecking removes the column from wherever it
 * was; checking appends it, so the operator's order is never silently
 * reshuffled. "Show all" on a group appends what is missing, in group order.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { GridColumn } from '../columns.js';
import { groupColumns, searchColumns } from './column-groups.js';
import {
  linkButton,
  optionEmpty,
  picker,
  pickerGroupActions,
  pickerGroupTitle,
  pickerGroups,
  pickerItem,
  pickerPanel,
  pickerSearch,
} from './styles.js';

export interface ColumnPickerProps {
  available: readonly GridColumn[];
  /** Visible column ids, in order. */
  visible: readonly string[];
  onVisibleChange: (columnIds: string[]) => void;
}

export function ColumnPicker({ available, visible, onVisibleChange }: ColumnPickerProps): ReactNode {
  const [query, setQuery] = useState('');
  const groups = useMemo(
    () =>
      groupColumns(searchColumns(available, query)),
    [available, query],
  );

  return (
    <div role="region" aria-label="Column picker" style={pickerPanel}>
      <input
        aria-label="Search columns"
        value={query}
        placeholder="Search columns"
        onChange={(event) => setQuery(event.target.value)}
        style={pickerSearch}
      />
      <div style={pickerGroups}>
        {groups.length === 0 ? <p style={optionEmpty}>No columns match this search.</p> : null}
        {groups.map((group) => {
          const shownIds = group.columns.map((column) => column.id);
          const missing = shownIds.filter((id) => !visible.includes(id));
          return (
            <section key={group.id} role="group" aria-label={group.label}>
              <h3 style={pickerGroupTitle}>
                {group.label}
                <span style={pickerGroupActions}>
                  <button
                    type="button"
                    disabled={missing.length === 0}
                    onClick={() => onVisibleChange([...visible, ...missing])}
                    style={linkButton}
                  >
                    Show all
                  </button>
                  <button
                    type="button"
                    disabled={missing.length === shownIds.length}
                    onClick={() => onVisibleChange(visible.filter((id) => !shownIds.includes(id)))}
                    style={linkButton}
                  >
                    Hide all
                  </button>
                </span>
              </h3>
              <div style={picker}>
                {group.columns.map((column) => {
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
            </section>
          );
        })}
      </div>
    </div>
  );
}
