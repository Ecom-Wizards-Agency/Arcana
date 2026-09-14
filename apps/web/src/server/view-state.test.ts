import { expect, it } from 'vitest';
import { serializeGridView } from '@wizard-ads/shared';
import { gotoRedirectLocation } from '@wizard-ads/db';
import { gridBackLocation, restoreGotoView } from './view-state';
it('restores a goto view while preserving the existing state and route parameters', () => {
  const view = serializeGridView({ id: 'one', name: 'Synthetic', entity: 'targets', columns: [], widths: {}, pinned: [], filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '' });
  const state = { view, panel: 'synthetic' };
  const location = restoreGotoView(gotoRedirectLocation('/grid?entity=targets', state), state);
  const url = new URL(location, 'https://example.test');
  expect(url.searchParams.get('view')).toBe(view);
  expect(JSON.parse(url.searchParams.get('state')!)).toEqual(state);
  expect(gridBackLocation(location)).toBe(location);
});
it('rejects external and unrelated back destinations', () => {
  expect(['//evil.test/grid', '/grid/elsewhere', '/grid?x=\\evil', '/targets/one'].map(gridBackLocation)).toEqual(Array(4).fill('/grid'));
});
