import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

import { readOptimizationWorkspace } from '@wizard-ads/db';

import { resolveOptimizerPreviewReadiness } from '../../optimizer/readiness';

import { listProfiles } from '../../../app/_lib/profiles';

export async function load(access: ScreenActor, _input: ScreenParams) {

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }

  const { handle, context } = entry;
  const orgId = context.active?.orgId ?? '';
  const profileId = await Promise.resolve(access.requestedProfile);
  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles, profileId);

  if (profile === null) {
    return { view: 'empty' as const, props: {} };
  }

  const [workspace, previewReadiness] = await Promise.all([
    access.readSql((sql) => readOptimizationWorkspace({ sql }, { orgId, profileId: profile.id })),
    resolveOptimizerPreviewReadiness(handle),
  ]);

  return { view: 'ready' as const, props: { profile, workspace, context, previewReadiness } };
}
