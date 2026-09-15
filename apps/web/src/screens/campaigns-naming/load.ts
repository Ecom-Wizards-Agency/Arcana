import { listCampaignNamingPresets } from '@wizard-ads/db';
import type { CampaignNamingPreset, NamingStrategy } from '@wizard-ads/shared';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { loadCampaignBuilderContext } from '../../campaigns/data';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
export type NamingData = { view: 'ready'; presets: CampaignNamingPreset[]; naming: NamingStrategy | null; profiles: { id: string; label: string }[]; canEdit: boolean; profileId: string }
  | { view: 'error' | 'empty' | 'gated' | 'not-measured'; message: string };
export async function load(access: ScreenActor, _input: ScreenParams): Promise<NamingData> {
  try { return await access.snapshot(async (snapshot) => {
    const profiles = await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId);
    const profile = access.selectProfile(profiles);
    if (!profile) return { view: 'empty', message: 'Connect a profile to save a convention.' };
    const context = await loadCampaignBuilderContext(snapshot, profile.id);
    return { view: 'ready', presets: await listCampaignNamingPresets(snapshot), naming: context.naming, profiles: profiles.map((item) => ({ id: item.id, label: item.label })), canEdit: context.canEdit, profileId: profile.id };
  }); } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'Naming conventions are unavailable.') }; }
}
