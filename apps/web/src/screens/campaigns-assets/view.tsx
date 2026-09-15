'use client';
import { CampaignUnavailable } from '../campaigns/unavailable';
import { campaignRequest } from '../../campaigns/client';
import { CampaignPage } from '../campaigns/ui';
import { AssetPicker } from './picker';
import type { AssetsData } from './load';
export default function AssetsScreen({ data }: { data: AssetsData }) {
  return <CampaignPage title="Pick a creative you already have">{data.view === 'ready' ? <AssetPicker initialTab={data.initialTab} snapshot={data.snapshot} used={data.used} canRefresh={data.canRefresh} onRefresh={async () => { await campaignRequest('/api/campaigns/assets', { profileId: data.profileId }); }} /> : <CampaignUnavailable screen="campaigns-assets" data={data} />}</CampaignPage>;
}
