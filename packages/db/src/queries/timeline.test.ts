import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { appendTimelineEvent, readManualTimelineEvents, readTimeline } from './timeline.js';
import { listExperimentEvents, mutateExperimentForActor, transitionExperiment } from './experiments.js';
import { asServiceRole } from '../testing/rls.js';
import { EXPERIMENT_STATUSES, canTransitionExperiment } from '@wizard-ads/shared';
const owner = '26400000-0000-4000-8000-000000000001', foreign = '26400000-0000-4000-8000-000000000002';
let db: TestDatabase, orgId: string, profileId: string, foreignProfile: string;
beforeAll(async () => { db = await createTestDatabase('wp264_timeline'); const [a] = await db.sql `select app.seed_tenant_fixture('timeline-synthetic',${owner},'owner') as id`; orgId = String(a!['id']); const [p] = await db.sql `select id from public.ad_profiles where org_id=${orgId}`; profileId = String(p!['id']); const [b] = await db.sql `select app.seed_tenant_fixture('timeline-foreign',${foreign},'owner') as id`; const [q] = await db.sql `select id from public.ad_profiles where org_id=${String(b!['id'])}`; foreignProfile = String(q!['id']); }, 180000);
afterAll(async () => { await db?.drop(); });
it('creates all four kinds and supersedes without losing history or crossing agencies', async () => {
    const before = await readManualTimelineEvents(db, orgId, profileId, true);
    for (const kind of ['promotion', 'listing', 'market', 'supply'] as const) {
        const saved = await withAuthenticatedOrgEditor(db, { orgId, userId: owner }, (context) => appendTimelineEvent(context, { profileId, name: `Synthetic ${kind}`, kind, start: '2026-08-01', end: null, scopeText: 'Recorded scope', note: 'Original', supersedesId: null }));
        const next = await withAuthenticatedOrgEditor(db, { orgId, userId: owner }, (context) => appendTimelineEvent(context, { profileId, name: `Revised ${kind}`, kind, start: '2026-09-01', end: null, scopeText: 'Recorded scope', note: 'Correction', supersedesId: saved.id }));
        expect(next.supersedesId).toBe(saved.id);
        await expect(db.sql `update public.timeline_events set note='rewritten' where id=${saved.id}`).rejects.toThrow(/append-only/);
        await expect(db.sql `delete from public.timeline_events where id=${saved.id}`).rejects.toThrow(/append-only/);
    }
    expect(await readManualTimelineEvents(db, orgId, profileId, true)).toHaveLength(before.length + 8);
    expect(await readManualTimelineEvents(db, orgId, profileId)).toHaveLength(before.length + 4);
    await expect(withAuthenticatedOrgEditor(db, { orgId, userId: owner }, (context) => appendTimelineEvent(context, { profileId: foreignProfile, name: 'Forbidden', kind: 'market', start: '2026-08-01', end: null, scopeText: '', note: '', supersedesId: null }))).rejects.toThrow('Profile not found');
});
it('enforces immutable hypothesis, status history and result at the database and authority', async () => {
    const actor = { orgId, userId: owner };
    const created = await mutateExperimentForActor(db, actor, { kind: 'create', profileId, name: 'Synthetic experiment', hypothesis: 'Original hypothesis', type: 'bid_push', metricFocus: 'acos', status: 'planned' });
    const id = created.item.id;
    await expect(db.sql `update public.experiments set hypothesis='rewritten' where id=${id}`).rejects.toThrow(/immutable/);
    await expect(db.sql `delete from public.experiments where id=${id}`).rejects.toThrow(/append-only/);
    await expect(mutateExperimentForActor(db, actor, { kind: 'edit', experimentId: id, hypothesis: 'Changed' })).rejects.toThrow();
    await mutateExperimentForActor(db, actor, { kind: 'transition', experimentId: id, status: 'running' });
    await mutateExperimentForActor(db, actor, { kind: 'transition', experimentId: id, status: 'ended' });
    const analyzed = await mutateExperimentForActor(db, actor, { kind: 'transition', experimentId: id, status: 'analyzed', resultNote: 'Synthetic observed result' });
    expect(analyzed.item.resultNote).toBe('Synthetic observed result');
    expect(analyzed.event?.actorId).toBe(owner);
    await expect(db.sql `update public.experiments set result_note='changed' where id=${id}`).rejects.toThrow(/once/);
    await expect(db.sql `update public.experiment_events set note='changed' where experiment_id=${id}`).rejects.toThrow(/append-only/);
    await expect(db.sql `delete from public.experiment_events where experiment_id=${id}`).rejects.toThrow(/append-only/);
    const rows = await db.sql `select id from public.experiment_events where experiment_id=${id}`;
    expect(rows).toHaveLength(4);
    await expect(mutateExperimentForActor(db, { orgId, userId: foreign }, { kind: 'transition', experimentId: id, status: 'running' })).rejects.toThrow();
});
it('reads source counts and leaves missing thresholds absent', async () => {
    const snapshot = await readTimeline(db, orgId, profileId);
    expect(snapshot.events.length).toBeGreaterThanOrEqual(5);
    expect(snapshot.settings).toEqual({ minDays: null, minClicks: null });
    expect(Object.keys(snapshot.scoped)).toHaveLength(snapshot.events.length);
});
it('unions campaign, ad-group and target scope once at each source grain', async () => {
    const actor = { orgId, userId: owner };
    const experiment = await mutateExperimentForActor(db, actor, { kind: 'create', profileId, name: 'Scope arithmetic', type: 'bid_push', metricFocus: 'sales', scope: { campaignIds: ['timeline-campaign'], adGroupIds: ['timeline-group'], targetIds: ['timeline-target'] } });
    await db.sql `insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,match_type,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
    values(${orgId},${profileId},'2026-08-10','SP','timeline-campaign','timeline-group','timeline-target','keyword','exact',100,10,10,1,100,1)`;
    await db.sql `insert into public.fact_sb_daily(org_id,profile_id,date,campaign_id,ad_group_id,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
    values(${orgId},${profileId},'2026-08-10','timeline-campaign','timeline-group',100,10,20,1,200,1)`;
    await db.sql `insert into public.fact_sd_daily(org_id,profile_id,date,campaign_id,ad_group_id,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
    values(${orgId},${profileId},'2026-08-10','timeline-campaign','timeline-group',100,10,30,1,300,1)`;
    const snapshot = await readTimeline(db, orgId, profileId);
    expect(snapshot.scoped[experiment.item.id]).toEqual([{ date: '2026-08-10', spend: 60, sales: 600, clicks: 30, orders: 3, impressions: 300 }]);
});
it('returns the real appended event when creation has a later recorded timestamp', async () => {
  const actor = { orgId, userId: owner };
  const [created] = await db.sql<{id:string}[]>`insert into public.experiments(org_id,profile_id,created_by,name,type,metric_focus,status,created_at)
    values(${orgId},${profileId},${owner},'Synthetic chronology','other','sales','planned',now()+interval '1 day') returning id`;
  const [initialEvent] = await db.sql<{id:number}[]>`select id from public.experiment_events where experiment_id=${created!.id}`;
  const moved = await mutateExperimentForActor(db, actor, { kind: 'transition', experimentId: created!.id, status: 'running' });
  expect(moved.event).toMatchObject({ fromStatus: 'planned', toStatus: 'running', actorId: owner });
  expect(moved.event!.id).not.toBe(Number(initialEvent!.id));
  const rows = await db.sql`select id from public.experiment_events where experiment_id=${created!.id}`;
  expect(rows).toHaveLength(2);
});

