import { expect, it } from 'vitest';
import { parseGridView } from '@wizard-ads/shared';
import { restoreQueueView, saveQueueView, queueViewStore } from './saved-view';

it('restores filters and density, with URL precedence and unknown versions refused', () => {
  const stored=saveQueueView({source:'sync',state:'observed',density:'compact'});
  expect(restoreQueueView({},stored)).toMatchObject({source:'sync',state:'observed',density:'compact'});
  expect(restoreQueueView({source:'queued',density:'comfortable'},stored)).toEqual({source:'queued',density:'comfortable'});
  const url=saveQueueView({source:'apply',density:'normal'});
  expect(restoreQueueView({view:url},stored)).toMatchObject({source:'apply',density:'normal'});
  expect(restoreQueueView({view:'2.e30'},stored)).toEqual({view:'2.e30'});
  expect(restoreQueueView({},'2.e30')).toEqual({});
  expect(parseGridView(saveQueueView({source:'',state:'',density:'compact'}))?.changeQueue?.filters).toEqual({});
});

it('uses the WP-250 store with separate signer, agency and namespace keys',async()=>{
  const values=new Map<string,string>();const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}};
  const actor={orgId:'00000000-0000-4000-8000-000000000001',userId:'00000000-0000-4000-8000-000000000002'};
  const store=queueViewStore(storage,actor);const saved=parseGridView(saveQueueView({density:'compact'}))!;
  await store.rememberLayout(saved);
  expect(store.cachedLayout('targets')?.changeQueue?.density).toBe('compact');
  expect(queueViewStore(storage,{...actor,userId:'00000000-0000-4000-8000-000000000003'}).cachedLayout('targets')).toBeNull();
  expect(queueViewStore(storage,{...actor,orgId:'00000000-0000-4000-8000-000000000004'}).cachedLayout('targets')).toBeNull();
  expect([...values.keys()]).toEqual([`changeQueue:wizard-ads:layout:v2:${actor.orgId}:${actor.userId}`]);
});

it.each(['campaign_creation','campaign_creation_retry'])('round-trips the %s source and attention state',source=>{
  const filters={source,state:'needs_attention',density:'compact'};
  expect(restoreQueueView({},saveQueueView(filters))).toMatchObject(filters);
});
