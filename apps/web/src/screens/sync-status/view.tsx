import { SpSourceStatus } from '../grid/spapi-evidence';
import { ProviderEvidencePanel } from '../recommendations/provider-evidence';
import { formatShellDate, formatTimestamp, formatDateWindow } from '../../ui/date-format';
import { TableFrame } from '../../ui/primitives';
import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { CoreReportEvidencePanel } from '../grid/core-report-evidence';
import { reportAccountingLabel } from '../../data/sync-status';

import { ReportLifecycleTables } from '../../../app/sync-status/report-lifecycle-tables';

import { Shell } from '../settings/frame';

import { colors, heading, muted, page, subheading, table, td, th } from '../../ui/tokens';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  if (data === null) return null;
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ result }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Sync status</h1>
    <ScreenState variant="gated" title="Access unavailable" body={<>
      {result.state === 'no-database'
        ? 'DATABASE_URL is not set, so this instance cannot read its own database.'
        : 'Your account is not a member of any organisation yet.'}
    </>} />
  </main>);
}

function renderReady({ context, status, sources, coreEvidence, providerEvidence }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>{providerEvidence?.map((item) => <section key={item.profileId}><h2>Profile {item.profileId}</h2><ProviderEvidencePanel evidence={item.evidence} consumer="sync-status" /></section>)}
    <Shell context={context} current="sync">
      <h1 style={heading}>Sync status</h1>
      {coreEvidence ? <CoreReportEvidencePanel evidence={coreEvidence} title="Report family coverage" /> : null}
      <p style={muted}>
        Freshness is the newest fact date a profile holds, not the last time a job ran. Same-day
        figures are provisional and sales restate for about fourteen days, so a fresh date is not
        a final one.
      </p>

      {status.freshness.some((row) => row.latestFactDate === null) ? <ScreenState variant="not-measured" title="Facts not measured" body="Some profiles have no synchronized fact date yet. Their freshness is shown as never." /> : null}
      <h2 style={subheading}>Profiles</h2>
      <TableFrame><table style={table}>
        <thead>
          <tr>
            <th style={th}>Profile</th>
            <th style={th}>Region</th>
            <th style={th}>Sync</th>
            <th style={th}>Newest facts</th>
            <th style={th}>Queued</th>
            <th style={th}>Running</th>
            <th style={th}>Failed</th>
          </tr>
        </thead>
        <tbody>
          {status.freshness.map((row) => (
            <tr key={row.profileId} data-testid="freshness-row">
              <td style={td}>
                <a href={`/sync-status?profile=${row.profileId}`}>{row.profileLabel}</a>
              </td>
              <td style={td}>{row.region}</td>
              <td style={td}>{row.syncEnabled ? 'on' : 'off'}</td>
              <td style={td}>{row.latestFactDate === null ? 'never' : formatShellDate(row.latestFactDate)}</td>
              <td style={td}>{row.queued}</td>
              <td style={td}>{row.running}</td>
              <td style={{ ...td, color: row.failed > 0 ? colors.bad : undefined }}>
                {row.failed}
              </td>
            </tr>
          ))}
        </tbody>
      </table></TableFrame>
      {status.freshness.length === 0 ? <ScreenState title="No profiles yet." body="Choose a connected profile or check again after the next sync." /> : null}

      <section aria-label="SP-API source status"><h2>SP-API sources</h2>{sources?.length ? sources.map(source => <SpSourceStatus key={source.family} evidence={source.evidence} label={source.family} />) : <p>Select a profile to inspect retail, ABA and catalogue source evidence.</p>}</section>
      <ReportLifecycleTables deadLetters={status.deadLetters} lifecycle={status.lifecycle} />

      <h2 style={subheading}>Jobs</h2>
      <TableFrame><table style={table}>
        <thead>
          <tr>
            <th style={th}>Profile</th>
            <th style={th}>Type</th>
            <th style={th}>Status</th>
            <th style={th}>Attempts</th>
            <th style={th}>Run after</th>
            <th style={th}>Finished</th>
            <th style={th}>Error</th>
          </tr>
        </thead>
        <tbody>
          {status.jobs.map((job) => (
            <tr key={job.id} data-testid="job-row">
              <td style={td}>{job.profileLabel}</td>
              <td style={td}>{job.jobType}</td>
              <td style={td}>{job.status}</td>
              <td style={td}>
                {job.attempts}/{job.maxAttempts}
              </td>
              <td style={td}>{formatTimestamp(job.runAfter)}</td>
              <td style={td}>{formatTimestamp(job.finishedAt)}</td>
              <td style={{ ...td, color: job.lastError ? colors.bad : undefined }}>
                {job.lastError ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table></TableFrame>
      {status.jobs.length === 0 ? <ScreenState title="Nothing has been queued yet." body="Choose a connected profile or check again after the next sync." /> : null}

      <h2 style={subheading}>Report requests</h2>
      <TableFrame><table style={table}>
        <thead>
          <tr>
            <th style={th}>Profile</th>
            <th style={th}>Report</th>
            <th style={th}>Window</th>
            <th style={th}>Status</th>
            <th style={th}>Polls</th>
            <th style={th}>Source</th>
            <th style={th}>Parsed</th>
            <th style={th}>Refused</th>
            <th style={th}>Promoted</th>
            <th style={th}>Unpromoted</th>
            <th style={th}>Loaded / canonical</th>
            <th style={th}>Reconciliation</th>
            <th style={th}>Error</th>
          </tr>
        </thead>
        <tbody>
          {status.reports.map((report) => (
            <tr key={report.id} data-testid="report-row">
              <td style={td}>{report.profileLabel}</td>
              <td style={td}>{report.reportType}</td>
              <td style={td}>
                {formatDateWindow(report.startDate, report.endDate)}
              </td>
              <td style={td}>{report.status}</td>
              <td style={td}>{report.pollAttempts}</td>
              <td style={td}>{report.sourceRows ?? '—'}</td>
              <td style={td}>{report.rowsParsed ?? '—'}</td>
              <td style={td}>{report.refusedRows ?? '—'}</td>
              <td style={td}>{report.promotedRows ?? '—'}</td>
              <td style={td}>{report.unpromotedRows ?? '—'}</td>
              <td style={td}>{report.rowsLoaded ?? '—'}</td>
              <td
                style={{
                  ...td,
                  color: report.accountingComplete === false || (
                    report.accountingComplete === null && report.countsMatch === false
                  ) ? colors.bad : undefined,
                }}
              >
                {reportAccountingLabel(report)}
              </td>
              <td style={{ ...td, color: report.error ? colors.bad : undefined }}>
                {report.error ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table></TableFrame>
      {status.reports.length === 0 ? <ScreenState title="No reports requested yet." body="Choose a connected profile or check again after the next sync." /> : null}
    </Shell>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data === null) return null;
  return <ScreenSurface title="Sync status">{ScreenContent({ data })}</ScreenSurface>;
}
