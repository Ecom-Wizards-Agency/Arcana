import { CoreReportEvidencePanel } from '../grid/core-report-evidence';
import { ListingEvidencePanel } from '../grid/spapi-evidence';
import { ProviderEvidencePanel } from '../recommendations/provider-evidence';
import { StreamEvidencePanel } from './stream-evidence';
import { formatShellDateRange } from '../../ui/date-format';
import { gateMessage } from '../../ui/gate-message';
import { EmptyState, PageHeader } from '../../ui/primitives';
import { CreativeLifecycleStatusView } from './evidence-view';
import { CreativeWorkspaceView } from './workspace';
import { CreativeCampaignView } from '../creative-campaign/view';
import { CreativeEligibilityView } from '../creative-eligibility/view';
import type { load } from './load';
import styles from './creative.module.css';

export type ScreenData = Awaited<ReturnType<typeof load>>;
export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <main className={styles.page}><PageHeader title="Creatives" /><p>{gateMessage(data.props.entry.state)}</p></main>;
  if (data.view === 'empty') return <main className={styles.page}><PageHeader title="Creatives" /><EmptyState title="No profiles yet" body="Connect Amazon Ads before loading creative performance." action={<a className="wa-btn" href="/settings/connections">Connect Amazon Ads</a>} /></main>;
  const { profile, period, selectedPresetId, workspace, evidence, mode } = data.props;
  const title = mode === 'eligibility' ? 'Asset eligibility and moderation status' : mode === 'campaign' ? 'Creative test' : 'Creatives';
  const query = new URLSearchParams({ profile: profile.id, from: period.start, to: period.end });
  if (selectedPresetId !== undefined) query.set('preset', selectedPresetId);
  return <main className={styles.page} data-testid="creative-screen" data-profile-id={profile.id} data-profile-label={profile.label}>
    <ProviderEvidencePanel evidence={data.props.providerEvidence} consumer="creative" />
    <PageHeader title={title} subtitle={mode === 'eligibility' ? 'Whether a video can run, and what is stopping it when it cannot.' : `Creative Performance · ${workspace.assets.filter((asset) => asset.assetId !== null).length} Sponsored Brands video creatives · ${formatShellDateRange(period.start, period.end)} · ad-grain facts from sbAds · current asset mappings do not establish historical attachment`} />
    {data.props.coreEvidence ? <CoreReportEvidencePanel evidence={data.props.coreEvidence} title="Reported ad video and new-to-brand measurements" /> : null}
    <ListingEvidencePanel evidence={data.props.listingEvidence} reports={data.props.listingReports} timezone={profile.timezone} />
    {mode === 'eligibility' ? <CreativeEligibilityView workspace={workspace} query={query.toString()} /> : <>
      <details className={styles.disclosure}><summary>Sync evidence</summary><CreativeLifecycleStatusView evidence={evidence} timezone={profile.timezone} profileId={profile.id} /></details>
      {!evidence.producerEligible ? <section className={styles.empty} data-testid="creative-pilot-gated"><h2>Creative sync is not active for this profile</h2><p>The hosted creativeSyncPilotFromEnv gate requires the creative pilot, this profile’s allowlist entry, and profile sync to be enabled.</p><a href={`/sync-status?profile=${profile.id}`}>Sync status →</a></section>
        : mode === 'campaign' ? <CreativeCampaignView workspace={workspace} campaignId={data.props.campaignId ?? ''} from={period.start} to={period.end} currencyCode={profile.currencyCode} query={query.toString()} />
          : <CreativeWorkspaceView workspace={workspace} currencyCode={profile.currencyCode} countryCode={profile.countryCode} query={query.toString()} selectedAssetId={data.props.selectedAssetId} tab={data.props.tab} detailOnly={mode === 'detail'} sbKeywordSyncEnabled={data.props.sbKeywordSyncEnabled} />}
      <StreamEvidencePanel evidence={data.props.streamEvidence} />
    </>}
  </main>;
}
