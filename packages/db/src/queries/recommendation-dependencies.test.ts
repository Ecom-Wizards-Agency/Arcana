import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencySet } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { exportAcceptedRecommendations, getExportBatch, listRecommendations } from './recommendations.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { readRecommendationPlacementFacts } from './facts.js';

const actor = '63636363-6363-4363-8363-636363636363';
describe('persisted coordinated dependency sets', () => {
  let db: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  beforeAll(async () => {
    db = await createTestDatabase('coordinated_dependency');
    const [tenant] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-coordination', ${actor}, 'owner') as id`;
    orgId = tenant!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
    profileId = profile!.id;
    const [run] = await db.sql<{ id: string }[]>`insert into public.recommendation_runs
      (org_id, profile_id, status, lookback_days, method_id, method_version)
      values (${orgId},${profileId},'succeeded',28,'sp.coordinated-efficiency','candidate.1') returning id`;
    runId = run!.id;
    await db.sql`insert into public.recommendation_run_campaigns (org_id, profile_id, run_id, campaign_id)
      values (${orgId},${profileId},${runId},'c-1')`;
  }, 60_000);
  afterAll(async () => { await db?.drop(); });
  function dependency() {
    const campaign = { profileId, campaignId: 'c-1', adProduct: 'SP', entityType: 'campaign', entityId: 'c-1' };
    return DependencySet.parse({ id: `${runId}:c-1`, campaignId: 'c-1', changes: [
      { control: 'target_bid', entityRef: { ...campaign, entityType: 'keyword', entityId: 'kw-1' }, current: 0.6, proposed: 0.3, unit: 'currency_per_click' },
      { control: 'placement_adjustment', entityRef: campaign, placementKey: 'top_of_search', current: 100, proposed: 300, unit: 'percentage' },
      { control: 'placement_adjustment', entityRef: campaign, placementKey: 'rest_of_search', current: 0, proposed: 100, unit: 'percentage' },
    ], precedenceReasons: ['Observe the base reduction before raising placements.', 'Observe the first placement change before the next.'] });
  }
  const insert = (set: unknown) => db.sql`insert into public.recommendations
    (org_id,profile_id,run_id,reason,entity_type,entity_id,ad_product,campaign_id,field,current_value,proposed_value,inputs,status)
    values (${orgId},${profileId},${runId},'high_acos','campaign','c-1','SP','c-1','control_set','null','null',
      ${JSON.stringify({ dependencySet: set })}::jsonb,'proposed') returning id`;
  it('round-trips all three ordered controls in one row and retains the scalar reference shape', async () => {
    expect(await insert(dependency())).toHaveLength(1);
    expect(await db.sql`insert into public.recommendations
      (org_id,profile_id,run_id,reason,entity_type,entity_id,field,current_value,proposed_value,inputs,status)
      values (${orgId},${profileId},${runId},'high_acos','keyword','kw-1','bid','0.6','0.3','{}','proposed') returning id`).toHaveLength(1);
    const rows = await listRecommendations(db, { orgId, profileId, runId });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.field === 'control_set')?.inputs.dependencySet).toEqual(dependency());
    expect(rows.find((r) => r.field === 'bid')).toMatchObject({ currentValue: 0.6, proposedValue: 0.3, inputs: {} });
  });
  it('rejects a hidden foreign target, fractional placement and incomplete precedence reasons', async () => {
    const foreign = dependency(); foreign.changes[0]!.entityRef.entityId = 'foreign-keyword';
    await expect(insert(foreign)).rejects.toMatchObject({ code: '23514' });
    const fractional = dependency(); fractional.changes[1]!.proposed = 300.5;
    await expect(insert(fractional)).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ ...dependency(), precedenceReasons: [] })).rejects.toMatchObject({ code: '23514' });
    const set = dependency();
    await expect(insert({ ...set, changes: [{ ...set.changes[1], proposed: '300' }], precedenceReasons: [] })).rejects.toMatchObject({ code: '23514' });
    await expect(insert({ ...set, changes: [{ ...set.changes[0], placementKey: 'top_of_search' },
      { ...set.changes[0], placementKey: 'rest_of_search' }], precedenceReasons: ['Duplicate identity'] })).rejects.toMatchObject({ code: '23514' });
  });
  it('reads only selected campaign placements in the exact window with reconciled shares', async () => {
    await db.sql`insert into public.fact_placement_daily
      (org_id,profile_id,date,ad_product,campaign_id,placement,clicks,sales_7d)
      values (${orgId},${profileId},'2026-08-01','SP','c-1','top_of_search',40,160),
        (${orgId},${profileId},'2026-08-01','SP','c-1','rest_of_search',40,80),
        (${orgId},${profileId},'2026-08-01','SP','c-1','product_pages',20,20),
        (${orgId},${profileId},'2026-08-01','SP','unselected','top_of_search',100,999),
        (${orgId},${profileId},'2026-08-30','SP','c-1','top_of_search',100,999)`;
    const facts = await readRecommendationPlacementFacts(db, { orgId, profileId, runId, start: '2026-08-01', end: '2026-08-28' });
    expect(facts).toHaveLength(3);
    expect(facts.reduce((sum, fact) => sum + fact.clicks, 0)).toBe(100);
    expect(facts.reduce((sum, fact) => sum + fact.sales, 0)).toBe(260);
    expect(facts.map((f) => f.clickShare).sort()).toEqual([0.2, 0.4, 0.4]);
    await db.sql`update public.recommendation_runs set method_id='sp.reference-efficiency',method_version='reference.1' where id=${runId}`;
    expect(await readRecommendationPlacementFacts(db, { orgId, profileId, runId, start: '2026-08-01', end: '2026-08-28' })).toEqual([]);
  });
  it('exports and reads one accepted set as three ordered rows with one source recommendation', async () => {
    const [recommendation] = await insert(dependency());
    const id = String(recommendation!.id);
    await db.sql`update public.recommendations set status='accepted' where id=${id}`;
    await db.sql`update public.keywords set bid=0.6 where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":100,"restOfSearch":0,"productPages":0}'::jsonb
      where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    const exported = await withAuthenticatedOrgEditor(db, { orgId, userId: actor }, (context) =>
      exportAcceptedRecommendations(context, { orgId, profileId, runId, ids: [id], actorId: actor,
        tag: 'synthetic-ordered-export', optGroup: 'synthetic', lever: 'other', note: 'Synthetic ordered preview' }));
    expect(exported.exported).toBe(1);
    expect(exported.skipped).toHaveLength(0);
    expect(exported.rows.map((row) => [row.entityType,row.field,row.old,row.new])).toEqual([
      ['keyword','bid',0.6,0.3], ['campaign','tos_modifier',100,300], ['campaign','ros_modifier',0,100],
    ]);
    const rows = await db.sql`select recommendation_id,dependency_set_id,dependency_step_index
      from public.apply_rows where batch_id=${exported.batchId} order by dependency_step_index`;
    expect(rows).toEqual([0,1,2].map((index) => ({ recommendation_id: id, dependency_set_id: dependency().id, dependency_step_index: index })));
    const [counts] = await db.sql`select exported_proposals,reversible_rows,unsupported_rows,dependency_sets_count
      from public.apply_batches where id=${exported.batchId}`;
    expect(counts).toEqual({ exported_proposals: 1, reversible_rows: 3, unsupported_rows: 0, dependency_sets_count: 1 });
    expect((await getExportBatch(db, { orgId, batchId: exported.batchId }))?.rows).toEqual(exported.rows);
  });
  it('refuses the whole export when one placement no longer matches the recommendation', async () => {
    const [recommendation] = await insert(dependency());
    const id = String(recommendation!.id);
    await db.sql`update public.recommendations set status='accepted' where id=${id}`;
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":101,"restOfSearch":0,"productPages":0}'::jsonb
      where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    const before = await db.sql`select count(*)::integer as count from public.apply_batches where org_id=${orgId}`;
    await expect(withAuthenticatedOrgEditor(db, { orgId, userId: actor }, (context) =>
      exportAcceptedRecommendations(context, { orgId, profileId, runId, ids: [id], actorId: actor,
        tag: 'synthetic-stale-export', optGroup: 'synthetic', lever: 'other', note: 'Synthetic stale preview' })))
      .rejects.toThrow(/no longer matches/);
    expect(await db.sql`select count(*)::integer as count from public.apply_batches where org_id=${orgId}`).toEqual(before);
    expect(await db.sql`select status,export_batch_id from public.recommendations where id=${id}`)
      .toEqual([{ status: 'accepted', export_batch_id: null }]);
  });
});
