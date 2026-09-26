import { expect, it } from 'vitest';
import { toCsv } from '@wizard-ads/ui';
import { entries } from './render-fixture';
import { attribution, displayValue, queueModel, QUEUE_COLUMNS } from './model';
it('exports exactly the visible source rows with raw old/new values and no totals',()=>{
  const model=queueModel(entries,'USD');
  expect(model.shown).toBe(6);expect(model.totalsRow).toBeNull();
  const csv=toCsv(model,{columns:QUEUE_COLUMNS,label:'change-queue',currencyCode:'USD'});
  expect(csv.exported).toBe(6);expect(csv.total).toBe(6);
  expect(csv.csv.split('\n').filter(line=>line.includes('Synthetic change'))).toHaveLength(6);
  expect(csv.csv).not.toContain('$1.00');
});
it('does not turn unknown values into zero or guess an ambiguous batch identity',()=>{
  expect(displayValue(null,'bid','USD')).toBe('—');
  expect(displayValue(0,'bid','USD')).toBe('$0.00');
  expect(attribution({...entries[2]!,candidateCount:3,batchLabel:null})).toBe('3 rows could explain it');
  expect(attribution({...entries[1]!,batchCount:null})).toBe('Unknown');
});
