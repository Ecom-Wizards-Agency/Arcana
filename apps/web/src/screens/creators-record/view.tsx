import type { CreatorIdentityDecision, CreatorRecordDetail, CreatorRefusedCandidate } from '@wizard-ads/shared';
import { creatorReplyTemplateName } from '@wizard-ads/shared';
import { Badge, EmptyState, TableFrame } from '../../ui/primitives';
import { formatShellDate, formatTimestamp } from '../../ui/date-format';
import {
  ACTION_WORDS, CreatorGated, CreatorHeader, CreatorLoadError, DRAFT_STATUS_TONE, DRAFT_STATUS_WORDS, FINGERPRINT_CLASS_LABEL, ImportRefusal,
  LockBadge, ScoreAgreement, SectionHead, SOURCE_LABEL, TenChecks, count, lastRead, shortFingerprint,
} from '../creators-daily-queue/creator-frame';
import { ACTION_LABEL } from '../creators-daily-queue/queue-summary';
import { DraftDecision } from '../creators-drafts/draft-decision';
import { blockedMoves } from '../creators-drafts/view';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const TITLE = 'Creator record';
const GATE_TONE = { BLOCKED: 'bad', HOLD: 'warn', PENDING_APPROVAL: 'info' } as const;

/** `resolve_record`'s rungs in words. */
export const RUNG_WORDS: Record<CreatorIdentityDecision['rung'], string> = {
  storefront: 'Rung 1: the storefront fingerprint matched a registered record',
  thread: 'Rung 2: the thread fingerprint matched a registered record on the same campaign',
  contacts: 'Rung 3: two contact fingerprints matched a registered record',
  new: 'No rung matched: the runner issued a new record id',
};
export const REFUSAL_WORDS: Record<CreatorRefusedCandidate['rule'], string> = {
  thread_on_other_campaign: 'Refused: the thread fingerprint is shared, but on another campaign. A thread matches only within its own campaign.',
  one_contact_fingerprint: 'Refused: one contact fingerprint is shared, and the runner needs two to match.',
};

const recordLink = (id: string) => <a href={`/creators/records/${id}`} data-record-link={id}>{id}</a>;
const classes = (shared: readonly (keyof typeof FINGERPRINT_CLASS_LABEL)[]) => shared.map((key) => FINGERPRINT_CLASS_LABEL[key]).join(', ');

function Fingerprints({ detail }: { detail: CreatorRecordDetail }) {
  const f = detail.record.fingerprints;
  const shown = (['storefront', 'thread'] as const).map((key) => [key, f[key] === null ? 'not recorded' : shortFingerprint(f[key]!)] as const);
  const contacts = (['fullName', 'email', 'phone', 'address'] as const).map((key) => [key, f[key] === null ? 'not recorded' : 'recorded'] as const);
  return <p className="wa-page-sub" data-testid="record-fingerprints">Fingerprints only:{' '}
    {[...shown, ...contacts].map(([key, value], index) => <span key={key}>{index === 0 ? '' : ' · '}<span data-fingerprint={key}>{FINGERPRINT_CLASS_LABEL[key]} <code>{value}</code></span></span>)}
  </p>;
}

function Identity({ detail }: { detail: CreatorRecordDetail }) {
  const { identity, refusedCandidates, matching } = detail;
  return <section aria-label="Identity" data-testid="record-identity" className="wa-stack">
    <SectionHead title="The rung that resolved it" />
    {identity === null
      ? <p data-testid="identity-rung" data-rung="not-recorded"><strong>Not recorded:</strong> the file import does not carry the rung; a creator:write key registers it.</p>
      : <p data-testid="identity-rung" data-rung={identity.rung}><strong>{RUNG_WORDS[identity.rung]}.</strong>{' '}
        <span className="wa-page-sub">Registered {formatTimestamp(identity.recordedAt)} by the {SOURCE_LABEL[identity.source]}.</span></p>}
    <Fingerprints detail={detail} />
    <SectionHead title="Candidates refused">{count(refusedCandidates.length)}</SectionHead>
    {refusedCandidates.length === 0
      ? <p className="wa-page-sub" data-testid="no-refused">No other record shares a fingerprint without matching.</p>
      : <TableFrame><table className="wa-table"><thead><tr><th>Record</th><th>Lock</th><th>Shares</th><th>Why it is not this creator</th></tr></thead>
        <tbody>{refusedCandidates.map((candidate) => <tr key={candidate.creatorRecordId} data-testid="refused-candidate" data-rule={candidate.rule}>
          <td>{recordLink(candidate.creatorRecordId)}</td><td><LockBadge lock={candidate.lockState} />{candidate.lockState === 'Unlocked' ? 'Unlocked' : null}</td>
          <td>{classes(candidate.shared)}</td><td>{REFUSAL_WORDS[candidate.rule]}</td></tr>)}</tbody></table></TableFrame>}
    <SectionHead title="Records that match">{count(matching.length)}</SectionHead>
    {matching.length === 0
      ? <p className="wa-page-sub" data-testid="no-matching">No other record matches it.</p>
      : <>
        <p className="wa-page-sub">A match means a Conflict lock: two records that the runner's rules would resolve to one creator cannot both act.</p>
        <TableFrame><table className="wa-table"><thead><tr><th>Record</th><th>Lock</th><th>Shares</th></tr></thead>
          <tbody>{matching.map((match) => <tr key={match.creatorRecordId} data-testid="matching-record">
            <td>{recordLink(match.creatorRecordId)}</td><td><LockBadge lock={match.lockState} />{match.lockState === 'Unlocked' ? 'Unlocked' : null}</td>
            <td>{classes(match.shared)}</td></tr>)}</tbody></table></TableFrame>
      </>}
  </section>;
}

