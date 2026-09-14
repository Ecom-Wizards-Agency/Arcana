import { describe, expect, it } from 'vitest';
import { buildGridModel } from './pipeline.js';
import { fieldAccessor, resolveField, type GridRow } from './rows.js';
import { toCsv } from './csv.js';
import { metricColumns } from './columns.js';
import { grandTotal } from './aggregate.js';
const measured: GridRow = { id: 'measured', currencyCode: 'USD', dimensions: { campaign: 'Synthetic campaign', kind: 'exact' }, totals: { impressions: 10, clicks: 2, spend: 0, sales: 4, orders: 1, units: 1 }, comparison: null };
const absent: GridRow = { ...measured, id: 'absent', measurement: { missing: ['spend'], comparisonMissing: [] } };
describe('unmeasured performance values', () => {
  it('propagates a wholly absent comparison through groups, totals and deltas', () => {
    const first = { ...measured, totals: { ...measured.totals, spend: 10 }, comparison: { ...measured.totals, spend: 10 } };
    const second = { ...measured, id: 'new', totals: { ...measured.totals, spend: 20 } };
    for (const groupBy of [[], ['campaign'], ['campaign', 'kind']]) {
      const model = buildGridModel([first, second], { groupBy });
      for (const row of [model.totalsRow!, ...(groupBy.length ? model.rows : [])]) {
        expect(resolveField(row, 'spend')).toBe(30);
        for (const key of ['spend_comparison', 'spend_delta_percent', 'spend_delta_absolute', 'acos_comparison']) {
          expect(resolveField(row, key)).toBeNull();
          expect(fieldAccessor(key)(row)).toBeNull();
        }
      }
    }
  });
  it('preserves missing comparison bases through deltas and CSV export', () => {
    const row: GridRow = { ...absent, comparison: measured.totals, measurement: { missing: ['spend'], comparisonMissing: ['sales'] } };
    for (const key of ['spend', 'sales_comparison', 'sales_delta_absolute', 'sales_delta_percent', 'acos_comparison']) {
      expect(resolveField(row, key)).toBeNull();
      expect(fieldAccessor(key)(row)).toBeNull();
      expect(resolveField(grandTotal([row])!, key)).toBeNull();
    }
    const csv = toCsv(buildGridModel([row, measured]), { columns: metricColumns('spend').filter((column) => column.id === 'spend'), label: 'Synthetic rows', currencyCode: 'USD' });
    expect(csv.exported).toBe(2);
    expect(csv.csv.split('\n').slice(2, 4)).toEqual(['', '0']);
  });
  it('keeps absent spend distinct from measured zero for cells and compiled accessors', () => {
    expect(resolveField(measured, 'spend')).toBe(0);
    for (const key of ['spend', 'cpc', 'acos']) {
      expect(resolveField(absent, key)).toBeNull();
      expect(fieldAccessor(key)(absent)).toBeNull();
    }
  });
  it('does not match an unmeasured value with a zero filter', () => {
    const model = buildGridModel([measured, absent], { filter: { groups: [{ filters: [{ key: 'SPEND', conditions: [{ operator: '=', values: ['0'] }] }] }] } });
    expect(model.matchedRows.map((row) => row.id)).toEqual(['measured']);
  });
  it('does not label an incomplete group or grand total as measured zero', () => {
    expect(resolveField(grandTotal([measured, absent])!, 'spend')).toBeNull();
    for (const groupBy of [['campaign'], ['campaign', 'kind']]) {
      const model = buildGridModel([measured, absent], { groupBy });
      expect(model.matched).toBe(2);
      for (const row of model.rows) expect(resolveField(row, 'spend')).toBeNull();
    }
  });
});
