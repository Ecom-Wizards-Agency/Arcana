import { describe, expect, it } from 'vitest';
import { METRIC_SPECS, resolveField, type GridRow } from '@wizard-ads/ui';
import { GRID_SUMMARY_METRICS, type GridSummaryEvidence } from '@wizard-ads/shared';
import { DEFAULT_SUMMARY_METRICS, summarizeGrid, summaryMetrics, windowTotal } from './summary-model';
import { formatDateWindow, formatShellDate } from '../../ui/date-format';

const BASES = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] as const;
const totals = (spend: number, sales: number) => ({ impressions: 1000, clicks: 20, spend, sales, orders: 2, units: 2 });
/** Reported in both windows. */
const steady: GridRow = { id: 'steady', currencyCode: 'USD', dimensions: {}, totals: totals(10, 40), comparison: totals(8, 20) };
/** Listed only for its comparison facts: no fact row in the selected window. */
const stopped: GridRow = { id: 'stopped', currencyCode: 'USD', dimensions: {}, totals: totals(0, 0), comparison: totals(5, 10),
  measurement: { missing: [...BASES], comparisonMissing: [], unreported: true } };
/** Launched inside the selected window: no comparison facts. */
const launched: GridRow = { id: 'launched', currencyCode: 'USD', dimensions: {}, totals: totals(6, 0), comparison: null };
const evidence: GridSummaryEvidence = { source: 'sp_target', heldFrom: '2026-07-01', heldThrough: '2026-09-15',
  period: { start: '2026-08-17', end: '2026-09-15' }, comparison: { start: '2026-07-18', end: '2026-08-16' } };
/** Window names as the shell formatter writes them. */
const RANGE = `this range (${formatDateWindow('2026-08-17', '2026-09-15')})`;
const PRIOR = `the comparison range (${formatDateWindow('2026-07-18', '2026-08-16')})`;
const card = (summary: ReturnType<typeof summarizeGrid>, key: string) => summary.cards.find((item) => item.key === key)!;

