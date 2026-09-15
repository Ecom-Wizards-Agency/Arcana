import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor, withAuthenticatedActor } from './authenticated-actor.js';
import { queueTargetBidChange, approveQueuedTargetChange, readTargetBidContext, listQueuedTargetChanges } from './queued-changes.js';
let db: TestDatabase;
const userId = randomUUID(), orgId = randomUUID(), profileId = randomUUID();
const actor = { userId, orgId };
beforeAll(async () => {
  db = await createTestDatabase('target_queue', { applyFixture: false });
  await db.sql`insert into auth.users(id) values(${userId})`;
  await db.sql`insert into public.orgs(id,slug,name) values(${orgId},'synthetic-queue','Synthetic queue')`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${userId},'owner')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${profileId},${orgId},'synthetic-profile','NA','US','USD','UTC')`;
  await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,state,budget_amount,budget_type,placement_bidding) values(${orgId},${profileId},'campaign','SP','enabled',100,'daily','{"topOfSearch":100,"restOfSearch":0,"productPages":0}')`;
  await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at) values(${orgId},${profileId},'keyword','SP','enabled','campaign','group','Synthetic keyword','exact',5,now())`;
}, 180000);
afterAll(async () => { await db?.drop(); });
it('records immutable model checks, refuses foreign reads and refuses approval of missing limits', async () => {
  const context = await withAuthenticatedActor(db,actor,(sql) => readTargetBidContext({sql},orgId,profileId,'keyword'));
  expect(context?.oldBid?.amount).toBe('5');
  const request = { requestId: randomUUID(), profileId, targetId:'keyword',expectedBid:context!.oldBid!,expectedReadAt:context!.readAt!,newBid:{amount:'6',currencyCode:'USD'},overrideReason:null };
  const id = await withAuthenticatedOrgEditor(db,actor,(tx) => queueTargetBidChange(tx,request));
  expect(await withAuthenticatedOrgEditor(db,actor,(tx) => queueTargetBidChange(tx,request))).toBe(id);
  const rows = await withAuthenticatedActor(db,actor,(sql) => listQueuedTargetChanges({sql},orgId,profileId));
  expect(rows).toHaveLength(1); expect(rows[0]?.checks).toHaveLength(5);
  expect(rows[0]?.request).toEqual(request);
  expect(rows[0]?.checks.filter((c) => !c.passed)).toHaveLength(4);
  await expect(withAuthenticatedOrgEditor(db,actor,(tx) => approveQueuedTargetChange(tx,{profileId,targetId:'keyword',changeId:id}))).rejects.toThrow('Every check');
  await expect(db.sql`update public.queued_changes set target_id='changed' where id=${id}`).rejects.toThrow('immutable');
  await expect(db.sql`delete from public.queued_changes where id=${id}`).rejects.toThrow('immutable');
  const foreign = await withAuthenticatedActor(db,actor,(sql) => listQueuedTargetChanges({sql},randomUUID(),profileId));
  expect(foreign).toHaveLength(0);
  const [counts] = await db.sql`select (select count(*)::int from public.queued_change_approvals) as approvals,(select count(*)::int from public.sp_write_execution_requests) as outbox`;
  expect(counts).toEqual({approvals:0,outbox:0});
});
it('refuses a decrease when rank protection evidence is missing and stale synchronized bids', async () => {
  const c = await withAuthenticatedActor(db,actor,(sql) => readTargetBidContext({sql},orgId,profileId,'keyword'));
  const request = { requestId: randomUUID(), profileId, targetId:'keyword', expectedBid:c!.oldBid!, expectedReadAt:c!.readAt!,newBid:{amount:'4',currencyCode:'USD'},overrideReason:null };
  await expect(withAuthenticatedOrgEditor(db,actor,(tx) => queueTargetBidChange(tx,request))).rejects.toThrow('Rank gate');
  await expect(withAuthenticatedOrgEditor(db,actor,(tx) => queueTargetBidChange(tx,{...request,newBid:{amount:'6',currencyCode:'USD'},expectedBid:{amount:'3',currencyCode:'USD'}}))).rejects.toThrow('synchronized bid changed');
});
it('records only approval after all checks pass and refuses later source drift', async () => {
  const groupId = randomUUID();
  await db.sql`insert into public.optimization_groups(id,org_id,profile_id,name,role,target_acos,bid_floor,bid_ceiling,bid_increase_cap,bid_decrease_cap,placement_increase_cap,placement_decrease_cap,cadence,prioritization) values(${groupId},${orgId},${profileId},'Synthetic group','profit',0.3,1,12,1,0.5,1,0.5,'1 day','balanced')`;
  await db.sql`insert into public.campaign_optimization_assignments(org_id,profile_id,campaign_id,group_id) values(${orgId},${profileId},'campaign',${groupId})`;
  await db.sql`insert into public.bid_series_daily(org_id,profile_id,target_id,campaign_id,ad_group_id,is_keyword,date,bid,suggested_bid_low,suggested_bid_median,suggested_bid_high) values(${orgId},${profileId},'keyword','campaign','group',true,current_date,5,4,8.4,11)`;
  const c = await withAuthenticatedActor(db,actor,(sql) => readTargetBidContext({sql},orgId,profileId,'keyword'));
  const request = { requestId: randomUUID(), profileId,targetId:'keyword',expectedBid:c!.oldBid!,expectedReadAt:c!.readAt!,newBid:{amount:'8.4',currencyCode:'USD'},overrideReason:null };
  const id = await withAuthenticatedOrgEditor(db,actor,(tx) => queueTargetBidChange(tx,request));
  const approve = () => withAuthenticatedOrgEditor(db,actor,(tx) => approveQueuedTargetChange(tx,{profileId,targetId:'keyword',changeId:id}));
  expect(await approve()).toBe(id); expect(await approve()).toBe(id);
  const [counts] = await db.sql`select (select count(*)::int from public.queued_change_approvals) as approvals,(select count(*)::int from public.sp_write_execution_requests) as outbox,(select count(*)::int from public.sp_write_provider_call_intents) as intents`;
  expect(counts).toEqual({approvals:1,outbox:0,intents:0});
  const second = await withAuthenticatedOrgEditor(db,actor,(tx) => queueTargetBidChange(tx,{...request,requestId:randomUUID()}));
  await db.sql`update public.optimization_groups set bid_ceiling=7 where id=${groupId}`;
  await expect(withAuthenticatedOrgEditor(db,actor,(tx) => approveQueuedTargetChange(tx,{profileId,targetId:'keyword',changeId:second}))).rejects.toThrow('Target or limits changed');
});
it('requires and retains a protected-rank override and refuses direct SQL forgery', async () => {
  await db.sql`insert into public.profile_strategy(org_id,profile_id,schema_version,doc) values(${orgId},${profileId},'synthetic','{"rank_protection":{"protection_rank":2}}')`;
  await db.sql`insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank) values(${orgId},${profileId},'SYNTHETIC1','Synthetic keyword',current_date,1)`;
  const c = await withAuthenticatedActor(db,actor,(sql) => readTargetBidContext({sql},orgId,profileId,'keyword'));
  const request = { requestId:randomUUID(),profileId,targetId:'keyword',expectedBid:c!.oldBid!,expectedReadAt:c!.readAt!,newBid:{amount:'4',currencyCode:'USD'},overrideReason:null as string|null };
  await expect(withAuthenticatedOrgEditor(db,actor,(tx)=>queueTargetBidChange(tx,request))).rejects.toThrow('Rank gate');
  request.overrideReason='Synthetic reviewed rank override';
  const id = await withAuthenticatedOrgEditor(db,actor,(tx)=>queueTargetBidChange(tx,request));
  const rows = await withAuthenticatedActor(db,actor,(sql)=>listQueuedTargetChanges({sql},orgId,profileId));
  expect(rows.find(r=>r.id===id)?.request.overrideReason).toBe(request.overrideReason);
  await expect(withAuthenticatedActor(db,actor,sql=>sql`insert into public.queued_changes(id,org_id,profile_id,target_id,created_by,context,request,checks) values(${randomUUID()},${orgId},${profileId},'forged',${userId},'{}','{}','[{},{},{},{},{}]')`)).rejects.toThrow('permission denied');
});
it('denies an existing foreign-agency proposal through RLS and approval admission', async () => {
  const otherOrg = randomUUID(), otherProfile = randomUUID(), otherId = randomUUID();
  await db.sql`insert into public.orgs(id,slug,name) values(${otherOrg},'synthetic-other-queue','Synthetic other queue')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${otherProfile},${otherOrg},'synthetic-other-profile','NA','US','USD','UTC')`;
  await db.sql`insert into public.queued_changes(id,org_id,profile_id,target_id,created_by,context,request,checks) values(${otherId},${otherOrg},${otherProfile},'foreign-target',${userId},'{}','{}','[{},{},{},{},{}]')`;
  const rows=await withAuthenticatedActor(db,actor,sql=>sql`select id from public.queued_changes where id=${otherId}`);
  expect(rows).toHaveLength(0);
  await expect(withAuthenticatedOrgEditor(db,actor,tx=>approveQueuedTargetChange(tx,{profileId:otherProfile,targetId:'foreign-target',changeId:otherId}))).rejects.toThrow('Resource not found');
});

const overrideWhitespace = '\u0009\u000A\u000B\u000C\u000D\u0020\u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF\u200B';
async function directProposalRequest() {
  const c = await withAuthenticatedActor(db, actor, (sql) => readTargetBidContext({ sql }, orgId, profileId, 'keyword'));
  return { requestId: randomUUID(), profileId, targetId: 'keyword', expectedBid: c!.oldBid!, expectedReadAt: c!.readAt!, newBid: { amount: '4', currencyCode: 'USD' }, overrideReason: 'Reviewed decrease' as string | null };
}
function directQueue(request: unknown) {
  // Deliberately bypass QueuedBidRequest.parse and the HTTP/query adapters.
  return withAuthenticatedActor(db, actor, (sql) => sql<{ id: string }[]>`
    select app.queue_target_bid(${orgId}::uuid,${JSON.stringify(request)}::text::jsonb)::text as id
  `);
}
function readProposals() {
  return withAuthenticatedActor(db, actor, (sql) => listQueuedTargetChanges({ sql }, orgId, profileId, 'keyword'));
}
it('refuses Unicode whitespace and zero-width protected overrides through direct authenticated admission', async () => {
  const request = await directProposalRequest();
  const c = await withAuthenticatedActor(db, actor, (sql) => readTargetBidContext({ sql }, orgId, profileId, 'keyword'));
  expect([c!.organicRank, c!.protectionRank, c!.oldBid!.amount]).toEqual([1, 2, '5']);
  const before = await readProposals();
  for (const overrideReason of ['\n\t', ...overrideWhitespace, overrideWhitespace]) {
    await expect(directQueue({ ...request, overrideReason })).rejects.toThrow('Invalid override reason');
  }
  expect(await readProposals()).toEqual(before);
  const [counts] = await db.sql`select (select count(*)::int from public.queued_changes where id=${request.requestId}) as queued,(select count(*)::int from public.queued_change_approvals where change_id=${request.requestId}) as approved`;
  expect(counts).toEqual({ queued: 0, approved: 0 });
});
it('normalizes direct authenticated overrides before immutable storage and idempotent approval', async () => {
  const request = await directProposalRequest();
  const raw = { ...request, overrideReason: overrideWhitespace + 'Reviewed decrease' + overrideWhitespace };
  expect(await directQueue(raw)).toEqual([{ id: request.requestId }]);
  expect(await directQueue(request)).toEqual([{ id: request.requestId }]);
  const row = (await readProposals()).find((q) => q.id === request.requestId)!;
  expect(row.request.overrideReason).toBe('Reviewed decrease');
  expect(row.checks[0]).toMatchObject({ passed: true, reason: 'Rank gate override: Reviewed decrease' });
  expect(row.checks.every((check) => check.passed)).toBe(true);
  const result = await withAuthenticatedActor(db, actor, (sql) => sql<{ id: string }[]>`
    select app.approve_queued_target_bid(${orgId}::uuid,${profileId}::uuid,'keyword',${request.requestId}::uuid)::text as id
  `);
  expect(result).toEqual([{ id: request.requestId }]);
});
it('refuses malformed JSON scalars and nested money before they can poison proposal readback', async () => {
  const request = { ...await directProposalRequest(), newBid: { amount: '6', currencyCode: 'USD' }, overrideReason: null };
  const malformed: unknown[] = [null, [], {}, { ...request, extra: true }];
  for (const field of ['requestId', 'profileId', 'targetId', 'expectedReadAt']) {
    for (const value of [null, 6, false, [], {}]) malformed.push({ ...request, [field]: value });
  }
  for (const field of ['expectedBid', 'newBid']) {
    for (const value of [null, 6, false, [], '6', {}, { amount: '6' }, { amount: '6', currencyCode: 'USD', extra: true }]) {
      malformed.push({ ...request, [field]: value });
    }
    for (const amount of [6, null, false, [], {}, '6.001', '6.0', '-1', 'NaN']) {
      malformed.push({ ...request, [field]: { amount, currencyCode: 'USD' } });
    }
    for (const currencyCode of [6, null, false, [], {}, 'EUR', 'usd', 'XYZ']) {
      malformed.push({ ...request, [field]: { amount: '6', currencyCode } });
    }
  }
  malformed.push({ ...request, targetId: '😀'.repeat(101) }, { ...request, overrideReason: '😀'.repeat(501) });
  expect(malformed).toHaveLength(76);
  const before = await readProposals();
  for (const input of malformed) await expect(directQueue(input)).rejects.toThrow(/Invalid (proposal|override)/);
  expect(await readProposals()).toEqual(before);
  const [count] = await db.sql`select count(*)::int as queued from public.queued_changes where id=${request.requestId}`;
  expect(count?.queued).toBe(0);
  expect(await directQueue(request)).toEqual([{ id: request.requestId }]);
  const after = await readProposals();
  expect(after).toHaveLength(before.length + 1);
  expect(after.find((row) => row.id === request.requestId)?.request).toEqual(request);
});
it('enforces the profile currency and zero-decimal marketplace precision in direct admission', async () => {
  await db.sql`update public.ad_profiles set currency_code='JPY' where id=${profileId}`;
  try {
    const request = { ...await directProposalRequest(), newBid: { amount: '6.1', currencyCode: 'JPY' }, overrideReason: null };
    await expect(directQueue(request)).rejects.toThrow('Invalid proposal money: unsupported marketplace precision');
    await expect(directQueue({ ...request, newBid: { amount: '6', currencyCode: 'USD' } })).rejects.toThrow('currency must match the profile');
    expect(await directQueue({ ...request, newBid: { amount: '6', currencyCode: 'JPY' } })).toEqual([{ id: request.requestId }]);
    expect((await readProposals()).find((row) => row.id === request.requestId)?.request.newBid).toEqual({ amount: '6', currencyCode: 'JPY' });
  } finally { await db.sql`update public.ad_profiles set currency_code='USD' where id=${profileId}`; }
});
