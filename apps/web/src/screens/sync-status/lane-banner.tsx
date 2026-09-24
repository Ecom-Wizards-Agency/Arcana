import type { ReportLaneErrorClass, ReportLaneStage, ReportLaneStatus } from '@wizard-ads/shared';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import { TableFrame } from '../../ui/primitives';
import { colors, muted, subheading, table, td, th } from '../../ui/tokens';

/** Operator-facing meaning of each bounded error class. Never provider or SQL text. */
export const REPORT_LANE_ERROR_LABELS: Readonly<Record<ReportLaneErrorClass, string>> = {
  create_outcome_unknown: 'Amazon may have received the request; its outcome needs attended reconciliation',
  provider_throttled: 'Amazon rate limit',
  provider_auth: 'Amazon authorization failed',
  provider_unavailable: 'Amazon did not answer',
  report_failed: 'Amazon reported the report as failed',
  report_timeout: 'The report did not finish within 4 hours',
  download_url_expired: 'The download link expired before the download',
  download_url_rejected: 'Report storage rejected the download link',
  download_transport: 'The download was interrupted',
  download_timeout: 'The download timed out',
  download_compressed_limit: 'The download exceeded the compressed size limit',
  download_inflate_limit: 'The download exceeded the decompressed size limit',
  payload_format: 'The downloaded file is not a report',
  payload_corrupt: 'The downloaded file was corrupt or truncated',
  parser_limit: 'A report row or the row count exceeded a parser limit',
  parser_refused_rows: 'The parser refused report rows',
  count_mismatch: 'Row counts did not reconcile',
  load_failed: 'Loading facts into the database failed',
  store_failed: 'Recording the report job in the database failed',
  retry_budget_exhausted: 'Retries were exhausted',
  unclassified: 'Unclassified failure; see the private worker log',
};

const STAGE_MEANING: Readonly<Record<ReportLaneStage, string>> = {
  request: 'asking Amazon for a report',
  poll: 'waiting for Amazon to finish it',
  fetch: 'downloading and parsing it',
  load: 'writing its rows to facts',
};

function newestFactDate(dates: readonly (string | null)[]): string | null {
  const measured = dates.filter((date): date is string => date !== null).sort();
  return measured.at(-1) ?? null;
}

/**
 * The freshness banner: which report stage stops new facts, and the bounded
 * class of its last error. Stage counts follow the selected profile; the dead
 * summary always covers the whole organisation and says so.
 */
export function ReportLaneBanner({ lane, factDates }: {
  lane: ReportLaneStatus;
  /** Newest fact date per profile shown; null means that profile has no facts yet. */
  factDates: readonly (string | null)[];
}) {
  const { blocking, organisationDead: dead } = lane;
  const newest = newestFactDate(factDates);
  const scope = lane.scope === 'profile' ? 'the selected profile' : 'every profile';
  return (
    <section aria-label="Report lane" data-testid="report-lane">
      <h2 style={subheading}>Report lane</h2>
      {blocking ? (
        <div role="alert" data-testid="report-lane-blocking" style={{ color: colors.bad }}>
          <strong>Reports are blocked at the {blocking.stage} stage</strong> ({STAGE_MEANING[blocking.stage]}).{' '}
          Last error class: <code data-testid="report-lane-error-class">{blocking.errorClass}</code>{' '}
          ({REPORT_LANE_ERROR_LABELS[blocking.errorClass]}), recorded {formatTimestamp(blocking.since)}.{' '}
          The {blocking.stage} stage last succeeded{' '}
          {blocking.lastSucceededAt === null ? 'never' : formatTimestamp(blocking.lastSucceededAt)}.{' '}
          Newest facts: {newest === null ? 'none yet' : formatShellDate(newest)}.
        </div>
      ) : (
        <p style={muted} data-testid="report-lane-clear">
          No report stage is blocked for {scope}: each stage&apos;s latest failure is older than its latest success.
        </p>
      )}
      <p style={muted} data-testid="report-lane-dead">
        Dead report jobs across the organisation: {dead.total} (request {dead.byStage.request}, poll{' '}
        {dead.byStage.poll}, fetch {dead.byStage.fetch}, load {dead.byStage.load}). Of these,{' '}
        {dead.reRequested} were re-requested automatically and {dead.resolved} were resolved through
        reconciliation.
      </p>
      <TableFrame><table style={table}>
        <caption style={{ ...muted, textAlign: 'left' }}>Report stages for {scope}</caption>
        <thead>
          <tr>
            <th style={th}>Stage</th>
            <th style={th}>Last succeeded</th>
            <th style={th}>Last failed</th>
            <th style={th}>Last error class</th>
            <th style={th}>Retrying</th>
            <th style={th}>Dead</th>
          </tr>
        </thead>
        <tbody>
          {lane.stages.map((stage) => (
            <tr key={stage.stage} data-testid="report-lane-stage">
              <td style={td}>{stage.stage}</td>
              <td style={td}>{stage.lastSucceededAt === null ? 'never' : formatTimestamp(stage.lastSucceededAt)}</td>
              <td style={td}>{stage.lastFailedAt === null ? 'no failure recorded' : formatTimestamp(stage.lastFailedAt)}</td>
              <td style={td}>{stage.lastErrorClass ?? '—'}</td>
              <td style={td}>{stage.retrying}</td>
              <td style={{ ...td, color: stage.dead > 0 ? colors.bad : undefined }}>{stage.dead}</td>
            </tr>
          ))}
        </tbody>
      </table></TableFrame>
    </section>
  );
}
