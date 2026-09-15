import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { seedSyntheticWriteHistory } from '../testing/sp-write-synthetic-execution.js';
import { withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { assertOptimizerApplyBatch, readOptimizerOperation, readOptimizerReview, readOptimizerSavedPreviews } from './optimizer-run.js';

describe('saved optimizer authenticated database reads', () => {
  let database: TestDatabase;
  const actor = { orgId: '', userId: randomUUID() };
  const other = { orgId: '', userId: randomUUID() };
  let profileId: string;
  let batchId: string;

  beforeAll(async () => {
    database = await createTestDatabase('optimizer_run');
    for (const owner of [actor, other]) {
      const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${owner.userId},'owner') as id`;
      owner.orgId = tenant!.id;
    }
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id=${actor.orgId}::uuid`;
    profileId = profile!.id;
    const [batch] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_preview_batches
      where org_id=${actor.orgId}::uuid and profile_id=${profileId}::uuid`;
    batchId = batch!.id;
    // The generic RLS fixture inserts one proposal after its inert completed run.
    await database.sql`update public.recommendation_runs run set proposals_count=(select count(*) from public.recommendations row
      where row.org_id=run.org_id and row.profile_id=run.profile_id and row.run_id=run.id)
      where run.org_id=${actor.orgId}::uuid and run.profile_id=${profileId}::uuid`;
  }, 60_000);

  afterAll(async () => { await database?.drop(); });

  it('reads the exact synthetic child roster through authenticated RLS', async () => {
    const review = await withAuthenticatedReadSnapshot(database, actor, (context) =>
      readOptimizerReview(context, { orgId: actor.orgId, profileId, batchId }));
    expect(review?.integrity).toMatchObject({ expectedChildren: 1, loadedChildren: 1, expectedCampaigns: 1,
      loadedCampaigns: 1, loadedProposals: 1, completeEvidence: false });
    expect(review?.children[0]?.campaignIds).toEqual(['c-1']);
    expect(review?.proposals).toHaveLength(1);
    expect(review?.totals.evaluated).toBeNull();
    expect(await withAuthenticatedReadSnapshot(database, other, (context) =>
      readOptimizerReview(context, { orgId: actor.orgId, profileId, batchId }))).toBeNull();
  });

  it('reads persisted forward and inverse observations without losing rows or crossing tenants', async () => {
    const history = await seedSyntheticWriteHistory(database, actor, profileId);
    await expect(withAuthenticatedReadSnapshot(database, actor, (context) => assertOptimizerApplyBatch(context,
      { orgId: actor.orgId, profileId, batchId, applyBatchId: history.sourceBatchId }))).resolves.toBeUndefined();
    await expect(withAuthenticatedReadSnapshot(database, actor, (context) => assertOptimizerApplyBatch(context,
      { orgId: actor.orgId, profileId, batchId: randomUUID(), applyBatchId: history.sourceBatchId }))).rejects.toThrow();
    await expect(withAuthenticatedReadSnapshot(database, other, (context) => assertOptimizerApplyBatch(context,
      { orgId: actor.orgId, profileId, batchId, applyBatchId: history.sourceBatchId }))).rejects.toThrow();
    const recovered = await withAuthenticatedReadSnapshot(database, actor, (context) => readOptimizerSavedPreviews(context,
      { orgId: actor.orgId, profileId, batchId }));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.preview.plan.id).toBe(history.original.planId);
    expect(recovered[0]?.admission?.operation).toEqual(history.original);
    expect(recovered[0]?.currentRows).toHaveLength(recovered[0]!.preview.plan.counts.providerRows);
    await expect(withAuthenticatedReadSnapshot(database, actor, (context) => readOptimizerSavedPreviews(context,
      { orgId: actor.orgId, profileId, batchId: randomUUID() }))).resolves.toEqual([]);
    await expect(withAuthenticatedReadSnapshot(database, other, (context) => readOptimizerSavedPreviews(context,
      { orgId: actor.orgId, profileId, batchId }))).rejects.toThrow();
    for (const operation of [history.original, history.inverse]) {
      const result = await withAuthenticatedReadSnapshot(database, actor, (context) =>
        readOptimizerOperation(context, { profileId, ...operation }));
      expect(result.rows).toHaveLength(result.plan.counts.providerRows);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ status: 'observed', providerOutcome: 'accepted', retryEligible: false });
      expect(result.rows[0]?.observed).toBe(result.rows[0]?.requested);
      expect(result.detail.snapshot.accounting.observedRequested).toBe(result.rows.length);
    }
    await expect(withAuthenticatedReadSnapshot(database, other, (context) =>
      readOptimizerOperation(context, { profileId, ...history.original }))).rejects.toThrow();
  }, 60_000);
});
