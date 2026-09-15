import type { load } from './load';
import { Builder } from './builder';
import { CampaignPage, Notice } from './ui';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  return <CampaignPage title="Campaign Builder" subtitle="Create campaigns in three steps. Settings stay beside you throughout.">
    {data.view === 'ready' ? <><p className="wa-hint">{data.context.profile.label} · {data.context.profile.countryCode} · {data.context.profile.currencyCode}</p><Builder context={data.context} initialStep={data.step} /></> : <Notice kind={data.view === 'error' ? 'bad' : 'neutral'}>{data.message}</Notice>}
  </CampaignPage>;
}
