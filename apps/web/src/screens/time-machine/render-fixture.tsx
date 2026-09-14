import type { ChangeQueueEntry, RestorePreviewRow } from '@wizard-ads/shared';
import type { ScreenData } from './view';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const entries: ChangeQueueEntry[] = ['apply','sync','sync','apply','queued','queued'].map((source,index) => ({
  id:`${source}:${index+1}`,when:`2026-09-05T09:${20-index}:00.000Z`, entity:`Synthetic change ${index+1}`,
  entityType:'keyword',entityId:`synthetic-${index}`,field:'bid',oldValue:1,newValue:2,source:source as ChangeQueueEntry['source'],
  state: (['confirmed','observed','unattributed','confirmed','awaiting review','approved'] as const)[index]!,
  batchId: source==='apply'?id(index+1):null,batchLabel:source==='apply'||index===2?String(1000+index):null,
  batchCount:source==='apply'?7:null,experimentStart:index===3,candidateCount:index===2?2:0,
  acknowledgedAt:null,acknowledgedBy:null,reviewHref:source==='queued'?['/targets',`synthetic-${index}`,'queue',id(index+1)].join('/') + '?' + new URLSearchParams({profile:id(50)}):null,
}));
export const restoreRows: RestorePreviewRow[] = ['ready','ready','conflict','already restored','conflict','unsupported','awaiting sync'].map((state,index) => ({
  rowId:id(index+1),entityId:`synthetic-${index}`,entityType:index===4?'campaign':'keyword',entity:`Synthetic restore ${index+1}`,
  field:index===4?'budget':index===5?'placement':'bid',weSet:index===5?235:2,now:index>=5?null:index===3?1:index===4?65:index===2?3:2,
  restoreTo:index===5?180:1,state:state as RestorePreviewRow['state'],readAt:index===6?null:'2026-09-05T09:20:00Z',
  why:['Untouched since we set it','Untouched since we set it','Someone changed it after us','Already back at the old value','Budget raised at Amazon','No adapter for this field','Not read back from Amazon yet'][index]!,
}));
export const ready = { view:'ready',props:{profileId:id(50),currencyCode:'USD',role:'owner',viewActor:{orgId:id(60),userId:id(61)},entries,hasOlder:false,cursor:null,query:{},partial:false,proposal:null,preview:null} } satisfies ScreenData;
export const restore = { view:'ready',props:{...ready.props,preview:{batchId:id(1),label:'1042',blockedReason:null,rows:restoreRows}} } satisfies ScreenData;
