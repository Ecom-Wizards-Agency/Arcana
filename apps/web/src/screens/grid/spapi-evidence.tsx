'use client';
import { useState } from 'react';
import styles from './spapi-evidence.module.css';
import { abaEvidence, listingChanges, retailEvidence, retailTacos, retailComparison } from '@wizard-ads/core';
import type { SpEvidence, SpParsedReport, SpRetailSpendEvidence } from '@wizard-ads/shared';

export const unavailableSpEvidence: SpEvidence = { state: 'unavailable', reason: 'No enabled source with verified observations for this period.', report: null };
const number = (value: number | null) => value === null ? 'Not measured' : value.toLocaleString('en-US');
const percent = (value: number | null) => value === null ? 'Not measured' : `${(value * 100).toFixed(2)}%`;
export function SpSourceStatus({ evidence, label }: { evidence: SpEvidence; label: string }) {
  return <p data-testid="sp-source-status" data-state={evidence.state}><strong>{label}: {evidence.state}</strong>{evidence.report
    ? ` · ${evidence.report.plan.start} to ${evidence.report.plan.end} · observed ${evidence.report.observedAt}` : ''}
    {evidence.reason ? ` · ${evidence.reason}` : ''}</p>;
}
export function RetailEvidencePanel({ evidence = unavailableSpEvidence, start, end, spend, asin, previous, previousPeriod }: {
  evidence?: SpEvidence; start: string; end: string; spend?: SpRetailSpendEvidence; asin?: string; previous?: SpEvidence; previousPeriod?: { start: string; end: string };
}) {
  const retail = retailEvidence(evidence, { start, end, ...(asin === undefined ? {} : { asin }) });
  const comparison = previous && previousPeriod ? retailComparison(retail, retailEvidence(previous, { ...previousPeriod, ...(asin === undefined ? {} : { asin }) })) : null;
  const tacos = spend === undefined || asin !== undefined ? null : retailTacos(evidence, spend);
  return <section className={styles.panel} aria-label="Retail sales and traffic">
    <h2>Retail sales and traffic{asin ? ` · ${asin}` : ''}</h2><SpSourceStatus evidence={{ ...evidence, state: retail.state, reason: retail.reason }} label="Sales and Traffic" />
    <table><thead><tr><th>Total retail sales</th><th>Ordered units</th><th>Sessions</th><th>Page views</th><th>Units / sessions</th><th>TACOS</th></tr></thead>
      <tbody><tr><td>{retail.sales === null || retail.currency === null ? 'Not measured' : `${number(retail.sales)} ${retail.currency}`}</td><td>{number(retail.units)}</td>
        <td>{number(retail.sessions)}</td><td>{number(retail.pageViews)}</td><td>{percent(retail.conversion)}</td><td>{percent(tacos)}</td></tr></tbody></table>
    {previousPeriod ? <p>Compared with {previousPeriod.start} to {previousPeriod.end}: traffic change {percent(comparison?.trafficChange ?? null)} · conversion change {comparison?.conversionChange == null ? 'Not measured' : `${(comparison.conversionChange * 100).toFixed(2)} percentage points`}</p> : null}
    {tacos === null ? <p>TACOS requires complete seller-wide ad spend and retail sales for the same marketplace, currency and dates.</p> : null}
  </section>;
}
export function AbaEvidencePanel({ evidence = unavailableSpEvidence, selectedAsin = '', query }: { evidence?: SpEvidence; selectedAsin?: string; query?: string }) {
  const [asin, setAsin] = useState(selectedAsin);
  const report = evidence.report;
  const queries = new Map((report?.rows ?? []).flatMap(row => row.kind === 'aba' && (query === undefined || row.query === query)
    ? [[`${row.department}\u0000${row.query}`, row] as const] : []));
  return <section className={styles.panel} aria-label="ABA search-term evidence"><h2>Brand Analytics search terms</h2><SpSourceStatus evidence={evidence} label="ABA" />
    <label>Selected ASIN <input aria-label="ABA selected ASIN" value={asin} maxLength={10} onChange={event => setAsin(event.target.value.toUpperCase())} /></label>
    <table><thead><tr><th>Department</th><th>Query</th><th>Search frequency rank</th><th>Selected ASIN result</th><th>Click share</th><th>Conversion share</th></tr></thead>
      <tbody>{[...queries.values()].slice(0, 100).map(row => {
        const result = abaEvidence(evidence, { query: row.query, asin, department: row.department, start: row.date, end: row.end });
        const selected = /^[A-Z0-9]{10}$/.test(asin);
        return <tr key={`${row.department}:${row.query}`}><td>{row.department}</td><td>{row.query}</td><td>{number(row.frequencyRank)}</td>
          <td>{!selected ? 'Choose an ASIN' : result.state === 'not-top-three' ? 'Not top 3' : result.state === 'present' ? `Slot ${result.slot}` : 'Not measured'}</td>
          <td>{selected ? percent(result.clickShare) : 'Not measured'}</td><td>{selected ? percent(result.conversionShare) : 'Not measured'}</td></tr>;
      })}</tbody></table>
    {queries.size > 100 ? <p>Showing 100 of {queries.size} observed department/query rows.</p> : null}
    {!queries.size ? <p>No observed query in this provider period. ASIN shares are not measured.</p> : null}
    <p>ABA reports ranked click and conversion shares. Search frequency rank describes query frequency.</p>
  </section>;
}
export function ListingEvidencePanel({ evidence = unavailableSpEvidence, reports = [], timezone = 'UTC' }: { evidence?: SpEvidence; reports?: SpParsedReport[]; timezone?: string }) {
  const changes = listingChanges(reports, timezone);
  return <section className={styles.panel} aria-label="Listing observations"><h2>Listing observations</h2><SpSourceStatus evidence={evidence} label="Catalogue" />
    {changes.length ? <table><thead><tr><th>ASIN / SKU</th><th>Field</th><th>Before</th><th>Observed value</th><th>Observation</th><th>Certainty</th><th>Source</th></tr></thead>
      <tbody>{changes.slice(0, 100).map(change => <tr key={change.id}><td>{change.asin} / {change.sku}</td><td>{change.field}</td><td>{change.before ?? 'Not measured'}</td><td>{change.after}</td>
        <td>{change.observedAt}</td><td>{change.certainty.kind}{change.certainty.from ? ` · ${change.certainty.from} to ${change.certainty.to}` : ''}</td><td>Catalogue listing report</td></tr>)}</tbody></table>
      : <p>No listing fields observed in this period. Historical coverage begins with the first recorded observation.</p>}
    {changes.length > 100 ? <p>Showing 100 of {changes.length} observed field changes.</p> : null}
  </section>;
}
