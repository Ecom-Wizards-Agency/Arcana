'use client';

/**
 * The filter builder: a draft row that reads `<column> <operator> <value>` and
 * the chip list of filters already applied.
 *
 * The row is deliberately chip-shaped rather than a modal query builder. The
 * recon's filter grammar is uniform across entities (54 keys on campaigns
 * alone, same shape everywhere), which is what makes chips work: one control
 * covers every column at every level, and an operator who learns it once never
 * learns it again.
 *
 * Draft state lives here and nowhere else. The builder emits a complete
 * `Filter` on Add; the toolbar folds it into the `FilterSet` a saved view
 * stores and a deep link restores. Clicking a chip hands its filter back in as
 * a `prefill`, the button reads Update, and the toolbar replaces the chip
 * rather than appending a second one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { GridColumn } from '../columns.js';
import { filterKindForColumn } from '../columns.js';
import type { Filter, FilterOperator } from '../filter.js';
import { columnIdToFilterKey } from '../filter.js';
import {
  buildCategoricalOptions,
  searchFilterOptions,
  selectAllFilterOptions,
  toggleFilterOption,
} from '../filter-options.js';
import type { GridRow } from '../rows.js';
import { OPERATOR_LABELS, describeFilter, operatorsFor } from './operators.js';
import {
  button,
  chip,
  chipClose,
  chipLabelButton,
  control,
  controlWidth,
  linkButton,
  optionCount,
  optionEmpty,
  optionHint,
  optionItem,
  optionList,
  row,
  valuePicker,
  valuePickerActions,
  valuePickerWrap,
  valueSearch,
  valueTrigger,
} from './styles.js';

const MAX_RENDERED_OPTIONS = 200;

/** A filter handed back to the builder for editing, with a token so the same filter can be reopened. */
export interface FilterPrefill {
  filter: Filter;
  token: number;
}

export interface FilterBuilderProps {
  /** Every column available at this level, for the key list and operator sets. */
  available: readonly GridColumn[];
  /** Complete authorized rows, before filters, used only to derive categorical choices. */
  optionRows: readonly GridRow[];
  onAdd: (filter: Filter) => void;
  /** Present while a chip is being edited: the draft loads from it and Add reads Update. */
  prefill?: FilterPrefill | null | undefined;
  onCancelEdit?: (() => void) | undefined;
}

