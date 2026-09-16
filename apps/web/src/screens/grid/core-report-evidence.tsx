import type { CoreReportEvidence } from '@wizard-ads/shared';

function familyLabel(value: string) {
  return value.replace(/^sp/, 'Sponsored Products · ').replace(/^sb/, 'Sponsored Brands · ').replace(/^sd/, 'Sponsored Display · ').replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function CoreReportEvidencePanel({ evidence, title = 'Additional report evidence' }: { evidence: readonly CoreReportEvidence[]; title?: string }) {
  return <section aria-label={title}><h2>{title}</h2>{evidence.map((item) => <details key={`${item.family}:${item.variant ?? "default"}`} data-report-family={item.family} data-evidence-status={item.status}>
    <summary>{familyLabel(item.family)} · {item.status === 'unmeasured' ? 'Not measured' : item.status} · {item.rowCount} reported {item.rowCount === 1 ? 'row' : 'rows'}</summary>
    <p>{item.grain.replaceAll('_', ' ')} scope. {item.variant?.startsWith('SUMMARY:') ? 'Reported period totals.' : 'Daily observations.'} {item.observedAt ? `Observed ${item.observedAt.slice(0, 10)}.` : 'No completed report observation.'} {item.truncated ? 'The displayed rows are incomplete.' : ''}</p>
    {item.grain === 'purchased_product' ? <p>Purchased-product relationships are already included in campaign revenue. Spend is not allocated to purchased ASINs.</p> : null}
    {item.grain === 'traffic_quality' ? <p>These traffic counts describe the campaign, including its other targets.</p> : null}
    {item.rows.length ? <table><thead><tr><th>Period</th><th>Reported identity</th><th>Attribution</th><th>Measurements</th></tr></thead><tbody>{item.rows.map((row, index) => <tr key={index}><td style={{ whiteSpace: 'nowrap' }}>{row.periodStart}{row.periodEnd !== row.periodStart ? ` to ${row.periodEnd}` : ''}</td><td>{Object.entries(row.dimensions).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${value}`).join('; ')}</td><td>{row.attributionGeneration}</td><td>{Object.entries(row.metrics).map(([key, value]) => `${key}: ${value ?? 'Not measured'}`).join('; ')}</td></tr>)}</tbody></table> : <p>No measured rows in this period.</p>}
  </details>)}</section>;
}
