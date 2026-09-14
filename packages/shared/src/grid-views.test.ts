import { describe, expect, it } from 'vitest';
import { parseGridView, serializeGridView, type GridSavedView } from './grid-views.js';
const view: GridSavedView = {
  id: 'synthetic', name: '分析 café', entity: 'targets', columns: ['targeting', 'spend'],
  widths: { targeting: 301 }, pinned: ['targeting'], density: 'compact',
  filter: { groups: [{ filters: [{ key: 'SPEND', logical_operator: 'AND', conditions: [{ operator: '>', values: ['12'] }] }] }] },
  sort: [{ columnId: 'spend', direction: 'desc' }], groupBy: ['campaign_name'],
  collapsedGroupIds: ['group-one'], dateRange: { start: '2026-08-01', end: '2026-08-31' }, updatedAt: '2026-09-01',
};
describe('shareable grid view', () => {
  it('round trips every field, including Unicode and collapse', () => {
    expect(parseGridView(serializeGridView(view))).toEqual(view);
    expect(Object.keys(parseGridView(serializeGridView(view))!)).toHaveLength(Object.keys(view).length);
  });
  it('rejects unknown versions, malformed input and invalid schema', () => {
    expect(['2.e30', '1.!', '1.e30', '1._w', null].map(parseGridView)).toEqual(Array(5).fill(null));
  });
});
