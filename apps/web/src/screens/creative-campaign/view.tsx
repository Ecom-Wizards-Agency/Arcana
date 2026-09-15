import { evaluateCreativeTest } from '@wizard-ads/core';
import type { CreativeMetricVerdict, CreativeWorkspace } from '@wizard-ads/shared';
import { LinkButton } from '../../ui/primitives';
import { CreativeThumbnail, DataTable, Chip, EvidenceCard, Missing } from '../creative/presentation';
import { creativeHref, integer, money, percent, ratio } from '../creative/format';
import styles from '../creative/creative.module.css';

export function CreativeCampaignView({ workspace, campaignId, from, to, currencyCode, query }: { workspace: CreativeWorkspace; campaignId: string; from: string; to: string; currencyCode: string; query: string }) {
  const campaign = workspace.campaigns.find((row) => row.campaignId === campaignId);
  if (campaign === undefined) return <EvidenceCard title="Campaign unavailable" tone="missing"><p>This campaign is not in the selected profile’s creative evidence.</p><LinkButton href={`/creative?${query}`}>All creatives</LinkButton></EvidenceCard>;
  const test = evaluateCreativeTest(workspace, campaignId, from);
  const measured = test.rows.filter((row) => row.performance !== null);
  const total = (metric: 'impressions' | 'clicks' | 'purchases' | 'cost' | 'sales') => measured.length === test.rows.length && measured.length > 0 ? measured.reduce((sum, row) => sum + row.performance![metric], 0) : null;
  const verdict = (metric: CreativeMetricVerdict) => metric.separates === null ? `${metric.metric.toUpperCase()} is not yet measured` : `${metric.metric.toUpperCase()} ${metric.separates ? 'separates these creatives' : 'does not separate these creatives'}`;
  return <section aria-label="Creative test"><LinkButton size="sm" href={`/creative?${query}`}>← All creatives</LinkButton>
    <div className={styles.sectionHeader}><h2>Creative test — {campaign.keywordText ?? 'Keyword unresolved'}</h2></div><p className={styles.muted}>{campaign.name ?? campaign.campaignId} · {from} – {to} · {test.structure.adGroupCount} ad groups · matched observational comparison</p>
    <EvidenceCard title={`${test.structure.state} · ${integer(test.structure.keywordCount)} keyword${test.structure.keywordCount === 1 ? '' : 's'} · ${test.structure.adGroupCount} ad groups · ${test.structure.creativeCount} creatives`} tone={test.structure.state === 'clean' ? 'info' : 'warn'}>
      {test.structure.state === 'clean' ? <p>1 creative per ad group. The convention holds, so each row below is one creative and nothing else.</p> : <><p>{test.structure.state === 'unmeasured' ? 'The available evidence cannot establish the testing convention.' : 'The campaign has drifted from the testing convention.'} Every observed row remains visible.</p><ul>{test.structure.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></>}
    </EvidenceCard>
    <DataTable label="Creative comparison" headers={['Creative', 'Ad group', 'Impressions', 'Delivery', 'Clicks', 'CTR', 'Orders', 'CVR', 'Spend', 'Sales', 'ACOS', 'Completion']}
      totals={<tr><td colSpan={2}>{test.rows.length} creative rows</td><td>{integer(total('impressions'))}</td><td>{percent(ratio(total('impressions'), total('impressions')))}</td><td>{integer(total('clicks'))}</td><td>{percent(ratio(total('clicks'), total('impressions')))}</td><td>{integer(total('purchases'))}</td><td>{percent(ratio(total('purchases'), total('clicks')))}</td><td>{money(total('cost'), currencyCode)}</td><td>{money(total('sales'), currencyCode)}</td><td>{percent(ratio(total('cost'), total('sales')))}</td><td>—</td></tr>}>
      {test.rows.map((row, index) => <tr key={`${row.adGroupId}:${row.assetId}:${index}`} data-thin={!row.measured} data-testid="creative-test-row"><td><div className={styles.creativeCell}><CreativeThumbnail url={row.thumbnailUrl} name={row.name ?? row.assetId ?? 'Unmapped creative'} /><div>{row.assetId === null ? 'Unmapped creative' : <a href={creativeHref(row.assetId, query)}>{row.name ?? row.assetId}</a>}<small>{row.assetId ?? 'No Amazon Asset ID'}</small>{row.measured ? null : <Chip>unmeasured</Chip>}</div></div></td><td>{row.adGroupName ?? row.adGroupId}</td><td>{integer(row.performance?.impressions ?? null)}</td><td><span className={styles.delivery}><span className={styles.bar}>{row.deliveryShare === null ? null : <span style={{ width: `${Math.min(100, row.deliveryShare * 100)}%` }} />}</span><span>{percent(row.deliveryShare)}</span></span></td><td>{integer(row.performance?.clicks ?? null)}</td><td data-thin={!row.measured}>{row.measured ? percent(row.performance?.ctr ?? null) : <Missing reason={row.unmeasuredReason ?? 'Insufficient evidence'} />}</td><td>{integer(row.performance?.purchases ?? null)}</td><td data-thin={!row.measured}>{row.measured ? percent(row.performance?.cvr ?? null) : <Missing reason={row.unmeasuredReason ?? 'Insufficient evidence'} />}</td><td>{money(row.performance?.cost ?? null, currencyCode)}</td><td>{money(row.performance?.sales ?? null, currencyCode)}</td><td>{percent(row.performance?.acos ?? null)}</td><td>{percent(ratio(row.performance?.videoCompleteViews ?? null, row.performance?.impressions ?? null))}</td></tr>)}
    </DataTable>
    <EvidenceCard title={test.ctr.floor === null || test.cvr.floor === null ? 'The account’s noise floor is not yet measured' : `${verdict(test.cvr)}. ${verdict(test.ctr)}.`}>
      {[test.cvr, test.ctr].map((metric) => <p key={metric.metric}>{metric.metric.toUpperCase()}: {metric.reason ?? `relative spread ${percent(metric.spread)} against this account’s fortnight noise floor of ${percent(metric.floor)}`}. {metric.observedFortnights} complete historical fortnights; {metric.requiredFortnights} required.</p>)}
      {test.ctr.separates === null || test.cvr.separates === null ? <p>No winner is declared while the evidence is unmeasured.</p> : <p>A spread exceeding the floor distinguishes the observed rates. This observational comparison does not establish a causal winner.</p>}
    </EvidenceCard>
    <p className={styles.footnote}>Delivery share uses observed impressions{test.rows.some((row) => row.performance === null) ? '; some creative rows have no measured delivery' : ''}. Delivery is not equal. This is a matched observational test, not a randomised experiment. Thin rows are unmeasured, not losing. Click evidence comes from this account’s configured evidence policy; the noise floor comes from its own history before this test window.</p>
  </section>;
}

export { default } from '../creative/view';
