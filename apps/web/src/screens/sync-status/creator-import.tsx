import type { CreatorImportKind, CreatorImportRun } from '@wizard-ads/shared';
import { TableFrame } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';
import { colors, muted, subheading, table, td, th } from '../../ui/tokens';

const KIND_LABEL: Record<CreatorImportKind, string> = {
  records: 'Creator records', action_log: 'Action log', queue_items: 'Queue items', sweep_runs: 'Sweep runs', sample_shipments: 'Sample shipments',
};
const COLUMNS = ['read', 'valid', 'invalid', 'inserted', 'updated', 'unchanged', 'removed'] as const;

/** The latest `creators:import` run: what it read, refused and wrote, per kind. A kind whose file was absent is not measured. */
export function CreatorImportCounters({ run }: { run: CreatorImportRun | null | undefined }) {
  return <section aria-label="Creator Connections import" data-testid="creator-import">
    <h2 style={subheading}>Creator Connections import</h2>
    {run === null || run === undefined
      ? <p style={muted}>No control-runner import is visible here: none has run, or your role cannot see Creator Connections. Its counters are not measured.</p>
      : <>
        <p style={{ ...muted, color: run.status === 'failed' ? colors.bad : undefined }} data-testid="creator-import-status">
          {run.status === 'failed' ? `Failed ${formatTimestamp(run.finishedAt)}: ${run.failure}${run.failedFile ? ` (${run.failedFile})` : ''}. Nothing was written.`
            : `Succeeded ${formatTimestamp(run.finishedAt)} from ${run.files.join(', ')}.`}
        </p>
        <TableFrame><table style={table}>
          <thead><tr><th style={th}>Kind</th>{COLUMNS.map((column) => <th key={column} style={th}>{column[0]!.toUpperCase() + column.slice(1)}</th>)}</tr></thead>
          <tbody>{(Object.keys(KIND_LABEL) as CreatorImportKind[]).map((kind) => {
            const counts = run.counts[kind];
            return <tr key={kind} data-testid="creator-import-row">
              <td style={td}>{KIND_LABEL[kind]}</td>
              {counts === null
                ? <td style={td} colSpan={COLUMNS.length}>Not measured: {run.status === 'failed' ? 'the run failed' : 'no file for it'}</td>
                : COLUMNS.map((column) => <td key={column} style={{ ...td, color: column === 'invalid' && counts.invalid > 0 ? colors.bad : undefined }}>{counts[column]}</td>)}
            </tr>;
          })}</tbody>
        </table></TableFrame>
      </>}
  </section>;
}
