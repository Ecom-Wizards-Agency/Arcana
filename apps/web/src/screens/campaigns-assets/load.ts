import { readAssetLibrarySnapshot, listUsedCampaignCreatives } from '@wizard-ads/db';
import { listProfiles } from '../../../app/_lib/profiles';
import type { AssetLibrarySnapshot, UsedCampaignCreative } from '@wizard-ads/shared/asset-library';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { unstable_rethrow } from 'next/navigation';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
export type AssetsData = { view: 'ready'; profileId: string; snapshot: AssetLibrarySnapshot | null; used: UsedCampaignCreative[]; canRefresh: boolean }
  | { view: 'error' | 'empty' | 'gated' | 'not-measured'; message: string };
export async function load(access: ScreenActor, _input: ScreenParams): Promise<AssetsData> {
  try { return await access.snapshot(async (snapshot) => {
    const profile = access.selectProfile(await listProfiles({ sql: snapshot.sql }, snapshot.actor.orgId));
    if (!profile) return { view: 'empty', message: 'Connect a profile to browse creative assets.' };
    return { view: 'ready', profileId: profile.id, snapshot: await readAssetLibrarySnapshot(snapshot, profile.id), used: await listUsedCampaignCreatives(snapshot, profile.id), canRefresh: false };
  }); } catch (error) { unstable_rethrow(error); return { view: 'error', message: pageReadErrorMessage(error, 'The asset-library snapshot is unavailable.') }; }
}