it('keeps an applied batch on the timeline after reversion and excludes unexecuted previews', async () => {
  const batches = await db.sql<{id:string;status:string}[]>`insert into public.apply_batches(org_id,profile_id,tag,opt_group,lever,note,status,applied_on)
    values (${orgId},${profileId},'Synthetic applied','Synthetic group','bid','Observed application','applied','2026-08-24'),
      (${orgId},${profileId},'Synthetic reverted','Synthetic group','bid','Original application remains evidence','reverted','2026-08-25'),
      (${orgId},${profileId},'Synthetic staged','Synthetic group','bid','Preview only','staged',null) returning id,status`;
  expect(batches).toHaveLength(3);
  const snapshot = await readTimeline(db, orgId, profileId);
  const retained = snapshot.events.filter((event) => batches.some((batch) => batch.id === event.id));
  expect(retained).toHaveLength(2);
  expect(retained.map((event) => event.status).sort()).toEqual(['applied','reverted']);
});

it('preserves an explicit planned end through the experiment authority', async () => {
  const created = await mutateExperimentForActor(db, { orgId, userId: owner }, { kind: 'create', profileId, name: 'Synthetic planned window', type: 'other', metricFocus: 'sales', status: 'planned', startAt: new Date('2026-08-01'), endAt: new Date('2026-08-15') });
  expect(created.item.startAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  expect(created.item.endAt?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
  expect(created.item.status).toBe('planned');
});

it('infers batch notes only from applied rows in the same profile, scope and window', async () => {
  const { listExperimentEvents, listExperimentInferredBatchNotes } = await import('./experiments.js');
  const actor = {orgId,userId:owner};
  const created = await mutateExperimentForActor(db,actor,{kind:'create',profileId,name:'Synthetic batch association',type:'bid_push',metricFocus:'acos',status:'running',startAt:new Date('2026-08-01'),endAt:new Date('2026-08-15'),scope:{campaignIds:['inferred-campaign'],targetIds:['inferred-target']}});
  const before = await listExperimentEvents(db,{orgId,experimentId:created.item.id});
  for (const [tag,day,status,entityType,entityId,profile] of [
    ['1038','2026-08-09','applied','target','inferred-target',profileId],
    ['campaign-match','2026-08-15','reverted','campaign','inferred-campaign',profileId],
    ['outside','2026-08-16','applied','target','inferred-target',profileId],
    ['unexecuted','2026-08-09','staged','target','inferred-target',profileId],
    ['unrelated','2026-08-09','applied','target','unrelated-target',profileId],
    ['foreign','2026-08-09','applied','target','inferred-target',foreignProfile],
  ]) {
    const [batch] = await db.sql<{id:string}[]>`insert into public.apply_batches(org_id,profile_id,tag,opt_group,lever,note,status,applied_on)
      select p.org_id,p.id,${tag!},'Synthetic group','bid','Observed',${status!}::public.apply_batch_status,${day!}::date from public.ad_profiles p where p.id=${profile!} returning id`;
    await db.sql`insert into public.apply_rows(batch_id,org_id,profile_id,entity_type,entity_id,field,new_value)
      select b.id,b.org_id,b.profile_id,${entityType!}::public.apply_entity_type,${entityId!},'bid','3.4'::jsonb from public.apply_batches b where b.id=${batch!.id}`;
  }
  const notes = await listExperimentInferredBatchNotes(db,{orgId,experimentId:created.item.id});
  expect(notes).toHaveLength(2);
  expect(notes[0]).toMatchObject({batchTag:'1038',newValue:3.4,inference:'scope-and-window',appliedOn:'2026-08-09'});
  expect(await listExperimentEvents(db,{orgId,experimentId:created.item.id})).toEqual(before);
  expect(await listExperimentInferredBatchNotes(db,{orgId:'26400000-0000-4000-8000-000000000099',experimentId:created.item.id})).toEqual([]);
  const unmatched = await mutateExperimentForActor(db,actor,{kind:'create',profileId,name:'No matching batch',type:'other',metricFocus:'sales'});
  expect(await listExperimentInferredBatchNotes(db,{orgId,experimentId:unmatched.item.id})).toEqual([]);
});

it('refuses the authenticated lifecycle bypass, reopening and unaudited end-date edits', async () => {
  const actor = { orgId, userId: owner };
  const created = await mutateExperimentForActor(db, actor, { kind: 'create', profileId, name: 'Direct SQL lifecycle', type: 'other', metricFocus: 'sales', startAt: new Date('2026-07-29') });
  const id = created.item.id;
  const direct = (statement: string) => withAuthenticatedOrgEditor(db, actor, ({ sql }) => sql.unsafe(statement, [id]));
  const trail = () => listExperimentEvents(db, { orgId, experimentId: id });
  await expect(direct("update public.experiments set status='analyzed' where id=$1")).rejects.toThrow(/Invalid experiment status transition/);
  await expect(direct("update public.experiments set end_at='2026-08-01' where id=$1")).rejects.toThrow(/only when closing/);
  await expect(direct("update public.experiments set hypothesis='changed' where id=$1")).rejects.toThrow(/immutable/);
  expect(await trail()).toHaveLength(1);
  await direct("update public.experiments set status='running' where id=$1");
  await expect(direct("update public.experiments set status='ended',end_at='2026-07-28' where id=$1")).rejects.toThrow(/experiments_window_order/);
  await direct("update public.experiments set status='ended' where id=$1");
  expect(await trail()).toHaveLength(3);
  await expect(direct("update public.experiments set status='running' where id=$1")).rejects.toThrow(/Invalid experiment status transition/);
  await expect(direct("update public.experiments set end_at=null where id=$1")).rejects.toThrow(/only when closing/);
  for (const result of ['null', "''", "'   '"])
    await expect(direct(`update public.experiments set status='analyzed',result_note=${result} where id=$1`)).rejects.toThrow(/result/i);
  await direct("update public.experiments set status='analyzed',result_note='Observed result' where id=$1");
  await expect(direct("update public.experiments set status='running',end_at=null where id=$1")).rejects.toThrow(/Invalid experiment status transition/);
  await expect(direct("update public.experiments set result_note='Rewritten result' where id=$1")).rejects.toThrow(/written once/);
  await expect(direct("update public.experiments set end_at='2026-09-01' where id=$1")).rejects.toThrow(/only when closing/);
  const events = await trail();
  expect(events.map((entry) => [entry.fromStatus, entry.toStatus, entry.actorId])).toEqual([
    [null, 'planned', owner], ['planned', 'running', owner], ['running', 'ended', owner], ['ended', 'analyzed', owner],
  ]);
  expect(events.every((entry) => entry.createdAt instanceof Date)).toBe(true);
  const [row] = await db.sql`select status,end_at,result_note,status_changed_at from public.experiments where id=${id}`;
  expect(row).toMatchObject({ status: 'analyzed', result_note: 'Observed result' });
  expect(row!.end_at).not.toBeNull();
  expect(new Date(row!.status_changed_at).getTime()).toBe(events[3]!.createdAt.getTime());
});
it('matches all 25 contract status pairs through direct authenticated SQL with one event per move', async () => {
  const actor = { orgId, userId: owner };
  let pairs = 0;
  for (const from of EXPERIMENT_STATUSES) for (const to of EXPERIMENT_STATUSES) {
    const created = await mutateExperimentForActor(db, actor, { kind: 'create', profileId, name: `Lifecycle ${from} to ${to}`, type: 'other', metricFocus: 'sales' });
    const id = created.item.id;
    const path = from === 'planned' ? [] : from === 'aborted' ? ['aborted'] as const
      : from === 'running' ? ['running'] as const : from === 'ended' ? ['running', 'ended'] as const : ['running', 'ended', 'analyzed'] as const;
    for (const status of path) await mutateExperimentForActor(db, actor, { kind: 'transition', experimentId: id, status,
      ...(status === 'analyzed' ? { resultNote: 'Observed result' } : {}) });
    const before = await listExperimentEvents(db, { orgId, experimentId: id });
    const move = () => withAuthenticatedOrgEditor(db, actor, ({ sql }) => sql`update public.experiments set status=${to}::public.experiment_status,
      result_note=case when ${from === 'ended' && to === 'analyzed'} then 'Observed result' else result_note end where id=${id}`);
    const allowed = canTransitionExperiment(from, to);
    if (allowed) await move();
    else await expect(move()).rejects.toThrow(/Invalid experiment status transition/);
    const after = await listExperimentEvents(db, { orgId, experimentId: id });
    expect(after).toHaveLength(before.length + Number(allowed && from !== to));
    expect(after.slice(0, before.length)).toEqual(before);
    if (allowed && from !== to) expect(after.at(-1)).toMatchObject({ fromStatus: from, toStatus: to, actorId: owner });
    pairs++;
  }
  expect(pairs).toBe(25);
});
it('atomically rolls back a status change if its trail cannot be appended and refuses forged entries', async () => {
  const actor = { orgId, userId: owner };
  const created = await mutateExperimentForActor(db, actor, { kind: 'create', profileId, name: 'Atomic trail', type: 'other', metricFocus: 'sales' });
  const id = created.item.id;
  const before = await listExperimentEvents(db, { orgId, experimentId: id });
  await expect(withAuthenticatedOrgEditor(db, actor, ({ sql }) => sql`select app.transition_timeline_experiment(
    ${orgId}::uuid,${id}::uuid,'running',${'x'.repeat(20001)},null,false,${owner}::uuid)`)).rejects.toThrow(/experiment_events_note_length/);
  expect(await listExperimentEvents(db, { orgId, experimentId: id })).toEqual(before);
  const [row] = await db.sql`select status from public.experiments where id=${id}`;
  expect(row!.status).toBe('planned');
  await expect(withAuthenticatedOrgEditor(db, actor, ({ sql }) => sql`insert into public.experiment_events(experiment_id,org_id,from_status,to_status,actor_id)
    values(${id},${orgId},'planned','analyzed',${foreign})`)).rejects.toMatchObject({ code: '42501' });
  await withAuthenticatedOrgEditor(db, actor, async ({ sql }) => {
    await sql`select app.transition_timeline_experiment(${orgId}::uuid,${id}::uuid,'running','Recorded start',null,false,${foreign}::uuid)`;
    // The prior call must not leave its note or supplied actor on a later SQL move.
    await sql`update public.experiments set status='ended' where id=${id}`;
    await sql`update public.experiments set status='ended' where id=${id}`;
  });
  const after = await listExperimentEvents(db, { orgId, experimentId: id });
  expect(after).toHaveLength(3);
  expect(after[1]).toMatchObject({ actorId: owner, note: 'Recorded start', fromStatus: 'planned', toStatus: 'running' });
  expect(after[2]).toMatchObject({ actorId: owner, note: null, fromStatus: 'running', toStatus: 'ended' });
});

it('records a scoped system job for service-role transitions without weakening user or lifecycle authority', async () => {
  const actor = { orgId, userId: owner };
  const created = await mutateExperimentForActor(db, actor, { kind: 'create', profileId, name: 'System lifecycle', type: 'other', metricFocus: 'sales' });
  const id = created.item.id;
  const [job] = await db.sql<{id:string}[]>`select id from public.sync_jobs where org_id=${orgId} and profile_id=${profileId} and job_type='recommendations.run' limit 1`;
  expect(job).toBeDefined();
  await expect(asServiceRole(db, sql => transitionExperiment({sql}, {orgId, experimentId:id, to:'running'}))).rejects.toThrow(/user actor or a scoped system job/);
  await expect(asServiceRole(db, sql => transitionExperiment({sql}, {orgId, experimentId:id, to:'running',systemJobId:foreign}))).rejects.toThrow(/scoped system job/);
  const [otherJob] = await db.sql<{id:string}[]>`select id from public.sync_jobs where profile_id=${foreignProfile} limit 1`;
  await expect(asServiceRole(db, sql => transitionExperiment({sql}, {orgId, experimentId:id, to:'running',systemJobId:otherJob!.id}))).rejects.toThrow(/scoped system job/);
  expect(await listExperimentEvents(db,{orgId,experimentId:id})).toHaveLength(1);
  await asServiceRole(db, sql => transitionExperiment({sql}, {orgId, experimentId:id, to:'running',systemJobId:job!.id,note:'Started by the recommendation job'}));
  // Direct SQL with the same service job context also uses the trigger.
  await asServiceRole(db, async sql => {
    await sql`select set_config('app.experiment_job',${job!.id},false)`;
    try { await sql`update public.experiments set status='ended' where id=${id}`; }
    finally { await sql`select set_config('app.experiment_job','',false)`; }
  });
  const events = await listExperimentEvents(db,{orgId,experimentId:id});
  expect(events).toHaveLength(3);
  expect(events.slice(1).map(event=>({from:event.fromStatus,to:event.toStatus,actor:event.actorId,system:event.systemActor}))).toEqual([
    {from:'planned',to:'running',actor:null,system:{role:'service_role',jobId:job!.id,jobType:'recommendations.run'}},
    {from:'running',to:'ended',actor:null,system:{role:'service_role',jobId:job!.id,jobType:'recommendations.run'}},
  ]);
  await expect(asServiceRole(db, sql => sql`update public.experiments set status='running' where id=${id}`)).rejects.toThrow(/Invalid experiment status transition/);
  await withAuthenticatedOrgEditor(db, actor, ({sql}) => sql`select app.transition_timeline_experiment(${orgId}::uuid,${id}::uuid,'analyzed',null,'Observed result',true,null,${job!.id}::uuid)`);
  const analyzed = (await listExperimentEvents(db,{orgId,experimentId:id})).at(-1)!;
  expect(analyzed.actorId).toBe(owner);
  expect(analyzed.systemActor).toBeNull();
  await expect(db.sql`update public.experiment_events set system_actor=null where id=${events[1]!.id}`).rejects.toThrow(/append-only/);
});
