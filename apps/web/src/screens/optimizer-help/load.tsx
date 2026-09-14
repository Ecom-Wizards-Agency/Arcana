import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';

export async function load(access: ScreenActor, input: ScreenParams) {
  const entry = access.entry;
  if (entry.state !== 'ok') return { view: 'gated' as const, props: { entry } };
  const profiles = await access.readSql((sql) => listProfiles({ sql }, entry.context.active?.orgId ?? ''));
  const profile = access.selectProfile(profiles, access.requestedProfile);
  if (profile === null) return { view: 'empty' as const, props: {} };
  return { view: 'ready' as const, props: { profileId: profile.id, example: input.searchParams['example'] === 'placement' } };
}
