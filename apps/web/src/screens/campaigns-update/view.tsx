import { CampaignUnavailable } from '../campaigns/unavailable';
import { CampaignBuilder } from '../../../app/campaigns/builder';
import { CampaignPage } from '../campaigns/ui';
import type { load } from './load';
export default function UpdateScreen({ data }: { data: Awaited<ReturnType<typeof load>> }) {
  return <CampaignPage title="Update campaigns" subtitle="Review sparse changes from the synced mirror and export a bulk sheet for manual upload.">{data.view === 'ready' ? <><CampaignBuilder {...data} /><a href={`/campaigns?profile=${data.profileId}`}>Create campaigns</a></> : <CampaignUnavailable screen="campaigns-update" data={data} />}</CampaignPage>;
}
