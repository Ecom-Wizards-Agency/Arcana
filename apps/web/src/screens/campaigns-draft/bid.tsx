'use client';
import { useState } from 'react';
import { calculateCampaignStartingBid, campaignBidRationale } from '@wizard-ads/core';
import type { CampaignBuilderBidBounds, CampaignBuilderBidEvidence, CampaignBuilderKeyword } from '@wizard-ads/shared';
import { CampaignPage, Button, Input, Notice, DetailsTable, Badge, money, exactMoney, exposureEquation } from '../campaigns/ui';

export function evidenceWindow(start: string, end: string): string {
  const first = new Date(`${start}T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`);
  const format = (date: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date);
  return first.getUTCMonth() === last.getUTCMonth() && first.getUTCFullYear() === last.getUTCFullYear() ? `${first.getUTCDate()} – ${format(last)}` : `${format(first)} – ${format(last)}`;
}
export function BidEditor({ keyword, evidence, bounds, currency, topOfSearch, audienceAdjustment, onUse, onCancel, expanded = false, sqpMeasured = false, adType = 'Sponsored Products', match = 'Exact', placementSource = 'setting', frozenRationale }: {
  keyword: CampaignBuilderKeyword; evidence: CampaignBuilderBidEvidence | null; bounds: CampaignBuilderBidBounds;
  currency: string; topOfSearch: number; audienceAdjustment: number; expanded?: boolean; sqpMeasured?: boolean;
  adType?: string; match?: string; placementSource?: 'setting' | 'name'; frozenRationale?: string;
  onUse: (keyword: CampaignBuilderKeyword) => void; onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(keyword.bid)); const [basis, setBasis] = useState(keyword.basis); const [show, setShow] = useState(expanded);
  const calculation = calculateCampaignStartingBid({ basis, manualBid: amount === '' ? null : Number(amount), evidence, bounds, topOfSearch, audienceAdjustment });
  const cpcBase = calculation.cpc === null ? null : calculation.cpc / calculation.placementMultiplier;
  const rationale = frozenRationale ?? campaignBidRationale({ keyword: keyword.text, basis, bid: amount === '' ? keyword.bid : Number(amount), currency, topOfSearch, audienceAdjustment, evidence });
  const cpcAvailable = calculation.reconciled === true;
  const row = (title: string, explanation: string, value: string, accent = false) => <div key={title}><dt>{title}<small>{explanation}</small></dt><dd style={accent ? { color: calculation.exceeded ? 'var(--wa-bad-text)' : 'var(--wa-indigo)' } : undefined}>{value}</dd></div>;
  return <CampaignPage title="Set starting bid" subtitle={`${keyword.text} · ${adType} · ${match}`}>
    <section className="wa-stack" aria-label="Starting bid editor"><div className="wa-actions"><Input aria-label="Starting bid amount" aria-invalid={calculation.exceeded || !calculation.inRange} type="number" style={{ width: '12rem' }} value={amount} onChange={(event) => setAmount(event.target.value)} /><span>{currency}</span><Button onClick={() => setShow(!show)}>{show ? 'Hide calculation' : 'View bid calculation'}</Button><Button onClick={() => setBasis('manual')}>Enter bid manually</Button></div>
      <p>Allowed base bid: {money(bounds.floor, currency)} to {money(bounds.ceiling, currency)}</p>
      {calculation.exceeded && <Notice kind="bad"><strong>Top-of-search exposure exceeds the limit</strong><p>Top-of-search exposure is {exactMoney(calculation.exposure, currency)}. The hard limit is {money(bounds.exposureCeiling, currency)}. Lower the bid or placement adjustment before creating the campaign.</p></Notice>}
      {!calculation.inRange && <Notice kind="bad">The entered bid must fit the allowed range and marketplace precision.</Notice>}
    </section>
    <div className="wa-actions" aria-label="Bid basis"><small className="wa-hint">BASIS</small>{[['keyword_cpc', 'keyword CPC', !cpcAvailable], ['sqp_value', 'SQP value', true], ['manual', 'manual', false]].map(([value, label, unavailable]) => <Button key={String(value)} aria-pressed={basis === value} onClick={() => setBasis(value as typeof basis)} style={{ background: basis === value ? 'var(--wa-indigo-soft)' : 'var(--wa-surface)' }}>{label}{unavailable ? ' · unavailable' : ''}</Button>)}</div>
    {show && <DetailsTable headings={['Calculation', 'Value']} rows={[
      ['Realized keyword CPC', `${money(evidence?.reportedCpc ?? calculation.cpc, currency)} · ${cpcAvailable ? 'Source reconciled' : 'Source requires verification'}`],
      ['Top-of-search adjustment', `${topOfSearch}% · ${placementSource === 'name' ? `Read from campaign name token (TOS-${topOfSearch})` : 'Verify campaign setting'}`], ['Audience adjustment', audienceAdjustment === 0 ? 'none' : `${audienceAdjustment}% · Compounds`],
      [<>Base bid formula <small className="wa-hint">· CPC suggestion</small></>, `${money(calculation.cpc, currency)} ÷ ${calculation.placementMultiplier} = ${exactMoney(cpcBase, currency)}`],
      [<>Top-of-search exposure formula <small className="wa-hint">· Selected starting bid</small></>, amount === '' ? 'Not measured' : exposureEquation(Number(amount), topOfSearch, audienceAdjustment, currency)],
      ['Base bid floor / ceiling', `${money(bounds.floor, currency)} / ${money(bounds.ceiling, currency)}`],
      ['Hard exposure ceiling', `${money(bounds.exposureCeiling, currency)}${calculation.exceeded ? ' · Exceeded' : calculation.exposure !== null && bounds.exposureCeiling !== null ? ' · Within limit' : ' · Not measured'}`],
    ]} />}
    {basis === 'keyword_cpc' && !cpcAvailable && <Notice kind="warn">The keyword-CPC basis needs verification. Review the source before relying on the suggested amount.</Notice>}
    {basis === 'sqp_value' && <Notice>{sqpMeasured ? 'SQP rows are available; a verified value-to-bid calculation is not available.' : 'SQP value: not measured. No weekly SQP rows are available.'}</Notice>}
    {calculation.reconciled === false && evidence && <Notice kind="warn"><strong>Source totals do not reconcile</strong><p>{evidence.clicks} clicks and {money(evidence.spend, currency)} spend imply about {money(calculation.cpc, currency)} CPC, not {money(evidence.reportedCpc, currency)}. Verify the report, period and filters before using the CPC basis.</p></Notice>}
    <div className="wa-actions">{basis === 'keyword_cpc' && calculation.base !== null && <Button onClick={() => setAmount(String(calculation.base))}>Use calculated amount</Button>}<Button variant="primary" disabled={!amount.trim() || !calculation.usable} onClick={() => onUse({ ...keyword, bid: Number(amount), basis })}>Use this bid</Button><Button onClick={onCancel}>Cancel</Button></div>
    <details className="campaign-bid-secondary"><summary>The bid, and why</summary><div className="wa-stack"><p className="wa-hint">{keyword.text} · {adType} · {match} · the rationale is frozen when saved, so this row still explains itself in six months.</p>
    <dl className="campaign-bid-rows">
      {row('Realised CPC on this keyword', `${evidence ? `What a click actually cost over ${evidence.days} days.` : 'Reporting period: not measured.'} The placement multiplier is already inside it. ${cpcAvailable ? 'Source reconciled' : 'Source requires verification'}.`, money(evidence?.reportedCpc ?? calculation.cpc, currency))}
      {row('Top-of-search adjustment on this campaign', placementSource === 'name' ? `Read from the campaign name, token (TOS-${topOfSearch}).` : 'Read from the reviewed campaign placement setting.', `+${topOfSearch}%`)}
      {row('Audience adjustment', 'If one existed it would compound on the placement one, not add to it.', audienceAdjustment === 0 ? 'none' : `+${audienceAdjustment}%`)}
      {row('Base bid = realised CPC ÷ (1 + adjustment)', 'Setting the base equal to the realised CPC would multiply that at top of search.', money(cpcBase, currency))}
      {row('Bid at top of search = base × multiplier', 'The number that reaches the auction. Audience adjustments compound on this.', money(amount === '' ? null : Number(amount) * calculation.placementMultiplier, currency), true)}
      {row('Floor and ceiling', 'Hard bounds. Never relaxed to reach a target.', `${money(bounds.floor, currency)} – ${money(bounds.ceiling, currency)}`)}
    </dl>
    <section className="campaign-rationale"><small className="wa-hint">RATIONALE, FROZEN WHEN SAVED</small><blockquote>“{rationale}”</blockquote><small className="wa-hint">Stored with the launch. A later change to the method or the defaults cannot rewrite it.</small></section>
    <div className="wa-actions campaign-bid-evidence" aria-label="Bid evidence"><Badge>{evidence ? `${evidence.clicks} clicks` : 'Clicks: not measured'}</Badge><Badge>{evidence ? `${money(evidence.spend, currency)} spend` : 'Spend: not measured'}</Badge><Badge>{evidence ? `${evidence.days} days` : 'Days: not measured'}</Badge><Badge>ACOS: {evidence?.sales != null && evidence.sales > 0 ? `${Number((evidence.spend / evidence.sales * 100).toFixed(2))}%` : 'not measured'}</Badge><Badge>{sqpMeasured ? 'SQP: data available' : 'SQP: no data'}</Badge></div>
    {evidence && <p className="wa-hint">{evidenceWindow(evidence.start, evidence.end)} · {evidence.sourceRows} source rows</p>}
    </div></details>
  </CampaignPage>;
}
