import { describe, expect, it } from 'vitest';
import { decodeGridRowColumns, encodeGridRowColumns, encodeGridPerformance, decodeGridPerformance, parseGridView, serializeGridView, type GridSavedView, type GridTransportRow, GridSavedView as GridSavedViewSchema } from './grid-views.js';
const view: GridSavedView = {
  id: 'synthetic', name: '分析 café', entity: 'targets', columns: ['targeting', 'spend'],
  widths: { targeting: 301 }, alignments: { targeting: 'left', spend: 'right' }, pinned: ['targeting'], density: 'compact',
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


describe('compact rank transport', () => {
  it('validates every history up front and materializes only the requested row', () => {
    const wire = { feeds: [], unattributed: null, rankAxis: Array.from({ length: 14 }, (_, index) => `2026-07-${String(index + 1).padStart(2, '0')}`), rankValues: { first: Array(14).fill(8), second: Array(14).fill(null) } };
    const decoded = decodeGridPerformance(wire);
    expect(Object.keys(decoded.rankDays)).toEqual(['first', 'second']);
    expect(Object.getOwnPropertyDescriptor(decoded.rankDays, 'first')?.get).toBeTypeOf('function');
    const first = decoded.rankDays['first'];
    expect(first).toHaveLength(14);

    expect(first?.every((day) => day.observed && day.rank === 8)).toBe(true);
    expect(decoded.rankDays['first']).toBe(first);
    expect(Object.getOwnPropertyDescriptor(decoded.rankDays, 'second')?.get).toBeTypeOf('function');
    wire.rankValues.second[0] = 12;
    expect(decoded.rankDays['second']?.[0]?.observed).toBe(false);
    expect(() => decodeGridPerformance({ ...wire, rankValues: { second: Array(14) } })).toThrow();
    expect(() => decodeGridPerformance({ ...wire, rankValues: { ...wire.rankValues, second: Array(14).fill(-1) } })).toThrow();
    expect(JSON.parse(JSON.stringify(decoded)).rankDays.second).toHaveLength(14);
  });
  it('shares dates, omits untouched histories and distinguishes unobserved from never ranked', () => {
    const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, '0')}`, observed: index > 0, rank: index > 1 ? index : null }));
    const evidence = { feeds: [], unattributed: null, rankDays: { measured: days, untouched: days.map((day) => ({ ...day, observed: false, rank: null })) } };
    const wire = encodeGridPerformance(evidence);
    expect(wire.rankAxis).toHaveLength(14);
    expect(Object.keys(wire.rankValues)).toEqual(['measured']);
    expect(wire.rankValues['measured']!.slice(0, 3)).toEqual([null, 0, 2]);
    expect(decodeGridPerformance(wire).rankDays).toEqual({ measured: days });
    expect(() => decodeGridPerformance({ ...wire, rankAxis: [] })).toThrow('date axis');
  });
});


describe('lossless grid row columns', () => {
  it('validates dimension primitives without accepting nonfinite numbers or nested values', () => {
    const totals = { impressions: 1, clicks: 1, spend: 1, sales: 1, orders: 1, units: 1 };
    const wire = encodeGridRowColumns([{ id: 'synthetic', currencyCode: 'USD', dimensions: {}, totals, comparison: null }]);
    for (const value of [null, true, false, 0, -1.5, '', 'Synthetic']) {
      expect(decodeGridRowColumns({ ...wire, dimensions: { value: [value] } })[0]!.dimensions['value']).toBe(value);
    }
    for (const value of [NaN, Infinity, -Infinity, undefined, {}, [], 1n]) {
      expect(() => decodeGridRowColumns({ ...wire, dimensions: { value: [value] } })).toThrow();
    }
  });
  it('round trips comparisons, nulls, absent keys, precision, measurement masks and tags', () => {
    const totals = { impressions: 100, clicks: 4, spend: 1.23456789, sales: 6.78901234, orders: 2, units: 3 };
    const rows: GridTransportRow[] = [
      { id: 'a', currencyCode: 'USD', dimensions: { nullable: null, name: 'Synthetic 日本語', flag: false }, totals, comparison: totals, tagIds: ['synthetic'], measurement: { missing: ['spend' as const], comparisonMissing: ['sales' as const] } },
      { id: 'b', currencyCode: 'EUR', dimensions: { name: 'Synthetic other' }, totals, comparison: null, tagIds: [] },
    ];
    const encoded = encodeGridRowColumns(rows);
    expect(decodeGridRowColumns(JSON.parse(JSON.stringify(encoded)))).toEqual(rows);
    expect(() => decodeGridRowColumns({ ...encoded, ids: [] })).toThrow();
    expect(() => decodeGridRowColumns({ ...encoded, comparison: { ...encoded.comparison, spend: [null, null] } })).toThrow();
    expect(() => decodeGridRowColumns({ ...encoded, tags: { 2: [] } })).toThrow();
    expect(decodeGridRowColumns(encodeGridRowColumns([]))).toEqual([]);
  });
});

const target = {
  series: { bid: true, realisedCpc: true, suggestedBand: true, maxCpc: false, dailySpend: true, acos: true },
  maxCpcExpanded: true,
};
const compare = Array.from({ length: 4 }, (_, index) => ({
  profileId: '00000000-0000-4000-8000-000000000001', targetId: `synthetic-${index}`,
}));
describe('Target 360 saved state', () => {
  it('preserves all four comparisons, toggles and originating grid fields', () => {
    const saved = { ...view, target, compare };
    const restored = parseGridView(serializeGridView(saved));
    expect(restored).toEqual(saved);
    expect(restored?.compare).toHaveLength(4);
  });
  it('leaves existing saved views unchanged', () => {
    expect(parseGridView(serializeGridView(view))).toEqual(view);
    expect(parseGridView(serializeGridView(view))).not.toHaveProperty('target');
  });
  it('refuses a fifth target', () => {
    expect(GridSavedViewSchema.safeParse({ ...view, compare: [...compare, { ...compare[0]!, targetId: 'fifth' }] }).success).toBe(false);
  });
  it('refuses duplicate target identities', () => {
    expect(GridSavedViewSchema.safeParse({ ...view, compare: [compare[0], compare[0]] }).success).toBe(false);
  });
  it('distinguishes identical target identifiers in different profiles', () => {
    expect(GridSavedViewSchema.safeParse({ ...view, compare: [compare[0], { ...compare[0]!, profileId: '00000000-0000-4000-8000-000000000002' }] }).success).toBe(true);
  });
  it('refuses unknown series instead of silently losing state', () => {
    expect(GridSavedViewSchema.safeParse({ ...view, target: { ...target, series: { ...target.series, invented: true } } }).success).toBe(false);
  });
});


describe('Change queue saved state', () => {
  it('round trips source, state and density in its own namespace', () => {
    const saved = { ...view, changeQueue: { filters: { source: 'queued' as const, state: 'awaiting review' as const }, density: 'comfortable' as const } };
    expect(parseGridView(serializeGridView(saved))).toEqual(saved);
    expect(parseGridView(serializeGridView(saved).replace(/^1\./, '2.'))).toBeNull();
    expect(GridSavedViewSchema.safeParse({ ...saved, changeQueue: { ...saved.changeQueue, filters: { source: 'invented' } } }).success).toBe(false);
  });
});
