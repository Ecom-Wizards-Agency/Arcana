import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const available = await databaseAvailable();

interface Scope {
  orgId: string;
  profileId: string;
  oldGroupId: string;
  newGroupId: string;
}

interface Exported {
  recommendationId: string;
  batchId: string;
  entityId: string;
  entityType: 'keyword' | 'campaign';
}

interface Safety {
  mayPropose: boolean;
  exportedRecommendations: number;
  incompleteObservations: number;
  holdDecisions: number;
  revertDecisions: number;
  reason: string;
}

const CLEAR = {
  mayPropose: true,
  exportedRecommendations: 0,
  incompleteObservations: 0,
  holdDecisions: 0,
  revertDecisions: 0,
};

describe.skipIf(!available)('one-time campaign observation safety + Postgres', () => {
  let database: TestDatabase;
  let sequence = 0;

  beforeAll(async () => {
    database = await createTestDatabase('one_time_campaign_safety', { applyFixture: false });
    const [functionRow] = await database.sql<{ present: boolean }[]>`
      select to_regprocedure('app.recommendation_campaign_safety(uuid,uuid,text[])') is not null as present
    `;
    expect(functionRow?.present).toBe(true);
  }, 60_000);

  afterAll(async () => { await database?.drop(); }, 30_000);

  it('retains an old-group observation after a campaign moves or becomes unassigned', async () => {
    const scope = await seedScope();
    const runId = await seedRun(scope, ['campaign-a']);
    const exported = await seedExport(scope, runId, 'campaign-a');
    await observe(scope, exported, 'hold', 'observing', 1);
    await database.sql`
      insert into public.campaign_optimization_assignments (org_id, profile_id, campaign_id, group_id)
      values (${scope.orgId}, ${scope.profileId}, 'campaign-a', ${scope.oldGroupId})
    `;
    const expected = {
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1,
      holdDecisions: 1, revertDecisions: 0,
    };
    expect(await safety(scope, ['campaign-a'])).toMatchObject(expected);
    const moved = await database.sql<{ campaign_id: string }[]>`
      update public.campaign_optimization_assignments set group_id = ${scope.newGroupId}
       where org_id = ${scope.orgId} and profile_id = ${scope.profileId} and campaign_id = 'campaign-a'
      returning campaign_id
    `;
    expect(moved).toHaveLength(1);
    expect(await safety(scope, ['campaign-a'])).toMatchObject(expected);
    const removed = await database.sql<{ campaign_id: string }[]>`
      delete from public.campaign_optimization_assignments
       where org_id = ${scope.orgId} and profile_id = ${scope.profileId} and campaign_id = 'campaign-a'
      returning campaign_id
    `;
    expect(removed).toHaveLength(1);
    expect(await safety(scope, ['campaign-a'])).toMatchObject(expected);
  });

  it('uses each recommendation campaign rather than every campaign in its prior run', async () => {
    const scope = await seedScope();
    const runId = await seedRun(scope, ['campaign-a', 'campaign-b']);
    const a = await seedExport(scope, runId, 'campaign-a');
    const b = await seedExport(scope, runId, 'campaign-b');
    await observe(scope, a, 'continue', 'complete', 1);
    await observe(scope, b, 'hold', 'observing', 1);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({ ...CLEAR, exportedRecommendations: 1 });
    expect(await safety(scope, ['campaign-b'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1, holdDecisions: 1,
    });
    expect(await safety(scope, ['campaign-a', 'campaign-b'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 2, incompleteObservations: 1, holdDecisions: 1,
    });
  });

  it('counts one recommendation once despite multiple apply rows', async () => {
    const scope = await seedScope();
    const exported = await seedExport(scope, await seedRun(scope, ['campaign-a']), 'campaign-a');
    await insertApplyRow(scope, exported);
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.apply_rows
       where org_id = ${scope.orgId} and profile_id = ${scope.profileId}
         and recommendation_id = ${exported.recommendationId}
    `;
    expect(count?.count).toBe(2);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1, holdDecisions: 0,
    });
  });

  it('uses the latest observation rather than the strongest historical decision', async () => {
    const scope = await seedScope();
    const exported = await seedExport(scope, await seedRun(scope, ['campaign-a']), 'campaign-a');
    await observe(scope, exported, 'revert', 'complete', 1);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({ mayPropose: false, revertDecisions: 1 });
    await observe(scope, exported, 'hold', 'observing', 2);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({
      mayPropose: false, incompleteObservations: 1, holdDecisions: 1, revertDecisions: 0,
    });
    await observe(scope, exported, 'continue', 'complete', 3);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({ ...CLEAR, exportedRecommendations: 1 });
    await observe(scope, exported, 'revert', 'complete', 4);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 0,
      holdDecisions: 0, revertDecisions: 1,
    });
  });

  it.each(['staged', 'applied'] as const)('holds a %s export with missing observation', async (status) => {
    const scope = await seedScope();
    const exported = await seedExport(scope, await seedRun(scope, ['campaign-a']), 'campaign-a');
    await setBatchStatus(exported.batchId, status);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1,
      holdDecisions: 0, revertDecisions: 0,
    });
  });

  it.each(['reverted', 'abandoned'] as const)('excludes %s batches even with a hold observation', async (status) => {
    const scope = await seedScope();
    const exported = await seedExport(scope, await seedRun(scope, ['campaign-a']), 'campaign-a');
    await observe(scope, exported, 'hold', 'observing', 1);
    await setBatchStatus(exported.batchId, status);
    expect(await safety(scope, ['campaign-a'])).toMatchObject(CLEAR);
  });

  it('keeps matching campaign IDs in another profile or organisation outside the selection', async () => {
    const own = await seedScope();
    const sibling = await seedScope(own.orgId);
    const foreign = await seedScope();
    const ownExport = await seedExport(own, await seedRun(own, ['campaign-a']), 'campaign-a');
    await observe(own, ownExport, 'continue', 'complete', 1);
    await seedExport(sibling, await seedRun(sibling, ['campaign-a']), 'campaign-a');
    const foreignExport = await seedExport(foreign, await seedRun(foreign, ['campaign-a']), 'campaign-a');
    await observe(foreign, foreignExport, 'revert', 'complete', 1);
    expect(await safety(own, ['campaign-a'])).toMatchObject({ ...CLEAR, exportedRecommendations: 1 });
    expect(await safety(sibling, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1, revertDecisions: 0,
    });
    expect(await safety(foreign, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 0, revertDecisions: 1,
    });
    expect(await safety({ ...own, profileId: foreign.profileId }, ['campaign-a'])).toMatchObject(CLEAR);
  });

  it('holds an active target export with unknown campaign scope even after complete observation', async () => {
    const scope = await seedScope();
    const exported = await seedExport(scope, await seedRun(scope, ['campaign-b']), null);
    await observe(scope, exported, 'continue', 'complete', 1);
    expect(await safety(scope, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1,
      reason: expect.stringContaining('scope cannot be established'),
    });
    await setBatchStatus(exported.batchId, 'abandoned');
    expect(await safety(scope, ['campaign-a'])).toMatchObject(CLEAR);
  });

  it('resolves a campaign entity with null campaign_id using its own immutable identity', async () => {
    const scope = await seedScope();
    const exported = await seedExport(scope, await seedRun(scope, ['campaign-a']), null, 'campaign');
    expect(exported.entityId).toBe('campaign-a');
    expect(await safety(scope, ['campaign-a'])).toMatchObject({
      mayPropose: false, exportedRecommendations: 1, incompleteObservations: 1,
    });
    expect(await safety(scope, ['campaign-b'])).toMatchObject(CLEAR);
  });

  async function seedScope(existingOrgId?: string): Promise<Scope> {
    const label = `campaign-safety-${++sequence}`;
    let orgId = existingOrgId;
    if (orgId === undefined) {
      const [org] = await database.sql<{ id: string }[]>`
        insert into public.orgs (slug, name) values (${label}, 'Synthetic campaign safety') returning id
      `;
      if (!org) throw new Error('Expected one synthetic organisation');
      orgId = org.id;
    }
    const [profile] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone)
      values (${orgId}, ${label}, 'NA', 'US', 'USD', 'UTC') returning id
    `;
    if (!profile) throw new Error('Expected one synthetic profile');
    const groups = await database.sql<{ id: string; name: string }[]>`
      insert into public.optimization_groups
        (org_id, profile_id, name, role, target_acos, bid_increase_cap, bid_decrease_cap,
         placement_increase_cap, placement_decrease_cap, cadence, prioritization)
      select ${orgId}, ${profile.id}, offered.name, 'profit', 0.3, 0.2, 0.2,
             0.2, 0.2, interval '7 days', 'balanced'
        from unnest(array['old', 'new']) offered(name)
      returning id, name
    `;
    expect(groups).toHaveLength(2);
    const oldGroupId = groups.find((group) => group.name === 'old')?.id;
    const newGroupId = groups.find((group) => group.name === 'new')?.id;
    if (!oldGroupId || !newGroupId) throw new Error('Expected both synthetic groups');
    return { orgId, profileId: profile.id, oldGroupId, newGroupId };
  }

  async function seedRun(scope: Scope, campaignIds: readonly string[]): Promise<string> {
    const [run] = await database.sql<{ id: string }[]>`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, engine_version, group_id, group_role, group_snapshot)
      values (${scope.orgId}, ${scope.profileId}, 'succeeded', 7, 'white-box-v1',
              ${scope.oldGroupId}, 'profit', '{}'::jsonb) returning id
    `;
    if (!run) throw new Error('Expected one synthetic historical run');
    const members = await database.sql<{ campaign_id: string }[]>`
      insert into public.recommendation_run_campaigns (org_id, profile_id, run_id, campaign_id)
      select ${scope.orgId}, ${scope.profileId}, ${run.id}, offered.campaign_id
        from unnest(${[...campaignIds]}::text[]) offered(campaign_id)
      returning campaign_id
    `;
    expect(members.map((member) => member.campaign_id).sort()).toEqual([...campaignIds].sort());
    return run.id;
  }

  async function seedExport(
    scope: Scope, runId: string, campaignId: string | null, entityType: Exported['entityType'] = 'keyword',
  ): Promise<Exported> {
    const entityId = entityType === 'campaign' ? 'campaign-a' : `synthetic-keyword-${++sequence}`;
    const [recommendation] = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (org_id, profile_id, run_id, reason, entity_type, entity_id, ad_product,
         campaign_id, ad_group_id, field, current_value, proposed_value, inputs, status)
      values (${scope.orgId}, ${scope.profileId}, ${runId}, 'high_acos',
              ${entityType}::public.entity_type, ${entityId}, 'SP', ${campaignId}, 'synthetic-ad-group',
              'bid', '0.4'::jsonb, '0.3'::jsonb, '{}'::jsonb, 'exported') returning id
    `;
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches (org_id, profile_id, tag, opt_group, lever, note, status)
      values (${scope.orgId}, ${scope.profileId}, ${`synthetic-${++sequence}`}, 'old', 'bid',
              'Synthetic campaign observation safety', 'staged') returning id
    `;
    if (!recommendation || !batch) throw new Error('Expected synthetic export records');
    const exported = { recommendationId: recommendation.id, batchId: batch.id, entityId, entityType };
    await insertApplyRow(scope, exported);
    return exported;
  }

  async function insertApplyRow(scope: Scope, exported: Exported): Promise<void> {
    const rows = await database.sql<{ id: string }[]>`
      insert into public.apply_rows
        (org_id, profile_id, batch_id, recommendation_id, entity_type, entity_id, field, old_value, new_value)
      values (${scope.orgId}, ${scope.profileId}, ${exported.batchId}, ${exported.recommendationId},
              ${exported.entityType}::public.apply_entity_type, ${exported.entityId}, 'bid', '0.4'::jsonb, '0.3'::jsonb)
      returning id
    `;
    expect(rows).toHaveLength(1);
  }

  async function observe(
    scope: Scope, exported: Exported, decision: 'hold' | 'continue' | 'revert',
    state: 'observing' | 'complete', order: number,
  ): Promise<void> {
    const rows = await database.sql<{ id: string }[]>`
      insert into public.recommendation_observations
        (org_id, profile_id, recommendation_id, group_id, expected_value,
         observation_window_start, observation_window_end, evidence_state, decision, evidence_note, observed_at)
      values (${scope.orgId}, ${scope.profileId}, ${exported.recommendationId}, ${scope.oldGroupId}, 0.3,
              '2026-08-20', '2026-08-26', ${state}::public.recommendation_evidence_state,
              ${decision}::public.recommendation_evidence_decision, 'Synthetic evidence',
              '2026-08-27T00:00:00Z'::timestamptz + ${order} * interval '1 second') returning id
    `;
    expect(rows).toHaveLength(1);
  }

  async function setBatchStatus(batchId: string, status: 'staged' | 'applied' | 'reverted' | 'abandoned'): Promise<void> {
    const rows = await database.sql<{ id: string }[]>`
      update public.apply_batches
         set status = ${status}::public.apply_batch_status,
             applied_on = case when ${status} = 'applied' then '2026-08-27'::date else applied_on end
       where id = ${batchId} returning id
    `;
    expect(rows).toHaveLength(1);
  }

  async function safety(scope: Pick<Scope, 'orgId' | 'profileId'>, campaignIds: readonly string[]): Promise<Safety> {
    const rows = await database.sql<{ safety: Safety }[]>`
      select app.recommendation_campaign_safety(${scope.orgId}::uuid, ${scope.profileId}::uuid,
                                               ${[...campaignIds]}::text[]) as safety
    `;
    expect(rows).toHaveLength(1);
    if (!rows[0]) throw new Error('Expected one safety result');
    expect(typeof rows[0].safety.reason).toBe('string');
    return rows[0].safety;
  }
});
