import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedActor, withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { acknowledgeObservedChange, countChangeQueue, listChangeQueue } from './time-machine.js';
import { recordEntityChanges } from './entities.js';
let db: TestDatabase;
const userId=randomUUID(), orgId=randomUUID(), profileId=randomUUID(), otherOrg=randomUUID(), otherProfile=randomUUID();
const actor={userId,orgId};
let observedId='';
beforeAll(async()=>{
  db=await createTestDatabase('change_queue',{applyFixture:false});
  await db.sql`insert into auth.users(id) values(${userId})`;
  for (const [org,profile,label] of [[orgId,profileId,'synthetic-queue'],[otherOrg,otherProfile,'synthetic-other']]) {
    await db.sql`insert into public.orgs(id,slug,name) values(${org!},${label!},'Synthetic agency')`;
    await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${profile!},${org!},${label!},'NA','US','USD','UTC')`;
  }
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${userId},'owner')`;
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
    if(index===1) await db.sql`insert into public.queued_change_approvals(change_id,org_id,profile_id,approved_by) values(${id},${orgId},${profileId},${userId})`;
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
