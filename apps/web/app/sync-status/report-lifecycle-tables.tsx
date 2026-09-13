import { REPORT_LIFECYCLE_STAGES, type DeadReportJob, type ReportLifecycleCounts } from '@wizard-ads/db';
import { muted, subheading, table, td, th } from '../../src/ui/tokens';

export function ReportLifecycleTables({ deadLetters, lifecycle }: {
  deadLetters: DeadReportJob[]; lifecycle: ReportLifecycleCounts[];
}) {
  return <>
    <h2 style={subheading}>Report lifecycle</h2>
    <p style={muted}>Counts are requests with recorded evidence of each stage; stages overlap.
      Promoted means at least one row reached canonical facts. Refused means a recorded row or parser refusal.</p>
    <table style={table}>
      <thead><tr><th style={th}>Report type</th>{REPORT_LIFECYCLE_STAGES.map((stage) =>
        <th style={th} key={stage}>{stage}</th>)}</tr></thead>
      <tbody>{lifecycle.map((row) => <tr key={row.reportType} data-testid="lifecycle-row">
        <td style={td}>{row.reportType}</td>{REPORT_LIFECYCLE_STAGES.map((stage) =>
          <td style={td} key={stage}>{row[stage]}</td>)}
      </tr>)}</tbody>
    </table>
    <h2 style={subheading}>Dead-letter jobs</h2>
    <p style={muted}>Newest 100 dead-letter jobs. First seen is queue creation; last seen is the last queue update.</p>
    <table style={table}>
      <thead><tr>{['Type', 'Profile', 'Last error', 'Attempts', 'First seen', 'Last seen'].map((label) =>
        <th style={th} key={label}>{label}</th>)}</tr></thead>
      <tbody>{deadLetters.map((job) => <tr key={job.id} data-testid="dead-letter-row">
        <td style={td}>{job.jobType}</td><td style={td}>{job.profileLabel}</td>
        <td style={td}>{job.lastError ?? '—'}</td><td style={td}>{job.attempts}</td>
        <td style={td}>{job.firstSeen}</td><td style={td}>{job.lastSeen}</td>
      </tr>)}</tbody>
    </table>
    {deadLetters.length === 0 ? <p style={muted}>No dead-letter jobs.</p> : null}
  </>;
}
