'use client';
import { useState } from 'react';
import type { NgramNegativeReview } from '@wizard-ads/core';
import { ResearchAction, ResearchInfo, researchMoney, researchPercent, researchMutation } from '../query-intelligence/research-ui';
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
  if (queued !== null) return <section className="research" aria-label="Negative keywords queued"><h1>Negative keywords queued</h1><div className="research-card good" role="status" data-testid="propose-result"><h2>{queued} negative keyword proposals added</h2><p>{campaigns} campaigns · {review.searchTerms} search terms · {money(review.candidate.cost)} spend</p></div><p>Review and approve the proposals in the change queue before they are sent to Amazon.</p><div className="research-actions"><a className="research-action primary" href={`${queue.path}?profile=${profileId}`}>Review proposals</a><ResearchAction onClick={onDismiss}>Back to N-gram review</ResearchAction></div></section>;
  return <section className="research" aria-label="Review negative keyword"><h1>Review negative keyword</h1><h2>{review.gram}</h2><strong>{review.candidate.clicks} clicks · {money(review.candidate.cost)} spend · {review.candidate.purchases} orders · {review.searchTerms} search terms</strong>
    <p>{review.candidate.reason === 'no_sales_over_target_cpa' ? `This term spent ${review.spendRatio.toFixed(1)}× the ${money(review.displayedTargetCostPerOrder)} target cost per order without an order.` : `This term has ${researchPercent(review.candidate.acos)} ACOS, above the ${researchPercent(review.options.acosCeiling ?? review.options.targetAcos)} ceiling.`}</p>
    <div><ResearchInfo label="View calculation" initialOpen={initialCalculationOpen}><strong>Why this negative was proposed</strong><p>Target cost per order = {researchPercent(review.options.targetAcos)} × {money(review.options.aov)} = {review.targetCostPerOrder}, displayed as {money(review.displayedTargetCostPerOrder)}.</p><p>Spend ratio = {money(review.candidate.cost)} ÷ {review.targetCostPerOrder} ≈ {review.spendRatio.toFixed(1)}×.</p><p>{review.candidate.sales === 0 ? `With ${review.candidate.purchases} orders and ${money(0)} sales, ACOS is undefined.` : `ACOS = ${money(review.candidate.cost)} ÷ ${money(review.candidate.sales)} = ${researchPercent(review.candidate.acos)}; ceiling ${researchPercent(review.options.acosCeiling ?? review.options.targetAcos)}.`}</p></ResearchInfo></div>
    <table className="research-table"><thead><tr><th>Campaign / Ad group</th><th>Negative match</th><th>Search terms</th><th>Spend</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.campaignId}:${row.adGroupId}`}><td>{campaignNames[row.campaignId] ?? row.campaignId}<br /><span className="muted">{row.adGroupId ?? 'Campaign scope'}</span></td><td><select aria-label={`Negative match ${index + 1}`} value={row.matchType} onChange={e => setRows(rows.map((r, i) => i === index ? {
      ...r,
      matchType: e.target.value as typeof r.matchType
    } : r))}><option value="negative_phrase">Phrase</option><option value="negative_exact">Exact</option></select></td><td>{row.searchTerms}</td><td>{money(row.spend)}</td></tr>)}</tbody></table>
    <strong>Total: {campaigns} campaigns · {review.searchTerms} search terms · {money(review.candidate.cost)}</strong><p className="muted">Each row covers a different campaign or ad group, so this total does not repeat spend.</p><p>Add the proposal to the queue for review before applying negatives to Amazon.</p>
    {error ? <p role="alert">{error}</p> : null}<div className="research-actions"><ResearchAction primary disabled={busy} onClick={() => void add()}>Add {rows.length} negatives to change queue</ResearchAction><ResearchAction disabled={busy} onClick={onDismiss}>Dismiss</ResearchAction></div></section>;
}
