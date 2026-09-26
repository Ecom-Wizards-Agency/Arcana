import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedActor, withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { acknowledgeObservedChange, countChangeQueue, listChangeQueue } from './time-machine.js';
import { recordEntityChanges } from './entities.js';
let db: TestDatabase;
const userId=randomUUID(), approverId=randomUUID(), analystId=randomUUID(), orgId=randomUUID(), profileId=randomUUID(), otherOrg=randomUUID(), otherProfile=randomUUID();
const actor={userId,orgId};
let observedId='';
beforeAll(async()=>{
  db=await createTestDatabase('change_queue',{applyFixture:false});
  await db.sql`insert into auth.users(id,email) values(${userId},'synthetic-owner@example.test'),(${approverId},'synthetic-approver@example.test'),(${analystId},'synthetic-analyst@example.test')`;
  for (const [org,profile,label] of [[orgId,profileId,'synthetic-queue'],[otherOrg,otherProfile,'synthetic-other']]) {
    await db.sql`insert into public.orgs(id,slug,name) values(${org!},${label!},'Synthetic agency')`;
    await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${profile!},${org!},${label!},'NA','US','USD','UTC')`;
  }
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${userId},'owner'),(${orgId},${approverId},'admin'),(${orgId},${analystId},'analyst')`;
  const batchId=randomUUID();
  await db.sql`insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,exported_at,exported_proposals,reversible_rows,unsupported_rows,artifact_sha256)
    values(${batchId},${orgId},${profileId},'1042','synthetic','bid','Synthetic export','2026-09-01T10:00:00Z',3,3,0,${'a'.repeat(64)})`;
  for (const entity of ['unique','ambiguous','ambiguous']) {
    await db.sql`insert into public.apply_rows(batch_id,org_id,profile_id,entity_type,entity_id,field,old_value,new_value)
      values(${batchId},${orgId},${profileId},'keyword',${entity},'bid','1','2')`;
  }
  const entities = ['unique', 'ambiguous', 'external'];
  await recordEntityChanges(db, entities.map((amazonId) => ({
    orgId, profileId, entityType: 'keyword' as const, amazonId,
    field: 'bid', oldValue: 1, newValue: 2, source: 'sync' as const,
    observedAt: new Date('2026-09-02T10:00:00Z'),
  })));
  const [observed]=await db.sql<{id:string}[]>`select id::text from public.entity_changes where org_id=${orgId} and amazon_id='external'`;
  observedId=observed!.id;
  for (let index=0;index<2;index++) {
    const id=randomUUID();
    await db.sql`insert into public.queued_changes(id,org_id,profile_id,target_id,created_by,created_at,context,request,checks)
      values(${id},${orgId},${profileId},'queued-target',${userId},${`2026-09-03T10:00:0${index}Z`},'{"targetLabel":"Synthetic queued target"}','{"expectedBid":{"amount":"1"},"newBid":{"amount":"2"}}','[{},{},{},{},{}]')`;
    if(index===1) await db.sql`insert into public.queued_change_approvals(change_id,org_id,profile_id,approved_by) values(${id},${orgId},${profileId},${approverId})`;
  }
},180000);
afterAll(async()=>{await db?.drop();});
it('merges all sources with exact counts, stable paging and no guessed attribution',async()=>{
  const rows=await withAuthenticatedActor(db,actor,sql=>listChangeQueue({sql},{orgId,profileId}));
  expect(rows).toHaveLength(8);
  expect(rows.map(row=>row.source)).toEqual(['queued','queued','sync','sync','sync','apply','apply','apply']);
  expect(rows.slice(0,2).map(row=>row.state)).toEqual(['approved','awaiting review']);
  const ambiguous=rows.find(row=>row.source==='sync'&&row.entityId==='ambiguous');
  expect(ambiguous).toMatchObject({state:'unattributed',candidateCount:2,batchId:null,batchLabel:'1042'});
  expect(rows.find(row=>row.source==='sync'&&row.entityId==='external')).toMatchObject({batchId:null,state:'observed'});
  expect(rows.find(row=>row.source==='apply'&&row.entityId==='unique')).toMatchObject({state:'confirmed'});
  const first=await listChangeQueue(db,{orgId,profileId,limit:4});
  const last=first.at(-1)!;
  const second=await listChangeQueue(db,{orgId,profileId,limit:4,before:{observedAt:last.when,id:last.id}});
  expect([...first,...second].map(row=>row.id)).toEqual(rows.map(row=>row.id));
  expect(await listChangeQueue(db,{orgId,profileId,from:'2000-01-01',to:'2000-01-02'})).toHaveLength(0);
});
it('names the owner of each change by kind, with member names only for an owner or admin reader',async()=>{
  const owners=(rows:Awaited<ReturnType<typeof listChangeQueue>>)=>rows.map(row=>`${row.source}:${row.entityId}:${row.actor.kind}:${row.actor.name??'-'}`);
  const asOwner=await withAuthenticatedActor(db,actor,sql=>listChangeQueue({sql},{orgId,profileId}));
  expect(asOwner).toHaveLength(8);
  expect(owners(asOwner).sort()).toEqual([
    'apply:ambiguous:automation:-','apply:ambiguous:automation:-','apply:unique:automation:-',
    'queued:queued-target:operator:synthetic-approver@example.test','queued:queued-target:operator:synthetic-owner@example.test',
    'sync:ambiguous:ads_console:-','sync:external:ads_console:-','sync:unique:ads_console:-',
  ]);
  expect(asOwner.find(row=>row.source==='queued'&&row.state==='approved')?.actor.name).toBe('synthetic-approver@example.test');
  expect(asOwner.find(row=>row.source==='queued'&&row.state==='awaiting review')?.actor.name).toBe('synthetic-owner@example.test');
  const batch=asOwner.find(row=>row.source==='apply')!.batchId!;
  await db.sql`update public.apply_batches set created_by=${approverId} where id=${batch}`;
  try {
    const exported=(await withAuthenticatedActor(db,actor,sql=>listChangeQueue({sql},{orgId,profileId,source:'apply'})));
    expect(exported).toHaveLength(3);
    expect(exported.map(row=>row.actor)).toEqual(Array.from({length:3},()=>({kind:'operator',name:'synthetic-approver@example.test'})));
    const asAnalyst=await withAuthenticatedActor(db,{orgId,userId:analystId},sql=>listChangeQueue({sql},{orgId,profileId}));
    expect(asAnalyst).toHaveLength(8);
    expect(asAnalyst.filter(row=>row.actor.kind==='operator').map(row=>row.actor.name)).toEqual([null,null,null,null,null]);
    const unauthenticated=await listChangeQueue(db,{orgId,profileId});
    expect(unauthenticated.filter(row=>row.actor.name!==null)).toHaveLength(0);
    expect(unauthenticated.filter(row=>row.actor.kind==='operator')).toHaveLength(5);
  } finally { await db.sql`update public.apply_batches set created_by=null where id=${batch}`; }
});
it('says on each batch row whether the batch restore preview can open, and null where there is no batch',async()=>{
  const rows=await withAuthenticatedActor(db,actor,sql=>listChangeQueue({sql},{orgId,profileId}));
  expect(rows).toHaveLength(8);
  const shape=(list:typeof rows)=>list.map(row=>`${row.source}:${row.entityId}:${String(row.batchRestorable)}`).sort();
  // Three rows, three reversible, none unsupported: every batch row can open its preview.
  expect(shape(rows)).toEqual([
    'apply:ambiguous:true','apply:ambiguous:true','apply:unique:true',
    'queued:queued-target:null','queued:queued-target:null',
    'sync:ambiguous:null','sync:external:null','sync:unique:true',
  ]);
  const batch=rows.find(row=>row.source==='apply')!.batchId!;
  // A create row without a before-value: the preview refuses the batch, so each row says false.
  await db.sql`update public.apply_batches set exported_proposals=4,unsupported_rows=1 where id=${batch}`;
  try {
    const refused=await withAuthenticatedActor(db,actor,sql=>listChangeQueue({sql},{orgId,profileId}));
    expect(refused).toHaveLength(8);
    expect(shape(refused).filter(entry=>entry.endsWith(':false'))).toEqual(['apply:ambiguous:false','apply:ambiguous:false','apply:unique:false','sync:unique:false']);
    expect(refused.filter(row=>row.batchId===null).every(row=>row.batchRestorable===null)).toBe(true);
  } finally { await db.sql`update public.apply_batches set exported_proposals=3,unsupported_rows=0 where id=${batch}`; }
  // The ledger expecting more reversible rows than were recorded is refused the same way.
  await db.sql`update public.apply_batches set exported_proposals=4,reversible_rows=4 where id=${batch}`;
  try {
    const short=await listChangeQueue(db,{orgId,profileId,source:'apply'});
    expect(short.map(row=>row.batchRestorable)).toEqual([false,false,false]);
  } finally { await db.sql`update public.apply_batches set exported_proposals=3,reversible_rows=3 where id=${batch}`; }
});
it('counts pending proposals and observations, records actor and time once, and does not enqueue',async()=>{
  expect(await withAuthenticatedActor(db,actor,sql=>countChangeQueue({sql},{orgId,profileId}))).toBe(4);
  await withAuthenticatedOrgEditor(db,actor,tx=>acknowledgeObservedChange(tx,{profileId,changeId:observedId}));
  const [receipt]=await db.sql`select acknowledged_at,acknowledged_by from public.entity_changes where id=${observedId}`;
  expect(receipt?.acknowledged_by).toBe(userId); expect(Number.isFinite(Date.parse(String(receipt?.acknowledged_at)))).toBe(true);
  await withAuthenticatedOrgEditor(db,actor,tx=>acknowledgeObservedChange(tx,{profileId,changeId:observedId}));
  const [again]=await db.sql`select acknowledged_at,acknowledged_by from public.entity_changes where id=${observedId}`;
  expect(again).toEqual(receipt);
  expect(await countChangeQueue(db,{orgId,profileId})).toBe(3);
  const [counts]=await db.sql`select (select count(*)::int from public.sp_write_execution_requests) as outbox,(select count(*)::int from public.sp_write_provider_call_intents) as intents`;
  expect(counts).toEqual({outbox:0,intents:0});
});
it('refuses cross-agency reads and acknowledgement, including another agency of the same user',async()=>{
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${otherOrg},${userId},'owner')`;
  const otherActor={userId,orgId:otherOrg};
  await expect(withAuthenticatedOrgEditor(db,otherActor,tx=>acknowledgeObservedChange(tx,{profileId,changeId:observedId}))).rejects.toThrow('Resource not found');
  expect(await withAuthenticatedActor(db,otherActor,sql=>listChangeQueue({sql},{orgId:otherOrg,profileId}))).toHaveLength(0);
  await expect(withAuthenticatedActor(db,actor,sql=>sql`update public.entity_changes set acknowledged_at=now(),acknowledged_by=${userId} where id=${observedId}`)).rejects.toThrow();
});
it('retains native application evidence and suppresses its exact legacy source',async()=>{
  const {seedSyntheticWriteHistory}=await import('../testing/sp-write-synthetic-execution.js');
  const nativeDb=await createTestDatabase('queue_native');
  try {
    const nativeUser=randomUUID();
    const [org]=await nativeDb.sql<{id:string}[]>`select app.seed_tenant_fixture('synthetic-native-queue',${nativeUser},'owner') as id`;
    const [profile]=await nativeDb.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${org!.id}`;
    const history=await seedSyntheticWriteHistory(nativeDb,{orgId:org!.id,userId:nativeUser},profile!.id);
    const rows=await listChangeQueue(nativeDb,{orgId:org!.id,profileId:profile!.id});
    const native=rows.filter(row=>row.id.startsWith('write:'));
    expect(native).toHaveLength(2);
    expect(native.map(row=>row.actor.kind)).toEqual(['operator','operator']);
    await nativeDb.sql`update auth.users set email='synthetic-native@example.test' where id=${nativeUser}`;
    const named=(await withAuthenticatedActor(nativeDb,{orgId:org!.id,userId:nativeUser},sql=>listChangeQueue({sql},{orgId:org!.id,profileId:profile!.id}))).filter(row=>row.id.startsWith('write:'));
    expect(named).toHaveLength(2);
    expect(named.map(row=>row.actor)).toEqual(Array.from({length:2},()=>({kind:'operator',name:'synthetic-native@example.test'})));
    expect(native.every(row=>row.state==='observed')).toBe(true);
    expect(rows.filter(row=>row.source==='apply'&&row.batchId===history.sourceBatchId)).toHaveLength(0);
    expect(new Set(rows.map(row=>row.id)).size).toBe(rows.length);
  } finally {await nativeDb.drop();}
},180000);

