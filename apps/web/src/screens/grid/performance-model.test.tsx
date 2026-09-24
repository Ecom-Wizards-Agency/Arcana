// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveField, type GridRow, type FilterSet } from '@wizard-ads/ui';
import { PerformanceVerdict } from '@wizard-ads/shared';
import { buildPerformanceModel, countPerformanceRows, scopeRows, verdictFilter } from './performance-model';
import { PerformanceSummary } from './performance-chrome';
const rows: GridRow[] = ([
  ['a', 'B000SYN001', 'Efficient', 4.5], ['b', 'B000SYN001', 'Rank gap', 15.5], ['c', 'B000SYN002', 'Efficient', 30],
] as const).map(([id, asin, verdict, spend]) => ({ id: String(id), currencyCode: 'USD', dimensions: { targeting: String(id), asin, verdict }, totals: { spend: Number(spend), sales: 100, clicks: 10, impressions: 100, orders: 1, units: 1 }, comparison: null }));
const filter: FilterSet = { groups: [{ filters: [{ key: 'TARGETING', conditions: [{ operator: '=', values: ['a'] }] }] }] };
describe('performance population', () => {
  it('shares flat row identities across rendering, action scope and complete export', () => {
    const { model } = buildPerformanceModel(rows, { sort: [{ columnId: 'spend', direction: 'desc' }] });
    expect(model.rows).toBe(model.exportRows);
    expect(model.rows).toHaveLength(rows.length);
    for (const row of model.rows) expect(model.matchedRows.find((item) => item.id === row.id)).toBe(row);
    expect(rows.every((row) => row.dimensions['spend_share'] === undefined)).toBe(true);
  });
  it.each(['50%', '50 %', '50,0 %'])('retains both equal spend contributors at the displayed boundary: %s', (value) => {
    const population = rows.slice(0, 2).map((item) => ({ ...item, totals: { ...item.totals, spend: 50 } }));
    for (const operator of ['>=', '='] as const) {
      const model = buildPerformanceModel(population, { filter: { groups: [{ filters: [{ key: 'SPEND_SHARE', conditions: [{ operator, values: [value] }] }] }] } }).model;
      expect(model.matchedRows.map((item) => item.id)).toEqual(['a', 'b']);
      expect(model.rows.map((item) => item.dimensions['spend_share'])).toEqual([0.5, 0.5]);
      expect(resolveField(model.totalsRow!, 'spend')).toBe(100);
    }
  });
  it('counts chips without shaping rows while retaining OR, lowercase verdict and percentage semantics', () => {
    const filters: FilterSet[] = [filter,
      { groups: [{ filters: [{ key: 'verdict', conditions: [{ values: ['efficient'] }] }] }, ...filter.groups] },
      { groups: [{ filters: [{ key: 'spend_share', conditions: [{ operator: '>', values: ['50%'] }] }] }] },
    ];
    for (const active of filters) for (const asin of [null, 'B000SYN001']) for (const diagnosis of PerformanceVerdict.shape.diagnosis.options) {
      const population = scopeRows(rows, asin);
      const clicked = verdictFilter(active, diagnosis);
      expect(countPerformanceRows(population, clicked)).toBe(buildPerformanceModel(population, { filter: clicked }).model.matched);
    }
  });
  it('filters a 75 percent spend contributor using the displayed 50% threshold', () => {
    const population = [25, 75].map((spend, index) => ({ ...rows[index]!, totals: { ...rows[index]!.totals, spend } }));
    for (const key of ['SPEND_SHARE', 'spend_share']) {
      const model = buildPerformanceModel(population, { filter: { groups: [{ filters: [{ key, conditions: [{ operator: '>', values: ['50%'] }] }] }] } }).model;
      expect(model.matchedRows.map((row) => row.id)).toEqual(['b']);
      expect(model.rows[0]!.dimensions['spend_share']).toBe(1);
      expect(resolveField(model.totalsRow!, 'spend')).toBe(75);
    }
  });
  it('replaces lowercase saved verdict predicates and normalizes the selected value', () => {
    const saved = { groups: [{ filters: [{ key: 'verdict', conditions: [{ operator: '=' as const, values: ['efficient'] }] }] }] };
    const next = verdictFilter(saved, ' rank GAP ');
    expect(next.groups[0]!.filters).toEqual([{ key: 'VERDICT', conditions: [{ operator: '=', values: ['Rank gap'] }] }]);
    expect(buildPerformanceModel(rows, { filter: next }).model.matchedRows.map((row) => row.id)).toEqual(['b']);
  });
  it('rebases spend share on active filters and ASIN scope and exports the same shares', () => {
    const one = buildPerformanceModel(scopeRows(rows, 'B000SYN001'), { filter }).model;
    expect(one.matched).toBe(1);
    expect(resolveField(one.totalsRow!, 'spend')).toBe(4.5);
    expect(one.rows[0]!.dimensions['spend_share']).toBe(1);
    expect(one.exportRows[0]!.dimensions['spend_share']).toBe(1);
    const scoped = buildPerformanceModel(scopeRows(rows, 'B000SYN001')).model;
    expect(scoped.rows.map((row) => row.dimensions['spend_share'])).toEqual([0.225, 0.775]);
  });
  it('keeps the spend denominator unknown if any matched contribution is unmeasured', () => {
    const missing = { ...rows[1]!, measurement: { missing: ['spend' as const], comparisonMissing: [] } };
    const model = buildPerformanceModel([rows[0]!, missing]).model;
    expect(resolveField(model.totalsRow!, 'spend')).toBeNull();
    expect(model.rows.map((row) => row.dimensions['spend_share'])).toEqual([null, null]);
  });
  it('replaces selected verdicts in every OR branch and counts precisely the chip click population', () => {
    const scoped = scopeRows(rows, 'B000SYN001');
    const active = verdictFilter(filter, 'Rank gap');
    for (const diagnosis of PerformanceVerdict.shape.diagnosis.options) {
      const clicked = buildPerformanceModel(scoped, { filter: verdictFilter(active, diagnosis) }).model;
      expect(clicked.matched).toBe(diagnosis === 'Efficient' ? 1 : 0);
    }
    const orFilter = { groups: [...active.groups, ...verdictFilter({ groups: [{ filters: [{ key: 'TARGETING', conditions: [{ operator: '=' as const, values: ['b'] }] }] }] }, 'Efficient').groups] };
    expect(buildPerformanceModel(scoped, { filter: verdictFilter(orFilter, 'Rank gap') }).model.matchedRows.map((row) => row.id)).toEqual(['b']);
  });
  // WP-321 changed this expectation: a row without comparison facts adds nothing
  // to the comparison total; it used to blank it. The prior is the $10.00 the
  // other row reported, and it stays unknown only when no row reported at all.
  it('sums the KPI comparison over the rows that reported in the comparison window', () => {
    const host = document.createElement('div');
    const first = { ...rows[0]!, totals: { ...rows[0]!.totals, spend: 10 }, comparison: { ...rows[0]!.totals, spend: 10 } };
    const second = { ...rows[1]!, totals: { ...rows[1]!.totals, spend: 20 } };
    const view = { id: 'test', name: 'Test', entity: 'targets' as const, columns: [], pinned: [], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '' };
    host.innerHTML = renderToStaticMarkup(createElement(PerformanceSummary, { rows: [first, second], currencyCode: 'USD', profileId: 'synthetic', onChange: () => {}, view }));
    expect(host.querySelector('[aria-label="Chart spend"]')?.textContent).toBe('Spend$30.00$10.00 · +200.0%');
    host.innerHTML = renderToStaticMarkup(createElement(PerformanceSummary, { rows: [{ ...first, comparison: null }, second], currencyCode: 'USD', profileId: 'synthetic', onChange: () => {}, view }));
    expect(host.querySelector('[aria-label="Chart spend"]')?.textContent).toBe('Spend$30.00— · —');
  });
});
