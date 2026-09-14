import { readOptimizerReview, readOptimizerSavedPreviews } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { listProfiles } from '../../../app/_lib/profiles';
import { requireOrgRole } from '../../server/org-role';
import { can } from '../../auth/roles';

export async function load(access: ScreenActor, input: ScreenParams) {
  if (access.entry.state !== 'ok') return { view: 'gated' as const, props: { entry: access.entry } };
  const orgId = access.actor().orgId;
  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles, access.requestedProfile);
  if (profile === null) return { view: 'empty' as const, props: {} };
  const batchId = Uuid.safeParse(input.params['batchId']);
  if (!batchId.success) return { view: 'error' as const, props: { message: 'This saved preview identity is invalid.' } };
  const { review, savedPreviews } = await access.snapshot(async (context) => {
    const identity = { orgId, profileId: profile.id, batchId: batchId.data };
    const review = await readOptimizerReview(context, identity);
    const mayReadWrites = can(await requireOrgRole(context), 'exportBatches');
    return { review, savedPreviews: review === null || !mayReadWrites ? [] : await readOptimizerSavedPreviews(context, identity) };
  });
  if (review === null) return { view: 'error' as const, props: { message: 'This saved preview was not found in this profile.' } };
  return { view: 'ready' as const, props: { profile, review, savedPreviews, details: input.searchParams['tab'] === 'details' } };
}