it('labels experiment start only for a recorded batch relationship',async()=>{
  const scope={orgId,profileId};
  const before=await listChangeQueue(db,scope);
  expect(before.filter(row=>row.source==='apply').every(row=>!row.experimentStart)).toBe(true);
  const batch=before.find(row=>row.source==='apply')!.batchId!;
  const experiment=randomUUID();
  await db.sql`insert into public.experiments(id,org_id,profile_id,name,type,metric_focus,created_by) values(${experiment},${orgId},${profileId},'Synthetic experiment','bid_push','acos',${userId})`;
  await db.sql`update public.apply_batches set experiment_id=${experiment} where id=${batch}`;
  const after=await listChangeQueue(db,scope);
  expect(after.filter(row=>row.source==='apply')).toHaveLength(3);
  expect(after.filter(row=>row.source==='apply').every(row=>row.experimentStart)).toBe(true);
  expect(after.find(row=>row.source==='sync'&&row.entityId==='ambiguous')?.experimentStart).toBe(false);
  const foreign=randomUUID();
  await db.sql`insert into public.experiments(id,org_id,profile_id,name,type,metric_focus,created_by) values(${foreign},${otherOrg},${otherProfile},'Synthetic foreign experiment','bid_push','acos',${userId})`;
  await expect(db.sql`update public.apply_batches set experiment_id=${foreign} where id=${batch}`).rejects.toThrow();
});
