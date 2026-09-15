'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Tabs } from '@wizard-ads/ui';
import { aggregateCreativeCampaigns } from '@wizard-ads/core';
import { creativeProductUrl, type CreativeWorkspace, type CreativeWorkspaceAsset, type CreativeAttributionState } from '@wizard-ads/shared';
import { Button, Input, LinkButton, Select } from '../../ui/primitives';
import { ATTRIBUTION_EXPLANATIONS, ATTRIBUTION_LABELS, filterAndSortCreativePerformance, type CreativeSort } from '../../creative/performance';
import { CreativePerformanceExplorer } from './attribution-evidence';
import type { CreativeTab } from './load';
import { creativeHref, creativeCampaignHref, CreativeThumbnail, Chip, EvidenceCard, DataTable, Measure, Missing, integer, money, percent, ratio, dateLabel } from './presentation';
import styles from './creative.module.css';
import { creativeChangeText } from './format';

const key = (asset: CreativeWorkspaceAsset) => asset.assetId ?? `attribution:${asset.attributionState}`;
const label = (asset: CreativeWorkspaceAsset) => asset.name ?? asset.assetId ?? `${ATTRIBUTION_LABELS[asset.attributionState]} performance`;
const tabItems = [{ value: 'overview', label: 'Overview' }, { value: 'keywords', label: 'Keywords' }, { value: 'spend', label: 'Spend' }, { value: 'placements', label: 'Placements' }, { value: 'change-history', label: 'Change history' }];
const states: CreativeAttributionState[] = ['mapped', 'legacy', 'unsupported', 'ambiguous', 'unmapped'];

export interface WorkspaceProps {
  workspace: CreativeWorkspace; currencyCode: string; countryCode: string; query: string;
  selectedAssetId: string | null; tab: CreativeTab; detailOnly?: boolean; sbKeywordSyncEnabled: boolean;
}

