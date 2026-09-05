'use client';

/**
 * Saved views: a select that applies one, and, when saving is allowed, a name
 * box and a Save button. The select always shows its placeholder because
 * applying a view is an action, not a persistent selection.
 */
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { SavedView } from '../views.js';
import { button, control, controlWidth } from './styles.js';

export interface SavedViewsProps {
  views: readonly SavedView[];
  onApply?: (view: SavedView) => void;
  onSave?: (name: string) => void;
}

export function SavedViews({ views, onApply, onSave }: SavedViewsProps): ReactNode {
  const [name, setName] = useState('');
  return (
    <>
      <select
        aria-label="Saved view"
        value=""
        onChange={(event) => {
          const view = views.find((candidate) => candidate.id === event.target.value);
          if (view !== undefined) onApply?.(view);
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
