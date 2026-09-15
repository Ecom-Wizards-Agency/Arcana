import { readCampaignRouteFixture, BuilderRouteData } from '../../campaigns/route-fixtures';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { listProfiles } from '../../../app/_lib/profiles';
import { loadCampaignBuilderContext } from '../../campaigns/data';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
export type BuilderScreenData = BuilderRouteData;
export async function load(access: ScreenActor, input: ScreenParams): Promise<BuilderScreenData> {
  const fixture = await readCampaignRouteFixture(access, input, 'campaigns', BuilderRouteData);
  if (fixture) return fixture;
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
