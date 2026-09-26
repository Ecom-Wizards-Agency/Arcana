import type { CreatorDailyQueueItem, CreatorImportRun, CreatorQueueSnapshot, CreatorSweepRun } from '@wizard-ads/shared';
import { Badge, EmptyState, TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import { CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, MissingChecks, NotImported, count, lastRead, sweepRead } from './creator-frame';
import { ACTION_LABEL, groupByAction, queueTiles, recordsWithoutAction } from './queue-summary';
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

function QueueRow({ item }: { item: CreatorDailyQueueItem }) {
  return <tr data-testid="queue-row" data-action={item.actionType}>
    <td>{item.creatorRecordId ?? <em>Unresolved thread</em>}{item.lockState === 'Conflict' || item.lockState === 'Locked for MCF'
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
            <tbody>{group.items.map((item) => <QueueRow key={`${item.queueId}#${item.occurrence}`} item={item} />)}</tbody>
          </table></TableFrame>
        </section>)}
        <p className="wa-page-sub" data-testid="no-action">{count(idle)} {idle === 1 ? 'record' : 'records'} on the registry produced no action on {day}.</p>
      </>}
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyQueue snapshot={data.props.snapshot} />;
    case 'gated': return <main className="wa-stack"><CreatorHeader title="Creator queue" subtitle="Daily Action Queue" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title="Creator queue" message={data.props.message} />;
  }
}
