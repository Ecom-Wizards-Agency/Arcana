import { expect, it } from 'vitest';
import { ChangeQueueEntry, ChangeQueueSource, RestorePreviewState, ChangeQueueRestoreBatchPreview } from './time-machine.js';
const entry={id:'change:1',when:'2026-09-05T09:20:00.000001Z',entity:'Synthetic target',entityType:'keyword',entityId:'synthetic',field:'bid',
  oldValue:null,newValue:1,source:'sync',state:'observed',batchId:null,batchLabel:null,batchCount:null,experimentStart:false,candidateCount:0,
  acknowledgedAt:null,acknowledgedBy:null,reviewHref:null};
it('preserves unknown values and exact source timestamps',()=>{
  const parsed=ChangeQueueEntry.parse(entry);
  expect(parsed.oldValue).toBeNull(); expect(parsed.batchCount).toBeNull(); expect(parsed.when).toBe(entry.when);
});
it('declares all six sources and every restore preview state without conflating ambiguity with readiness',()=>{
  expect(ChangeQueueSource.options).toEqual(['apply','sync','queued','restore','campaign_creation','campaign_creation_retry']);
  expect(RestorePreviewState.options).toEqual(['ready','conflict','already restored','unsupported','awaiting sync','ambiguous']);
});
it('refuses invalid sources and negative candidate counts',()=>{
  expect(ChangeQueueEntry.safeParse({...entry,source:'guessed'}).success).toBe(false);
  expect(ChangeQueueEntry.safeParse({...entry,candidateCount:-1}).success).toBe(false);
});

it('counts coordinated proposals separately from physical restore rows and refuses ready dependency sets',()=>{
  const id='10000000-0000-4000-8000-000000000001';
  const row={batchId:id,rowId:id,recommendationId:null,entityType:'keyword',entityId:'synthetic',entityName:null,field:'bid',
    originalValue:1,proposedValue:2,exportedValue:2,synchronizedValue:null,synchronizedAt:null,currentValue:null,currentSyncedAt:null,
    inverseValue:1,state:'unsupported',conflict:false,exportAllowed:false,reason:'Coordinated restore unavailable'};
  const batch={batchId:id,sourceBatchId:null,activeReversionBatchId:null,profileId:id,tag:'synthetic',optGroup:'synthetic',lever:'coordinated',note:'',
    lifecycleStatus:'exported',exportedAt:'2026-09-15T00:00:00Z',appliedAt:null,artifactSha256:null,exportedProposals:1,
    reversibleRows:2,unsupportedRows:0,rows:[row,{...row,rowId:'10000000-0000-4000-8000-000000000002'}],readyRows:0,blockedRows:2,
    exportAllowed:false,reason:'Coordinated restore unavailable',dependencySetCount:1};
  expect(ChangeQueueRestoreBatchPreview.parse(batch).rows).toHaveLength(2);
  expect(ChangeQueueRestoreBatchPreview.safeParse({...batch,blockedRows:1}).success).toBe(false);
  expect(ChangeQueueRestoreBatchPreview.safeParse({...batch,exportAllowed:true}).success).toBe(false);
  expect(ChangeQueueRestoreBatchPreview.safeParse({...batch,dependencySetCount:null}).success).toBe(false);
  expect(ChangeQueueRestoreBatchPreview.safeParse({...batch,dependencySetCount:null,exportedProposals:2}).success).toBe(true);
});