function Qualification({ detail }: { detail: CreatorRecordDetail }) {
  const { qualification, qualifiedOn } = detail.record;
  return <section aria-label="Qualification" data-testid="record-qualification" className="wa-stack">
    <SectionHead title="The ten checks" />
    {qualification === null
      ? <EmptyState variant="not-measured" data-creator-state="score-not-measured" title="Not measured"
        body="No queue run has scored this record, so it has no computed score. It is not 0 / 10." />
      : <>
        <p data-testid="computed-score"><strong>{qualification.score} / 10</strong> computed by the runner{qualifiedOn ? ` on ${formatShellDate(qualifiedOn)}` : ''}
          {qualification.missing.length > 0 ? `; ${count(qualification.missing.length)} missing` : '; nothing missing'}.</p>
        <TenChecks missing={qualification.missing} />
      </>}
    <ScoreAgreement computed={qualification?.score ?? null} tracker={detail.trackerScore} />
  </section>;
}

function QueueToday({ detail }: { detail: CreatorRecordDetail }) {
  const item = detail.queueItem;
  const refused = detail.lastImport?.status === 'failed';
  return <section aria-label="On the queue today" data-testid="record-queue" className="wa-stack">
    <SectionHead title="On the queue" />
    {refused
      ? <p className="wa-page-sub" data-testid="queue-withheld">The queue row is not shown, because the last read failed and it would read as today's.</p>
      : item === null
        ? <p className="wa-page-sub" data-testid="queue-none">The newest queue run did not name this record.</p>
        : <p data-testid="queue-item" data-action={item.actionType}>{ACTION_LABEL[item.actionType]} · <Badge tone={GATE_TONE[item.gateResult]}>{item.gateResult}</Badge>
          {' '}· {item.queueState} · due {formatShellDate(item.dueDate)} · run {formatShellDate(item.runDate)}
          <br /><span className="wa-page-sub" style={{ overflowWrap: 'anywhere' }}>{item.reason}</span>
          {item.gateResult === 'PENDING_APPROVAL' ? <><br /><a href="/creators/drafts">The reply drafts for the day</a></> : null}</p>}
  </section>;
}

function Events({ detail }: { detail: CreatorRecordDetail }) {
  const { events } = detail;
  return <section aria-label="Everything since" data-testid="record-events" className="wa-stack">
    <SectionHead title="Everything since">{count(events.length)}</SectionHead>
    {events.length === 0
      ? <p className="wa-page-sub" data-testid="no-events">The action log holds nothing for this record yet.</p>
      : <TableFrame><table className="wa-table"><thead><tr><th>When</th><th>What</th><th>Detail</th><th>Evidence</th><th>Source</th></tr></thead>
        <tbody>{events.map((event) => {
          const detailParts = [event.asin, event.reservationId, event.reasonCode].filter((part): part is string => part !== null);
          return <tr key={event.eventKey} data-testid="record-event" data-action={event.action}>
            <td>{event.occurredAt === null ? <span className="wa-page-sub" data-time="not-recorded">time not recorded</span> : formatTimestamp(event.occurredAt)}
              <br /><span className="wa-page-sub">logged {formatTimestamp(event.recordedAt)}</span></td>
            <td>{ACTION_WORDS[event.action]}</td>
            <td style={{ overflowWrap: 'anywhere' }}>{detailParts.join(' · ')}
              {event.relatedRecordIds.length > 0 ? <>{detailParts.length ? ' · ' : ''}with {event.relatedRecordIds.map((id, index) => <span key={id}>{index ? ', ' : ''}{recordLink(id)}</span>)}</> : null}</td>
            <td>{event.evidenceReference ?? <span className="wa-page-sub">none</span>}</td>
            <td>{SOURCE_LABEL[event.source]}</td>
          </tr>;
        })}</tbody></table></TableFrame>}
  </section>;
}

