'use client';
import { useState } from 'react';
import { calculateCampaignStartingBid } from '@wizard-ads/core';
import type { CampaignBuilderBidBounds, CampaignBuilderBidEvidence, CampaignBuilderKeyword } from '@wizard-ads/shared';
import { CampaignPage, Button, Input, Notice, DetailsTable, money } from '../campaigns/ui';

export function BidEditor({ keyword, evidence, bounds, currency, topOfSearch, audienceAdjustment, onUse, onCancel, expanded = false, sqpMeasured = false }: {
  keyword: CampaignBuilderKeyword; evidence: CampaignBuilderBidEvidence | null; bounds: CampaignBuilderBidBounds;
  currency: string; topOfSearch: number; audienceAdjustment: number; expanded?: boolean; sqpMeasured?: boolean;
  onUse: (keyword: CampaignBuilderKeyword) => void; onCancel: () => void;
}) {
  const [amount, setAmount] = useState(String(keyword.bid)); const [basis, setBasis] = useState(keyword.basis); const [show, setShow] = useState(expanded);
  const calculation = calculateCampaignStartingBid({ basis, manualBid: amount === '' ? null : Number(amount), evidence, bounds, topOfSearch, audienceAdjustment });
  return <CampaignPage title="Set starting bid" subtitle={keyword.text}>
    <div className="wa-actions" aria-label="Bid basis"><strong>BASIS</strong>{[['keyword_cpc', 'Keyword CPC'], ['sqp_value', 'SQP value'], ['manual', 'Manual']].map(([value, label]) => <Button key={value} aria-pressed={basis === value} onClick={() => setBasis(value as typeof basis)}>{label}</Button>)}</div>
    <div className="wa-actions"><Input aria-label="Starting bid amount" type="number" style={{ width: '12rem' }} value={amount} onChange={(event) => setAmount(event.target.value)} /><span>{currency}</span><Button onClick={() => setShow(!show)}>{show ? 'Hide calculation' : 'View bid calculation'}</Button><Button onClick={() => setBasis('manual')}>Enter bid manually</Button></div>
    <p>Allowed base bid: {money(bounds.floor, currency)} to {money(bounds.ceiling, currency)}</p>
    {calculation.exceeded && <Notice kind="bad"><strong>Top-of-search exposure exceeds the limit</strong><p>Top-of-search exposure is {money(calculation.exposure, currency)}. The hard limit is {money(bounds.exposureCeiling, currency)}. Lower the bid or placement adjustment before creating the campaign.</p></Notice>}
    {!calculation.inRange && <Notice kind="bad">The entered bid must fit the allowed range and marketplace precision.</Notice>}
    {basis === 'keyword_cpc' && calculation.reconciled !== true && <Notice kind="warn">The keyword-CPC basis needs verification. Review the source before relying on the suggested amount.</Notice>}
    {basis === 'sqp_value' && <Notice>{sqpMeasured ? 'SQP rows are available; a verified value-to-bid calculation is not available.' : 'SQP value: not measured. No weekly SQP rows are available.'}</Notice>}
    {show && <DetailsTable headings={['Calculation', 'Value']} rows={[
      ['Realized keyword CPC', `${money(evidence?.reportedCpc ?? calculation.cpc, currency)} · ${calculation.reconciled === true ? 'Source reconciled' : 'Source requires verification'}`],
      ['Top-of-search adjustment', `${topOfSearch}% · Reviewed draft setting`], ['Audience adjustment', `${audienceAdjustment}% · Compounds`],
      ['Base bid formula', `${money(calculation.cpc, currency)} ÷ ${calculation.placementMultiplier} = ${calculation.rawBase ?? 'Unavailable'}`],
      ['Top-of-search exposure formula', `${amount || 'Unavailable'} × ${calculation.placementMultiplier} × ${calculation.audienceMultiplier} = ${calculation.exposure == null ? 'Unavailable' : Number(calculation.exposure.toFixed(6))}`],
      ['Base bid floor / ceiling', `${money(bounds.floor, currency)} / ${money(bounds.ceiling, currency)}`],
      ['Hard exposure ceiling', `${money(bounds.exposureCeiling, currency)}${calculation.exceeded ? ' · Exceeded' : ''}`],
    ]} />}
    {calculation.reconciled === false && evidence && <Notice kind="warn"><strong>Source totals do not reconcile</strong><p>{evidence.clicks} clicks and {money(evidence.spend, currency)} spend imply about {money(calculation.cpc, currency)} CPC, not {money(evidence.reportedCpc, currency)}. Verify the report, period and filters before using the CPC basis.</p></Notice>}
    {evidence && <p className="wa-hint">{evidence.clicks} clicks · {money(evidence.spend, currency)} spend · {evidence.days} measured days · {evidence.start} to {evidence.end} · {evidence.sourceRows} source rows</p>}
    {basis === 'keyword_cpc' && calculation.base !== null && <Button onClick={() => setAmount(String(calculation.base))}>Use calculated amount</Button>}
    <div className="wa-actions"><Button disabled={!amount.trim() || !calculation.usable} onClick={() => onUse({ ...keyword, bid: Number(amount), basis })}>Use this bid</Button><Button onClick={onCancel}>Cancel</Button></div>
  </CampaignPage>;
}
