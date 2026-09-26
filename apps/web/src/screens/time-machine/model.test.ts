import { expect, it } from 'vitest';
import { toCsv } from '@wizard-ads/ui';
import { entries } from './render-fixture';
import { ACTOR_WORDS, attribution, displayValue, owner, ownerLine, queueModel, QUEUE_COLUMNS } from './model';
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
  expect(attribution({...entries[1]!,batchCount:null})).toBeNull();
});
it('names the owner, or the owner kind in words when no name is readable, ahead of the batch evidence',()=>{
  expect(entries.map(owner)).toEqual(['Synthetic operator','Ads console user','Ads console user','Arcana automation','Arcana operator','Arcana operator']);
  expect(entries.map(ownerLine)).toEqual(['Synthetic operator · Batch 1000 · 7 changes','Ads console user','Ads console user · Batch 1002 · two rows could explain it',
    'Arcana automation · Batch 1003 · experiment start','Arcana operator · Review proposal','Arcana operator · Review proposal']);
  expect(Object.values(ACTOR_WORDS)).toEqual(['Arcana operator','Arcana automation','Ads console user','Unknown']);
  const csv=toCsv(queueModel(entries,'USD'),{columns:QUEUE_COLUMNS,label:'change-queue',currencyCode:'USD'}).csv;
  expect(csv.split('\n').find(line=>line.includes('WHEN'))).toContain('OWNER');
  expect(csv.split('\n').filter(line=>line.includes('Synthetic operator · Batch 1000 · 7 changes'))).toHaveLength(1);
});
