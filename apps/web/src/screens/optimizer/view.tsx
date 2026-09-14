import { gateMessage } from "../../ui/gate-message";
import { oneTimePreviewUnavailableMessage } from "../../optimizer/readiness";
import { todayIsoInTimeZone } from "../../../app/_lib/periods";
import { OptimizerFrame, OptimizerUnavailable } from "./frame";
import { ChooseCampaigns } from "./choose";
import type { load } from "./load";
export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === "gated") return <OptimizerUnavailable message={gateMessage(data.props.entry.state)} />;
  if (data.view === "empty") return <OptimizerUnavailable message="No profiles yet. Connect Amazon Ads to choose campaigns." />;
  const { profile, campaignRows, period, previewReadiness, mayRunOptimizer, params } = data.props;
  return <OptimizerFrame title="Optimize Now" subtitle={`${profile.label} · ${profile.countryCode} · ${profile.currencyCode}`} step={1}>
    <ChooseCampaigns rows={campaignRows} profileId={profile.id} currencyCode={profile.currencyCode} period={period} today={todayIsoInTimeZone(profile.timezone)} mayRun={mayRunOptimizer} readiness={{ ready: previewReadiness.ready, ...(previewReadiness.ready ? {} : { message: oneTimePreviewUnavailableMessage(previewReadiness.reason) }) }} methods={data.props.savedMethods} initialBatchId={params.batch} />
    {data.props.run === null ? <p>No recommendation preview has run yet.</p> : null}
  </OptimizerFrame>;
}
