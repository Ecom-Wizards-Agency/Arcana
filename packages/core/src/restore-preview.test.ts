import { expect, it } from 'vitest';
import { COORDINATED_RESTORE_UNAVAILABLE, type ReversionRowPreview } from '@wizard-ads/shared';
import { classifyRestoreRow, restoreCounts } from './restore-preview.js';
const base: ReversionRowPreview = {batchId:'10000000-0000-4000-8000-000000000001',rowId:'10000000-0000-4000-8000-000000000002',recommendationId:null,
  entityType:'keyword',entityId:'synthetic',entityName:'Synthetic target',field:'bid',originalValue:1,proposedValue:2,exportedValue:2,synchronizedValue:2,
  synchronizedAt:'2026-09-05T08:00:00Z',currentValue:2,currentSyncedAt:'2026-09-05T09:00:00Z',inverseValue:1,state:'ready',conflict:false,exportAllowed:true,reason:'Synthetic evidence'};
const classify=(changes:Partial<ReversionRowPreview>)=>classifyRestoreRow({exportedAt:'2026-09-05T07:00:00Z',row:{...base,...changes}});
it('partitions seven rows with exact copy and no null-to-zero conversion',()=>{
  const rows=[classify({}),classify({}),classify({state:'conflict',currentValue:3}),classify({state:'conflict',field:'budget',currentValue:65}),
    classify({state:'unsupported',currentValue:null}),classify({state:'awaiting_sync',currentSyncedAt:null,currentValue:null}),classify({state:'already_reverted',currentValue:1})];
  expect(restoreCounts(rows)).toEqual({total:7,ready:2,blocked:4,nothingToDo:1});
  expect(rows.map(r=>r.why)).toEqual(['Untouched since we set it','Untouched since we set it','Someone changed it after us','Budget raised at Amazon','No adapter for this field','Not read back from Amazon yet','Already back at the old value']);
  expect(rows[5]?.now).toBeNull();
  expect(rows.filter(r=>r.state==='ready').map(r=>r.restoreTo)).toEqual([1,1]);
});
it('requires freshness and uniquely attributed observation even if current values match',()=>{
  expect(classify({currentSyncedAt:'2026-09-05T06:00:00Z'}).state).toBe('awaiting sync');
  expect(classify({state:'ambiguous',synchronizedAt:null}).state).toBe('ambiguous');
  expect(classify({state:'awaiting_sync',synchronizedAt:null}).state).toBe('awaiting sync');
  expect(classify({currentValue:null,originalValue:null}).state).not.toBe('already restored');
});
it('retains microsecond precision at the export/read boundary',()=>{
  const row={...base,currentSyncedAt:'2026-09-05T07:00:00.000001Z'};
  expect(classifyRestoreRow({row,exportedAt:'2026-09-05T07:00:00.000002Z'}).state).toBe('awaiting sync');
});

it('keeps coordinated controls blocked and preserves their reason even without an observation',()=>{
  const row=classify({state:'unsupported',reason:COORDINATED_RESTORE_UNAVAILABLE,currentSyncedAt:null,currentValue:null});
  expect(row).toMatchObject({state:'unsupported',why:COORDINATED_RESTORE_UNAVAILABLE,now:null});
  expect(restoreCounts([row])).toEqual({total:1,ready:0,blocked:1,nothingToDo:0});
});

it('classifies a mirror newer than export but older than the linked write as awaiting sync, including microseconds',()=>{
  expect(classify({currentSyncedAt:'2026-09-05T07:30:00Z'})).toMatchObject({state:'awaiting sync',now:null,why:'Not read back from Amazon yet'});
  expect(classify({currentSyncedAt:'2026-09-05T08:00:00.000001Z',synchronizedAt:'2026-09-05T08:00:00.000002Z'}).state).toBe('awaiting sync');
  expect(classify({currentSyncedAt:base.synchronizedAt}).state).toBe('ready');
});
