import { describe, expect, it } from 'vitest';
import { columnsFor } from '../columns.js';
import { groupColumns, searchColumns } from './column-groups.js';

describe('column picker groups', () => {
  it('groups the full catalogue by subject and preserves all four metric variants', () => {
    const available = columnsFor('targets');
    const groups = groupColumns(available);
    expect(groups.map((group) => group.id)).toEqual(['Identity', 'RANK & ORGANIC', 'SPONSORED PRODUCTS', 'SQP', 'BRAND ANALYTICS']);
    const regrouped = groups.flatMap((group) => group.columns.map((column) => column.id));
    expect(regrouped).toHaveLength(available.length);
    expect(new Set(regrouped).size).toBe(available.length);
    const sponsored = groups.find((group) => group.id === 'SPONSORED PRODUCTS')!;
    expect(sponsored.columns.map((column) => column.id)).toEqual(expect.arrayContaining(['acos', 'acos_comparison', 'acos_delta_absolute', 'acos_delta_percent']));
    expect(groups.find((group) => group.id === 'RANK & ORGANIC')?.columns.map((column) => column.id)).toContain('rank_grid');

  });

  it('matches every query word against header, id and description', () => {
    const available = columnsFor('search_terms');
    expect(searchColumns(available, 'acos prev').map((column) => column.id)).toEqual(['acos_comparison']);
    expect(searchColumns(available, 'harvest').map((column) => column.id)).toEqual(['harvested']);
    expect(searchColumns(available, 'RE-HARVESTS').map((column) => column.id)).toEqual(['harvested']);
    expect(searchColumns(available, '   ')).toHaveLength(available.length);
    expect(searchColumns(available, 'no such column')).toEqual([]);
  });
});
