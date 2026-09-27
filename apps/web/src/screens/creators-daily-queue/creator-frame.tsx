/**
 * Furniture shared by the three Creator Connections screens: the heading with
 * its `Run by hand` chip, the last-read line, and the refusal a failed read
 * produces. Creators here are Amazon Creator Connections creators; `Creatives`
 * elsewhere in the product are Sponsored Brands video assets.
 */
import type { ReactNode } from 'react';
import type { CreatorImportFailure, CreatorImportFile, CreatorImportRun } from '@wizard-ads/shared';
import { EmptyState, PageHeader, StatusChip } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';

/** Why the chip applies: the procedure, the durable record, and no Amazon surface that runs it. */
export const RUN_BY_HAND_NOTE = 'Run by hand: the amazon-creator-connections skill runs this procedure in a browser, '
  + 'and the values come from the control runner\'s files. Arcana imports them; it runs nothing in Amazon.';

export function CreatorHeader({ title, subtitle, children }: { title: string; subtitle: ReactNode; children?: ReactNode }) {
  return <PageHeader title={<>{title} <StatusChip status="run-by-hand" title={RUN_BY_HAND_NOTE} /></>} subtitle={subtitle}
    meta={children} />;
}

const FILE_LABEL: Record<CreatorImportFile, string> = {
  registry: 'registry cache', queue: 'queue output', sweep_checkpoint: 'sweep checkpoint', mcf_reservations: 'MCF reservation list',
};
const FAILURE: Record<CreatorImportFailure, string> = {
  directory_unreadable: 'the import could not open its directory',
  no_runner_files: 'the directory held none of the four runner files',
  file_unreadable: 'a runner file could not be read as JSON',
  file_shape_invalid: 'a runner file did not have the shape the runner writes',
  database_write_failed: 'the files were read, but writing them failed and nothing was kept',
};

export function lastRead(run: CreatorImportRun | null): string {
  if (run === null) return 'Nothing imported yet';
  return `Last read ${formatTimestamp(run.finishedAt)}${run.status === 'failed' ? ' (failed)' : ''}`;
}

/** The tracker refusing: the last read failed, so nothing on this screen may pass for today's. */
export function ImportRefusal({ run, withheld }: { run: CreatorImportRun; withheld: string }) {
  const file = run.failedFile === null ? '' : ` (${FILE_LABEL[run.failedFile]})`;
  return <EmptyState variant="error" data-creator-state="refused" title="Nothing was read"
    body={<>The import at {formatTimestamp(run.finishedAt)} stopped because {FAILURE[run.failure ?? 'file_unreadable']}{file}. {withheld}</>}
    meta="Fix the runner output and run creators:import again. Earlier rows are kept, not shown as current." />;
}

/** Nothing supplied this screen's file: no import at all, or an import that did not read it. Not measured, and not zero. */
export function NotImported({ what, file, run }: { what: string; file: string; run: CreatorImportRun | null }) {
  return <EmptyState variant="not-measured" data-creator-state="not-imported" title={run === null ? 'Nothing imported yet' : `No ${file} read`}
    body={run === null
      ? <>No control-runner files have been imported for this organisation, so {what} is not measured. It is not zero.</>
      : <>The import at {formatTimestamp(run.finishedAt)} read no {file}, so {what} is not measured. It is not zero.</>}
    meta="Run creators:import with the directory the runner writes to." />;
}

/**
 * Whether the latest import supplied a sweep. The sweep checkpoint is a proposed
 * file nothing produces yet; an import that skipped it must not let an older
 * sweep pass for the current one.
 */
export function sweepRead(run: CreatorImportRun | null): 'read' | 'absent' | 'not-produced' | 'no-import' {
  if (run === null) return 'no-import';
  const counts = run.counts.sweep_runs;
  if (counts === null) return 'absent';
  return counts.valid > 0 ? 'read' : 'not-produced';
}

export function CreatorGated() {
  return <EmptyState variant="gated" data-creator-state="gated" title="Owners, admins and analysts only"
    body="Creator Connections records are visible to owners, admins and analysts of this organisation." />;
}

export function CreatorLoadError({ title, message }: { title: string; message: string }) {
  return <main className="wa-stack"><PageHeader title={title} /><EmptyState variant="error" title="Could not load this screen" body={message} /></main>;
}

/** `8 / 10` with the one missing check that matters most, and a count for the rest. */
export function MissingChecks({ missing }: { missing: readonly string[] }) {
  if (missing.length === 0) return <span className="wa-page-sub">none</span>;
  const [first, ...rest] = missing;
  return <span><span className="wa-badge" data-missing={first}>{first!.replaceAll('_', ' ')}</span>{rest.length ? <span className="wa-page-sub"> +{rest.length}</span> : null}</span>;
}

export const count = (value: number) => new Intl.NumberFormat('en-GB').format(value);
