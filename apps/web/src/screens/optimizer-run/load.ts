import { assertOptimizerApplyBatch, readOptimizerOperation, readOptimizerRetryExclusions, readOptimizerReview } from '@wizard-ads/db';
import { SpWriteOperationRequest } from '@wizard-ads/shared/sp-write-application';
import { Uuid } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { listProfiles } from '../../../app/_lib/profiles';
export async function load(access: ScreenActor, input: ScreenParams) {
  if (access.entry.state !== 'ok') return { view: 'gated' as const, props: { entry: access.entry } };
  const profiles = await access.readSql((sql) => listProfiles({ sql }, access.actor().orgId));
  const profile = access.selectProfile(profiles, access.requestedProfile);
  if (!profile) return { view: 'empty' as const, props: {} };
  const batchId = Uuid.safeParse(input.params['batchId']);
  const identity = SpWriteOperationRequest.safeParse({ profileId: profile.id, executionId: input.searchParams['execution'], planId: input.searchParams['plan'] });
  if (!batchId.success || !identity.success) return { view: 'error' as const, props: { message: 'Open this run from its saved approval. Its execution and plan identities are required.' } };
  const saved = await access.snapshot(async (context) => {
    const saved = await readOptimizerOperation(context, identity.data);
    const source = saved.plan.source;
    if (source.kind !== 'apply_batch') throw new Error('This operation is not an optimizer proposal.');
    await assertOptimizerApplyBatch(context, { orgId: context.actor.orgId, profileId: profile.id, batchId: batchId.data, applyBatchId: source.applyBatchId });
    const excluded = await readOptimizerRetryExclusions(context, { plan: saved.plan });
    const review = await readOptimizerReview(context, { orgId: context.actor.orgId, profileId: profile.id, batchId: batchId.data });
    return { operation: saved, retryProposals: review?.proposals ?? [], retrySnapshots: review?.children.flatMap((child) => child.calculationSnapshots) ?? [], ...(source.retryOrigin ? { retryDetails: { excludedSuccessfulNames: excluded.map((row) => row.name) } } : {}) };
  });
  return { view: 'ready' as const, props: { profile, ...saved, batchId: batchId.data, retry: input.searchParams['retry'] === '1' } };
}
