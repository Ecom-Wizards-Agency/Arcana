'use client';
import { useState } from 'react';
import type { BrandLensBucket, BrandLensDecision, BrandLensOverride, QueryVocabularyEntry, QueryVocabularyKind } from '@wizard-ads/shared';
import { QueryVocabularyEntry as Entry, normalizeResearchQuery } from '@wizard-ads/shared';
import { BRAND_BUCKETS, brandBucketPerformance, classifyBrandKeywords, dominantBrandBucket } from '@wizard-ads/core';
import { ResearchAction, ResearchMenu, researchMoney, researchPercent, researchMutation } from '../query-intelligence/research-ui';
import { formatResearchPeriod } from '../query-intelligence/research-format';
import type { load } from './load';
import '../query-intelligence/research.css';
export type BrandLensData = Awaited<ReturnType<typeof load>>;
const names = {
  branded: 'Branded',
  competitor: 'Competitor',
  generic: 'Generic'
};
export function BrandLens({ data, initialTab = 'setup' }: { data: Extract<BrandLensData, { view: 'ready' }>; initialTab?: 'setup' | 'review' | 'overview' | 'exclusions' }) {
  const [tab, setTab] = useState(initialTab), [vocabulary, setVocabulary] = useState(data.source.vocabulary), [overrides, setOverrides] = useState(data.source.overrides), [campaigns, setCampaigns] = useState(data.source.campaigns), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const rows = classifyBrandKeywords(data.source.keywords, vocabulary, overrides, data.source.profile.marketplaceId), buckets = brandBucketPerformance(rows), money = (n: number | null) => researchMoney(n, data.profile.currencyCode);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      return await researchMutation(path, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The save failed');
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function word(action: 'add' | 'remove' | 'approve', kind: QueryVocabularyKind, value: string, id?: string) {
    const result = await mutate('/api/query-intelligence/vocabulary', action === 'add' ? {
      action,
      profileId: data.profile.id,
      kind,
      value
    } : {
      action,
      profileId: data.profile.id,
      id
    });
    if (result) setVocabulary(Entry.array().parse(result['entries']));
  }
  async function decide(keyword: string, bucket: BrandLensBucket, decision: BrandLensDecision) {
    const result = await mutate('/api/brand-lens/overrides', {
      profileId: data.profile.id,
      keyword,
      bucket,
      decision
    });
    if (result) {
      // Re-read stamped decisions; the UI does not manufacture a reviewer or approval time.
      const response = await fetch(`/api/brand-lens?profileId=${data.profile.id}&from=${data.period.start}&to=${data.period.end}`);
      if (response.ok) {
        const body = await response.json() as { overrides: BrandLensOverride[] };
        setOverrides(body.overrides);
      }
    }
  }
  async function exclude(id: string, excluded: boolean) {
    const result = await mutate('/api/brand-lens/exclusions', {
      profileId: data.profile.id,
      campaignId: id,
      excluded
    });
    if (result) setCampaigns(campaigns.map(c => c.id === id ? {
      ...c,
      excluded
    } : c));
  }
  const branded = buckets[0]!, generic = buckets[2]!, measured = buckets.some(b => b.spend !== null), totalSpend = rows.length&&rows.every(r=>r.spend!==null)?rows.reduce((n,r)=>n+r.spend!,0):null, totalSales = rows.length&&rows.every(r=>r.sales!==null)?rows.reduce((n,r)=>n+r.sales!,0):null;
  return <main className="research"><header><h1>Brand lens</h1><p className="muted">{data.profile.label} · {formatResearchPeriod(data.period)}</p></header><nav className="research-tabs" aria-label="Brand lens sections">{(['setup', 'review', 'overview', 'exclusions'] as const).map(t => <ResearchAction key={t} primary={tab === t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'setup' ? 'Word setup' : t === 'review' ? 'Review classifications' : t === 'overview' ? 'Ad performance by bucket' : 'Campaign exclusions'}</ResearchAction>)}</nav>
    {error ? <p role="alert">{error}</p> : null}
    {tab === 'setup' ? <><h2>Brand lens — setup</h2><p>Classifies your own keywords into branded, competitor and generic. The model proposes tokens; rules do the classifying; you own the boundary.</p>
      <TokenGroup title="Brand tokens" description="Anything containing one of these is branded, including approved misspellings from your search terms." kinds={['own_brand_term', 'own_brand_alias']} entries={vocabulary} busy={busy} onWord={word} />
      <TokenGroup title="Competitor tokens" description="Competitor brand names come out of generic demand." kinds={['competitor_brand']} entries={vocabulary} busy={busy} onWord={word} />
      <TokenGroup title="Core tokens" description="Category language this product can win. On the SQP side it splits generic into core and head; you own that boundary." kinds={['core_term']} entries={vocabulary} busy={busy} onWord={word} />
      <div className="brand-classify-row"><div><strong>{rows.length} keywords will be classified</strong><p className="muted">Classification is rule-based and deterministic. Re-running with the same tokens gives the same answer.</p></div><ResearchAction primary onClick={() => setTab('review')}>Classify keywords</ResearchAction></div></> : null}
    {tab === 'review' ? <><h2>Review classifications</h2><p>{rows.length} keywords · 3 buckets · every row can be overridden, and an override sticks through the next run.</p><div className="research-table-scroll"><table className="research-table"><thead><tr><th>Keyword</th><th>Proposed</th><th>Matched on</th><th>Spend</th><th>ACOS</th><th>Override</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{r.keyword}</td><td><span className={`research-chip ${r.bucket}`}>{names[r.bucket]}</span></td><td className={r.matchedOn === 'no token matched' ? 'muted' : ''}>{r.matchedOn}</td><td>{money(r.spend)}</td><td>{researchPercent(r.acos)}</td><td><div className="research-actions">{r.decision ? <span className={`research-chip ${r.decision}`}>{r.decision}</span> : null}<ResearchMenu label={`change classification for ${r.keyword}`} disabled={busy} options={[
      { label: 'Keep proposed', onSelect: () => void decide(r.keyword, r.proposed, 'kept') },
      { label: `Confirm ${names[r.bucket]}`, onSelect: () => void decide(r.keyword, r.bucket, 'confirmed') },
      ...BRAND_BUCKETS.map(bucket => ({ label: names[bucket], onSelect: () => void decide(r.keyword, bucket, 'changed') })),
      ...(r.decision ? [{ label: 'Remove override', onSelect: () => void mutate('/api/brand-lens/overrides', { action: 'remove', profileId: data.profile.id, keyword: r.keyword }).then(result => {
        if (result) setOverrides(overrides.filter(o => o.normalizedKeyword !== normalizeResearchQuery(r.keyword)));
      }) }] : []),
    ]} /></div></td></tr>)}</tbody></table></div><p className="muted">Core and head both belong to Generic here. Explicit query exclusions and unreviewed tokens remain visible for judgement; classification does not exclude a campaign.</p></> : null}
    {tab === 'overview' ? <><h2>Ad performance by bucket</h2><table className="research-table"><thead><tr><th>Bucket</th><th>Share of spend</th><th>Spend</th><th>Sales</th><th>ACOS</th><th>Clicks</th><th>CPC</th></tr></thead><tbody>{buckets.map(b => <tr key={b.bucket}><td><span className={`research-chip ${b.bucket}`}>{names[b.bucket]}</span></td><td>{researchPercent(b.share)}<div className="research-share"><span style={{ width: `${(b.share ?? 0) * 100}%` }} /></div></td><td>{money(b.spend)}</td><td>{money(b.sales)}</td><td className={b.acos === null || data.profile.targetAcos === null ? undefined : b.acos <= data.profile.targetAcos ? 'research-good-text' : 'research-bad-text'}>{researchPercent(b.acos)}</td><td>{b.clicks ?? '—'}</td><td>{money(b.cpc)}</td></tr>)}</tbody></table>
      <div className="research-card info" data-testid="brand-insight">{measured ? <><strong>{branded.share === null ? 'Brand spend share is not measured in this window.' : `${researchPercent(branded.share)} of ad spend is defending your own brand name${branded.acos !== null ? `, at ${researchPercent(branded.acos)} ACOS` : branded.sales === 0 ? ', with no attributed sales in this window' : ', with attributed sales unavailable in this window'}`}</strong>
      <p>{generic.acos !== null ? `Generic runs at ${researchPercent(generic.acos)} ACOS` : generic.sales === 0 ? 'Generic has no attributed sales in this window' : 'Generic ACOS is not measured in this window'}; {totalSpend !== null && totalSales !== null && totalSales > 0 ? `blended ACOS is ${researchPercent(totalSpend / totalSales)}` : totalSales === 0 ? 'blended ACOS is undefined with no attributed sales' : 'blended ACOS is not measured'}. {buckets[1]!.spend === 0 ? 'Competitor spend is zero. Review whether that matches the agreed strategy.' : buckets[1]!.spend === null ? 'Competitor performance is not measured in this window.' : `Competitor spend is ${money(buckets[1]!.spend)}.`}</p></> : <strong>No keyword performance is measured in this window.</strong>}</div><p className="muted">Branded ROAS cannot tell you whether this spend protected demand or captured sales that would have happened anyway. Answering that needs a holdout, not a bucket.</p></> : null}
    {tab === 'exclusions' ? <><h2>Campaign exclusions</h2><p>Keep chosen campaigns out of optimization so an automatic bid change does not undo the agreed brand strategy.</p><div className="research-card brand-exclusion-note"><strong>Classifying a term does not block it.</strong><p className="muted">Calling a keyword branded only decides which bucket it is reported in. Whether it is bid on, and by whom, is a separate and deliberate choice made here. Keeping the two apart is what lets you say “branded searches belong to the brand campaign” without that sentence quietly changing a bid.</p></div><table className="research-table"><thead><tr><th>Campaign</th><th>Bucket it serves</th><th>Optimization</th><th>Why</th></tr></thead><tbody>{campaigns.map(c => {
      const bucket = dominantBrandBucket(rows, c.id);
      return <tr key={c.id}><td>{c.name}</td><td>{bucket ? names[bucket] : 'Unclassified'}</td><td>{c.groupId ? <button type="button" role="switch" aria-checked={c.excluded} aria-label={`Exclude ${c.name}`} className={`research-chip research-exclusion-switch ${c.excluded ? 'confirmed' : ''}`} disabled={busy} onClick={() => void exclude(c.id, !c.excluded)}>{c.excluded ? 'Excluded' : 'Included'}</button> : <span>Assign to a group first</span>}</td><td>{c.groupId ? `${c.groupRole ?? 'Assigned group'} · ${c.excluded ? 'excluded from new optimization proposals' : 'eligible under group settings'}` : 'No optimization group'}</td></tr>;
    })}</tbody></table></> : null}
  </main>;
}
function TokenGroup({ title, description, kinds, entries, busy, onWord }: { title: string; description: string; kinds: QueryVocabularyKind[]; entries: QueryVocabularyEntry[]; busy: boolean; onWord: (action: 'add' | 'remove' | 'approve', kind: QueryVocabularyKind, value: string, id?: string) => Promise<void> }) {
  const [value, setValue] = useState(''), [kind, setKind] = useState(kinds[0]!), [adding, setAdding] = useState(false);
  const own = entries.filter(e => kinds.includes(e.kind)), proposed = own.filter(e => e.source === 'ai_suggestion');
  const tone = title === 'Brand tokens' ? 'branded' : title === 'Competitor tokens' ? 'competitor' : 'good';
  return <section className="brand-token-section"><div className="brand-token-heading"><h2>{title}</h2><span className="muted">{proposed.length ? `model proposed ${proposed.length} · you kept ${proposed.filter(e => e.approved).length}` : 'No model proposals yet'}</span></div>
    <p className="muted">{description}</p><div className="research-actions">{own.map(e => <span className={`research-chip ${tone}`} key={e.id}>{e.value}{!e.approved ? <button type="button" disabled={busy} onClick={() => void onWord('approve', e.kind, e.value, e.id)}>Approve</button> : null}<button type="button" aria-label={`Remove ${e.value}`} disabled={busy} onClick={() => void onWord('remove', e.kind, e.value, e.id)}>×</button></span>)}
    <button type="button" className="research-add-chip" aria-label={`Add to ${title}`} aria-expanded={adding} disabled={busy} onClick={() => setAdding(!adding)}>+ add</button></div>
    {adding ? <form className="research-actions brand-token-form" onSubmit={event => { event.preventDefault(); if (value.trim()) void onWord('add', kind, value).then(() => { setValue(''); }); }}><label className="research-field">Add to {title}<input autoFocus value={value} onChange={event => setValue(event.target.value)} /></label>
    {kinds.length > 1 ? <label className="research-field">Brand token kind<select value={kind} onChange={event => setKind(event.target.value as QueryVocabularyKind)}><option value="own_brand_term">Brand term</option><option value="own_brand_alias">Misspelling or alias</option></select></label> : null}
    <button type="submit" className="research-action" disabled={busy || !value.trim()}>Add token</button><ResearchAction onClick={() => setAdding(false)}>Cancel</ResearchAction></form> : null}
  </section>;
}
