/**
 * The daily report as it would be posted, rendered on `/creators/samples?report=daily`.
 * Arcana posts nothing: the text is counts only, and what the render left out is
 * counted beside it so a reader can see what was withheld and why.
 */
import {
  CREATOR_MCF_NOT_FOUND_ESCALATION, CreatorGateResult, CreatorSampleLaneState, type CreatorMcfSettlementState, type CreatorQueueSnapshot, type CreatorSampleSnapshot,
} from '@wizard-ads/shared';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import { count, sweepRead } from '../creators-daily-queue/creator-frame';

export interface DailyReportData {
  queue: CreatorQueueSnapshot;
  /** Each lane's settlement by derived order key; null until Amazon has been asked. */
  settlements: Record<string, CreatorMcfSettlementState | null>;
}
export interface DailyReport {
  lines: string[];
  removed: { item: string; count: number | null; note: string }[];
}

const GATE_WORDS: Record<CreatorGateResult, string> = { BLOCKED: 'blocked', HOLD: 'on hold', PENDING_APPROVAL: 'awaiting approval' };
const SETTLEMENT_WORDS = { found: 'found', not_found: 'not found yet', escalated: `escalated after ${CREATOR_MCF_NOT_FOUND_ESCALATION} empty reads` } as const;
const tally = <T extends string>(values: readonly T[], order: readonly T[], words: (value: T) => string) => order
  .map((value) => [value, values.filter((item) => item === value).length] as const).filter(([, n]) => n > 0)
  .map(([value, n]) => `${count(n)} ${words(value)}`).join(', ');

function queueLine(queue: CreatorQueueSnapshot): string {
  if (queue.runDate === null) return 'Queue: not measured, because no queue file has been read.';
  const gates = tally(queue.items.map((item) => item.gateResult), CreatorGateResult.options, (gate) => GATE_WORDS[gate]);
  const escalated = queue.items.filter((item) => item.queueState === 'Escalated').length;
  return `Queue ${formatShellDate(queue.runDate)}: ${count(queue.items.length)} ${queue.items.length === 1 ? 'item' : 'items'}`
    + `${gates ? ` (${gates})` : ''}${escalated > 0 ? `; ${count(escalated)} escalated` : ''}.`;
}

function sweepLine(queue: CreatorQueueSnapshot): string {
  const read = sweepRead(queue.lastImport);
  const sweep = queue.sweep;
  if (sweep === null || read === 'absent' || read === 'not-produced') return 'Inbox sweep: not measured, because none came with the last import.';
  const c = sweep.counts;
  return `Inbox sweep ${formatTimestamp(sweep.completedAt)}: ${count(c.mounted)} threads enumerated, ${count(c.changed)} changed, `
    + `${count(c.heldOrEscalated)} held or escalated, ${count(c.unmatched)} unmatched; ${sweep.reconciled ? 'it reconciled' : 'it did not reconcile'}.`;
}

function sampleLines(samples: CreatorSampleSnapshot, settlements: DailyReportData['settlements']): string[] {
  const { shipments, lastImport } = samples;
  if (shipments.length === 0) {
    const read = lastImport !== null && lastImport.files.some((file) => file === 'registry' || file === 'mcf_reservations');
    return [read ? 'Sample lanes: none recorded.' : 'Sample lanes: not measured, because no registry or reservation list has been read.'];
  }
  const states = tally(shipments.map((lane) => lane.laneState), CreatorSampleLaneState.options, (state) => state);
  const settled = shipments.map((lane) => settlements[lane.derivedOrderKey] ?? null);
  const kinds = tally(settled.flatMap((state) => state === null ? [] : [state.settlement]), ['found', 'not_found', 'escalated'] as const,
    (kind) => SETTLEMENT_WORDS[kind]);
  const unread = settled.filter((state) => state === null).length;
  return [
    `Sample lanes: ${count(shipments.length)} (${states}).`,
    `Amazon order reads: ${[kinds, unread > 0 ? `${count(unread)} not read yet` : ''].filter(Boolean).join(', ')}.`,
  ];
}

/** The text, and what was withheld from it. Pure: the counts come only from the snapshots. */
export function dailyReport(samples: CreatorSampleSnapshot, data: DailyReportData): DailyReport {
  const { queue } = data;
  const failed = samples.lastImport?.status === 'failed' ? samples.lastImport : null;
  const title = `Creator Connections daily report · ${queue.runDate === null ? 'no queue run' : formatShellDate(queue.runDate)}`;
  const lines = failed !== null
    ? [title, `Not reported: the import at ${formatTimestamp(failed.finishedAt)} failed, so nothing here would read as current.`]
    : [title, queueLine(queue), sweepLine(queue), ...sampleLines(samples, data.settlements)];
  const tracking = samples.shipments.flatMap((lane) => lane.packages ?? []).filter((item) => item.trackingNumber !== null).length;
  const orders = samples.shipments.filter((lane) => lane.runnerOrderId !== null).length;
  return {
    lines,
    removed: [
      { item: 'Tracking numbers', count: tracking, note: 'kept on the sample screens, never in a posted report' },
      { item: 'Runner order ids', count: orders, note: 'kept on the sample screens, never in a posted report' },
      { item: 'Names, addresses, emails, phone numbers and links', count: null,
        note: 'Arcana holds none of these (fingerprints only), so there were none to remove' },
    ],
  };
}

/**
 * Server-rendered, so it opens without client script. It is not marked
 * aria-modal: the shell around the screen stays reachable; the screen itself is
 * made inert by the caller, and Close takes focus when the page loads.
 */
export function DailyReportModal({ report }: { report: DailyReport }) {
  return <div className="wa-modal-backdrop" data-testid="daily-report">
    <section role="dialog" aria-labelledby="daily-report-title" className="wa-modal"
      style={{ maxWidth: 'min(44rem, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
      <header className="wa-modal__head"><h2 className="wa-modal__title" id="daily-report-title">Daily report</h2>
        <span className="wa-page-sub">the text that would be posted</span></header>
      <div className="wa-modal__body wa-stack">
        <p className="wa-banner wa-banner--info" data-testid="daily-report-nothing-posted" style={{ display: 'block', margin: 0 }}>
          <strong>Nothing is posted from Arcana.</strong> This is the report rendered from what Arcana holds; posting it happens outside Arcana, by hand.</p>
        <pre data-testid="daily-report-text" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{report.lines.join('\n')}</pre>
        <h3 className="wa-section-title">Removed before posting</h3>
        <ul data-testid="daily-report-removed" style={{ margin: 0 }}>{report.removed.map((entry) => <li key={entry.item} data-removed={entry.item}>
          {entry.item}: {entry.count === null ? 'none held' : `${count(entry.count)} withheld`} ({entry.note})</li>)}</ul>
      </div>
      <footer className="wa-modal__foot"><a className="wa-btn" href="/creators/samples" data-testid="daily-report-close" autoFocus>Close</a></footer>
    </section>
  </div>;
}
