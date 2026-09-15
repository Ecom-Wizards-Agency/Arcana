import { readCampaignRouteFixture, UpdateRouteData } from '../../campaigns/route-fixtures';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
export type UpdateData = UpdateRouteData;
export async function load(access: ScreenActor, input: ScreenParams): Promise<UpdateData> {
  const fixture = await readCampaignRouteFixture(access, input, 'campaigns-update', UpdateRouteData);
  if (fixture) return fixture;
  try { return await access.snapshot(async (snapshot) => {
    const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
    if (!profile) return { view: 'empty', message: 'Connect a profile before building an update.' };
    return { view: 'ready', profileId: profile.id, profileLabel: profile.label, marketplace: profile.countryCode };
  }); } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'The campaign update is unavailable.') }; }
}