describe('summary window rule', () => {
  it('totals the measured facts of the rows that reported in each window', () => {
    const summary = summarizeGrid([steady, stopped, launched], { entity: 'campaigns', metrics: DEFAULT_SUMMARY_METRICS, evidence });
    expect([summary.current.reported, summary.comparison.reported]).toEqual([2, 2]);
    expect(card(summary, 'spend')).toMatchObject({ current: { value: 16, reason: null }, prior: { value: 13, reason: null } });
    expect(card(summary, 'spend').delta).toBeCloseTo((16 - 13) / 13 * 100, 9);
    // Ratios are rebuilt from the window sums, never averaged.
    expect(card(summary, 'acos').current.value).toBeCloseTo(16 / 40, 9);
    expect(card(summary, 'acos').prior.value).toBeCloseTo(13 / 30, 9);
    expect(card(summary, 'cvr').current.value).toBeCloseTo(4 / 40, 9);
    expect(summary.cards.map((item) => item.key)).toEqual(DEFAULT_SUMMARY_METRICS);
    expect(summary.cards.every((item) => item.current.value !== null && item.prior.value !== null)).toBe(true);
  });

  it('gives the table total the same bases and measurement as the strip', () => {
    const total = windowTotal([steady, stopped, launched])!;
    expect(total.measurement).toBeUndefined();
    expect(total.groupSize).toBe(3);
    expect(resolveField(total, 'spend')).toBe(16);
    expect(resolveField(total, 'spend_comparison')).toBe(13);
    expect(windowTotal([])).toBeNull();
    // A row that reported without spend still makes the spend total unknown.
    const partial = windowTotal([steady, { ...launched, measurement: { missing: ['spend'], comparisonMissing: [] } }])!;
    expect(partial.measurement).toEqual({ missing: ['spend'], comparisonMissing: [] });
    expect(resolveField(partial, 'spend')).toBeNull();
    expect(resolveField(partial, 'sales')).toBe(40);
  });

  it('explains a base some reported rows lack, and every ratio built on it, without calling it unmeasured', () => {
    const withoutSales: GridRow = { ...launched, comparison: totals(1, 1), measurement: { missing: ['sales'], comparisonMissing: [] } };
    const summary = summarizeGrid([steady, withoutSales], { entity: 'campaigns', metrics: ['spend', 'sales', 'acos', 'roas'], evidence });
    expect(card(summary, 'spend').current.value).toBe(16);
    expect(card(summary, 'sales').current).toEqual({ value: null, notMeasured: false, note: null,
      reason: `Sales is missing for 1 of 2 campaigns with facts in ${RANGE}, so no total is shown.` });
    expect(card(summary, 'acos').current.reason).toBe(`Sales is missing for 1 of 2 campaigns with facts in ${RANGE}, so ACOS has no total.`);
    expect(card(summary, 'roas').current.reason).toBe(`Sales is missing for 1 of 2 campaigns with facts in ${RANGE}, so ROAS has no total.`);
    expect(card(summary, 'sales').prior.value).toBe(21);
    expect(card(summary, 'sales').delta).toBeNull();
  });

  it('calls a comparison window not measured only when its source holds no facts for it, naming the source and since when', () => {
    const late = { ...evidence, heldFrom: '2026-08-20' };
    const summary = summarizeGrid([launched], { entity: 'campaigns', metrics: ['spend'], evidence: late });
    expect(card(summary, 'spend').current).toMatchObject({ value: 6, notMeasured: false });
    expect(card(summary, 'spend').current.note).toBe(`Sponsored Products target facts are held from ${formatShellDate('2026-08-20')}, so ${RANGE} is only partly covered.`);
    expect(card(summary, 'spend').prior).toEqual({ value: null, notMeasured: true, note: null,
      reason: `Sponsored Products target facts are held from ${formatShellDate('2026-08-20')}, after ${PRIOR} ends.` });
    expect(card(summary, 'spend').delta).toBeNull();
  });

  it('distinguishes a source that holds nothing, a source that ends early, and rows that did not report', () => {
    const none = summarizeGrid([stopped], { entity: 'search_terms', metrics: ['clicks'], evidence: { ...evidence, source: 'search_term', heldFrom: null, heldThrough: null } });
    expect(card(none, 'clicks').current).toMatchObject({ value: null, notMeasured: true, reason: 'This profile holds no search term facts yet.' });
    const ended = summarizeGrid([stopped], { entity: 'placements', metrics: ['clicks'], evidence: { ...evidence, source: 'placement', heldThrough: '2026-08-10' } });
    expect(card(ended, 'clicks').current).toMatchObject({ notMeasured: true, reason: `Placement facts are held only through ${formatShellDate('2026-08-10')}, before ${RANGE} starts.` });
    // The source reaches the window; these rows simply have no facts in it. Not zero, and not "not measured".
    const silent = summarizeGrid([stopped, { ...stopped, id: 'other' }], { entity: 'campaigns', metrics: ['clicks'], evidence });
    expect(card(silent, 'clicks').current).toMatchObject({ value: null, notMeasured: false, reason: `None of the 2 campaigns in this view has facts for ${RANGE}.` });
    expect(card(silent, 'clicks').prior.value).toBe(40);
    const one = summarizeGrid([stopped], { entity: 'products', metrics: ['clicks'] });
    expect(card(one, 'clicks').current.reason).toBe('The one product in this view has no facts for this range.');
  });

  it('covers an empty view, a switched-off comparison and a zero denominator', () => {
    const empty = summarizeGrid([], { entity: 'targets', metrics: ['spend'], evidence });
    expect(card(empty, 'spend').current).toMatchObject({ value: null, reason: 'No targets match this view.' });
    const off = summarizeGrid([{ ...steady, comparison: null }], { entity: 'targets', metrics: ['spend'], evidence, comparisonOff: true });
    expect(card(off, 'spend')).toMatchObject({ current: { value: 10 }, prior: { value: null, reason: 'Comparison is off.', notMeasured: false }, delta: null });
    const unsold = summarizeGrid([launched], { entity: 'campaigns', metrics: ['acos'], evidence });
    expect(card(unsold, 'acos').current).toMatchObject({ value: null, notMeasured: false, reason: `ACOS is undefined because the sales total is zero in ${RANGE}.` });
    const zeroPrior = summarizeGrid([{ ...steady, comparison: { ...totals(0, 20) } }], { entity: 'campaigns', metrics: ['spend'] });
    expect(card(zeroPrior, 'spend')).toMatchObject({ prior: { value: 0 }, delta: null });
  });
});

describe('summary metric catalogue', () => {
  it('mirrors the grid metric registry exactly, in its order', () => {
    expect([...GRID_SUMMARY_METRICS]).toEqual(METRIC_SPECS.map((spec) => spec.key));
  });
  it('keeps catalogue metrics once, in the saved order, and falls back to the frame default', () => {
    expect(summaryMetrics(undefined)).toEqual(DEFAULT_SUMMARY_METRICS);
    expect(summaryMetrics([])).toEqual(DEFAULT_SUMMARY_METRICS);
    expect(summaryMetrics(['roas', 'spend', 'roas', 'not-a-metric'])).toEqual(['roas', 'spend']);
    expect(DEFAULT_SUMMARY_METRICS).toEqual(['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc']);
  });
});
