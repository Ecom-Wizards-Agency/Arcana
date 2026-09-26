'use client';
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { formatInteger } from '../format.js';
import { tokens } from '../theme.js';

/** Of the rows a select-all acts on, how many are selected: none, some or all. */
export type SelectionState = 'none' | 'some' | 'all';

export function selectionState(rowIds: readonly string[], selected: ReadonlySet<string>): SelectionState {
  let count = 0;
  for (const id of rowIds) if (selected.has(id)) count += 1;
  return count === 0 ? 'none' : count === rowIds.length ? 'all' : 'some';
}

/**
 * The header checkbox of a selection column, with the three states a bulk
 * selection has. A partial selection is drawn as the native mixed state and
 * announced as `aria-checked="mixed"`, so "some rows are selected" is never read
 * as "none" (J4). Checking selects every row it counts; unchecking clears them.
 */
export function SelectAllCheckbox({ state, count, onChange, label }: {
  state: SelectionState;
  /** Rows the checkbox acts on; zero disables it. */
  count: number;
  onChange: (select: boolean) => void;
  label?: string;
}): ReactNode {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (input.current !== null) input.current.indeterminate = state === 'some';
  }, [state]);
  return <input
    ref={input}
    type="checkbox"
    aria-label={label ?? `Select all ${formatInteger(count)} ${count === 1 ? 'row' : 'rows'}`}
    aria-checked={state === 'some' ? 'mixed' : state === 'all'}
    data-selection-state={state}
    checked={state === 'all'}
    disabled={count === 0}
    onClick={(event) => event.stopPropagation()}
    onChange={() => onChange(state !== 'all')}
    style={{ margin: 0, width: 14, height: 14, accentColor: tokens.color.indigo, cursor: count === 0 ? 'default' : 'pointer' }}
  />;
}