export function CreativeWorkspaceView(props: WorkspaceProps) {
  const { workspace, currencyCode, query, detailOnly = false } = props;
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [campaignType, setCampaignType] = useState('all');
  const [attributionState, setAttributionState] = useState<CreativeAttributionState | 'all'>('all');
  const [sort, setSort] = useState<CreativeSort>('spend_desc');
  const [localSelection, setLocalSelection] = useState<string | null>(null);
  useEffect(() => { setLocalSelection(null); }, [props.selectedAssetId]);
  const measured = filterAndSortCreativePerformance(workspace.assets.flatMap((asset) => asset.performance === null ? [] : [asset.performance]), { query: search, campaignType, attributionState, sort });
  const order = new Map(measured.map((asset, index) => [asset.assetId ?? `attribution:${asset.attributionState}`, index]));
  const visible = workspace.assets.filter((asset) => asset.performance !== null ? order.has(key(asset)) :
    (campaignType === 'all' || campaignType === 'SB') && (attributionState === 'all' || asset.attributionState === attributionState)
    && `${label(asset)} ${asset.assetId ?? ''}`.toLowerCase().includes(search.toLowerCase().trim()))
    .sort((a, b) => (order.get(key(a)) ?? Infinity) - (order.get(key(b)) ?? Infinity) || label(a).localeCompare(label(b)));
  const selectedKey = localSelection ?? props.selectedAssetId;
  const selected = selectedKey === null ? visible[0] : workspace.assets.find((asset) => key(asset) === selectedKey);
  const select = (asset: CreativeWorkspaceAsset) => {
    setLocalSelection(key(asset));
    const params = new URLSearchParams(query); params.set('asset', key(asset));
    router.replace(`/creative?${params}`, { scroll: false });
  };
  const reset = () => { setSearch(''); setCampaignType('all'); setAttributionState('all'); setSort('spend_desc'); };
  if (!workspace.assets.length) return <section className={styles.empty} data-testid="creative-not-measured"><h2>Creative performance is not measured</h2><p>The pilot is enabled, but no assets or attributable facts are available for this window.</p><a href={`/sync-status?profile=${new URLSearchParams(query).get('profile') ?? ''}`}>Sync status →</a></section>;
  return <section aria-label="Creative workspace" className={detailOnly ? styles.detail : styles.split}>
    {detailOnly ? <LinkButton href={`/creative?${query}`} size="sm">← All creatives</LinkButton> : <aside className={styles.pane} aria-label="Creative list">
      <div className={styles.paneHeader}><div className={styles.paneTitle}><strong className={styles.eyebrow}>Creative</strong><a href={`/creative/eligibility?${query}`}>Asset eligibility →</a></div>
        <Input aria-label="Find creative" type="search" placeholder="Name or Amazon Asset ID" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
        <div className={styles.filters}>
          <label>Campaign type<Select value={campaignType} onChange={(event) => setCampaignType(event.currentTarget.value)}><option value="all">All campaign types</option>{[...new Set(workspace.assets.flatMap((asset) => asset.performance?.campaignTypes ?? ['SB']))].map((type) => <option key={type} value={type}>{type === 'SB' ? 'Sponsored Brands' : type}</option>)}</Select></label>
          <label>Attribution<Select value={attributionState} onChange={(event) => setAttributionState(event.currentTarget.value as CreativeAttributionState | 'all')}><option value="all">All states</option>{states.map((state) => <option key={state} value={state}>{ATTRIBUTION_LABELS[state]}</option>)}</Select></label>
          <label>Sort by<Select value={sort} onChange={(event) => setSort(event.currentTarget.value as CreativeSort)}><option value="spend_desc">Spend · high to low</option><option value="sales_desc">Ad sales · high to low</option><option value="impressions_desc">Impressions · high to low</option><option value="ctr_desc">CTR · high to low</option><option value="video_completes_desc">Video completes · high to low</option><option value="creative_asc">Creative · A to Z</option><option value="campaign_type_asc">Campaign type · A to Z</option></Select></label>
          <Button size="sm" onClick={reset}>Clear filters</Button>
        </div><span className={styles.muted} aria-live="polite">{visible.length} of {workspace.assets.length} creative rows</span>
      </div>
      {visible.map((asset) => <button key={key(asset)} type="button" className={styles.row} aria-pressed={selected !== undefined && key(selected) === key(asset)} onClick={() => select(asset)} data-testid="creative-list-row">
        <CreativeThumbnail url={asset.thumbnailUrl} name={label(asset)} /><span className={styles.rowCopy}><span>{label(asset)}{asset.durationSeconds === null ? '' : ` · ${asset.durationSeconds}s`}</span><small title={asset.assetId ?? 'No Amazon Asset ID'}>{asset.assetId?.slice(0, 24) ?? 'No Amazon Asset ID'}</small><small>ACOS {percent(asset.performance?.acos ?? null)} · CTR {percent(asset.performance?.ctr ?? null)} · {new Set(workspace.campaigns.filter((campaign) => asset.campaignIds.includes(campaign.campaignId)).flatMap((campaign) => campaign.keywordText === null ? [] : [campaign.keywordText])).size} keywords</small></span><strong className={styles.amount}>{money(asset.performance?.cost ?? null, currencyCode)}</strong>
      </button>)}
      {!visible.length ? <p className={styles.footnote}>No creative rows match these filters.</p> : null}
      <details className={styles.disclosure}><summary>Attribution key</summary>{states.map((state) => <p key={state}><strong>{ATTRIBUTION_LABELS[state]}: </strong>{ATTRIBUTION_EXPLANATIONS[state]}</p>)}</details>
    </aside>}
    {selected === undefined ? <section className={styles.empty}><h2>{selectedKey === null ? 'Select a creative' : 'Asset unavailable'}</h2><p>{selectedKey === null ? 'Clear the filters to see the available creatives.' : 'This asset is not present in the selected profile and reporting window.'}</p></section>
      : <CreativeDetail {...props} asset={selected} />}
  </section>;
}