function Samples({ detail }: { detail: CreatorRecordDetail }) {
  const { shipments } = detail;
  return <section aria-label="Sample lanes" data-testid="record-samples" className="wa-stack">
    <SectionHead title="Sample lanes">{count(shipments.length)}</SectionHead>
    {shipments.length === 0
      ? <p className="wa-page-sub" data-testid="no-samples">The runner has recorded no sample lane for this record.</p>
      : <TableFrame><table className="wa-table"><thead><tr><th>ASIN</th><th>Order key</th><th>Lane</th><th>MCF status</th></tr></thead>
        <tbody>{shipments.map((shipment) => <tr key={shipment.derivedOrderKey} data-testid="record-sample" data-lane={shipment.laneState}>
          <td><code>{shipment.asin}</code></td><td><code title="SHA-256 over organisation, creator record and ASIN; no date">{shipment.derivedOrderKey}</code></td>
          <td>{shipment.laneState}</td><td>{shipment.mcf === null ? <span className="wa-page-sub">Not read from Amazon</span> : shipment.mcf.status}</td>
        </tr>)}</tbody></table></TableFrame>}
    {shipments.length > 0 ? <p className="wa-page-sub"><a href="/creators/samples">All sample shipments</a></p> : null}
  </section>;
}

/**
 * Every draft for the record, open ones with their controls: the drafts screen
 * shows only the newest day, and an approved draft from an earlier day stays
 * open until it is marked sent by hand or withdrawn.
 */
function Drafts({ detail, canDecide }: { detail: CreatorRecordDetail; canDecide: boolean }) {
  const { drafts } = detail;
  const refused = detail.lastImport?.status === 'failed';
  return <section aria-label="Reply drafts" data-testid="record-drafts" className="wa-stack">
    <SectionHead title="Reply drafts">{count(drafts.length)}</SectionHead>
    {drafts.length === 0
      ? <p className="wa-page-sub" data-testid="no-drafts">No reply draft has been submitted for this record.</p>
      : <TableFrame><table className="wa-table"><thead><tr><th>Day</th><th>Template</th><th>Status</th></tr></thead>
        <tbody>{drafts.map((draft) => <tr key={draft.id} data-testid="record-draft" data-status={draft.status}>
          <td>{formatShellDate(draft.draftDate)}</td><td>{creatorReplyTemplateName(draft.templateKey)}</td>
          <td>{draft.status === 'draft' || draft.status === 'approved'
            ? <DraftDecision draftId={draft.id} status={draft.status}
              blocked={blockedMoves({ draft, lockState: detail.record.lockState, queueAction: null }, { canDecide, refused })} />
            : <Badge tone={DRAFT_STATUS_TONE[draft.status]}>{DRAFT_STATUS_WORDS[draft.status]}</Badge>}</td>
        </tr>)}</tbody></table></TableFrame>}
    {drafts.length > 0 ? <p className="wa-page-sub"><a href="/creators/drafts">The day's drafts</a>. Approving a draft sends nothing: the operator sends the text by hand in Amazon.</p> : null}
  </section>;
}

function ReadyRecord({ detail, canDecide }: { detail: CreatorRecordDetail; canDecide: boolean }) {
  const { record, lastImport } = detail;
  const subtitle = <>{record.brand} · campaign {record.campaignId} · {lastRead(lastImport)}</>;
  return <main className="wa-stack" data-testid="creator-record" data-record={record.creatorRecordId}>
    <CreatorHeader title={`${TITLE} ${record.creatorRecordId}`} subtitle={subtitle}>
      <LockBadge lock={record.lockState} />
      <span data-testid="record-status">Status: {record.status ?? <span className="wa-page-sub">not reported</span>}</span>
      <span className="wa-page-sub">Record {record.recordState} · created {formatShellDate(record.createdOn)}
        {record.lastVerifiedOn ? ` · last verified ${formatShellDate(record.lastVerifiedOn)}` : ''}</span>
    </CreatorHeader>
    <p className="wa-page-sub"><a href="/creators">Creator queue</a></p>
    {lastImport?.status === 'failed' ? <ImportRefusal run={lastImport} withheld="The record's history is shown; its queue row is not, because it would read as today's." /> : null}
    {record.lockState === 'Conflict' ? <p className="wa-banner wa-banner--bad" data-testid="conflict-banner" style={{ display: 'block' }}>
      <strong>Locked in Conflict.</strong> Another record resolves to the same creator, so nothing may act on this one until the identity is resolved in the registry.
      {' '}<a href={`/creators/conflicts/${record.creatorRecordId}`}>Open the conflict</a></p> : null}
    <Identity detail={detail} />
    <Qualification detail={detail} />
    <QueueToday detail={detail} />
    <Events detail={detail} />
    <Samples detail={detail} />
    <Drafts detail={detail} canDecide={canDecide} />
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyRecord detail={data.props.detail} canDecide={data.props.canDecide} />;
    case 'missing': return <main className="wa-stack" data-testid="creator-record"><CreatorHeader title={TITLE} subtitle="Creator Connections" />
      <EmptyState variant="empty" data-creator-state="record-missing" title="No such record"
        body={data.props.id === null ? 'This address does not name a creator record id.' : `No creator record ${data.props.id} is registered for this organisation.`}
        action={<a href="/creators">Creator queue</a>} /></main>;
    case 'gated': return <main className="wa-stack"><CreatorHeader title={TITLE} subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title={TITLE} message={data.props.message} />;
  }
}
