import type { CreatorImportKind, CreatorImportRun } from '@wizard-ads/shared';
import { TableFrame } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';
import { colors, muted, subheading, table, td, th } from '../../ui/tokens';

const KIND_LABEL: Record<CreatorImportKind, string> = {
  records: 'Creator records', action_log: 'Action log', queue_items: 'Queue items', sweep_runs: 'Sweep runs', sample_shipments: 'Sample shipments', preflights: 'Pre-flights',
};
const COLUMNS = ['read', 'valid', 'invalid', 'inserted', 'updated', 'unchanged', 'skipped', 'removed'] as const;
const COLUMN_TITLE: Partial<Record<(typeof COLUMNS)[number], string>> = { skipped: 'Valid rows left untouched on purpose: Arcana-owned sample lanes' };

/** Live sealed-address custody that should already be gone (DESIGN §4.4); both counts must be 0. */
export interface CreatorMcfResidue { expiredLive: number; custodyFreeLive: number }

/**
 * The latest `creators:import` run: what it read, refused, wrote and skipped, per kind, and the MCF custody residue.
 * `residue` undefined or null: not measured (no grant visibility, or the read failed), never 0.
 */
export function CreatorImportCounters({ run, residue }: { run: CreatorImportRun | null | undefined; residue?: CreatorMcfResidue | null }) {
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
          <thead><tr><th style={th}>Kind</th>{COLUMNS.map((column) => <th key={column} style={th} title={COLUMN_TITLE[column]}>{column[0]!.toUpperCase() + column.slice(1)}</th>)}</tr></thead>
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
        <p style={muted} data-testid="creator-import-skipped">{run.counts.sample_shipments === null
          ? 'Arcana-owned lanes left unchanged: not measured, because no sample lane file was read.'
          : `Arcana-owned lanes left unchanged: ${run.counts.sample_shipments.skipped}. The runner's file named them; Arcana's send ledger owns them.`}</p>
      </>}
    <p style={{ ...muted, color: residue != null && residue.expiredLive + residue.custodyFreeLive > 0 ? colors.bad : undefined }} data-testid="creator-mcf-residue"
      data-residue={residue == null ? 'not-measured' : String(residue.expiredLive + residue.custodyFreeLive)}>
      {residue == null
        ? 'Sealed-address custody residue: not measured.'
        : `Sealed-address custody residue: ${residue.expiredLive} past expiry, ${residue.custodyFreeLive} behind a send that should hold none. Both should be 0.`}</p>
  </section>;
}
