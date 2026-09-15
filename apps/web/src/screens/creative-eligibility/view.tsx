import type { CreativeWorkspace } from '@wizard-ads/shared';
import { LinkButton } from '../../ui/primitives';
import { CreativeThumbnail, DataTable, EvidenceCard, Missing } from '../creative/presentation';
import { creativeHref } from '../creative/format';
import styles from '../creative/creative.module.css';

export function CreativeEligibilityView({ workspace, query }: { workspace: CreativeWorkspace; query: string }) {
  const assets = workspace.assets.filter((asset) => asset.assetId !== null);
  return <section aria-label="Asset eligibility"><LinkButton href={`/creative?${query}`} size="sm">← All creatives</LinkButton>
    <EvidenceCard title="Not measured" tone="missing"><p>No source supplies asset moderation or eligibility yet. Usage below comes from observed creative placements; moderation, Amazon’s reason and whether an asset can run remain unmeasured.</p></EvidenceCard>
    <DataTable label="Asset eligibility and moderation" headers={['Asset', 'Used in', 'Moderation', 'Reason given by Amazon', 'Can it run']}>
      {assets.map((asset) => <tr key={asset.assetId}><td><div className={styles.creativeCell}><CreativeThumbnail url={asset.thumbnailUrl} name={asset.name ?? asset.assetId!} /><div><a href={creativeHref(asset.assetId!, query)}>{asset.name ?? asset.assetId}</a><small>{asset.assetId}</small></div></div></td><td>{asset.placementCampaignIds.length} campaigns</td><td><Missing reason="Moderation ingestion has no source" /></td><td><Missing reason="Amazon rejection reasons have no source" /></td><td><Missing reason="Eligibility has no source" /></td></tr>)}
    </DataTable>{assets.length === 0 ? <p className={styles.footnote}>No observed assets yet.</p> : null}
    <h3 className={styles.eyebrow}>The states this will carry, once there is a source</h3><div className={styles.legends}><p><strong>Awaiting review</strong>Amazon has not completed review.</p><p><strong>Approved</strong>Amazon has approved the asset.</p><p><strong>Rejected</strong>The reason will be carried verbatim.</p><p><strong>Unknown</strong>Shown as unknown, never as approved.</p></div>
    <p className={styles.footnote}>An asset that cannot run must say so on the screen where you would pick it. The campaign builder follows the same rule.</p>
  </section>;
}

export { default } from '../creative/view';
