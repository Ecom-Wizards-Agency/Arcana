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
type ReadyProps = Extract<ScreenData, { view: 'ready' }>['props'];

/** What the page leads with, in priority order: a switch that stops sync, then missing measurements. */
export type CreativeLead = 'deployment_disabled' | 'profile_sync_disabled' | 'not_measured' | 'measured';
export function creativeLead({ evidence, workspace }: Pick<ReadyProps, 'evidence' | 'workspace'>): CreativeLead {
  if (evidence.reason === 'deployment_disabled') return 'deployment_disabled';
  if (evidence.reason === 'profile_sync_disabled') return 'profile_sync_disabled';
  return evidence.snapshot === null && workspace.assets.every((asset) => asset.performance === null) ? 'not_measured' : 'measured';
}

function LeadState({ lead, profileId, retained }: { lead: Exclude<CreativeLead, 'measured'>; profileId: string; retained: boolean }) {
  const syncStatus = <a href={`/sync-status?profile=${profileId}`}>Sync status →</a>;
  if (lead === 'deployment_disabled') return <section className={styles.empty} data-testid="creative-sync-disabled" data-lead={lead}><h2>Creative sync is switched off for this deployment</h2><p>Reason: deployment_disabled. The deployment flag OPENSPELL_CREATIVE_SYNC_DISABLED=1 stops new creative observations for every profile. Whoever runs this deployment has to remove the flag; nothing on this page turns it back on.{retained ? ' Evidence already collected stays visible below.' : ''}</p>{syncStatus}</section>;
  if (lead === 'profile_sync_disabled') return <section className={styles.empty} data-testid="creative-profile-sync-disabled" data-lead={lead}><h2>Profile sync is switched off</h2><p>Creative sync runs by default for every synced profile, but this profile's sync is off, so no creative observations are scheduled. An owner or admin turns it back on in <a href="/settings/profiles">Settings → Profiles</a>; Sync status shows when the first run is queued.</p>{syncStatus}</section>;
  return <section className={styles.empty} data-testid="creative-not-measured" data-lead={lead}><h2>Not measured yet</h2><p>Creative performance is not measured until the first creative sync completes. Creative sync runs by default for every synced profile, so Arcana queues it on its own; nobody needs to start it.</p>{syncStatus}</section>;
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data.view === 'gated') return <main className={styles.page}><PageHeader title="Creatives" /><p>{gateMessage(data.props.entry.state)}</p></main>;
  if (data.view === 'empty') return <main className={styles.page}><PageHeader title="Creatives" /><EmptyState title="No profiles yet" body="Connect Amazon Ads before loading creative performance." action={<a className="wa-btn" href="/settings/connections">Connect Amazon Ads</a>} /></main>;
  const { profile, period, selectedPresetId, workspace, evidence, mode } = data.props;
  const title = mode === 'eligibility' ? 'Asset eligibility and moderation status' : mode === 'campaign' ? 'Creative test' : 'Creatives';
  const query = new URLSearchParams({ profile: profile.id, from: period.start, to: period.end });
  if (selectedPresetId !== undefined) query.set('preset', selectedPresetId);
  const lead = creativeLead({ evidence, workspace });
  // Before any measurement, the count of creatives says nothing; the state below the title does.
  const subtitle = mode === 'eligibility' ? 'Whether a video can run, and what is stopping it when it cannot.'
    : lead === 'not_measured' ? `Sponsored Brands video creatives · ${formatShellDateRange(period.start, period.end)}`
      : `Creative Performance · ${workspace.assets.filter((asset) => asset.assetId !== null).length} Sponsored Brands video creatives · ${formatShellDateRange(period.start, period.end)} · ad-grain facts from sbAds · current asset mappings do not establish historical attachment`;
  return <main className={styles.page} data-testid="creative-screen" data-profile-id={profile.id} data-profile-label={profile.label} data-lead={lead}>
    <PageHeader title={title} subtitle={subtitle} />
    {/* The state leads; a switched-off producer stops new observations only, so retained evidence stays visible below. */}
    {lead === 'measured' || (lead === 'not_measured' && mode === 'eligibility') ? null : <LeadState lead={lead} profileId={profile.id} retained={workspace.assets.some((asset) => asset.performance !== null)} />}
    <ProviderEvidencePanel evidence={data.props.providerEvidence} consumer="creative" />
    {data.props.coreEvidence ? <CoreReportEvidencePanel evidence={data.props.coreEvidence} title="Reported ad video and new-to-brand measurements" /> : null}
    <ListingEvidencePanel evidence={data.props.listingEvidence} reports={data.props.listingReports} timezone={profile.timezone} />
    {mode === 'eligibility' ? <CreativeEligibilityView workspace={workspace} query={query.toString()} /> : <>
      <details className={styles.disclosure}><summary>Sync evidence</summary><CreativeLifecycleStatusView evidence={evidence} timezone={profile.timezone} profileId={profile.id} /></details>
      {evidence.snapshot === null && workspace.assets.every((asset) => asset.performance === null) ? (lead === 'not_measured' ? null : <section className={styles.empty} data-testid="creative-not-measured"><h2>Creative performance is not measured until the first creative sync completes</h2></section>)
        : mode === 'campaign' ? <CreativeCampaignView workspace={workspace} campaignId={data.props.campaignId ?? ''} from={period.start} to={period.end} currencyCode={profile.currencyCode} query={query.toString()} />
          : <CreativeWorkspaceView workspace={workspace} currencyCode={profile.currencyCode} countryCode={profile.countryCode} query={query.toString()} selectedAssetId={data.props.selectedAssetId} tab={data.props.tab} detailOnly={mode === 'detail'} sbKeywordSyncEnabled={data.props.sbKeywordSyncEnabled} />}
      <StreamEvidencePanel evidence={data.props.streamEvidence} />
    </>}
  </main>;
}
