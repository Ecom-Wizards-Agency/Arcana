import { CampaignUnavailable } from './unavailable';
import type { load } from './load';
import { Builder } from './builder';
import { CampaignPage } from './ui';
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  return <CampaignPage title="Create campaigns" subtitle="Three steps, because settings are context rather than a stage. Nothing here needs a hand-typed ID.">
    {data.view === 'ready' ? <><Builder context={data.context} initialStep={data.step} initialRecipe={data.initialRecipe} initialSource={data.initialSource} /></> : <CampaignUnavailable screen="campaigns" data={data} />}
  </CampaignPage>;
}
