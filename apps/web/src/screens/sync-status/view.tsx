import { SpSourceStatus } from '../grid/spapi-evidence';
import { ProviderEvidencePanel } from '../recommendations/provider-evidence';
import { formatShellDate, formatTimestamp, formatDateWindow } from '../../ui/date-format';
import { TableFrame } from '../../ui/primitives';
import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { CoreReportEvidencePanel } from '../grid/core-report-evidence';
import { reportAccountingLabel } from '../../data/sync-status';
import { ReportLifecycleTables } from '../../../app/sync-status/report-lifecycle-tables';
import { ReportLaneBanner } from './lane-banner';
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

function renderReady({ context, status, lane, sources, coreEvidence, providerEvidence }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  // Measured per profile by the lane query, including explicit zeros. A legacy
  // failure returns its job to Queued, so a stored `failed` state never exists.
  const health = new Map(lane.profiles.map((row) => [row.profileId, row]));
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
      <ReportLaneBanner lane={lane} factDates={status.freshness.map((row) => row.latestFactDate)} />
      <h2 style={subheading}>Profiles</h2>
      <p style={muted}>
        Retrying and Dead count this profile&apos;s jobs of every type. A failed job that will retry
        waits in Queued; a dead job exhausted its retries or failed permanently.
      </p>
      <TableFrame><table style={table}>
        <thead>
          <tr>
            <th style={th}>Profile</th>
            <th style={th}>Region</th>
            <th style={th}>Sync</th>
            <th style={th}>Newest facts</th>
            <th style={th}>Queued</th>
            <th style={th}>Running</th>
            <th style={th}>Retrying (this profile)</th>
            <th style={th}>Dead (this profile)</th>
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
              <td style={td} data-testid="profile-retrying">{health.get(row.profileId)?.retrying ?? 'not measured'}</td>
              <td
                style={{ ...td, color: (health.get(row.profileId)?.dead ?? 0) > 0 ? colors.bad : undefined }}
                data-testid="profile-dead"
              >
                {health.get(row.profileId)?.dead ?? 'not measured'}
              </td>
            </tr>
          ))}
        </tbody>
      </table></TableFrame>
      {status.freshness.length === 0 ? <ScreenState title="No profiles yet." body="Choose a connected profile or check again after the next sync." /> : null}

      <section aria-label="SP-API source status"><h2>SP-API sources</h2>{sources?.length ? sources.map(source => <SpSourceStatus key={source.family} evidence={source.evidence} label={source.family} />) : <p>Select a profile to inspect retail, ABA and catalogue source evidence.</p>}</section>
      <h2 style={subheading}>Additional Stream datasets</h2>
      <p style={muted}>Bindings and projections default off. Event time determines age; replay does not renew evidence. Counters include only verified binding scope; unmatched delivery failures remain in the infrastructure ledger.</p>
      {status.streams ? <TableFrame><table style={table}><thead><tr>{['Dataset', 'Bindings', 'Enabled', 'Confirmation', 'Stored', 'Latest event', 'Maximum lag', 'Duplicates / rejected / dead-lettered'].map((label) => <th style={th} key={label}>{label}</th>)}</tr></thead><tbody>
        {status.streams.map((row) => <tr key={row.datasetId} data-testid="stream-extension-row"><td style={td}>{row.datasetId}</td><td style={td}>{row.bindingCount}</td><td style={td}>{row.enabled ? 'on' : 'off'}</td><td style={td}>{row.confirmed ? 'confirmed' : 'missing confirmation'}</td><td style={td}>{row.stored}</td><td style={td}>{formatTimestamp(row.latestEventAt)}</td><td style={td}>{row.maximumLagSeconds === null ? '—' : `${row.maximumLagSeconds}s`}</td><td style={td}>{[row.duplicates, row.rejected, row.deadLettered].map((n) => n === null ? 'unmeasured' : n).join(' / ')}</td></tr>)}
      </tbody></table></TableFrame> : <p style={muted}>Choose a profile to inspect Stream bindings.</p>}
      <ReportLifecycleTables deadLetters={status.deadLetters} lifecycle={status.lifecycle} />

      <h2 style={subheading}>Catalogue and Amazon history sources</h2>
      <TableFrame><table style={table}><thead><tr><th style={th}>Profile</th><th style={th}>Marketplace</th><th style={th}>Family</th><th style={th}>Gate</th><th style={th}>Covered window</th><th style={th}>Source age</th><th style={th}>Source rows</th><th style={th}>Verified rows</th><th style={th}>Cursor</th></tr></thead><tbody>
        {status.catalogue.map((row)=><tr key={`${row.profileLabel}:${row.marketplaceId}:${row.family}:${row.selectorKey??'unselected'}`} data-testid="catalogue-source-row"><td style={td}>{row.profileLabel}</td><td style={td}>{row.marketplaceId}</td><td style={td}>{row.family}</td><td style={td}>{row.enabled&&row.reportingRecoveryVerified?'enabled':row.reportingRecoveryVerified?'source off':'recovery unverified'}</td><td style={td}>{row.coveredFrom&&row.coveredThrough?`${formatTimestamp(row.coveredFrom)} – ${formatTimestamp(row.coveredThrough)}`:'Not measured'}</td><td style={td}>{formatTimestamp(row.observedAt)}</td><td style={td}>{row.sourceRows??'Unavailable'}</td><td style={td}>{row.loadedRows??'Unavailable'}</td><td style={{...td,color:row.cursorFailure?colors.bad:undefined}}>{row.cursorFailure??(row.loadedRows===null?'Not run':'ok')}</td></tr>)}
      </tbody></table></TableFrame>
      {status.catalogue.length===0?<ScreenState variant="not-measured" title="Catalogue sources not provisioned" body="Product Metadata, Product Eligibility, Validation Configurations and Change History remain unavailable until an operator provisions their disabled gates."/>:null}

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
