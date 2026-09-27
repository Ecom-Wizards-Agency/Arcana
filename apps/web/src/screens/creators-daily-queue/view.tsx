import type { CreatorDailyQueueItem, CreatorIdleGroup, CreatorImportRun, CreatorQueueSnapshot, CreatorSweepRun, CreatorTrackerScore } from '@wizard-ads/shared';
import { Badge, EmptyState, TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import {
  CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, MissingChecks, NotImported, ScoreAgreement, TenChecks, count, lastRead, sweepRead,
} from './creator-frame';
import { ACTION_LABEL, groupByAction, orderIdleGroups, queueTiles, recordsWithoutAction } from './queue-summary';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const GATE_TONE = { BLOCKED: 'bad', HOLD: 'warn', PENDING_APPROVAL: 'info' } as const;

function Tile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return <div className="wa-kpi-mini" data-testid={testId}><strong>{count(value)}</strong><span>{label}</span></div>;
}

/** The sweep counts strip: the last run's nine counts, from its checkpoint, only when the latest import read one. */
export function SweepStrip({ sweep, lastImport }: { sweep: CreatorSweepRun | null; lastImport: CreatorImportRun | null }) {
  const read = sweepRead(lastImport);
  if (sweep === null || read === 'absent' || read === 'not-produced') {
    return <p className="wa-page-sub" data-testid="sweep-strip">{read === 'not-produced'
      ? 'The last import found a sweep file it could not read as a checkpoint, so the sweep counts are not measured.'
      : 'No inbox sweep came with the last import, so the sweep counts are not measured.'}</p>;
  }
  const c = sweep.counts;
  const cells: [string, number][] = [['mounted', c.mounted], ['opened', c.opened], ['changed', c.changed], ['messages examined', c.messagesExamined],
    ['sent', c.messagesSent], ['no-action', c.noActionAcknowledgements], ['held or escalated', c.heldOrEscalated], ['archived spam', c.archivedSpam],
    ['unmatched', c.unmatched]];
  return <section aria-label="Last inbox sweep" data-testid="sweep-strip" className={`wa-banner wa-banner--${sweep.reconciled ? 'good' : 'warn'}`}
    style={{ flexDirection: 'column', gap: '0.375rem' }}>
    <div><strong>{sweep.reconciled ? 'The last sweep reconciled' : 'The last sweep did not reconcile'}</strong>
      <span> · run {formatTimestamp(sweep.completedAt)} · from the run checkpoint{sweep.evidenceReference ? ` ${sweep.evidenceReference}` : ''} · </span>
      <a href="/creators/sweep">Inbox sweep</a></div>
    <div className="wa-row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
      {cells.map(([label, value]) => <span key={label} data-sweep-count={label}><strong>{count(value)}</strong> {label}</span>)}
    </div>
  </section>;
}

