import { readOptimizationWorkspace } from '@wizard-ads/db';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
export async function load(access: ScreenActor, _input: ScreenParams) {
  const entry = access.entry;
  if (entry.state !== 'ok') return { view: 'gated' as const, props: { entry } };
  const orgId = entry.context.active?.orgId ?? '';
  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles, access.requestedProfile);
  if (profile === null) return { view: 'empty' as const, props: {} };
  const workspace = await access.readSql((sql) => readOptimizationWorkspace({ sql }, { orgId, profileId: profile.id }));
  return { view: 'ready' as const, props: { profileId: profile.id, groups: workspace.groups } };
}
