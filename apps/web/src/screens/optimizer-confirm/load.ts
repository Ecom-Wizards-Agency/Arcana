import { readSpWriteConfirmationSnapshot } from '../../writes/http';
import { assertOptimizerApplyBatch } from '@wizard-ads/db';
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
  const plan = Uuid.safeParse(input.searchParams['plan']);
  if (plan.success) {
    const recorded = await access.snapshot(async (context) => {
      const saved = await readSpWriteConfirmationSnapshot(context, { profileId: profile.id, planId: plan.data });
      const source = saved.preview.plan.source;
      if (source.kind !== 'apply_batch') throw new Error('This operation is not an optimizer proposal.');
      await assertOptimizerApplyBatch(context, { orgId: context.actor.orgId, profileId: profile.id, batchId: batch.data, applyBatchId: source.applyBatchId });
      return saved;
    });
    return { view: 'ready' as const, props: { profile, batchId: batch.data, recorded, applyBatchId: null } };
  }
  const applyBatch = Uuid.safeParse(input.searchParams['applyBatch']);
  if (!applyBatch.success) return { view: 'error' as const, props: { message: 'Select changes and prepare their immutable preview first.' } };
  await access.snapshot((context) => assertOptimizerApplyBatch(context, { orgId: context.actor.orgId, profileId: profile.id, batchId: batch.data, applyBatchId: applyBatch.data }));
  return { view: 'ready' as const, props: { profile, batchId: batch.data, recorded: null, applyBatchId: applyBatch.data } };
}
