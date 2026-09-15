import { readSponsoredPrompts } from '@wizard-ads/db';
import type { SponsoredPromptSnapshot } from '@wizard-ads/shared';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import { screenEnabled, type ScreenParams } from '../types';
import { descriptor } from './descriptor';

export type SponsoredPromptsData = { view: 'gated' } | { view: 'empty' } | {
  view: 'ready'; countryCode: string; currencyCode: string; canEdit: boolean; snapshot: SponsoredPromptSnapshot;
};
export async function load(access: ScreenActor, _input: ScreenParams): Promise<SponsoredPromptsData> {
  if (!screenEnabled(descriptor) || access.entry.state !== 'ok') return { view: 'gated' };
  const role = access.entry.context.active?.role;
  return access.snapshot(async (context) => {
    const profiles = await listProfiles({ sql: context.sql }, context.actor.orgId);
    const profile = access.selectProfile(profiles);
    if (!profile) return { view: 'empty' };
    const snapshot = await readSponsoredPrompts({ sql: context.sql }, { ...context.actor, profileId: profile.id });
    return { view: 'ready', countryCode: profile.countryCode, currencyCode: profile.currencyCode,
      canEdit: role === 'owner' || role === 'admin' || role === 'analyst', snapshot };
  });
}
