import { readSpWriteConfirmationSnapshot } from '../../writes/http';
import { assertOptimizerApplyBatch, readOptimizerReview, readOptimizerExports, readOptimizerRetryExclusions } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { listProfiles } from '../../../app/_lib/profiles';

export async function load(access: ScreenActor, input: ScreenParams) {
  if (access.entry.state !== 'ok') return { view: 'gated' as const, props: { entry: access.entry } };
  const profiles = await access.readSql((sql) => listProfiles({ sql }, access.actor().orgId));
  const profile = access.selectProfile(profiles, access.requestedProfile);
  if (!profile) return { view: 'empty' as const, props: {} };
  const batch = Uuid.safeParse(input.params['batchId']);
  if (!batch.success) return { view: 'error' as const, props: { message: 'Invalid saved preview identity.' } };
  const review = await access.snapshot((context) => readOptimizerReview(context, { orgId: context.actor.orgId, profileId: profile.id, batchId: batch.data }));
  const proposals = review?.proposals ?? [];
  const plan = Uuid.safeParse(input.searchParams['plan']);
  if (plan.success) {
    const saved = await access.snapshot(async (context) => {
      const saved = await readSpWriteConfirmationSnapshot(context, { profileId: profile.id, planId: plan.data });
      const source = saved.preview.plan.source;
      if (source.kind !== 'apply_batch') throw new Error('This operation is not an optimizer proposal.');
      await assertOptimizerApplyBatch(context, { orgId: context.actor.orgId, profileId: profile.id, batchId: batch.data, applyBatchId: source.applyBatchId });
      const excluded = await readOptimizerRetryExclusions(context, saved.preview);
      return { recorded: saved, ...(source.retryOrigin ? { retryDetails: { excludedSuccessfulNames: excluded.map((row) => row.name) } } : {}) };
    });
    return { view: 'ready' as const, props: { profile, batchId: batch.data, proposals, ...saved, applyBatchId: null } };
  }
  const applyBatch = Uuid.safeParse(input.searchParams['applyBatch']);
  if (!applyBatch.success) return { view: 'error' as const, props: { message: 'Select changes and prepare their immutable preview first.' } };
  const forwardRowIds = await access.snapshot(async (context) => {
    const scope = { orgId: context.actor.orgId, profileId: profile.id, batchId: batch.data };
    await assertOptimizerApplyBatch(context, { ...scope, applyBatchId: applyBatch.data });
    const exports = await readOptimizerExports(context, scope);
    const selected = exports.find((item) => item.applyBatchId === applyBatch.data);
    if (review?.executionSnapshot && !selected) throw new Error('The saved one-time selection export is unavailable.');
    return selected?.forwardRowIds;
  });
  return { view: 'ready' as const, props: { profile, batchId: batch.data, proposals, recorded: null, applyBatchId: applyBatch.data, ...(forwardRowIds ? { forwardRowIds } : {}) } };
}
