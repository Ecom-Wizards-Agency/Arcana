/**
 * Furniture shared by the three Creator Connections screens: the heading with
 * its `Run by hand` chip, the last-read line, and the refusal a failed read
 * produces. Creators here are Amazon Creator Connections creators; `Creatives`
 * elsewhere in the product are Sponsored Brands video assets.
 */
import type { ReactNode } from 'react';
import {
  CREATOR_QUALIFICATION_CHECKS, type CreatorActionKind, type CreatorFingerprintClass, type CreatorImportFailure, type CreatorImportFile,
  type CreatorImportRun, type CreatorLockState, type CreatorQualificationCheck, type CreatorSource,
} from '@wizard-ads/shared';
import { Badge, EmptyState, PageHeader, StatusChip } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';

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

/** A fingerprint is shown as its first eight hex characters and never in full. */
export const shortFingerprint = (fingerprint: string) => `${fingerprint.slice(0, 8)}…`;
export const checkLabel = (check: CreatorQualificationCheck) => check.replaceAll('_', ' ');

export const FINGERPRINT_CLASS_LABEL: Record<CreatorFingerprintClass, string> = {
  storefront: 'storefront', thread: 'thread', fullName: 'full name', email: 'email', phone: 'phone', address: 'address',
};

export const SOURCE_LABEL: Record<CreatorSource, string> = { 'control-runner': 'runner file import', mcp: 'creator:write key', web: 'Arcana' };

/** Action-log kinds in words. */
export const ACTION_WORDS: Record<CreatorActionKind, string> = {
  identity_conflict_locked: 'Locked in Conflict with another record', mcf_reserved: 'Sample order reserved',
  mcf_screen_verified: 'MCF order screen verified before submit', mcf_reconciliation_required: 'Submit was ambiguous: reconciliation required',
  sample_confirmed: 'Sample confirmed', mcf_reservation_cancelled: 'Sample reservation cancelled', identity_resolved: 'Identity resolved',
  score_recorded: 'Qualification score recorded', message_sent_by_hand: 'Message sent by hand in Amazon', status_moved: 'Tracker status moved',
  content_verified: 'Content verified', escalated: 'Escalated', preflight_recorded: 'Sample pre-flight recorded',
  draft_submitted: 'Reply draft submitted', draft_approved: 'Reply draft approved', draft_sent_by_hand: 'Reply marked sent by hand',
  draft_withdrawn: 'Reply draft withdrawn',
};

export function LockBadge({ lock }: { lock: CreatorLockState | null }) {
  if (lock === null || lock === 'Unlocked') return null;
  return <Badge tone={lock === 'Conflict' ? 'bad' : 'warn'} data-lock={lock}>{lock}</Badge>;
}

/** All ten checks in the runner's order, each passed or missing. `missing` is the runner's own list. */
export function TenChecks({ missing }: { missing: readonly CreatorQualificationCheck[] }) {
  return <ol className="wa-stack" data-testid="ten-checks" style={{ listStyle: 'none', margin: 0, padding: 0, gap: '0.25rem' }}>
    {CREATOR_QUALIFICATION_CHECKS.map((check) => {
      const passed = !missing.includes(check);
      return <li key={check} data-check={check} data-passed={passed ? 'true' : 'false'}>
        <Badge tone={passed ? 'good' : 'bad'}>{passed ? 'passed' : 'missing'}</Badge> {checkLabel(check)}</li>;
    })}
  </ol>;
}

/**
 * The computed score beside the tracker's typed one. A computed score that was
 * never measured is said so, never drawn as 0 / 10; a tracker score nobody
 * reported is said so too.
 */
export function ScoreAgreement({ computed, tracker }: { computed: number | null; tracker: { score: number; scoredOn: string } | null }) {
  if (tracker === null) return <p className="wa-page-sub" data-testid="score-agreement" data-agreement="no-tracker-score">No tracker score reported.</p>;
  const typed = <>The tracker says <strong>{tracker.score} / 10</strong> (scored {formatShellDate(tracker.scoredOn)})</>;
  if (computed === null) {
    return <p className="wa-page-sub" data-testid="score-agreement" data-agreement="not-measured">{typed}; the computed score is not measured, so the two cannot be compared.</p>;
  }
  if (computed === tracker.score) return <p className="wa-page-sub" data-testid="score-agreement" data-agreement="agrees">{typed}, and the runner agrees.</p>;
  return <p className="wa-banner wa-banner--warn" data-testid="score-agreement" data-agreement="disagrees" style={{ display: 'block' }}>
    <strong>The score disagrees.</strong> {typed}; the runner computes <strong>{computed} / 10</strong> from the checks. The tracker is not changed here.</p>;
}

export const DRAFT_STATUS_WORDS = {
  draft: 'Awaiting approval', approved: 'Approved: to send by hand', sent_by_hand: 'Sent by hand', withdrawn: 'Withdrawn',
} as const;
export const DRAFT_STATUS_TONE = { draft: 'info', approved: 'good', sent_by_hand: 'neutral', withdrawn: 'neutral' } as const;

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="wa-section-head"><h2 className="wa-section-title">{title}{children === undefined ? null : <> <span className="wa-page-sub">{children}</span></>}</h2></div>;
}
