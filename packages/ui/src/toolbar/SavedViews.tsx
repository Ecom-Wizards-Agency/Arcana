'use client';

/**
 * Saved views: a select that applies one, a name box and Save button when
 * saving is allowed, and a Delete button for the view just applied when
 * removal is allowed. The select always shows its placeholder because applying
 * a view is an action, not a persistent selection; deletion therefore targets
 * the last view applied, named on the button so the operator deletes what
 * they think they are deleting.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SavedView } from '../views.js';
import { button, control, controlWidth } from './styles.js';

export interface SavedViewsProps {
  views: readonly SavedView[];
  onApply?: (view: SavedView) => void;
  onSave?: (name: string) => void;
  onRemove?: (view: SavedView) => void;
}

export function SavedViews({ views, onApply, onSave, onRemove }: SavedViewsProps): ReactNode {
  const [name, setName] = useState('');
  const [appliedId, setAppliedId] = useState<string | null>(null);
  // Resolved against the current list, so a view deleted or renamed elsewhere
  // does not leave a stale delete button behind.
  const applied = appliedId === null ? undefined : views.find((view) => view.id === appliedId);
  return (
    <>
      <select
        aria-label="Saved view"
        value=""
        onChange={(event) => {
          const view = views.find((candidate) => candidate.id === event.target.value);
          if (view === undefined) return;
          setAppliedId(view.id);
          onApply?.(view);
        }}
        style={control}
      >
        <option value="">Saved views…</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
      {onRemove === undefined || applied === undefined ? null : (
        <button
          type="button"
          aria-label={`Delete view ${applied.name}`}
          title={`Delete the saved view “${applied.name}”`}
          onClick={() => {
            setAppliedId(null);
            onRemove(applied);
          }}
          style={button}
        >
          Delete view
        </button>
      )}
      {onSave === undefined ? null : (
        <>
          <input
            aria-label="New view name"
            value={name}
            placeholder="Name this view"
            onChange={(event) => setName(event.target.value)}
            style={controlWidth('9rem')}
          />
          <button
            type="button"
            style={button}
            onClick={() => {
              if (name.trim() === '') return;
              onSave(name.trim());
              setName('');
            }}
          >
            Save view
          </button>
        </>
      )}
    </>
  );
}
