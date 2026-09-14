import { expect, it } from 'vitest';
import { TimelineEventInput } from './timeline-events.js';
import { GridSavedView, parseGridView, serializeGridView } from './grid-views.js';
it('admits exactly four manual kinds, validates dates and excludes actor injection', () => {
    const input = { profileId: '26400000-0000-4000-8000-000000000001', name: 'Synthetic event', start: '2026-08-01', end: null, scopeText: 'Product notes', note: '' };
    for (const kind of ['promotion', 'market', 'listing', 'supply'])
        expect(TimelineEventInput.safeParse({ ...input, kind }).success).toBe(true);
    expect(TimelineEventInput.safeParse({ ...input, kind: 'experiment' }).success).toBe(false);
    expect(TimelineEventInput.safeParse({ ...input, kind: 'promotion', end: '2026-07-01' }).success).toBe(false);
    expect(TimelineEventInput.safeParse({ ...input, kind: 'promotion', actorId: input.profileId }).success).toBe(false);
});
it('round trips selections and zoom through the shared saved view with a four-series cap', () => {
    const value = { id: 'timeline', name: 'Timeline', entity: 'campaigns', columns: [], pinned: [], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: { start: '2026-08-01', end: '2026-08-30' }, updatedAt: '2026-08-30', chartedMeasures: ['spend', 'sales', 'acos', 'cvr'], timeline: { mode: 'organic', hiddenKinds: ['market'], eventId: 'synthetic-event', asin: 'SYNTHETIC', keyword: 'sample', category: '' } };
    const view = GridSavedView.parse(value);
    expect(parseGridView(serializeGridView(view))).toEqual(view);
    expect(GridSavedView.safeParse({ ...value, chartedMeasures: ['spend', 'sales', 'acos', 'cvr', 'orders'] }).success).toBe(false);
    expect(GridSavedView.safeParse({ ...value, chartedMeasures: ['spend', 'spend'] }).success).toBe(false);
});
