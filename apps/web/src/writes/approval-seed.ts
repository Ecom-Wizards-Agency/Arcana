import { syntheticRecommendationMethodInputs } from '@wizard-ads/db/testing';
import { randomUUID } from 'node:crypto';
import { exportAcceptedRecommendations, withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from '@wizard-ads/db';
import { previewSpWriteForActor, readRecordedSpWritePreviewForActor } from '@wizard-ads/db/sp-write-application';
import type { TestDatabase } from '@wizard-ads/db/testing';

/** Persist a real, unapproved synthetic preview in the disposable browser-test database. */
export async function seedRecordedSpWritePreview(database: TestDatabase) {
  if (!/^wizard_ads_(?:test_|e2e$)/u.test(database.name)) {
    throw new Error('Approval fixture requires the disposable test database');
  }
  const userId = randomUUID();
  const [tenant] = await database.sql<{ org_id: string }[]>`
    select app.seed_tenant_fixture(${`approval-fixture-${randomUUID()}`}, ${userId}, 'owner') as org_id`;
  const orgId = tenant!.org_id;
  const [source] = await database.sql<{ profile_id: string; run_id: string }[]>`
    select profile_id::text, id::text as run_id from public.recommendation_runs where org_id = ${orgId}`;
  const profileId = source!.profile_id;
  const recommendationId = randomUUID();
  await database.sql`insert into public.recommendations
    (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
    values (${recommendationId}, ${source!.run_id}, ${orgId}, ${profileId}, 'high_acos',
      'keyword', 'kw-1', 'bid', '0.9'::jsonb, '0.7'::jsonb, ${JSON.stringify(syntheticRecommendationMethodInputs())}::text::jsonb, 'accepted')`;
  const grantVersion = randomUUID();
  await database.sql`insert into public.sp_write_profile_grant_versions
    (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
     connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
    select grant_id, ${grantVersion}, org_id, profile_id, true, amazon_profile_id,
      connection_id, region, marketplace_id, currency_code, api_dialect, created_by
    from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}`;
  await database.sql`update public.sp_write_profile_grant_heads set version_id = ${grantVersion}
    where org_id = ${orgId} and profile_id = ${profileId}`;
  const gateVersion = randomUUID();
  await database.sql`insert into public.sp_write_environment_gate_versions
    (version_id, enabled, max_unresolved_calls) values (${gateVersion}, true, 1)`;
  await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id)
    values (true, ${gateVersion}) on conflict (singleton) do update set version_id = excluded.version_id`;
  const batch = await exportAcceptedRecommendations(database, { orgId, profileId, runId: source!.run_id,
    ids: [recommendationId], actorId: userId, tag: 'Synthetic approval fixture', optGroup: 'synthetic',
    lever: 'bid-down', note: 'Synthetic browser approval' });
  const actor = { orgId, userId };
  const preview = await withAuthenticatedOrgEditor(database, actor, (context) => previewSpWriteForActor(context, { requestId: randomUUID(), profileId, applyBatchId: batch.batchId }));
  return { actor, profileId, planId: preview.plan.id,
    approvalPath: `/writes/${preview.plan.id}?profile=${profileId}`,
    review: await withAuthenticatedReadSnapshot(database, actor, (context) => readRecordedSpWritePreviewForActor(context, { profileId, planId: preview.plan.id })) };
}