export function CreativeDetail({ workspace, asset, currencyCode, countryCode, query, tab, sbKeywordSyncEnabled }: WorkspaceProps & { asset: CreativeWorkspaceAsset }) {
  const router = useRouter();
  const campaigns = workspace.campaigns.filter((campaign) => asset.campaignIds.includes(campaign.campaignId));
  const [campaignChoice, setCampaignChoice] = useState<string>('');
  const compareId = campaigns.length === 1 ? campaigns[0]!.campaignId : campaigns.some((campaign) => campaign.campaignId === campaignChoice) ? campaignChoice : '';
  const amazonUrl = creativeProductUrl(countryCode, asset.advertisedAsin);
  const setTab = (next: string) => {
    if (asset.assetId === null) return;
    const params = new URLSearchParams(query); params.set('tab', next);
    router.push(creativeHref(asset.assetId, params.toString()), { scroll: false });
  };
  const content = tab === 'overview' || asset.assetId === null ? <CreativeOverview asset={asset} currencyCode={currencyCode} targetAcos={workspace.targetAcos} />
    : tab === 'keywords' || tab === 'spend' ? <CreativeCampaignTable workspace={workspace} asset={asset} currencyCode={currencyCode} query={query} tab={tab} sbKeywordSyncEnabled={sbKeywordSyncEnabled} />
      : tab === 'placements' ? <CreativePlacements workspace={workspace} asset={asset} currencyCode={currencyCode} /> : <CreativeHistory workspace={workspace} asset={asset} currencyCode={currencyCode} />;
  return <article className={styles.detail} aria-label="Selected creative">
    <header className={styles.detailHeader}><CreativeThumbnail url={asset.thumbnailUrl} name={label(asset)} large /><div><h2>{label(asset)}{asset.durationSeconds === null ? '' : ` · ${asset.durationSeconds}s`}</h2><p className={styles.muted}>{asset.assetId ?? 'No Amazon Asset ID'} · {asset.assetType?.toUpperCase() ?? 'Type not measured'} · {asset.width !== null && asset.height !== null ? `${asset.width}×${asset.height}` : 'Dimensions not measured'} · observed in {asset.campaignIds.length} campaigns · first seen {dateLabel(asset.firstSeenAt)}</p>
      <div className={styles.actions}><span className={styles.disabledAction}><Button variant="primary" size="sm" disabled title="Destination not decided">Open in-depth ↗</Button><small>Destination not decided</small></span>
        {campaigns.length > 1 ? <label className={styles.disabledAction}><span className={styles.muted}>Campaign to compare</span><Select aria-label="Campaign to compare" value={campaignChoice} onChange={(event) => setCampaignChoice(event.currentTarget.value)}><option value="">Choose campaign</option>{campaigns.map((campaign) => <option key={campaign.campaignId} value={campaign.campaignId}>{campaign.name ?? campaign.campaignId}</option>)}</Select></label> : null}
        {compareId ? <LinkButton size="sm" href={creativeCampaignHref(compareId, query)}>Compare creatives</LinkButton> : <Button size="sm" disabled title="Choose an observed campaign">Compare creatives</Button>}
        {amazonUrl === null ? <span className={styles.disabledAction}><Button size="sm" disabled title="No ASIN on this asset">View on Amazon</Button><small>No ASIN on this asset</small></span> : <LinkButton size="sm" href={amazonUrl} target="_blank" rel="noopener noreferrer">View on Amazon</LinkButton>}
      </div></div></header>
    {asset.assetId === null ? <><EvidenceCard title="Attribution is unresolved" tone="warn"><p>{ATTRIBUTION_EXPLANATIONS[asset.attributionState]}</p></EvidenceCard>{content}</> : <Tabs ariaLabel="Creative detail tabs" items={tabItems.map((item) => ({ ...item, panel: item.value === tab ? content : null }))} value={tab} onValueChange={setTab} />}
    {asset.performance === null ? null : <details className={styles.disclosure}><summary>Drill down · ad-level attribution evidence</summary><CreativePerformanceExplorer rows={[asset.performance]} currencyCode={currencyCode} /></details>}
  </article>;
}

