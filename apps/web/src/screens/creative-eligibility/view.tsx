import type { CreativeWorkspace } from '@wizard-ads/shared';
import { LinkButton } from '../../ui/primitives';
import { CreativeThumbnail, DataTable, EvidenceCard, Missing } from '../creative/presentation';
import { creativeHref } from '../creative/format';
import styles from '../creative/creative.module.css';

export function CreativeEligibilityView({ workspace, query }: { workspace: CreativeWorkspace; query: string }) {
  const assets = workspace.assets.filter((asset) => asset.assetId !== null);
  const measured = assets.filter((asset) => asset.eligibility?.some((row) => row.evidenceState === 'measured')).length;
  return <section aria-label="Asset eligibility"><LinkButton href={`/creative?${query}`} size="sm">← All creatives</LinkButton>
    <EvidenceCard title={measured ? 'Stored moderation evidence' : 'Not measured'} tone={measured ? 'info' : 'missing'}>
      <p>{measured} of {assets.length} assets have measured moderation in a named program and marketplace. Unknown, stale and pending evidence cannot make an asset selectable.</p>
    </EvidenceCard>
    <DataTable label="Asset eligibility and moderation" headers={['Asset', 'Used in', 'Moderation', 'Reason given by Amazon', 'Can it run']}>
      {assets.map((asset) => <tr key={asset.assetId}><td><div className={styles.creativeCell}><CreativeThumbnail url={asset.thumbnailUrl} name={asset.name ?? asset.assetId!} /><div><a href={creativeHref(asset.assetId!, query)}>{asset.name ?? asset.assetId}</a><small>{asset.assetId}</small></div></div></td>
        <td>{asset.placementCampaignIds.length} campaigns</td>
        <td>{asset.eligibility?.length ? asset.eligibility.map((row, index) => <p key={index}>{row.status}<small>{row.context.program} · {row.context.marketplace} · {row.identity.version} · {row.evidenceState}</small></p>) : <Missing reason="Moderation ingestion has no source" />}</td>
        <td>{asset.eligibility?.length ? asset.eligibility.map((row, index) => <p key={index}>{row.reasons.length ? row.reasons.join(' ') : 'No reason supplied.'}</p>) : <Missing reason="Amazon rejection reasons have no source" />}</td>
        <td>{asset.eligibility?.length ? asset.eligibility.map((row, index) => <p key={index}>{row.selectable ? 'Eligible in this context' : row.canRun === 'ineligible' ? 'Not eligible' : 'Not established'}<small>{row.observedAt ? `Observed ${row.observedAt}` : 'No observation'}</small></p>) : <Missing reason="Eligibility has no source" />}</td>
      </tr>)}
    </DataTable>{assets.length === 0 ? <p className={styles.footnote}>No observed assets yet.</p> : null}
    <h3 className={styles.eyebrow}>Moderation states</h3><div className={styles.legends}><p><strong>Awaiting review</strong>Amazon has not completed review.</p><p><strong>Approved</strong>Approval applies to the named program, marketplace and version.</p><p><strong>Rejected</strong>Safe provider reason text appears above.</p><p><strong>Unknown</strong>Missing or conflicting evidence remains unavailable for selection.</p></div>
    <p className={styles.footnote}>Processing and pre-moderation checks do not establish final permission to serve.</p>
  </section>;
}

export { default } from '../creative/view';
