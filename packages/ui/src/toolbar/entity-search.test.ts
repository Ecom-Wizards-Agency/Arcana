import { describe, expect, it } from 'vitest';
import { columnsFor } from '../columns.js';
import type { Filter } from '../filter.js';
import { buildGridModel } from '../pipeline.js';
import { syntheticSearchTermRows } from '../fixtures.js';
import { entitySearchColumn, readEntitySearch, writeEntitySearch } from './entity-search.js';

const acos: Filter = { key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] };

describe('entity search', () => {
  it('searches the pinned identity column of every level', () => {
    expect(entitySearchColumn(columnsFor('campaigns'))?.id).toBe('campaign_name');
    expect(entitySearchColumn(columnsFor('ad_groups'))?.id).toBe('ad_group_name');
    expect(entitySearchColumn(columnsFor('targets'))?.id).toBe('targeting');
    expect(entitySearchColumn(columnsFor('search_terms'))?.id).toBe('search_term');
    expect(entitySearchColumn(columnsFor('placements'))?.id).toBe('placement');
    expect(entitySearchColumn([])).toBeNull();
  });

  it('compiles to one LIKE filter on that column and reads the same text back', () => {
    const column = entitySearchColumn(columnsFor('search_terms'));
    const written = writeEntitySearch([acos], column, '  blue widget ');
    expect(written).toEqual([
      acos,
      { key: 'SEARCH_TERM', conditions: [{ operator: 'LIKE', values: ['blue widget'] }] },
    ]);
    expect(readEntitySearch(written, column)).toBe('blue widget');
    expect(readEntitySearch([acos], column)).toBe('');

    const rows = syntheticSearchTermRows(300, { seed: 9 });
    const model = buildGridModel(rows, { filter: { groups: [{ filters: written }] } });
    expect(model.matched).toBeGreaterThan(0);
    expect(
      model.matchedRows.every((row) =>
        String(row.dimensions['search_term']).toLowerCase().includes('blue widget'),
      ),
    ).toBe(true);
  });

  it('replaces the search in place and removes it when the box is cleared', () => {
    const column = entitySearchColumn(columnsFor('campaigns'));
    const first = writeEntitySearch([], column, 'rank');
    const withMore = [...first, acos];
    const replaced = writeEntitySearch(withMore, column, 'profit');
    expect(replaced.map((filter) => filter.key)).toEqual(['CAMPAIGN_NAME', 'ACOS']);
    expect(readEntitySearch(replaced, column)).toBe('profit');
    expect(writeEntitySearch(replaced, column, '')).toEqual([acos]);
  });

  it('leaves a manual multi-condition or exact filter on the same column alone', () => {
    const column = entitySearchColumn(columnsFor('campaigns'));
    const exact: Filter = { key: 'CAMPAIGN_NAME', conditions: [{ operator: '=', values: ['x'] }] };
    expect(readEntitySearch([exact], column)).toBe('');
    expect(writeEntitySearch([exact], column, 'y')).toEqual([
      exact,
      { key: 'CAMPAIGN_NAME', conditions: [{ operator: 'LIKE', values: ['y'] }] },
    ]);
  });
});
