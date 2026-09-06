'use client';

/**
 * The free-text entity search box at the left of the toolbar. It owns no
 * state of its own beyond the characters being typed: the text is a `LIKE`
 * filter on the level's identity column (`entity-search.ts`), so it appears as
 * a chip, saves with the view and survives a reload like every other filter.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { GridColumn } from '../columns.js';
import type { Filter } from '../filter.js';
import { entitySearchColumn, readEntitySearch, writeEntitySearch } from './entity-search.js';
import { searchBox } from './styles.js';

export interface EntitySearchProps {
  available: readonly GridColumn[];
  filters: readonly Filter[];
  onChange: (filters: readonly Filter[]) => void;
}

export function EntitySearch({ available, filters, onChange }: EntitySearchProps): ReactNode {
  const column = entitySearchColumn(available);
  const applied = readEntitySearch(filters, column);
  const [draft, setDraft] = useState(applied);
  // A chip removed or a view applied changes the filter from outside; the box follows.
  useEffect(() => {
    setDraft(applied);
  }, [applied]);

  if (column === null) return null;
  return (
    <input
      type="search"
      aria-label="Entity search"
      placeholder={`Search ${column.header.toLowerCase()}…`}
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(writeEntitySearch(filters, column, event.target.value));
      }}
      style={searchBox}
    />
  );
}
