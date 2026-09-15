'use client';
import { useState } from 'react';
import type { NgramNegativeReview } from '@wizard-ads/core';
import { ResearchAction, ResearchInfo, researchMoney, researchExactMoney, researchPercent, researchMutation } from '../query-intelligence/research-ui';
import { campaignCount } from '../query-intelligence/research-format';
import { SCREEN_REGISTRY } from '../registry-metadata';
const queue = SCREEN_REGISTRY.find(screen => screen.id === 'time-machine')!;
import '../query-intelligence/research.css';
export function NgramNegativeReviewPanel({ review, profileId, period, currencyCode, campaignNames, onDismiss, selectedTerms, initialQueued = false, initialCalculationOpen = false }: { review: NgramNegativeReview; profileId: string; period: { start: string; end: string }; currencyCode: string; campaignNames: Record<string, string>; onDismiss: () => void; selectedTerms?: string[]; initialQueued?: boolean; initialCalculationOpen?: boolean }) {
  const [rows, setRows] = useState(review.rows), [busy, setBusy] = useState(false), [error, setError] = useState(''), [queued, setQueued] = useState<number | null>(initialQueued ? review.rows.length : null);
  const money = (v: number | null) => researchMoney(v, currencyCode), campaigns = new Set(rows.map(r => r.campaignId)).size;
  async function add() {
    setBusy(true);
    setError('');
    try {
      const response = await researchMutation('/api/ngrams/negatives', {
        profileId,
        window: period,
        gram: review.gram,
        n: review.n,
        selectedTerms,
        proposals: rows.map(row => ({
          ...row,
          searchTerm: review.gram,
          gramInputs: {
            ...review.options,
            spend: review.candidate.cost,
            sales: review.candidate.sales,
            orders: review.candidate.purchases,
            reason: review.candidate.reason
          }
        }))
      });
      if (response['created'] !== rows.length || response['offered'] !== rows.length) throw new Error('Queue counts did not reconcile. Reload before trying again.');
      setQueued(rows.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The queue could not be confirmed');
    } finally {
      setBusy(false);
    }
  }
  if (queued !== null) return <section className="research" aria-label="Negative keywords queued"><h1>Negative keywords queued</h1><div className="research-card good" role="status" data-testid="propose-result"><h2>{queued} negative keyword proposals added</h2><p>{campaignCount(campaigns)} · {review.searchTerms} search terms · {money(review.candidate.cost)} spend</p></div><p>Review and approve the proposals in the change queue before they are sent to Amazon.</p><div className="research-actions"><a className="research-action primary" href={`${queue.path}?profile=${profileId}`}>Review proposals</a><ResearchAction onClick={onDismiss}>Back to N-gram review</ResearchAction></div></section>;
  const noSales = review.candidate.reason === 'no_sales_over_target_cpa';
  return <section className="research" aria-label="Review negative keyword"><header><h1>Propose a negative</h1><p className="muted">Selected from the gram table. Nothing here changes Amazon — it writes a proposal that has to be reviewed and exported.</p></header>
    <dl className="negative-summary">{([
      ['Gram', review.gram], ['Search terms', review.searchTerms], ['Impressions', review.impressions],
      ['Clicks', review.candidate.clicks], ['Spend', money(review.candidate.cost)], ['Sales', money(review.candidate.sales)], ['Orders', review.candidate.purchases],
    ] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className={`research-card ${noSales ? 'bad' : 'warn'}`}><div className="research-actions"><span className={`research-chip ${noSales ? 'bad' : 'confirmed'}`}>{noSales ? 'no sales over target CPA' : 'ACOS over the ceiling'}</span><span className="muted">one of two reasons the engine can give</span></div>
      <p>{noSales ? `This term spent ${review.spendRatio.toFixed(1)}× the ${money(review.displayedTargetCostPerOrder)} target cost per order without an order.` : `This term has ${researchPercent(review.candidate.acos)} ACOS, above the ${researchPercent(review.options.acosCeiling ?? review.options.targetAcos)} ceiling.`}</p></div>
    <div><ResearchInfo label="View calculation" initialOpen={initialCalculationOpen}><strong>Why this negative was proposed</strong><p>Target cost per order = {researchPercent(review.options.targetAcos)} × {money(review.options.aov)} = {researchExactMoney(review.targetCostPerOrder, currencyCode)}, displayed as {money(review.displayedTargetCostPerOrder)}.</p><p>Spend ratio = {money(review.candidate.cost)} ÷ {researchExactMoney(review.targetCostPerOrder, currencyCode)} ≈ {review.spendRatio.toFixed(1)}×.</p><p>{review.candidate.sales === 0 ? `With ${review.candidate.purchases} orders and ${money(0)} sales, ACOS is undefined.` : `ACOS = ${money(review.candidate.cost)} ÷ ${money(review.candidate.sales)} = ${researchPercent(review.candidate.acos)}; ceiling ${researchPercent(review.options.acosCeiling ?? review.options.targetAcos)}.`}</p></ResearchInfo></div>
    <table className="research-table negative-scopes"><thead><tr><th>Campaign</th><th>Ad group</th><th>Match type to add</th><th>Search terms</th><th>Spend on this gram</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.campaignId}:${row.adGroupId}`}><td>{campaignNames[row.campaignId] ?? row.campaignId}</td><td>{row.adGroupId ?? 'Campaign scope'}</td><td><select disabled={busy} aria-label={`Negative match ${index + 1}`} value={row.matchType} onChange={e => setRows(rows.map((r, i) => i === index ? {
      ...r,
      matchType: e.target.value as typeof r.matchType
    } : r))}><option value="negative_phrase">Phrase</option><option value="negative_exact">Exact</option></select></td><td>{row.searchTerms}</td><td>{money(row.spend)}</td></tr>)}</tbody>
    <tfoot><tr><td colSpan={5}>{campaignCount(campaigns)} · {review.searchTerms} search terms · {money(review.candidate.cost)} — this total is safe because every row is a different {campaigns === rows.length ? 'campaign' : 'campaign or ad group'}</td></tr></tfoot></table>
    {error ? <p role="alert">{error}</p> : null}<div className="research-actions"><ResearchAction primary disabled={busy} aria-description={`${rows.length} negative keyword proposals will be added to the change queue`} onClick={() => void add()}>Accept proposal</ResearchAction><ResearchAction disabled={busy} onClick={onDismiss}>Dismiss</ResearchAction><p className="muted">proposed → accepted → exported. Accepting moves it to the change queue; it does not reach Amazon.</p></div>
    <p className="muted">This screen creates a proposal and negates nothing. A one-click negative that actually negated would be the only place in this product where a click leaves the review loop.</p></section>;
}