export function CreativeOverview({ asset, currencyCode, targetAcos }: { asset: CreativeWorkspaceAsset; currencyCode: string; targetAcos: number | null }) {
  const p = asset.performance;
  const funnel = [['First quartile', p?.videoFirstQuartileViews ?? null], ['Midpoint', p?.videoMidpointViews ?? null], ['Third quartile', p?.videoThirdQuartileViews ?? null], ['Complete', p?.videoCompleteViews ?? null]] as const;
  return <section aria-label="Creative overview">
    {p === null ? <EvidenceCard title="Not measured" tone="missing"><p>This asset has no attributable ad-grain facts in the selected window.</p></EvidenceCard> : null}
    <dl className={styles.metrics}>
      <Measure label="Impressions" value={integer(p?.impressions ?? null)}>Viewable: <Missing reason="Viewable impressions are not available at this creative grain" /></Measure>
      <Measure label="Clicks" value={integer(p?.clicks ?? null)}>CTR {percent(p?.ctr ?? null)}</Measure>
      <Measure label="Spend" value={money(p?.cost ?? null, currencyCode)}>CPC {money(ratio(p?.cost ?? null, p?.clicks ?? null), currencyCode)}</Measure>
      <Measure label="Sales" value={money(p?.sales ?? null, currencyCode)}>Orders {integer(p?.purchases ?? null)}</Measure>
      <Measure label="ACOS" value={percent(p?.acos ?? null)}>Target {percent(targetAcos)}</Measure>
      <Measure label="CVR" value={percent(ratio(p?.purchases ?? null, p?.clicks ?? null))}>Orders / clicks</Measure>
    </dl>
    <h3 className={styles.eyebrow}>Video completion</h3>
    <div className={styles.funnel}>{funnel.map(([name, value]) => <div key={name} className={styles.funnelRow}><span>{name}</span><span className={styles.bar}>{value === null || p === null || p.impressions <= 0 ? null : <span style={{ width: `${Math.min(100, value / p.impressions * 100)}%` }} />}</span><span>{value === null ? <Missing reason={`${name} was not reported for every source row`} /> : integer(value)}</span><strong>{percent(ratio(value, p?.impressions ?? null))}</strong></div>)}</div>
    {funnel.every(([, value]) => value === null) ? <p className={styles.muted}>Completion quartiles are not measured.</p> : null}
    <p className={styles.footnote}>Percentages are of impressions, not of the previous quartile. Completion is a creative diagnostic — it is not interchangeable with sales, and a video that completes well can still lose on contribution.</p>
  </section>;
}

function KeywordChip({ provenance }: { provenance: 'synced' | 'from_campaign_name' | 'unresolved' }) {
  return <Chip tone={provenance === 'synced' ? 'good' : provenance === 'from_campaign_name' ? 'warn' : 'bad'}>{provenance === 'from_campaign_name' ? 'from campaign name' : provenance}</Chip>;
}

