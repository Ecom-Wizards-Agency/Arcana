'use client';

/**
 * The grid's chrome: entity search, the filter builder and its chips, density,
 * the column picker, saved views, fullscreen, export, and the group bar.
 *
 * Every control here edits the same `FilterSet` / column-order / group-by state
 * a saved view stores and a deep link restores. There is no "toolbar state" and
 * "view state" -- one object, so what an operator sees is exactly what gets
 * shared. The entity search box is the clearest case: it is a `LIKE` filter
 * on the identity column, not a second search mechanism.
 *
 * This file composes and lays out; the controls live beside it:
 *
 *   `toolbar/EntitySearch.tsx`    free text as a filter on the pinned dimension
 *   `toolbar/FilterBuilder.tsx`   the draft row and the applied-filter chips
 *   `toolbar/ColumnPicker.tsx`    the grouped, searchable visible-column checklist
 *   `toolbar/GroupBar.tsx`        the drop zone and ordered, reorderable grouping chips
 *   `toolbar/SavedViews.tsx`      apply, save and delete named views
 *   `toolbar/operators.ts`        operator sets, labels and `describeFilter`
 *
 * Layout, top to bottom: search and filter draft; the control row; applied
 * chips; the column picker when open; and last the group bar, so it sits
 * directly above the grid whose headers are dragged into it.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { EntityLevel, GridColumn } from './columns.js';
import { ENTITY_LABELS, ENTITY_LEVELS } from './columns.js';
import { DENSITY_LABELS, GRID_DENSITIES } from './density.js';
import type { GridDensity } from './density.js';
import type { Filter, FilterSet } from './filter.js';
import { formatInteger } from './format.js';
import type { GridModel } from './pipeline.js';
import type { GridRow } from './rows.js';
import type { SavedView } from './views.js';
import { ColumnPicker } from './toolbar/ColumnPicker.js';
import { EntitySearch } from './toolbar/EntitySearch.js';
import { FilterBuilder, FilterChips } from './toolbar/FilterBuilder.js';
import type { FilterPrefill } from './toolbar/FilterBuilder.js';
import { GroupBar } from './toolbar/GroupBar.js';
import { SavedViews } from './toolbar/SavedViews.js';
import {
  bar,
  button,
  control,
  controlsRow,
  primaryButton,
  row,
  segmentStyle,
  segmented,
  spacer,
} from './toolbar/styles.js';

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
  onRemoveView?: (view: SavedView) => void;
  /** Row density; the control appears only when the host can persist a change. */
  density?: GridDensity;
  onDensityChange?: (density: GridDensity) => void;
  /** Fullscreen; the toggle appears only when the host owns a fullscreen mode. */
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** Rendered to the right of the counts: freshness, crosscheck chip, anything. */
  children?: ReactNode;
}

const NO_ROWS: readonly GridRow[] = [];

export function GridToolbar(props: GridToolbarProps): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState<(FilterPrefill & { index: number }) | null>(null);

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

  const submitFilter = (filter: Filter): void => {
    if (editing === null) {
      setFilters([...filters, filter]);
      return;
    }
    const replaced = filters.map((existing, index) => (index === editing.index ? filter : existing));
    setEditing(null);
    setFilters(replaced);
  };

  return (
    <div style={bar}>
      <div style={row}>
        <EntitySearch available={props.available} filters={filters} onChange={setFilters} />
        <FilterBuilder
          available={props.available}
          optionRows={props.optionRows ?? NO_ROWS}
          onAdd={submitFilter}
          prefill={editing}
          onCancelEdit={() => setEditing(null)}
        />
      </div>

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

        {props.onDensityChange === undefined ? null : (
          <select
            aria-label="Row density"
            value={props.density ?? 'normal'}
            onChange={(event) => props.onDensityChange?.(event.target.value as GridDensity)}
            style={control}
          >
            {GRID_DENSITIES.map((density) => (
              <option key={density} value={density}>
                {DENSITY_LABELS[density]}
              </option>
            ))}
          </select>
        )}

        <button
          type="button"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((open) => !open)}
          style={button}
        >
          Columns ({props.visible.length})
        </button>

        {props.views === undefined ? null : (
          <SavedViews
            views={props.views}
            {...(props.onApplyView === undefined ? {} : { onApply: props.onApplyView })}
            {...(props.onSaveView === undefined ? {} : { onSave: props.onSaveView })}
            {...(props.onRemoveView === undefined ? {} : { onRemove: props.onRemoveView })}
          />
        )}

        {props.onFullscreenChange === undefined ? null : (
          <button
            type="button"
            aria-pressed={props.fullscreen === true}
            onClick={() => props.onFullscreenChange?.(props.fullscreen !== true)}
            style={button}
          >
            {props.fullscreen === true ? 'Exit fullscreen' : 'Enter fullscreen'}
          </button>
        )}

        {props.onExport === undefined ? null : (
          <button type="button" onClick={props.onExport} style={primaryButton}>
            {props.model.grouped
              ? `Export CSV (${formatInteger(props.model.exported)} deepest ${props.model.exported === 1 ? 'group' : 'groups'})`
              : `Export CSV (${formatInteger(props.model.exported)} of ${formatInteger(props.model.total)})`}
          </button>
        )}
      </div>

      <FilterChips
        filters={filters}
        available={props.available}
        onChange={(next) => {
          setEditing(null);
          setFilters(next);
        }}
        onEdit={(index) => {
          const filter = filters[index];
          if (filter === undefined) return;
          setEditing({ index, filter, token: Date.now() });
        }}
      />

      {pickerOpen ? (
        <ColumnPicker
          available={props.available}
          visible={props.visible}
          onVisibleChange={props.onVisibleChange}
        />
      ) : null}

      <GroupBar
        dimensions={dimensions}
        groupBy={selectedGroupBy}
        onChange={props.onGroupByChange}
      />
    </div>
  );
}