export function FilterBuilder({
  available,
  optionRows,
  onAdd,
  prefill = null,
  onCancelEdit,
}: FilterBuilderProps): ReactNode {
  const [draftKey, setDraftKey] = useState('');
  const [draftOperator, setDraftOperator] = useState<FilterOperator>('LIKE');
  const [draftValue, setDraftValue] = useState('');
  const [draftValues, setDraftValues] = useState<string[]>([]);
  const [valuePickerOpen, setValuePickerOpen] = useState(false);
  const [optionSearch, setOptionSearch] = useState('');
  const valueTriggerRef = useRef<HTMLButtonElement>(null);

  const draftColumn = available.find((column) => columnIdToFilterKey(column.id) === draftKey);
  const draftKind = draftColumn === undefined ? 'text' : filterKindForColumn(draftColumn);
  const categoricalOptions = useMemo(
    () =>
      draftKind === 'categorical' && draftColumn !== undefined
        ? buildCategoricalOptions(optionRows, draftColumn.id)
        : [],
    [draftColumn, draftKind, optionRows],
  );
  const matchingOptions = useMemo(
    () => searchFilterOptions(categoricalOptions, optionSearch),
    [categoricalOptions, optionSearch],
  );

  const resetDraft = (): void => {
    setDraftValue('');
    setDraftValues([]);
    setOptionSearch('');
    setValuePickerOpen(false);
  };

  // Load the draft from a chip. Only the first condition is editable here;
  // the builder never produced a multi-condition filter and does not pretend to.
  useEffect(() => {
    if (prefill === null) return;
    const { filter } = prefill;
    const column = available.find((candidate) => columnIdToFilterKey(candidate.id) === filter.key);
    const condition = filter.conditions[0];
    const kind = column === undefined ? 'text' : filterKindForColumn(column);
    const allowed = operatorsFor(column);
    const operator = condition?.operator ?? '=';
    setDraftKey(filter.key);
    setDraftOperator(allowed.includes(operator) ? operator : (allowed[0] as FilterOperator));
    setDraftValue(kind === 'categorical' ? '' : condition?.values[0] ?? '');
    setDraftValues(kind === 'categorical' ? [...(condition?.values ?? [])] : []);
    setOptionSearch('');
    setValuePickerOpen(false);
  }, [available, prefill]);

  const addFilter = (): void => {
    const values = draftKind === 'categorical' ? draftValues : [draftValue.trim()].filter(Boolean);
    if (draftKey === '' || values.length === 0) return;
    onAdd({ key: draftKey, conditions: [{ operator: draftOperator, values }] });
    if (prefill !== null) setDraftKey('');
    resetDraft();
  };

  const cancelEdit = (): void => {
    setDraftKey('');
    setDraftOperator('LIKE');
    resetDraft();
    onCancelEdit?.();
  };

  const operators = operatorsFor(draftColumn);

  /** Selecting a column re-derives the operator set and snaps the draft into it. */
  const chooseKey = (key: string): void => {
    setDraftKey(key);
    const column = available.find((candidate) => columnIdToFilterKey(candidate.id) === key);
    const next = operatorsFor(column);
    if (!next.includes(draftOperator)) setDraftOperator(next[0] as FilterOperator);
    resetDraft();
  };

  const editing = prefill !== null;

  return (
    <div style={row} data-toolbar-row="filters">
      <select
        aria-label="Filter column"
        value={draftKey}
        onChange={(event) => chooseKey(event.target.value)}
        style={control}
      >
        <option value="">Add filter…</option>
        {available.map((column) => (
          <option key={column.id} value={columnIdToFilterKey(column.id)}>
            {column.header}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter operator"
        value={draftOperator}
        onChange={(event) => setDraftOperator(event.target.value as FilterOperator)}
        style={controlWidth('10rem')}
      >
        {operators.map((operator) => (
          <option key={operator} value={operator}>
            {OPERATOR_LABELS[operator]}
          </option>
        ))}
      </select>
      {draftKind === 'categorical' ? (
        <div style={valuePickerWrap}>
          <button
            ref={valueTriggerRef}
            type="button"
            aria-label="Filter values"
            aria-expanded={valuePickerOpen}
            aria-haspopup="dialog"
            onClick={() => setValuePickerOpen((open) => !open)}
            style={valueTrigger}
          >
            {draftValues.length === 0
              ? `Choose ${draftColumn?.header.toLowerCase() ?? 'values'}…`
              : `${draftValues.length} selected`}
            <span aria-hidden>▾</span>
          </button>
          {valuePickerOpen ? (
            <div
              role="dialog"
              aria-label={`${draftColumn?.header ?? 'Filter'} values`}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                setValuePickerOpen(false);
                valueTriggerRef.current?.focus();
              }}
              style={valuePicker}
            >
              <input
                autoFocus
                aria-label="Search filter values"
                value={optionSearch}
                onChange={(event) => setOptionSearch(event.target.value)}
                placeholder="Search values"
                style={valueSearch}
              />
              <div style={valuePickerActions}>
                <button
                  type="button"
                  onClick={() =>
                    setDraftValues((selected) => selectAllFilterOptions(selected, matchingOptions))
                  }
                  disabled={matchingOptions.length === 0}
                  style={linkButton}
                >
                  Select all{optionSearch.trim() === '' ? '' : ` (${matchingOptions.length})`}
                </button>
                <button
                  type="button"
                  onClick={() => setDraftValues([])}
                  disabled={draftValues.length === 0}
                  style={linkButton}
                >
                  Clear
                </button>
                <span style={optionCount}>{draftValues.length} selected</span>
              </div>
              <div style={optionList}>
                {matchingOptions.slice(0, MAX_RENDERED_OPTIONS).map((option) => (
                  <label key={option.value.toLowerCase()} style={optionItem}>
                    <input
                      type="checkbox"
                      checked={draftValues.some(
                        (selected) => selected.toLowerCase() === option.value.toLowerCase(),
                      )}
                      onChange={() =>
                        setDraftValues((selected) => toggleFilterOption(selected, option.value))
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
                {matchingOptions.length === 0 ? (
                  <p style={optionEmpty}>No values match this search.</p>
                ) : null}
              </div>
              {matchingOptions.length > MAX_RENDERED_OPTIONS ? (
                <p style={optionHint}>
                  Showing the first {MAX_RENDERED_OPTIONS}. Search to narrow the list; Select all
                  still selects all {matchingOptions.length} matches.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <input
          aria-label="Filter value"
          value={draftValue}
          placeholder={draftColumn === undefined ? 'Choose a field' : draftColumn.header}
          onChange={(event) => setDraftValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addFilter();
          }}
          style={controlWidth('9rem')}
        />
      )}
      <button
        type="button"
        onClick={addFilter}
        disabled={draftKey === '' || (draftKind === 'categorical' ? draftValues.length === 0 : draftValue.trim() === '')}
        style={button}
      >
        {editing ? 'Update' : 'Add'}
      </button>
      {editing ? (
        <button type="button" onClick={cancelEdit} style={linkButton}>
          Cancel
        </button>
      ) : null}
    </div>
  );
}

export interface FilterChipsProps {
  filters: readonly Filter[];
  available: readonly GridColumn[];
  onChange: (filters: readonly Filter[]) => void;
  /** Called with the chip's index when its label is clicked; omit and chips are read-only. */
  onEdit?: ((index: number) => void) | undefined;
}

/**
 * The applied filters as removable chips. Renders nothing when there are none.
 * A chip whose key the builder can express is a button that reopens it; the
 * meta keys (tags, deltas) it cannot express stay plain text.
 */
export function FilterChips({ filters, available, onChange, onEdit }: FilterChipsProps): ReactNode {
  if (filters.length === 0) return null;
  const editable = (filter: Filter): boolean =>
    onEdit !== undefined && available.some((column) => columnIdToFilterKey(column.id) === filter.key);
  return (
    <div style={row}>
      {filters.map((filter, index) => (
        <span key={`${filter.key}-${index}`} style={chip}>
          {editable(filter) ? (
            <button
              type="button"
              aria-label={`Edit filter ${filter.key}`}
              onClick={() => onEdit?.(index)}
              style={chipLabelButton}
            >
              {describeFilter(filter, available)}
            </button>
          ) : (
            describeFilter(filter, available)
          )}
          <button
            type="button"
            aria-label={`Remove filter ${filter.key}`}
            onClick={() => onChange(filters.filter((_, i) => i !== index))}
            style={chipClose}
          >
            ×
          </button>
        </span>
      ))}
      <button type="button" onClick={() => onChange([])} style={linkButton}>
        Clear all
      </button>
    </div>
  );
}