export function CreativeCampaignTable({ workspace, asset, currencyCode, query, tab, sbKeywordSyncEnabled }: Pick<WorkspaceProps, 'workspace' | 'currencyCode' | 'query' | 'sbKeywordSyncEnabled'> & { asset: CreativeWorkspaceAsset; tab: 'keywords' | 'spend' }) {
  const aggregated = aggregateCreativeCampaigns(asset.performance);
  const rows = workspace.campaigns.filter((campaign) => asset.campaignIds.includes(campaign.campaignId)).map((campaign) => ({ ...campaign, metrics: aggregated.find((item) => item.campaignId === campaign.campaignId) ?? null }));
  const resolved = new Set(rows.flatMap((row) => row.keywordText === null ? [] : [row.keywordText])).size;
  const p = asset.performance;
  return <section><div className={styles.sectionHeader}><h2>{tab === 'keywords' ? `${label(asset)}, by keyword` : `Where this video's ${money(p?.cost ?? null, currencyCode)} went`}</h2></div><p className={styles.muted}>One row per campaign · ad-grain facts · scrolls sideways</p>
    {tab === 'keywords' ? <EvidenceCard title="This is exact, not inferred"><p>The creative-testing convention is one campaign per keyword, with each ad group holding a different creative on that keyword. Synced keyword entities establish the keyword; parsed campaign names carry their own label. Unresolved campaigns stay in the table.</p></EvidenceCard> : null}
    <DataTable label={tab === 'keywords' ? 'Creative by keyword' : 'Creative spend by campaign'} headers={tab === 'keywords' ? ['Campaign', 'Keyword', 'Keyword source', 'Impressions', 'Clicks', 'CTR', 'Spend', 'Sales', 'ACOS', 'Orders', 'CVR', 'CPC'] : ['Campaign', 'Keyword', 'Spend', 'Share', 'CPC', 'Sales', 'ACOS', 'Orders']}
      totals={<tr><td colSpan={2}>{rows.length} campaigns · {resolved} keywords resolved</td>{tab === 'keywords' ? <><td /><td>{integer(p?.impressions ?? null)}</td><td>{integer(p?.clicks ?? null)}</td><td>{percent(p?.ctr ?? null)}</td><td>{money(p?.cost ?? null, currencyCode)}</td><td>{money(p?.sales ?? null, currencyCode)}</td><td>{percent(p?.acos ?? null)}</td><td>{integer(p?.purchases ?? null)}</td><td>{percent(ratio(p?.purchases ?? null, p?.clicks ?? null))}</td><td>{money(ratio(p?.cost ?? null, p?.clicks ?? null), currencyCode)}</td></> : <><td>{money(p?.cost ?? null, currencyCode)}</td><td>{percent(ratio(p?.cost ?? null, p?.cost ?? null))}</td><td>{money(ratio(p?.cost ?? null, p?.clicks ?? null), currencyCode)}</td><td>{money(p?.sales ?? null, currencyCode)}</td><td>{percent(p?.acos ?? null)}</td><td>{integer(p?.purchases ?? null)}</td></>}</tr>}>
      {rows.map((row) => <tr key={row.campaignId}><td><a href={creativeCampaignHref(row.campaignId, query)}>{row.name ?? row.campaignId}</a></td><td>{row.keywordText ?? <Missing reason="The campaign keyword is unresolved; no keyword was guessed" />}</td>{tab === 'keywords' ? <><td><KeywordChip provenance={row.keywordProvenance} /></td><td>{integer(row.metrics?.impressions ?? null)}</td><td>{integer(row.metrics?.clicks ?? null)}</td><td>{percent(row.metrics?.ctr ?? null)}</td><td>{money(row.metrics?.cost ?? null, currencyCode)}</td><td>{money(row.metrics?.sales ?? null, currencyCode)}</td><td>{percent(row.metrics?.acos ?? null)}</td><td>{integer(row.metrics?.purchases ?? null)}</td><td>{percent(row.metrics?.cvr ?? null)}</td><td>{money(row.metrics?.cpc ?? null, currencyCode)}</td></> : <><td>{money(row.metrics?.cost ?? null, currencyCode)}</td><td>{percent(row.metrics?.share ?? null)}</td><td>{money(row.metrics?.cpc ?? null, currencyCode)}</td><td>{money(row.metrics?.sales ?? null, currencyCode)}</td><td>{percent(row.metrics?.acos ?? null)}</td><td>{integer(row.metrics?.purchases ?? null)}</td></>}</tr>)}
    </DataTable>
    {tab === 'keywords' ? <><div className={styles.legends}><p><KeywordChip provenance="synced" />Read from the Sponsored Brands keyword entity itself.</p><p><KeywordChip provenance="from_campaign_name" />Parsed by the Reverse Builder using the organisation’s naming preset. A rename can break this association.</p><p><KeywordChip provenance="unresolved" />The name did not parse or the campaign holds more than one keyword. The keyword stays blank.</p></div>{sbKeywordSyncEnabled ? null : <EvidenceCard title="Needs ingestion — Sponsored Brands keyword entities" tone="warn"><p>Sponsored Brands keyword entity sync is off for this profile. Parsed names remain labelled until synchronized entities are available.</p></EvidenceCard>}</> : <p className={styles.footnote}>Share is of this creative’s spend, not the account. CPC is realised cost per click and contains the placement multiplier.</p>}
  </section>;
}

