'use client';

/**
 * The grid's chrome: filter chips, group-by, the column picker, saved views and
 * export.
 *
 * Every control here edits the same `FilterSet` / column-order / group-by state
 * a saved view stores and a deep link restores. There is no "toolbar state" and
 * "view state" -- one object, so what an operator sees is exactly what gets
 * shared.
 *
 * This file composes and lays out; the controls live beside it:
 *
 *   `toolbar/FilterBuilder.tsx`   the draft row and the applied-filter chips
 *   `toolbar/ColumnPicker.tsx`    the visible-column checklist
 *   `toolbar/GroupingLevels.tsx`  ordered, reorderable grouping levels
 *   `toolbar/SavedViews.tsx`      apply and save named views
 *   `toolbar/operators.ts`        operator sets, labels and `describeFilter`
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { EntityLevel, GridColumn } from './columns.js';
import { ENTITY_LABELS, ENTITY_LEVELS } from './columns.js';
import type { Filter, FilterSet } from './filter.js';
import { formatInteger } from './format.js';
import type { GridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import type { SavedView } from './views.js';
import { ColumnPicker } from './toolbar/ColumnPicker.js';
import { FilterBuilder, FilterChips } from './toolbar/FilterBuilder.js';
import { GroupingLevels } from './toolbar/GroupingLevels.js';
import { SavedViews } from './toolbar/SavedViews.js';
import { bar, button, controlsRow, primaryButton, segmentStyle, segmented, spacer } from './toolbar/styles.js';

export { describeFilter } from './toolbar/operators.js';

export interface GridToolbarProps {
  entity: EntityLevel;
  onEntityChange?: (entity: EntityLevel) => void;
  /** Every column available at this level, for the picker and the filter key list. */
  available: readonly GridColumn[];
  /** Visible column ids, in order. */
  visible: readonly string[];
  onVisibleChange: (columnIds: string[]) => void;
  filter: FilterSet;
  onFilterChange: (filter: FilterSet) => void;
  groupBy: readonly string[];
  onGroupByChange: (columnIds: string[]) => void;
  model: GridModel;
  /** Complete authorized rows, before filters, used only to derive categorical choices. */
  optionRows?: readonly GridRow[];
  onExport?: () => void;
  views?: readonly SavedView[];
  onApplyView?: (view: SavedView) => void;
  onSaveView?: (name: string) => void;
  /** Rendered to the right of the counts: freshness, crosscheck chip, anything. */
  children?: ReactNode;
}

const NO_ROWS: readonly GridRow[] = [];

export function GridToolbar(props: GridToolbarProps): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false);

  const filters = props.filter.groups[0]?.filters ?? [];
  const dimensions = useMemo(
    () => props.available.filter((column) => column.kind === 'dimension'),
    [props.available],
  );
  const selectedGroupBy = useMemo(
    () => [...new Set(props.groupBy)].filter((id) => dimensions.some((column) => column.id === id)),
    [dimensions, props.groupBy],
  );

  const setFilters = (next: readonly Filter[]): void => {
    props.onFilterChange(next.length === 0 ? { groups: [] } : { groups: [{ filters: next }] });
  };

  return (
    <div style={bar}>
      <FilterBuilder
        available={props.available}
        optionRows={props.optionRows ?? NO_ROWS}
        onAdd={(filter) => setFilters([...filters, filter])}
      />

      <div style={controlsRow} data-toolbar-row="table-controls">
        {props.onEntityChange === undefined ? null : (
          <div style={segmented} role="tablist" aria-label="Entity level">
            {ENTITY_LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                role="tab"
                aria-selected={level === props.entity}
                onClick={() => props.onEntityChange?.(level)}
                style={segmentStyle(level === props.entity)}
              >
                {ENTITY_LABELS[level]}
              </button>
            ))}
          </div>
        )}
        {props.children}
        <div style={spacer} />

        <GroupingLevels
          dimensions={dimensions}
          groupBy={selectedGroupBy}
          onChange={props.onGroupByChange}
        />

        <button type="button" onClick={() => setPickerOpen((open) => !open)} style={button}>
          Columns ({props.visible.length})
        </button>

        {props.views === undefined ? null : (
          <SavedViews
            views={props.views}
            {...(props.onApplyView === undefined ? {} : { onApply: props.onApplyView })}
            {...(props.onSaveView === undefined ? {} : { onSave: props.onSaveView })}
          />
        )}

        {props.onExport === undefined ? null : (
          <button type="button" onClick={props.onExport} style={primaryButton}>
            {props.model.grouped
              ? `Export CSV (${formatInteger(props.model.exported)} deepest ${props.model.exported === 1 ? 'group' : 'groups'})`
              : `Export CSV (${formatInteger(props.model.exported)} of ${formatInteger(props.model.total)})`}
          </button>
        )}
      </div>

      <FilterChips filters={filters} available={props.available} onChange={setFilters} />

      {pickerOpen ? (
        <ColumnPicker
          available={props.available}
          visible={props.visible}
          onVisibleChange={props.onVisibleChange}
        />
      ) : null}
    </div>
  );
}
