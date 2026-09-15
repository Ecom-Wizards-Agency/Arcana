import { readCampaignRouteFixture, AssetsRouteData } from '../../campaigns/route-fixtures';
import { readAssetLibrarySnapshot, listUsedCampaignCreatives } from '@wizard-ads/db';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
export type AssetsData = AssetsRouteData;
export async function load(access: ScreenActor, input: ScreenParams): Promise<AssetsData> {
  const fixture = await readCampaignRouteFixture(access, input, 'campaigns-assets', AssetsRouteData);
  if (fixture) return fixture;
  try { return await access.snapshot(async (snapshot) => {
    const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
    if (!profile) return { view: 'empty', message: 'Connect a profile to browse creative assets.' };
    const members = await snapshot.sql<{ role: string }[]>`select role::text from public.org_members where org_id=${snapshot.actor.orgId}::uuid and user_id=${snapshot.actor.userId}::uuid`;
    return { view: 'ready', profileId: profile.id, snapshot: await readAssetLibrarySnapshot(snapshot, profile.id), used: await listUsedCampaignCreatives(snapshot, profile.id), canRefresh: members.some((member) => ['owner', 'admin', 'analyst'].includes(member.role)) };
  }); } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'The asset-library snapshot is unavailable.') }; }
}
