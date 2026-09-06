import { describe, expect, it } from 'vitest';
import { columnsFor } from '../columns.js';
import { groupColumns, searchColumns } from './column-groups.js';

describe('column picker groups', () => {
  it('splits a level into attributes and the four metric families, losing nothing', () => {
    const available = columnsFor('targets');
    const groups = groupColumns(available);
    expect(groups.map((group) => group.id)).toEqual([
      'dimensions',
      'metrics',
      'comparison',
      'delta_absolute',
      'delta_percent',
    ]);
    const regrouped = groups.flatMap((group) => group.columns.map((column) => column.id));
    expect(regrouped).toHaveLength(available.length);
    expect(new Set(regrouped).size).toBe(available.length);
    expect(groups[0]?.columns.every((column) => column.kind === 'dimension')).toBe(true);
    expect(groups[1]?.columns.map((column) => column.id)).toContain('acos');
    expect(groups[2]?.columns.map((column) => column.id)).toContain('acos_comparison');
    expect(groups[3]?.columns.map((column) => column.id)).toContain('acos_delta_absolute');
    expect(groups[4]?.columns.map((column) => column.id)).toContain('acos_delta_percent');
    // Every metric family is the same size: four columns per metric.
    expect(new Set(groups.slice(1).map((group) => group.columns.length)).size).toBe(1);
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
