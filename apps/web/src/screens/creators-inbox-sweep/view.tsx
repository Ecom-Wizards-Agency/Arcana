import type { CreatorSweepRun, CreatorSweepSnapshot, CreatorThreadOutcome } from '@wizard-ads/shared';
import { TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import { EmptyState } from '../../ui/primitives';
import { CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, NotImported, count, lastRead, sweepRead } from '../creators-daily-queue/creator-frame';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const OUTCOME_LABEL: Record<CreatorThreadOutcome, string> = {
  unchanged: 'Unchanged', actioned: 'Actioned', held: 'Held', escalated: 'Escalated', unmatched: 'Unmatched', unopened: 'Not opened', unclassified: 'Not classified',
};

/** `threads enumerated = unchanged + actioned + held/escalated`, with unmatched required to be zero. */
function Equation({ sweep }: { sweep: CreatorSweepRun }) {
  const c = sweep.counts;
  const sum = c.noActionAcknowledgements + c.changed + c.heldOrEscalated + c.unmatched;
  return <p data-testid="sweep-equation">
    <strong>{count(c.mounted)}</strong> enumerated {sum === c.mounted ? '=' : '≠'} {count(c.noActionAcknowledgements)} no-action + {count(c.changed)} changed
    {' '}+ {count(c.heldOrEscalated)} held or escalated + {count(c.unmatched)} unmatched{sum === c.mounted ? '' : ` (${count(sum)})`}.
    {' '}{c.unmatched === 0 ? 'Every thread resolved to one record.' : `${count(c.unmatched)} ${c.unmatched === 1 ? 'thread' : 'threads'} could not match, and a sweep reconciles only at zero.`}
  </p>;
}

function Counts({ sweep }: { sweep: CreatorSweepRun }) {
  const c = sweep.counts;
  const rows: [string, number, string][] = [
    ['Threads mounted', c.mounted, 'The final count after scrolling the list to its true end; the first load mounts about a hundred.'],
    ['Threads opened', c.opened, 'Read through the newest message. An archived thread whose newest message is unchanged may be skipped.'],
    ['Changed threads', c.changed, 'The newest-message signature differed from the checkpoint, so every later message was processed.'],
    ['Messages examined', c.messagesExamined, 'Every message after each changed thread\'s checkpoint.'],
    ['Messages sent', c.messagesSent, 'Replies sent in this run, each approved one thread at a time.'],
    ['No-action acknowledgements', c.noActionAcknowledgements, 'Threads read and left as they were.'],
    ['Held or escalated', c.heldOrEscalated, 'Explicitly held, or escalated for the operator.'],
    ['Archived spam', c.archivedSpam, `A subset of the ${count(c.changed)} changed threads, not a fourth term.`],
    ['Unmatched', c.unmatched, 'No single record: a display name alone never resolves one.'],
  ];
  return <TableFrame><table className="wa-table" aria-label="The nine run counts">
    <thead><tr><th>Count</th><th className="wa-num" data-numeric="true">Threads</th><th>What it means</th></tr></thead>
    <tbody>{rows.map(([label, value, note]) => <tr key={label} data-testid="sweep-count"><td>{label}</td><td className="wa-num" data-numeric="true">{count(value)}</td><td>{note}</td></tr>)}</tbody>
  </table></TableFrame>;
}

function ReadySweep({ snapshot }: { snapshot: CreatorSweepSnapshot }) {
  const { latest, previous, lastImport } = snapshot;
  const subtitle = <>{latest ? <>Run {formatTimestamp(latest.completedAt)}{latest.brand ? <> · {latest.brand}</> : null}
    {latest.evidenceReference ? <> · evidence {latest.evidenceReference}</> : null} · </> : null}{lastRead(lastImport)}</>;
  const head = <CreatorHeader title="Inbox sweep" subtitle={subtitle} />;
  if (lastImport?.status === 'failed') {
    return <main className="wa-stack" data-testid="creator-sweep"><CreatorHeader title="Inbox sweep" subtitle={lastRead(lastImport)} />
      <ImportRefusal run={lastImport} withheld={latest ? `The sweep of ${formatShellDate(latest.runDate)} is not shown, because it would read as today's.` : 'No sweep is shown.'} />
    </main>;
  }
  const read = sweepRead(lastImport);
  if (read === 'not-produced') {
    const invalid = lastImport?.counts.sweep_runs?.invalid ?? 0;
    return <main className="wa-stack" data-testid="creator-sweep"><CreatorHeader title="Inbox sweep" subtitle={lastRead(lastImport)} />
      <EmptyState variant="not-measured" data-creator-state="sweep-not-produced" title="No sweep checkpoint read"
        body={<>The last import found a sweep file but could not read it as a checkpoint ({count(invalid)} counted invalid), so how the thread list was
          drained is not measured.{latest ? ' The older sweep is not shown as current.' : ''} It is not zero.</>}
        meta="The checkpoint file is a proposed contract: the skill does not write it yet." /></main>;
  }
  if (latest === null || read === 'absent') {
    return <main className="wa-stack" data-testid="creator-sweep"><CreatorHeader title="Inbox sweep" subtitle={lastRead(lastImport)} />
      <NotImported what="how the thread list was drained" file="sweep checkpoint" run={lastImport} /></main>;
  }
  const shown = latest.unresolved.length;
  const unresolvedTotal = latest.counts.unmatched;
  return <main className="wa-stack" data-testid="creator-sweep">
    {head}
    <section data-testid="sweep-verdict" className={`wa-banner wa-banner--${latest.reconciled ? 'good' : 'warn'}`} style={{ display: 'block' }}>
      <strong>{latest.reconciled ? 'This sweep reconciled.' : 'This sweep did not reconcile.'}</strong>{' '}
      {latest.reconciled ? 'Every mounted thread is accounted for and none is unmatched.' : 'Do not report it as complete until every count below balances and unmatched is zero.'}
    </section>
    <Equation sweep={latest} />
    <h2 className="wa-section-title">How the thread list was drained</h2>
    <Counts sweep={latest} />
    {latest.outcomes === null
      ? <p className="wa-page-sub" data-testid="sweep-outcomes">The checkpoint listed no per-thread outcomes, so the thread breakdown is not measured.</p>
      : <p className="wa-page-sub" data-testid="sweep-outcomes">Per-thread checkpoint: {(Object.keys(OUTCOME_LABEL) as CreatorThreadOutcome[])
        .map((outcome) => `${count(latest.outcomes![outcome])} ${OUTCOME_LABEL[outcome].toLowerCase()}`).join(' · ')}.</p>}
    <h2 className="wa-section-title">What it could not match</h2>
    {unresolvedTotal === 0 && shown === 0 ? <p className="wa-page-sub">Nothing: every thread resolved to one record.</p> : <>
      <p className="wa-page-sub" data-testid="unmatched-summary">{shown === 0
        ? `${count(unresolvedTotal)} unmatched, but the checkpoint named no threads. Their fingerprints are not measured.`
        : `${count(shown)} of ${count(Math.max(unresolvedTotal, shown))} listed by thread fingerprint. Raw thread titles and names never leave the browser.`}</p>
      {shown > 0 ? <TableFrame><table className="wa-table">
        <thead><tr><th>Thread fingerprint</th><th>Newest message</th><th>Outcome</th><th>Why</th></tr></thead>
        <tbody>{latest.unresolved.map((thread) => <tr key={thread.threadKey} data-testid="unmatched-thread">
          <td><code title={thread.threadKey}>{thread.threadKey.slice(0, 12)}…</code></td>
          <td>{thread.amazonTimestamp === null ? 'Not recorded' : `Amazon · ${formatTimestamp(thread.amazonTimestamp)}`}</td>
          <td>{OUTCOME_LABEL[thread.outcome]}</td><td>{thread.reason ?? 'No reason recorded'}</td></tr>)}</tbody>
      </table></TableFrame> : null}
    </>}
    {previous ? <p className="wa-page-sub" data-testid="previous-sweep">Previous run {formatTimestamp(previous.completedAt)}: {count(previous.counts.mounted)} mounted,
      {' '}{count(previous.counts.unmatched)} unmatched, {previous.reconciled ? 'reconciled' : 'did not reconcile'}.</p> : null}
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadySweep snapshot={data.props.snapshot} />;
    case 'gated': return <main className="wa-stack"><CreatorHeader title="Inbox sweep" subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title="Inbox sweep" message={data.props.message} />;
  }
}
