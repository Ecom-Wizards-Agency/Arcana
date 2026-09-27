import type { CreatorDraftRow, CreatorDraftsSnapshot } from '@wizard-ads/shared';
import { creatorReplyTemplateName } from '@wizard-ads/shared';
import { EmptyState } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import {
  CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, LockBadge, SOURCE_LABEL, count, lastRead, shortFingerprint,
} from '../creators-daily-queue/creator-frame';
import { ACTION_LABEL } from '../creators-daily-queue/queue-summary';
import { DraftDecision, type DraftDecisionProps } from './draft-decision';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const TITLE = 'Creator replies';
export const SENDS_NOTHING = 'Approving a draft sends nothing. Arcana records the decision; the operator sends the text by hand in Amazon\'s '
  + 'Creator Connections inbox, then marks it sent by hand here.';
export const BLOCKED_REASON = {
  role: 'Owners and admins approve. You can read the drafts.',
  conflict: 'Locked in Conflict: nothing may be approved or sent until the identity is resolved in the registry.',
  refused: 'The last import failed, so the queue these drafts answer did not read. Approval waits for a read that succeeds.',
} as const;

/** Why each move is unavailable for one draft. Withdrawing stays open to owners and admins: it sends nothing and approves nothing. */
export function blockedMoves(row: CreatorDraftRow, context: { canDecide: boolean; refused: boolean }): DraftDecisionProps['blocked'] {
  if (!context.canDecide) return { approved: BLOCKED_REASON.role, sent_by_hand: BLOCKED_REASON.role, withdrawn: BLOCKED_REASON.role };
  const conflict = row.lockState === 'Conflict';
  return {
    approved: conflict ? BLOCKED_REASON.conflict : context.refused ? BLOCKED_REASON.refused : null,
    sent_by_hand: conflict ? BLOCKED_REASON.conflict : null,
    withdrawn: null,
  };
}

export function draftTiles(rows: readonly CreatorDraftRow[]) {
  const of = (status: CreatorDraftRow['draft']['status']) => rows.filter((row) => row.draft.status === status).length;
  return { total: rows.length, awaiting: of('draft'), approved: of('approved'), sent: of('sent_by_hand'), withdrawn: of('withdrawn') };
}

/** Drafts per thread, in the order the read returned them. */
export function byThread(rows: readonly CreatorDraftRow[]): { threadKey: string; rows: CreatorDraftRow[] }[] {
  const groups = new Map<string, CreatorDraftRow[]>();
  for (const row of rows) groups.set(row.draft.threadKey, [...(groups.get(row.draft.threadKey) ?? []), row]);
  return [...groups].map(([threadKey, members]) => ({ threadKey, rows: members }));
}

const who = (userId: string | null, viewerId: string) => userId === null ? 'an unrecorded user' : userId === viewerId ? 'you' : `user ${userId.slice(0, 8)}`;

function Tile({ label, value, testId }: { label: string; value: number; testId: string }) {
  return <div className="wa-kpi-mini" data-testid={testId}><strong>{count(value)}</strong><span>{label}</span></div>;
}

function Draft({ row, viewerId, blocked }: { row: CreatorDraftRow; viewerId: string; blocked: DraftDecisionProps['blocked'] }) {
  const { draft } = row;
  return <article className="wa-stack" data-testid="draft" data-status={draft.status} data-template={draft.templateKey} style={{ gap: '0.375rem' }}>
    <p><strong>{creatorReplyTemplateName(draft.templateKey)}</strong></p>
    <p data-testid="draft-body" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>{draft.body}</p>
    <p className="wa-page-sub" data-testid="draft-meta">Submitted {formatTimestamp(draft.createdAt)} by the {SOURCE_LABEL[draft.source]}
      {draft.approvedAt === null ? null : <> · approved {formatTimestamp(draft.approvedAt)} by {who(draft.approvedBy, viewerId)}</>}
      {draft.closedAt === null ? null : <> · {draft.status === 'sent_by_hand' ? 'marked sent by hand' : 'withdrawn'} {formatTimestamp(draft.closedAt)} by {who(draft.closedBy, viewerId)}</>}</p>
    <DraftDecision draftId={draft.id} status={draft.status} blocked={blocked} />
  </article>;
}