/** The row opened in place (444:301): the ten checks, the score that disagrees, and where to go next. No client state. */
function OpenedRow({ item, tracker }: { item: CreatorDailyQueueItem & { creatorRecordId: string }; tracker: CreatorTrackerScore | undefined }) {
  const id = item.creatorRecordId;
  return <details data-testid="queue-row-open" data-record={id}>
    <summary>{id}</summary>
    <div className="wa-stack" style={{ gap: '0.5rem', marginTop: '0.5rem', minWidth: '16rem' }}>
      <TenChecks missing={item.missing} />
      <p><strong>{item.computedScore} / 10</strong> computed by the runner.</p>
      <ScoreAgreement computed={item.computedScore} tracker={tracker === undefined ? null : { score: tracker.trackerScore, scoredOn: tracker.scoredOn }} />
      <p className="wa-row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
        <a href={`/creators/records/${id}`} data-testid="open-record">Open the record</a>
        {item.lockState === 'Conflict' ? <a href={`/creators/conflicts/${id}`} data-testid="open-conflict">Open the conflict</a> : null}
        {item.gateResult === 'PENDING_APPROVAL' ? <a href="/creators/drafts" data-testid="open-drafts">The day's reply drafts</a> : null}
      </p>
    </div>
  </details>;
}

function QueueRow({ item, tracker }: { item: CreatorDailyQueueItem; tracker: CreatorTrackerScore | undefined }) {
  return <tr data-testid="queue-row" data-action={item.actionType}>
    <td>{item.creatorRecordId === null ? <em>Unresolved thread</em> : <OpenedRow item={{ ...item, creatorRecordId: item.creatorRecordId }} tracker={tracker} />}
      {item.lockState === 'Conflict' || item.lockState === 'Locked for MCF'
      ? <> <Badge tone={item.lockState === 'Conflict' ? 'bad' : 'warn'} data-lock={item.lockState}>{item.lockState}</Badge></> : null}</td>
    <td>{item.currentStatus || <span className="wa-page-sub">no status</span>}</td>
    <td><Badge tone={GATE_TONE[item.gateResult]}>{item.gateResult}</Badge></td>
    <td>{item.queueState}</td>
    <td>{formatShellDate(item.dueDate)}</td>
    <td className="wa-num" data-numeric="true">{item.computedScore} / 10</td>
    <td><MissingChecks missing={item.missing} /></td>
    <td style={{ overflowWrap: 'anywhere' }}>{item.reason}</td>
  </tr>;
}

/**
 * The records that produced no action (444:2), by the tracker status last
 * reported for them. A label outside the tracker's dropdown gets its own
 * refusal group, never a stage; a status never reported is not measured.
 */
export function IdleGroups({ groups }: { groups: readonly CreatorIdleGroup[] }) {
  if (groups.length === 0) return null;
  const { recognised, unrecognised, unreported } = orderIdleGroups(groups);
  const records = (n: number) => `${count(n)} ${n === 1 ? 'record' : 'records'}`;
  return <section aria-label="Records that produced no action" data-testid="idle-groups" className="wa-stack">
    <div className="wa-section-head"><h2 className="wa-section-title">Records that produced no action, by status</h2></div>
    {recognised.length > 0 ? <TableFrame><table className="wa-table">
      <thead><tr><th>Tracker status</th><th data-numeric="true">Records</th></tr></thead>
      <tbody>{recognised.map((group) => <tr key={group.status} data-testid="idle-group" data-status={group.status!}>
        <td>{group.status}</td><td className="wa-num" data-numeric="true">{count(group.records)}</td></tr>)}</tbody>
    </table></TableFrame> : null}
    {unrecognised.length > 0 ? <div className="wa-banner wa-banner--bad" data-testid="idle-unrecognised" style={{ display: 'block' }}>
      <strong>Not in the tracker's dropdown.</strong> The status vocabulary is closed, so these labels are refused rather than read as a new stage.
      <ul style={{ margin: '0.375rem 0 0', paddingLeft: '1.25rem' }}>{unrecognised.map((group) => <li key={group.status} data-testid="idle-refused" data-status={group.status!}>
        <code>{group.status}</code>: {records(group.records)}</li>)}</ul>
    </div> : null}
    {unreported !== null ? <p className="wa-page-sub" data-testid="idle-unreported">Status not reported: {records(unreported.records)}.
      {' '}No tracker status has been reported for {unreported.records === 1 ? 'it' : 'them'}, so {unreported.records === 1 ? 'its' : 'their'} stage is not measured.</p> : null}
  </section>;
}

function ReadyQueue({ snapshot }: { snapshot: CreatorQueueSnapshot }) {
  const { lastImport, runDate, items } = snapshot;
  const brands = [...new Set(items.map((item) => item.brand).filter(Boolean))];
  const subtitle = <>Daily Action Queue{runDate ? <> · {formatShellDate(runDate)}</> : null} · {lastRead(lastImport)}
    {brands.length === 1 ? <> · {brands[0]}</> : null}</>;
  if (lastImport?.status === 'failed') {
    // Refusing means naming no day and no brand: only the failed read.
    return <main className="wa-stack" data-testid="creator-queue"><CreatorHeader title="Creator queue" subtitle={<>Daily Action Queue · {lastRead(lastImport)}</>} />
      <ImportRefusal run={lastImport} withheld={runDate ? `The queue for ${formatShellDate(runDate)} is not shown, because it would read as today's.` : 'No queue is shown.'} />
    </main>;
  }
  if (runDate === null) {
    return <main className="wa-stack" data-testid="creator-queue"><CreatorHeader title="Creator queue" subtitle={subtitle} />
      <NotImported what="the day's work" file="queue output" run={lastImport} /></main>;
  }
  const tiles = queueTiles(items);
  const trackers = new Map(snapshot.trackerScores.map((score) => [score.creatorRecordId, score]));
  const day = formatShellDate(runDate);
  const idle = recordsWithoutAction(items, snapshot.registryRecords);
  return <main className="wa-stack" data-testid="creator-queue">
    <CreatorHeader title="Creator queue" subtitle={subtitle} />
    <SweepStrip sweep={snapshot.sweep} lastImport={lastImport} />
    {items.length === 0
      ? <EmptyState variant="empty" data-creator-state="worked-to-zero" title="Worked to zero"
        body={<>The queue for {day} holds no actions. {count(idle)} {idle === 1 ? 'record' : 'records'} on the registry did not move.</>}
        meta={lastRead(lastImport)} />
      : <>
        <div className="wa-kpi-strip" aria-label="Queue totals">
          <Tile label="In the queue" value={tiles.total} testId="tile-total" />
          <Tile label="Awaiting your approval" value={tiles.awaitingApproval} testId="tile-approval" />
          <Tile label="Held or blocked" value={tiles.heldOrBlocked} testId="tile-held" />
          <Tile label="Locked" value={tiles.locked} testId="tile-locked" />
        </div>
        <p className="wa-page-sub" data-testid="queue-states">{count(tiles.queued)} queued · {count(tiles.escalated)} escalated.
          {' '}A queue item never grants send authority: every message waits for approval one thread at a time.</p>
        {groupByAction(items).map((group) => <section key={group.action} aria-label={ACTION_LABEL[group.action]} data-testid="queue-group" data-action={group.action}>
          <div className="wa-section-head"><h2 className="wa-section-title">{ACTION_LABEL[group.action]} <span className="wa-page-sub">{count(group.items.length)}</span></h2></div>
          <TableFrame><table className="wa-table">
            <thead><tr><th>Record</th><th style={{ minWidth: 176 }}>Status</th><th>Gate</th><th>State</th><th>Due</th><th data-numeric="true">Score</th>
              <th style={{ width: 220 }}>Missing</th><th style={{ width: 232 }}>Reason</th></tr></thead>
            <tbody>{group.items.map((item) => <QueueRow key={`${item.queueId}#${item.occurrence}`} item={item}
              tracker={item.creatorRecordId === null ? undefined : trackers.get(item.creatorRecordId)} />)}</tbody>
          </table></TableFrame>
        </section>)}
        <p className="wa-page-sub" data-testid="no-action">{count(idle)} {idle === 1 ? 'record' : 'records'} on the registry produced no action on {day}.</p>
      </>}
    <IdleGroups groups={snapshot.idle} />
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyQueue snapshot={data.props.snapshot} />;
    case 'gated': return <main className="wa-stack"><CreatorHeader title="Creator queue" subtitle="Daily Action Queue" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title="Creator queue" message={data.props.message} />;
  }
}
