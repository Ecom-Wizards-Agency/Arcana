// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resolveField, type GridRow, type FilterSet } from '@wizard-ads/ui';
import { PerformanceVerdict } from '@wizard-ads/shared';
import { buildPerformanceModel, scopeRows, verdictFilter } from './performance-model';
import { PerformanceSummary } from './performance-chrome';
const rows: GridRow[] = ([
  ['a', 'B000SYN001', 'Efficient', 4.5], ['b', 'B000SYN001', 'Rank gap', 15.5], ['c', 'B000SYN002', 'Efficient', 30],
] as const).map(([id, asin, verdict, spend]) => ({ id: String(id), currencyCode: 'USD', dimensions: { targeting: String(id), asin, verdict }, totals: { spend: Number(spend), sales: 100, clicks: 10, impressions: 100, orders: 1, units: 1 }, comparison: null }));
const filter: FilterSet = { groups: [{ filters: [{ key: 'TARGETING', conditions: [{ operator: '=', values: ['a'] }] }] }] };
describe('performance population', () => {
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
  it('renders KPI comparison and delta unknown for an absent comparison contributor', () => {
    const host = document.createElement('div');
    const first = { ...rows[0]!, totals: { ...rows[0]!.totals, spend: 10 }, comparison: { ...rows[0]!.totals, spend: 10 } };
    const second = { ...rows[1]!, totals: { ...rows[1]!.totals, spend: 20 } };
    host.innerHTML = renderToStaticMarkup(createElement(PerformanceSummary, { rows: [first, second], currencyCode: 'USD', profileId: 'synthetic', onChange: () => {}, view: { id: 'test', name: 'Test', entity: 'targets', columns: [], pinned: [], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '' } }));
    expect(host.querySelector('[aria-label="Chart spend"]')?.textContent).toBe('Spend$30.00— · —');
  });
});
