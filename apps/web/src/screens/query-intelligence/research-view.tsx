'use client';
import { useState } from 'react';
import type { QueryCategory, QueryVocabularyEntry, SqpWeeklyFact } from '@wizard-ads/shared';
import { classifyQuery, researchCategoryCounts, researchDemandGroups, researchQueryRows } from '@wizard-ads/core';
import { EmptyState } from '@wizard-ads/ui';
import { ResearchAction, researchPercent } from './research-ui';
import { VocabularyEditor } from './vocabulary';
import './research.css';
const reason = 'Search Query Performance is not connected for this profile';
const labels: Record<QueryCategory, string> = {
  own_brand: 'Own brand',
  core: 'Core',
  head: 'Head',
  competitor: 'Competitor',
  excluded: 'Excluded',
  unreviewed: 'Unreviewed'
};
const chip = (category: QueryCategory) => category === 'own_brand' ? 'branded' : category === 'competitor' ? 'competitor' : 'generic';
export function QueryResearch({ profileId, marketplaceId, facts, ppc, vocabulary: initial, initialCategory=null, initialSearch='', initialMetric='searches' }: { profileId: string; marketplaceId: string; facts: SqpWeeklyFact[]; ppc: { searchTerm: string }[]; vocabulary: QueryVocabularyEntry[]; initialCategory?:QueryCategory|null; initialSearch?:string; initialMetric?:'searches'|'impressions' }) {
  const [metric, setMetric] = useState<'searches' | 'impressions'>(initialMetric), [category, setCategory] = useState<QueryCategory | null>(initialCategory), [sort, setSort] = useState<'ctrGap' | 'cvrGap' | 'searchVolume'>('searchVolume'), [ascending, setAscending] = useState(false), [vocabulary, setVocabulary] = useState(initial);
  const groups = researchDemandGroups(facts), counts = researchCategoryCounts(facts, ppc, vocabulary, marketplaceId), rows = researchQueryRows(facts), measured = facts.length > 0;
  const filtered = rows.filter(r => (category === null || r.category === category) && r.searchQuery.toLowerCase().includes(initialSearch.toLowerCase())).sort((a, b) => {
    const av = a[sort], bv = b[sort];
    return av === null ? 1 : bv === null ? -1 : (ascending ? av - bv : bv - av);
  });
  const core = groups.find(g => g.category === 'core')!, total = rows.reduce((n, row) => n + row.searchVolume, 0);
  const maxSearch = Math.max(1, ...groups.map(g => g.searches)), maxPurchases = Math.max(1, ...groups.map(g => g.marketPurchases), ...groups.map(g => g.purchases));
  function changeSort(next: typeof sort) {
    if (sort === next) setAscending(!ascending); else {
      setSort(next);
      setAscending(false);
    }
  }
  const missing = () => <EmptyState variant="not-measured" title="Not measured" body={reason} />;
  const ppcTerms = [...new Set(ppc.map(p => p.searchTerm))].map(searchQuery => ({
    searchQuery,
    category: classifyQuery({
      searchQuery,
      vocabulary,
      marketplaceId
    }).category
  })).filter(r => (category === null || r.category === category) && r.searchQuery.toLowerCase().includes(initialSearch.toLowerCase()));
  return <div className="research"><p className="muted">SQP impression share measures product presence in search results. Amazon counts each ASIN shown, so it is not share of voice.</p>
    <div className="research-actions"><ResearchAction aria-pressed={metric === 'searches'} onClick={() => setMetric('searches')}>Searches</ResearchAction><ResearchAction aria-pressed={metric === 'impressions'} onClick={() => setMetric('impressions')}>Your impression share</ResearchAction></div>
    <div className="research-charts"><section className="research-card" aria-label="Demand split"><h2>{measured ? `Winnable category demand is ${core.searches.toLocaleString()} searches a week${total ? ` · ${researchPercent(core.searches / total)} of everything searched` : ''}` : 'Winnable category demand'}</h2>
      {measured ? <div className="research-chart-bars">{groups.map(g => <div className="research-chart-group" data-chart-category={g.category} key={g.category}><div className="research-bar-pair"><div className={`research-bar ${g.category === 'core' ? 'accent' : ''}`} style={{ height: `${(metric === 'searches' ? g.searches / maxSearch : g.impressionShare ?? 0) * 100}%` }}><span className="research-bar-label">{metric === 'searches' ? g.searches.toLocaleString() : researchPercent(g.impressionShare)}</span></div></div><strong>{g.label}</strong><span>({g.caption})</span>{g.example ? <span className="muted">e.g. “{g.example}”</span> : null}</div>)}</div> : missing()}
      <p className="muted">Counts show where demand is. Capture rates across intents are not comparable.</p></section>
      <section className="research-card" aria-label="You versus the market"><h2>{measured ? `On winnable category demand the market buys ${core.marketPurchases.toLocaleString()} a week. You sell ${core.purchases.toLocaleString()}.` : 'You versus the market'}</h2>
        {measured ? <div className="research-chart-bars">{groups.map(g => <div className="research-chart-group" key={g.category} data-purchase-category={g.category}><div className="research-bar-pair"><div className="research-bar" aria-label={`Market purchases ${g.marketPurchases}`} style={{ height: `${g.marketPurchases / maxPurchases * 100}%` }}><span className="research-bar-label">{g.marketPurchases.toLocaleString()}</span></div><div className="research-bar accent" aria-label={`Your purchases ${g.purchases}`} style={{ height: `${g.purchases / maxPurchases * 100}%` }}><span className="research-bar-label">{g.purchases.toLocaleString()}<br />{researchPercent(g.purchaseShare)}</span></div></div><strong>{g.label}</strong><span>({g.caption})</span></div>)}</div> : missing()}<p className="muted">Market and your purchases use the same measure. Your share is annotated on your bar, never a bar of its own.</p></section></div>
    <div role="status" className={`research-card ${measured ? 'info' : 'warn'}`}>{measured ? `${facts.length} Search Query Performance rows in the selected weekly report. Market counts are counted once per query.` : reason}</div>
    <div className="research-actions" aria-label="Query categories">{counts.map(c => <button type="button" key={c.category} className={`research-chip ${chip(c.category)} ${category === c.category ? 'selected' : ''}`} aria-pressed={category === c.category} onClick={() => setCategory(category === c.category ? null : c.category)}>{labels[c.category]} {c.count}</button>)}</div>
    <p className="muted">The six categories preserve the distinction between core and head demand. There is no branded-versus-generic toggle.</p>
    <div className="research-table-scroll"><table className="research-table query-performance" aria-label="Query performance"><thead><tr><th>Search query</th><th>Intent</th><th><button onClick={() => changeSort('searchVolume')}>AVG SV</button></th><th>Imp share</th><th>Brand CTR</th><th>Mkt CTR</th><th aria-sort={sort === 'ctrGap' ? (ascending ? 'ascending' : 'descending') : 'none'}><button onClick={() => changeSort('ctrGap')}>CTR gap</button></th><th>Brand CVR</th><th>Mkt CVR</th><th aria-sort={sort === 'cvrGap' ? (ascending ? 'ascending' : 'descending') : 'none'}><button onClick={() => changeSort('cvrGap')}>CVR gap</button></th><th>Purch share</th><th>Brand purchases</th></tr></thead><tbody>
      {filtered.map(r => <tr key={r.normalizedQuery}><td>{r.searchQuery}</td><td><span className={`research-chip ${chip(r.category)}`}>{labels[r.category]}</span></td><td>{r.searchVolume.toLocaleString()}</td><td>{researchPercent(r.impressionShare)}<div className="research-share"><span style={{ width: `${(r.impressionShare ?? 0) * 100}%` }} /></div></td><td>{researchPercent(r.brandCtr)}</td><td>{researchPercent(r.marketCtr)}</td><td><Gap value={r.ctrGap} /></td><td>{researchPercent(r.brandCvr)}</td><td>{researchPercent(r.marketCvr)}</td><td><Gap value={r.cvrGap} /></td><td>{researchPercent(r.purchaseShare)}</td><td>{r.purchases.toLocaleString()}</td></tr>)}
      {!measured ? ppcTerms.map(r => <tr key={r.searchQuery}><td>{r.searchQuery}</td><td><span className={`research-chip ${chip(r.category)}`}>{labels[r.category]}</span></td>{Array.from({ length: 10 }, (_, i) => <td key={i}><span data-state="not-measured" title={reason}>Not measured</span></td>)}</tr>) : null}
    </tbody></table></div>{!measured && !ppcTerms.length ? missing() : null}
    <VocabularyEditor profileId={profileId} entries={vocabulary} onChange={setVocabulary} /></div>;
}
function Gap({ value }: { value: number | null }) {
  return value === null ? <span>—</span> : <span className={`research-chip ${value >= 0 ? 'good' : 'bad'}`}>{value > 0 ? '+' : ''}{value.toFixed(2)} pp</span>;
}
