'use client';
import { useState } from 'react';
import { calculateCampaignStartingBid, campaignBidRationale } from '@wizard-ads/core';
import type { CampaignBuilderBidBounds, CampaignBuilderBidEvidence, CampaignBuilderKeyword } from '@wizard-ads/shared';
import { CampaignPage, Button, Input, Notice, DetailsTable, Badge, money } from '../campaigns/ui';

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
  const row = (title: string, explanation: string, value: string, accent = false) => <div key={title}><dt>{title}<small>{explanation}</small></dt><dd style={accent ? { color: 'var(--wa-accent)' } : undefined}>{value}</dd></div>;
  return <CampaignPage title="The bid, and why" subtitle={`${keyword.text} · ${adType} · ${match} · the rationale is frozen when saved, so this row still explains itself in six months.`}>
    <div className="wa-actions" aria-label="Bid basis"><small className="wa-hint">BASIS</small>{[['keyword_cpc', 'keyword CPC', !cpcAvailable], ['sqp_value', 'SQP value', true], ['manual', 'manual', false]].map(([value, label, unavailable]) => <Button key={String(value)} aria-pressed={basis === value} onClick={() => setBasis(value as typeof basis)} style={{ background: basis === value ? 'var(--wa-accent-soft)' : 'var(--wa-surface)' }}>{label}{unavailable ? ' · unavailable' : ''}</Button>)}</div>
    {!show && <dl className="campaign-bid-rows">
      {row('Realised CPC on this keyword', `What a click actually cost, ${evidence?.days ?? 'unmeasured'} days. The placement multiplier is already inside it. ${cpcAvailable ? 'Source reconciled' : 'Source requires verification'}.`, money(evidence?.reportedCpc ?? calculation.cpc, currency))}
      {row('Top-of-search adjustment on this campaign', placementSource === 'name' ? `Read from the campaign name, token (TOS-${topOfSearch}).` : 'Read from the reviewed campaign placement setting.', `+${topOfSearch}%`)}
      {row('Audience adjustment', 'If one existed it would compound on the placement one, not add to it.', audienceAdjustment === 0 ? 'none' : `+${audienceAdjustment}%`)}
      {row('Base bid = realised CPC ÷ (1 + adjustment)', 'Setting the base equal to the realised CPC would multiply that at top of search.', money(cpcBase, currency))}
      {row('Bid at top of search = base × multiplier', 'The number that reaches the auction. Audience adjustments compound on this.', money(amount === '' ? null : Number(amount) * calculation.placementMultiplier, currency), true)}
      {row('Floor and ceiling', 'Hard bounds. Never relaxed to reach a target.', `${money(bounds.floor, currency)} – ${money(bounds.ceiling, currency)}`)}
    </dl>}
    {show && <DetailsTable headings={['Calculation', 'Value']} rows={[
      ['Realized keyword CPC', `${money(evidence?.reportedCpc ?? calculation.cpc, currency)} · ${cpcAvailable ? 'Source reconciled' : 'Source requires verification'}`],
      ['Top-of-search adjustment', `${topOfSearch}% · Verify campaign setting`], ['Audience adjustment', audienceAdjustment === 0 ? 'none' : `${audienceAdjustment}% · Compounds`],
      ['Base bid formula', `${money(calculation.cpc, currency)} ÷ ${calculation.placementMultiplier} = ${cpcBase ?? 'Unavailable'}`],
      ['Top-of-search exposure formula', `${amount || 'Unavailable'} × ${calculation.placementMultiplier} × ${calculation.audienceMultiplier} = ${calculation.exposure == null ? 'Unavailable' : Number(calculation.exposure.toFixed(6))}`],
      ['Base bid floor / ceiling', `${money(bounds.floor, currency)} / ${money(bounds.ceiling, currency)}`],
      ['Hard exposure ceiling', `${money(bounds.exposureCeiling, currency)}${calculation.exceeded ? ' · Exceeded' : ''}`],
    ]} />}
    <section className="campaign-rationale"><small className="wa-hint">RATIONALE, FROZEN WHEN SAVED</small><blockquote>“{rationale}”</blockquote><small className="wa-hint">Stored with the launch. A later change to the method or the defaults cannot rewrite it.</small></section>
    <div className="wa-actions" aria-label="Bid evidence"><Badge>{evidence ? `${evidence.clicks} clicks` : 'Clicks: not measured'}</Badge><Badge>{money(evidence?.spend, currency)} spend</Badge><Badge>{evidence ? `${evidence.days} days` : 'Days: not measured'}</Badge><Badge>ACOS: {evidence?.sales != null && evidence.sales > 0 ? `${Number((evidence.spend / evidence.sales * 100).toFixed(2))}%` : 'not measured'}</Badge><Badge>{sqpMeasured ? 'SQP: data available' : 'SQP: no data'}</Badge></div>
    {evidence && <p className="wa-hint">{evidenceWindow(evidence.start, evidence.end)} · {evidence.sourceRows} source rows</p>}
    <section className="wa-stack"><h2>Set starting bid</h2><div className="wa-actions"><Input aria-label="Starting bid amount" type="number" style={{ width: '12rem' }} value={amount} onChange={(event) => setAmount(event.target.value)} /><span>{currency}</span><Button onClick={() => setShow(!show)}>{show ? 'Hide calculation' : 'View bid calculation'}</Button><Button onClick={() => setBasis('manual')}>Enter bid manually</Button></div>
    <p>Allowed base bid: {money(bounds.floor, currency)} to {money(bounds.ceiling, currency)}</p></section>
    {calculation.exceeded && <Notice kind="bad"><strong>Top-of-search exposure exceeds the limit</strong><p>Top-of-search exposure is {money(calculation.exposure, currency)}. The hard limit is {money(bounds.exposureCeiling, currency)}. Lower the bid or placement adjustment before creating the campaign.</p></Notice>}
    {!calculation.inRange && <Notice kind="bad">The entered bid must fit the allowed range and marketplace precision.</Notice>}
    {basis === 'keyword_cpc' && !cpcAvailable && <Notice kind="warn">The keyword-CPC basis needs verification. Review the source before relying on the suggested amount.</Notice>}
    {basis === 'sqp_value' && <Notice>{sqpMeasured ? 'SQP rows are available; a verified value-to-bid calculation is not available.' : 'SQP value: not measured. No weekly SQP rows are available.'}</Notice>}
    {calculation.reconciled === false && evidence && <Notice kind="warn"><strong>Source totals do not reconcile</strong><p>{evidence.clicks} clicks and {money(evidence.spend, currency)} spend imply about {money(calculation.cpc, currency)} CPC, not {money(evidence.reportedCpc, currency)}. Verify the report, period and filters before using the CPC basis.</p></Notice>}
    {basis === 'keyword_cpc' && calculation.base !== null && <Button onClick={() => setAmount(String(calculation.base))}>Use calculated amount</Button>}
    <div className="wa-actions"><Button disabled={!amount.trim() || !calculation.usable} onClick={() => onUse({ ...keyword, bid: Number(amount), basis })}>Use this bid</Button><Button onClick={onCancel}>Cancel</Button></div>
  </CampaignPage>;
}