function ReadyDrafts({ snapshot, canDecide, viewerId }: { snapshot: CreatorDraftsSnapshot; canDecide: boolean; viewerId: string }) {
  const { lastImport, draftDate, rows, submittedEver } = snapshot;
  const subtitle = <>The day's drafts{draftDate ? <> · {formatShellDate(draftDate)}</> : null} · {lastRead(lastImport)}</>;
  const head = <CreatorHeader title={TITLE} subtitle={subtitle} />;
  if (submittedEver === 0 || draftDate === null) {
    return <main className="wa-stack" data-testid="creator-drafts">{head}
      <EmptyState variant="not-measured" data-creator-state="no-drafts-ever" title="No drafts have been submitted"
        body="No reply draft has been submitted for this organisation, so there is nothing to approve. It is not a day with zero replies."
        meta="The amazon-creator-connections skill submits drafts with a creator:write key." /></main>;
  }
  const refused = lastImport?.status === 'failed';
  const sendsNothing = <p className="wa-banner wa-banner--info" data-testid="sends-nothing" style={{ display: 'block' }}>{SENDS_NOTHING}</p>;
  if (rows.length === 0) {
    return <main className="wa-stack" data-testid="creator-drafts">{head}
      <EmptyState variant="empty" data-creator-state="no-drafts-today" title="No drafts for the day"
        body={<>The newest draft day, {formatShellDate(draftDate)}, holds no draft. {count(submittedEver)} {submittedEver === 1 ? 'draft has' : 'drafts have'} been submitted in all.</>} /></main>;
  }
  const tiles = draftTiles(rows);
  const threads = byThread(rows);
  return <main className="wa-stack" data-testid="creator-drafts">
    {head}
    {sendsNothing}
    {refused ? <ImportRefusal run={lastImport!} withheld="The drafts are shown, but none can be approved until a read succeeds, because the queue they answer did not read." /> : null}
    {!canDecide ? <p className="wa-page-sub" data-testid="analyst-note">{BLOCKED_REASON.role}</p> : null}
    <div className="wa-kpi-strip" aria-label="Draft totals">
      <Tile label="Drafts" value={tiles.total} testId="tile-drafts" />
      <Tile label="Awaiting approval" value={tiles.awaiting} testId="tile-awaiting" />
      <Tile label="Approved, to send by hand" value={tiles.approved} testId="tile-approved" />
      <Tile label="Sent by hand" value={tiles.sent} testId="tile-sent" />
    </div>
    <p className="wa-page-sub" data-testid="draft-counts">{count(threads.length)} {threads.length === 1 ? 'thread' : 'threads'} · {count(tiles.withdrawn)} withdrawn.
      {' '}Each thread is approved one draft at a time.</p>
    {threads.map((thread) => {
      const first = thread.rows[0]!;
      const ids = [...new Set(thread.rows.map((row) => row.draft.creatorRecordId))];
      return <section key={thread.threadKey} className="wa-card" data-testid="draft-thread" data-thread={shortFingerprint(thread.threadKey)} aria-label={`Thread ${shortFingerprint(thread.threadKey)}`}>
        <div className="wa-card__body wa-stack">
          <h2 className="wa-card__title">Thread <code>{shortFingerprint(thread.threadKey)}</code> · {ids.map((id, index) => <span key={id}>{index ? ', ' : ''}<a href={`/creators/records/${id}`}>{id}</a></span>)}
            {' '}<LockBadge lock={first.lockState} /></h2>
          <p className="wa-page-sub">{first.queueAction === null ? 'Not on the queue for this day' : `On the queue: ${ACTION_LABEL[first.queueAction]}`}
            {first.lockState === 'Conflict' ? <> · <a href={`/creators/conflicts/${first.draft.creatorRecordId}`}>Open the conflict</a></> : null}</p>
          {thread.rows.map((row) => <Draft key={row.draft.id} row={row} viewerId={viewerId} blocked={blockedMoves(row, { canDecide, refused })} />)}
        </div>
      </section>;
    })}
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyDrafts snapshot={data.props.snapshot} canDecide={data.props.canDecide} viewerId={data.props.viewerId} />;
    case 'gated': return <main className="wa-stack"><CreatorHeader title={TITLE} subtitle="The day's drafts" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title={TITLE} message={data.props.message} />;
  }
}
