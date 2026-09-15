import type { CampaignBuilderContext } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { listProfiles } from '../../../app/_lib/profiles';
import { loadCampaignBuilderContext } from '../../campaigns/data';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
export type BuilderScreenData = { view: 'ready'; context: CampaignBuilderContext; step: 'products' | 'targets' | 'review' }
  | { view: 'error' | 'empty' | 'gated' | 'not-measured'; message: string };
export async function load(access: ScreenActor, input: ScreenParams): Promise<BuilderScreenData> {
  try {
    return await access.snapshot(async (snapshot) => {
      const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
      if (!profile) return { view: 'empty', message: 'Connect a profile to choose advertised products.' };
      const context = await loadCampaignBuilderContext(snapshot, profile.id);
      const step = input.searchParams['step'];
      return { view: 'ready', context, step: step === 'targets' || step === 'review' ? step : 'products' };
    });
  } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'Campaign Builder is unavailable. Try again.') }; }
}
