import type { StreamConsumerEvidence } from '@wizard-ads/shared';
import styles from './creative.module.css';

/** Supplemental source observations; never mixed into report totals or restore actions. */
export function StreamEvidencePanel({ evidence, title = 'Amazon Marketing Stream evidence' }: {
  evidence?: StreamConsumerEvidence; title?: string;
}) {
  if (!evidence) return null;
  return <section aria-label={title} data-testid="stream-consumer-evidence" className={styles.detail}>
    <header className={styles.sectionHeader}><h2>{title}</h2></header>
    <p className={styles.footnote}>{evidence.truncated ? 'Showing the first 500 provider observations. Narrow the date range for older evidence. ' : ''}{evidence.measured} measured observations · {evidence.unresolved} unresolved · {evidence.excluded} outside this selection · {evidence.completeness}</p>
    {evidence.events.length === 0 ? <p>Not measured. No resolved Stream facts are available for this selection.</p> :
      <div className={styles.tableWrap}><table className={styles.table}><caption className={styles.footnote}>Provider observations · partial evidence · separate from report totals and local actions</caption>
        <thead><tr><th>Source dataset</th><th>Entity</th><th>Observation</th><th>Source time / revision</th><th>Window</th></tr></thead>
        <tbody>{evidence.events.map((event) => {
          const r = event.record, o = r.observation;
          return <tr key={event.identity}><td>{r.datasetId}</td><td>{'entityId' in o ? o.entityId : 'creativeId' in o ? o.creativeId : o.campaignId}</td>
            <td>{'clicks' in o ? `Clicks: ${o.clicks}` : 'engagements' in o ? `Engagements: ${o.engagements}` :
              'recommendedBudget' in o ? `Provider budget advice: ${o.recommendedBudget} ${o.currency}` :
                'diagnosticCode' in o ? `${o.severity}: ${o.diagnosticCode}` :
                  `${o.operation}${o.name === undefined ? '' : ` · ${o.name}`} · State: ${o.state ?? '— (not supplied)'}`}</td>
            <td><time dateTime={r.eventTime}>{r.eventTime}</time> / {r.revision}{evidence.staleEventIds.includes(event.identity) ? ' · Stale' : ''}</td>
            <td>{r.window ? `${r.window.start} – ${r.window.end}` : '—'}</td></tr>;
        })}</tbody></table></div>}
    {evidence.associations.length ? <div className={styles.tableWrap}><table className={styles.table}><caption className={styles.footnote}>Verified entity associations</caption><thead><tr><th>Entity</th><th>Association</th><th>Endpoint</th></tr></thead>
      <tbody>{evidence.associations.map((edge,index)=><tr key={index}><td>{edge.from.providerId}</td><td>{edge.relation}</td><td>{edge.to.kind}: {edge.to.providerId}{edge.to.version ? ` / ${edge.to.version}` : ''}</td></tr>)}</tbody></table></div> : null}
  </section>;
}
