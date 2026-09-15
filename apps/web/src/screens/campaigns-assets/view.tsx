'use client';
import { campaignRequest } from '../../campaigns/client';
import { CampaignPage, Notice } from '../campaigns/ui';
import { AssetPicker } from './picker';
import type { AssetsData } from './load';
export default function AssetsScreen({ data }: { data: AssetsData }) {
  return <CampaignPage title="Creative asset library">{data.view === 'ready' ? <AssetPicker snapshot={data.snapshot} used={data.used} canRefresh={data.canRefresh} onRefresh={async () => { await campaignRequest('/api/campaigns/assets', { profileId: data.profileId }); }} /> : <Notice>{data.message}</Notice>}</CampaignPage>;
}