const placementLabel = (placement: string) => placement === 'top_of_search' ? 'Top of search' : placement === 'rest_of_search' ? 'Rest of search' : placement === 'product_pages' ? 'Product pages' : placement;
export function CreativePlacements({ workspace, asset, currencyCode }: { workspace: CreativeWorkspace; asset: CreativeWorkspaceAsset; currencyCode: string }) {
  const rows = workspace.placements.filter((row) => asset.campaignIds.includes(row.campaignId));
  const sum = (field: 'impressions' | 'clicks' | 'cost' | 'sales') => rows.length ? rows.reduce((total, row) => total + row[field], 0) : null;
  return <section><EvidenceCard title="This split is the campaign’s, not this video’s" tone="warn"><p>Amazon reports placements at campaign grain. These totals cover each campaign that carries this asset, including its other creatives. They cannot be assigned to this video.</p></EvidenceCard>
    {!rows.length ? <EvidenceCard title="Placement facts are not measured" tone="missing"><p>No campaign placement facts are available in this reporting window.</p></EvidenceCard> : <DataTable label="Campaign placement facts" headers={['Campaign', 'Placement', 'Impressions', 'Clicks', 'CTR', 'CPC', 'Spend', 'Sales', 'ACOS', 'Modifier']} totals={<tr><td colSpan={2}>Campaign totals</td><td>{integer(sum('impressions'))}</td><td>{integer(sum('clicks'))}</td><td>{percent(ratio(sum('clicks'), sum('impressions')))}</td><td>{money(ratio(sum('cost'), sum('clicks')), currencyCode)}</td><td>{money(sum('cost'), currencyCode)}</td><td>{money(sum('sales'), currencyCode)}</td><td>{percent(ratio(sum('cost'), sum('sales')))}</td><td>—</td></tr>}>
      {rows.map((row) => <tr key={`${row.campaignId}:${row.placement}`}><td>{workspace.campaigns.find((campaign) => campaign.campaignId === row.campaignId)?.name ?? row.campaignId}</td><td>{placementLabel(row.placement)}</td><td>{integer(row.impressions)}</td><td>{integer(row.clicks)}</td><td>{percent(ratio(row.clicks, row.impressions))}</td><td>{money(ratio(row.cost, row.clicks), currencyCode)}</td><td>{money(row.cost, currencyCode)}</td><td>{money(row.sales, currencyCode)}</td><td>{percent(ratio(row.cost, row.sales))}</td><td>{row.modifier === null ? <Missing reason="Campaign placement modifier not synchronized" /> : `${row.modifier}%`}</td></tr>)}
    </DataTable>}
    <p className={styles.footnote}>The modifier is a setting read from the campaign. It is not a realised price. Low top-of-search delivery beside a high multiplier can indicate that the base bid is too low; this split alone does not establish that cause.</p>
  </section>;
}

export function CreativeHistory({ workspace, asset, currencyCode }: { workspace: CreativeWorkspace; asset: CreativeWorkspaceAsset; currencyCode: string }) {
  const rows = workspace.changes.filter((change) => asset.assetId !== null && change.assetIds.includes(asset.assetId));
  return <section><div className={styles.sectionHeader}><h2>Everything that could have moved this creative’s numbers</h2></div><p className={styles.muted}>Selected window · ordered newest first · recorded observation certainty</p>
    {!rows.length ? <EvidenceCard title="No recorded changes in this window" tone="missing"><p>No scoped bid, placement or creative first-seen observations are held for this selection.</p></EvidenceCard> : <DataTable label="Creative change history" headers={['When', 'Certainty', 'What', 'Change', 'Scope', 'Effect on this creative']}>
      {rows.map((row) => <tr key={row.id}><td>{dateLabel(row.observedAt)}</td><td><Chip tone={row.certainty.kind === 'exact' ? 'good' : row.certainty.kind === 'window' ? 'warn' : 'muted'}>{row.certainty.kind}{row.certainty.kind === 'window' ? row.certainty.widthDays === null ? ' · width unknown' : ` · ${row.certainty.widthDays} days` : ''}</Chip></td><td><Chip>{row.kind}</Chip></td><td className={styles.wrap}>{creativeChangeText(row, currencyCode)}</td><td>{row.scope}</td><td>{row.effect}</td></tr>)}
    </DataTable>}
    <EvidenceCard title="A gap is not a change date" tone="missing"><p>Exact: consecutive observations bracket the change. Window: observations are missing on either side; the label carries the gap width. First: the earliest observation held.</p><p>The judgement is made once when the change is recorded and stored, never recomputed on read.</p></EvidenceCard>
    <p className={styles.footnote}>Effects describe the scope of the change. No spend or sales effect is inferred.</p><EvidenceCard title="Needs ingestion: listing snapshots" tone="warn"><p>Listing and promotion changes have no source on this screen yet.</p></EvidenceCard>
  </section>;
}
