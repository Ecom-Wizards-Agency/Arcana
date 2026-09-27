import { Fragment, type ReactNode } from 'react';
import type { CreatorFulfillmentDetail, CreatorLockState, CreatorReconciliationReason, CreatorSampleShipment } from '@wizard-ads/shared';
import { CREATOR_MCF_NOT_FOUND_ESCALATION } from '@wizard-ads/shared';
import { Badge, EmptyState, TableFrame } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';
import { CreatorGated, CreatorHeader, CreatorLoadError, ImportRefusal, LockBadge, SectionHead, count, lastRead } from '../creators-daily-queue/creator-frame';
import { amazonRead, clock, money } from '../creators-sample-preflight/order-key';
import { REFUSED_ORDER_STATUSES, carrierFailed, fulfillmentStages, trackingNotSafeToSend, type FulfillmentStage } from './stages';
import type { CreatorMcfLaneSend } from '@wizard-ads/db';
import { SEND_STATE_WORDS, STATE_REASON_WORDS } from '../creators-sample-preflight/send-model';
import { CANCEL_ORIGINS, cancelAnswerWords, cancelEndingWords, cancelOpen, endingOf, notSentCause, statusClass } from '../creators-sample-preflight/cancel-model';
import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

const TITLE = 'Sample order';
type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
const NOT_READ = 'not read';

/** `UNCERTAIN_MCF_CANCELLATION_REASONS` in words: why the runner could not tell whether the submit landed. */
export const RECONCILIATION_WORDS: Record<CreatorReconciliationReason, string> = {
  confirmation_missing: 'the submit went through, and no confirmation came back',
  outcome_unknown: 'the submit returned nothing the runner could read as success or failure',
  request_timeout: 'the submit timed out before Amazon answered',
};
const LOCK_WORDS: Record<CreatorLockState, string> = { 'Locked for MCF': 'locked for MCF', Conflict: 'locked in Conflict', Unlocked: 'unlocked' };
const STAGE_TONE = { done: 'good', now: 'warn', not_yet: 'neutral', not_read: 'neutral', refused: 'bad' } as const;
const STAGE_NUMBER = ['One', 'Two', 'Three', 'Four'] as const;

const recordLink = (id: string) => <a href={`/creators/records/${id}`} data-record-link={id}>{id}</a>;
const orderKey = (key: string) => <code title="SHA-256 over organisation, creator record and ASIN; no date">{key}</code>;
const notRead = <span className="wa-page-sub" data-value="not-read">{NOT_READ}</span>;

function stageWords(stage: FulfillmentStage, lane: CreatorSampleShipment): string {
  switch (stage.state) {
    case 'done': return 'done';
    case 'now': return 'where it is now';
    case 'not_yet': return 'not yet';
    case 'not_read': return NOT_READ;
    case 'refused': return lane.mcf?.status === 'Cancelled' ? 'cancelled' : 'refused';
  }
}

/** Label and value pairs; `data-fact` names each value for tests. */
function Facts({ rows, testid }: { rows: readonly (readonly [string, string, ReactNode])[]; testid: string }) {
  return <dl data-testid={testid} style={{ display: 'grid', gridTemplateColumns: 'minmax(10rem, max-content) 1fr', gap: '0.25rem 1.5rem', margin: 0 }}>
    {rows.map(([key, label, value]) => <Fragment key={key}><dt className="wa-page-sub">{label}</dt>
      <dd data-fact={key} style={{ margin: 0, overflowWrap: 'anywhere' }}>{value}</dd></Fragment>)}
  </dl>;
}

function Panel({ title, testid, children }: { title: string; testid: string; children: ReactNode }) {
  return <section className="wa-card" data-testid={testid} aria-label={title}>
    <header className="wa-card__head"><h2 className="wa-card__title">{title}</h2></header>
    <div className="wa-card__body wa-stack" style={{ gap: '0.5rem' }}>{children}</div>
  </section>;
}

const cards = { display: 'grid', gap: '1rem', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))' } as const;

function Card({ number, title, answer, answerKey, tone, testid, attribute, children }: {
  number: string; title: string; answer: string; answerKey: string; tone: Tone; testid: string; attribute: [string, string]; children?: ReactNode;
}) {
  return <section className="wa-card" data-testid={testid} {...{ [attribute[0]]: attribute[1] }} data-answer={answerKey} aria-label={title}>
    <div className="wa-card__body wa-stack" style={{ gap: '0.35rem' }}>
      <span className="wa-page-sub">{number}</span>
      <strong>{title}</strong>
      <span><Badge tone={tone}>{answer}</Badge></span>
      {children === undefined || children === null ? null : <span className="wa-page-sub" data-testid={`${testid}-detail`}>{children}</span>}
    </div>
  </section>;
}

interface Answer { answer: string; key: string; tone: Tone; detail: ReactNode }

/** Questions two and three, answered only from the settlement the worker's reads made. */
function settlementAnswers(detail: CreatorFulfillmentDetail, lane: CreatorSampleShipment): { accepted: Answer; exists: Answer } {
  const { settlement } = detail;
  if (settlement === null) {
    return {
      accepted: { answer: 'not read yet', key: 'not-read', tone: 'neutral', detail: 'Amazon has not been asked about this order id.' },
      exists: { answer: 'not read yet', key: 'not-read', tone: 'neutral', detail: 'Amazon has not been asked about this order id. One read of it answers this question.' },
    };
  }
  const probes = probeCount(settlement.notFoundProbes);
  // A not-found read can come from either operation: name the one the newest read used, and only when it is the read that settled.
  const newest = detail.observations[0];
  const last = newest !== undefined && newest.readAt === settlement.lastProbeAt ? amazonRead(newest.operation, newest.readAt)
    : `read at ${clock(settlement.lastProbeAt)}`;
  switch (settlement.settlement) {
    case 'found': {
      const mcf = lane.mcf;
      const provenance = mcf === null ? 'status not read' : amazonRead(mcf.operation, mcf.readAt);
      const refused = mcf !== null && REFUSED_ORDER_STATUSES.includes(mcf.status);
      return {
        accepted: mcf === null ? { answer: 'found, status not read', key: 'found', tone: 'info', detail: provenance }
          : refused ? { answer: `no: ${mcf.status}`, key: 'refused', tone: 'bad', detail: provenance }
            : { answer: `yes: ${mcf.status}`, key: 'yes', tone: 'good', detail: provenance },
        exists: { answer: 'yes, under this id', key: 'yes', tone: 'good', detail: provenance },
      };
    }
    case 'not_found':
      return {
        accepted: { answer: 'not known', key: 'not-known', tone: 'warn', detail: 'Amazon holds no order under this id, so nothing says it accepted one.' },
        exists: { answer: 'not found', key: 'not-found', tone: 'warn',
          detail: <>Amazon had no order under this id on <span data-testid="not-found-probes">{probes}</span> reads · last {last}</> },
      };
    case 'escalated':
      return {
        accepted: { answer: 'not known', key: 'not-known', tone: 'warn', detail: 'Amazon holds no order under this id, so nothing says it accepted one.' },
        exists: { answer: 'escalated', key: 'escalated', tone: 'bad',
          detail: <>{CREATOR_MCF_NOT_FOUND_ESCALATION} reads found nothing: stays locked, a person looks. {count(settlement.notFoundProbes)} not-found reads running · last {last}</> },
      };
  }
}

function ReservationHolds({ detail, lane }: { detail: CreatorFulfillmentDetail; lane: CreatorSampleShipment }) {
  const lock = detail.lockState === null ? 'lock not recorded' : LOCK_WORDS[detail.lockState];
  return <Panel title="What the reservation holds" testid="reservation-holds">
    <Facts testid="reservation-facts" rows={[
      ['reservation', 'Reservation', lane.reservationId ?? <span className="wa-page-sub">not recorded</span>],
      ['order-key', 'Order id · derived', orderKey(lane.derivedOrderKey)],
      ['record', 'Creator record', <>{recordLink(lane.creatorRecordId)} · {lock}</>],
      ['asin-sku', 'ASIN and SKU', <><code>{lane.asin}</code> · {lane.sku ?? <span className="wa-page-sub">SKU not recorded</span>}</>],
      ['fee', 'Fee at reservation', <>{money(lane.feeCents)}{lane.feeCapCents === null ? null : <span className="wa-page-sub"> · cap {money(lane.feeCapCents)}</span>}</>],
      ['lane-state', 'Reservation state', lane.laneState],
    ]} />
  </Panel>;
}

function LockLine({ lane }: { lane: CreatorSampleShipment }) {
  return <p className="wa-page-sub" data-testid="lock-line">The lock is not hand-editable, and nothing on this page releases it. {lane.orderOwner === 'arcana'
    ? 'Arcana\'s send ledger owns this lane\'s state, and the runner\'s import leaves it unchanged;'
    : 'The runner owns the lane state and the lock;'} settling whether an order exists is not releasing the lock.</p>;
}

function Reconciliation({ detail, lane }: { detail: CreatorFulfillmentDetail; lane: CreatorSampleShipment }) {
  const { accepted, exists } = settlementAnswers(detail, lane);
  const reason = lane.reconciliationReason;
  return <section aria-label="The ambiguous submit" data-testid="reconciliation" className="wa-stack">
    <section className="wa-banner wa-banner--warn" data-testid="ambiguous-banner" style={{ display: 'block' }}>
      <strong>The submit was ambiguous, so three different questions are open, and one read answers the third.</strong>{' '}
      Whether the form was submitted, whether Amazon accepted it, and whether an order exists are separate questions. Reading the first as an answer
      to the third is how a creator receives two parcels. Asking Amazon for this order id answers the third directly.
    </section>
    <div style={cards} data-testid="questions">
      <Card number="One" title="Was the form submitted?" testid="question" attribute={['data-question', 'submitted']}
        answer={lane.verifiedAt === null ? 'not recorded' : `yes, verified for submit at ${clock(lane.verifiedAt)}`}
        answerKey={lane.verifiedAt === null ? 'not-recorded' : 'yes'} tone={lane.verifiedAt === null ? 'neutral' : 'good'}>
        {reason === null ? 'The runner recorded no reason for the reconciliation.' : <>Runner · <code>{reason}</code>: {RECONCILIATION_WORDS[reason]}.</>}
      </Card>
      <Card number="Two" title="Did Amazon accept it?" testid="question" attribute={['data-question', 'accepted']}
        answer={accepted.answer} answerKey={accepted.key} tone={accepted.tone}>{accepted.detail}</Card>
      <Card number="Three" title="Does an order exist?" testid="question" attribute={['data-question', 'exists']}
        answer={exists.answer} answerKey={exists.key} tone={exists.tone}>{exists.detail}</Card>
    </div>
    <ReservationHolds detail={detail} lane={lane} />
    <div className="wa-grid-2">
      <Panel title="One read, three outcomes" testid="three-outcomes">
        <p style={{ margin: 0 }} data-outcome="found"><strong>The order comes back:</strong> it landed. The read is recorded against this lane; the runner
          records the confirmation and releases the lock, and a person tells the creator.</p>
        <p style={{ margin: 0 }} data-outcome="not_found"><strong>Amazon says there is no such order:</strong> it did not land, as of that read. Retrying
          is safe here, because the id is derived from the creator record and the ASIN rather than generated, so a retry cannot become a second order.</p>
        <p style={{ margin: 0 }} data-outcome="escalated"><strong>Still nothing after {CREATOR_MCF_NOT_FOUND_ESCALATION} reads running:</strong> the lane
          stays locked, escalates, and nothing changes. A person looks.</p>
      </Panel>
      <section className="wa-banner wa-banner--bad" data-testid="no-new-order-id" style={{ display: 'block' }}>
        <strong>There is no way to invent a new order id.</strong>{' '}
        The id is derived from the organisation, the creator record and the ASIN. It is shown above, and no control changes it. A corrective second
        order is never placed after an ambiguous first one, and a duplicate submit under the same id is rejected by Amazon rather than shipped.
      </section>
    </div>
    <LockLine lane={lane} />
  </section>;
}

function Stages({ stages, lane }: { stages: readonly FulfillmentStage[]; lane: CreatorSampleShipment }) {
  return <div style={cards} data-testid="stages">
    {stages.map((stage, index) => <Card key={stage.stage} number={STAGE_NUMBER[index]!} title={stage.title} testid="stage" attribute={['data-stage', stage.stage]}
      answer={stageWords(stage, lane)} answerKey={stage.state} tone={STAGE_TONE[stage.state]}>{stage.note}</Card>)}
  </div>;
}

function AmazonNow({ detail, lane }: { detail: CreatorFulfillmentDetail; lane: CreatorSampleShipment }) {
  const { shipments } = detail;
  const packages = lane.packages;
  return <Panel title="What Amazon reports right now" testid="amazon-now">
    <Facts testid="amazon-facts" rows={[
      ['order-status', 'Order status', lane.mcf === null ? notRead
        : <span data-provenance={lane.mcf.operation}><strong>{lane.mcf.status}</strong> <span className="wa-page-sub">{amazonRead(lane.mcf.operation, lane.mcf.readAt)}</span></span>],
      ['shipments', 'Shipments in the array', shipments === null ? notRead : count(shipments.length)],
    ]} />
    {shipments !== null && shipments.length > 1 ? <p className="wa-banner wa-banner--warn" data-testid="split-shipments" style={{ display: 'block' }}>
      <strong>Amazon lists {count(shipments.length)} shipments for this order.</strong> A sample is one unit, so more than one entry means a shipment was
      cancelled and replaced or the order split; either is a signal something is wrong with the order.</p> : null}
    {shipments !== null && shipments.length > 0 ? <TableFrame><table className="wa-table">
      <thead><tr><th>Shipment</th><th>Status</th><th>Shipped</th><th>Estimated arrival</th></tr></thead>
      <tbody>{shipments.map((shipment) => <tr key={shipment.amazonShipmentId} data-testid="amazon-shipment" data-status={shipment.status}>
        <td><code>{shipment.amazonShipmentId}</code></td><td>{shipment.status}</td>
        <td>{shipment.shippedAt === null ? notRead : formatTimestamp(shipment.shippedAt)}</td>
        <td>{shipment.estimatedArrivalAt === null ? notRead : formatTimestamp(shipment.estimatedArrivalAt)}</td>
      </tr>)}</tbody></table></TableFrame> : null}
    {packages === null ? <p className="wa-page-sub" data-testid="packages-not-read">Packages: not read from Amazon.</p>
      : packages.length === 0 ? <p className="wa-page-sub" data-testid="no-packages">Amazon lists no package yet.</p>
        : <TableFrame><table className="wa-table">
          <thead><tr><th>Package</th><th>Carrier</th><th>Tracking number</th><th>Estimated arrival</th><th>Carrier status</th></tr></thead>
          <tbody>{packages.map((item) => <tr key={item.packageNumber} data-testid="amazon-package" data-carrier-status={item.carrierStatus ?? 'none'}>
            <td>Package {item.packageNumber}</td>
            <td>{item.carrierCode ?? notRead}</td>
            <td>{item.trackingNumber === null ? notRead : <code>{item.trackingNumber}</code>}</td>
            <td>{item.estimatedArrivalAt === null ? notRead : formatTimestamp(item.estimatedArrivalAt)}</td>
            <td>{item.carrierStatus === null ? <span className="wa-page-sub" data-value="no-carrier-status">no carrier status yet</span>
              : <>{item.carrierStatus}{item.carrierStatusReadAt === null ? null
                : <><br /><span className="wa-page-sub">{amazonRead('getPackageTrackingDetails', item.carrierStatusReadAt)}</span></>}</>}</td>
          </tr>)}</tbody></table></TableFrame>}
  </Panel>;
}

function Fulfillment({ detail, lane }: { detail: CreatorFulfillmentDetail; lane: CreatorSampleShipment }) {
  const stages = fulfillmentStages(lane, detail.shipments);
  return <section aria-label="The order Amazon holds" data-testid="fulfillment" className="wa-stack">
    {carrierFailed(lane.packages, detail.shipments) ? <section className="wa-banner wa-banner--bad" data-testid="carrier-failed" style={{ display: 'block' }}>
      <strong>The carrier reports the parcel is not reaching the creator.</strong>{' '}
      A live package is returning, returned or undeliverable. Nothing about delivery goes to the creator, and a person looks before anything else happens.
    </section> : null}
    {trackingNotSafeToSend(lane.packages, detail.shipments) ? <section className="wa-banner wa-banner--warn" data-testid="not-safe-to-send" style={{ display: 'block' }}>
      <strong>There is a tracking number, and it is not safe to send yet.</strong>{' '}
      The carrier does not show the package moving. Carrier and tracking number can still change while a shipment is processing, and a cancelled
      shipment can be replaced by another entry in the same array. The creator hears from us at in-transit, not before.
    </section> : null}
    <Stages stages={stages} lane={lane} />
    <div className="wa-grid-2">
      <AmazonNow detail={detail} lane={lane} />
      <Panel title="Read the whole array" testid="whole-array">
        <p style={{ margin: 0 }}>A cancelled shipment can be replaced by another entry in the same array rather than removed from it. Taking the first entry
          can give a package that will never move and a tracking number that will never scan.</p>
        <p style={{ margin: 0 }}>One order can also split into more than one shipment. A sample is a single unit, so a split here is a signal something is
          wrong with the order, not a normal case.</p>
      </Panel>
    </div>
  </section>;
}

/**
 * "n of 3" while the count is under the escalation threshold. Past it (a lane
 * that is not an ambiguous submit never escalates) the count stands alone,
 * never "4 of 3".
 */
export function probeCount(probes: number): string {
  return probes < CREATOR_MCF_NOT_FOUND_ESCALATION ? `${count(probes)} of ${CREATOR_MCF_NOT_FOUND_ESCALATION}`
    : `${count(probes)} (only an ambiguous submit escalates)`;
}
function settlementLine(detail: CreatorFulfillmentDetail): string {
  const { settlement } = detail;
  if (settlement === null) return 'Settlement: not read yet. Amazon has not been asked about this order id.';
  const last = formatTimestamp(settlement.lastProbeAt);
  switch (settlement.settlement) {
    case 'found': return `Settlement: found. Amazon holds an order under this id, last read ${last}.`;
    case 'not_found': return `Settlement: not found on ${probeCount(settlement.notFoundProbes)} reads running, last read ${last}.`;
    case 'escalated': return `Settlement: escalated. ${count(settlement.notFoundProbes)} reads running found nothing, last read ${last}; the lane stays locked and a person looks.`;
  }
}

function Reads({ detail }: { detail: CreatorFulfillmentDetail }) {
  const { observations, observationsTotal } = detail;
  return <section aria-label="Reads from Amazon" data-testid="reads" className="wa-stack">
    <p data-testid="settlement-line" data-settlement={detail.settlement?.settlement ?? 'not-read'}>{settlementLine(detail)}</p>
    <SectionHead title="Reads from Amazon"><span data-testid="observation-count">{count(observations.length)} of {count(observationsTotal)}</span></SectionHead>
    {observations.length === 0
      ? <p className="wa-page-sub" data-testid="no-observations">Amazon has not been asked about this order yet.</p>
      : <TableFrame><table className="wa-table">
        <thead><tr><th>Read</th><th>Operation</th><th>Order id asked</th><th>Outcome</th></tr></thead>
        <tbody>{observations.map((item) => <tr key={item.observationKey} data-testid="observation" data-outcome={item.outcome}>
          <td>{formatTimestamp(item.readAt)}</td><td>{item.operation}</td><td><code>{item.queriedOrderId}</code></td>
          <td>{item.outcome === 'found' ? <>found · {item.status}</> : 'not found'}</td>
        </tr>)}</tbody></table></TableFrame>}
    <p className="wa-page-sub">The worker made these reads, with nobody in a browser. No read changes the lane state or releases the lock.</p>
  </section>;
}

/** What each send outcome means for this order; the controls stay on the pre-flight. */
const OUTCOME_LINE: Partial<Record<CreatorMcfLaneSend['state'], string>> = {
  approved: 'Approved; the worker has not sent the order request yet.',
  dispatching: 'The worker is sending the order request now.',
  accepted: 'Amazon answered HTTP 200. That is not placed: a read must show Received or later with this SKU and one unit.',
  placed: 'A read found the order under this id with this SKU and one unit.',
  uncertain: 'The order request returned nothing readable. Only reads of this order id settle it; no second order is requested.',
  conflict: 'Amazon holds an order under this id that does not match the send.',
  rejected: 'Amazon rejected the order request, and a follow-up read found no order.',
  not_created: 'Released as not created after enough not-found reads.',
  failed_by_amazon: 'Amazon holds the order in a failed status.',
  failed_after_placement: 'The placed order later became Cancelled or Unfulfillable in Amazon.',
  cancel_requested: 'Arcana approved a cancel of this order; the worker has not sent the cancel request yet.',
  cancel_dispatching: 'The worker sent Arcana\'s one cancel request to Amazon. Only a read showing Cancelled settles it; the request is never sent twice.',
  cancelled: 'Arcana asked Amazon to cancel this order, and a read showed it Cancelled. The lane is Cancelled.',
};

/** Where the send's newest cancel stands, read-only: approved and waiting, sent, or how it ended. Null when none was pressed. */
function CancelLine({ send }: { send: CreatorMcfLaneSend }) {
  const cancel = send.cancel;
  if (cancel === null) return null;
  const [key, text] = send.state === 'cancel_dispatching' || (cancel.reservedAt !== null && cancel.endedAt === null)
    ? ['dispatching', `The one cancel request was reserved ${cancel.reservedAt === null ? 'at a time not recorded' : `at ${formatTimestamp(cancel.reservedAt)}`}. Amazon's answer so far: ${cancelAnswerWords(cancel)}${endingOf(cancel) === 'not_sent' ? ` ${notSentCause(cancel.endingReason)}` : ''} Arcana waits for a read showing Cancelled and never sends the request twice.`]
    : cancelOpen(cancel) ? ['approved', `Cancel approved at ${formatTimestamp(cancel.approvedAt)}, waiting for the worker. If it has not taken it by ${clock(cancel.claimDeadline)} it expires and nothing is sent to Amazon.`]
      : [endingOf(cancel) ?? 'open', `${cancelEndingWords(cancel)}${cancel.ending === 'not_honoured' ? ` Amazon's answer to the request: ${cancelAnswerWords(cancel)}` : ''}${cancel.endedAt === null ? '' : ` Ended ${formatTimestamp(cancel.endedAt)}.`}`];
  return <span data-testid="arcana-cancel" data-cancel={key}>{text}</span>;
}

/** Arcana placed this lane's order: its outcome, in the ledger's words, with the Amazon status and codes. */
function ArcanaOutcome({ send, lane }: { send: CreatorMcfLaneSend; lane: CreatorSampleShipment }) {
  const words = SEND_STATE_WORDS[send.state];
  const escalation = send.escalationReason === 'ladder_exhausted' ? 'Amazon has not settled this order in 7 days.'
    : send.escalationReason === 'conflict' ? 'Escalated as a conflict.' : null;
  return <Panel title="Arcana's order request" testid="arcana-outcome">
    <p style={{ margin: 0 }} data-send-state={send.state}><Badge tone={words.tone}>{words.title}</Badge>{' '}
      <span className="wa-page-sub">since {formatTimestamp(send.stateChangedAt)}</span></p>
    <Facts testid="arcana-facts" rows={[
      ['outcome', 'What it means', OUTCOME_LINE[send.state] ?? (send.stateReason === null ? words.title : STATE_REASON_WORDS[send.stateReason] ?? send.stateReason)],
      ['amazon-status', 'Amazon status', send.amazonStatus ?? notRead],
      ['accepted', 'Accepted by Amazon', send.acceptedAt === null ? <span className="wa-page-sub">not accepted</span> : formatTimestamp(send.acceptedAt)],
      ['placed', 'Placed', send.placedAt === null ? <span className="wa-page-sub">not placed</span> : formatTimestamp(send.placedAt)],
      ['codes', 'Amazon codes', (send.providerCodes ?? []).length === 0 ? <span className="wa-page-sub">none</span>
        : (send.providerCodes ?? []).map((code) => <code key={code}>{code} </code>)],
      ...(send.cancel === null ? [] : [['cancel', 'Cancel in Amazon', <CancelLine key="cancel" send={send} />] as const]),
    ]} />
    {CANCEL_ORIGINS.includes(send.state) && !cancelOpen(send.cancel) && statusClass(send.amazonStatus ?? lane.mcf?.status ?? null) === 'cancellable'
      ? <p style={{ margin: 0 }} data-testid="cancel-link-line">Amazon holds this order as {send.amazonStatus ?? lane.mcf?.status}, so it can still be cancelled.
        {' '}<a href={`/creators/samples/${lane.derivedOrderKey}/preflight`} data-testid="cancel-link">Cancel on the send page</a></p> : null}
    {escalation === null ? null : <p className="wa-banner wa-banner--bad" data-testid="arcana-escalation" style={{ display: 'block', margin: 0 }}><strong>{escalation}</strong></p>}
    <p className="wa-page-sub" style={{ margin: 0 }}>Arcana owns this lane&apos;s order. Asking Amazon, releasing, recording as sent and cancelling are on
      {' '}<a href={`/creators/samples/${lane.derivedOrderKey}/preflight`} data-testid="arcana-controls-link">the pre-flight</a>.</p>
  </Panel>;
}

function ReadyOrder({ detail, send }: { detail: CreatorFulfillmentDetail; send: CreatorMcfLaneSend | null }) {
  const { lane, lastImport } = detail;
  const refused = lastImport?.status === 'failed';
  const shown = refused ? null : lane;
  const parts = shown === null ? [] : [shown.creatorRecordId, shown.asin, shown.reservationId ?? 'reservation not recorded', shown.laneState];
  const header = <CreatorHeader title={TITLE} subtitle={<>{parts.map((part) => `${part} · `).join('')}{lastRead(lastImport)}</>}>
    <span data-testid="order-key">{orderKey(detail.derivedOrderKey)}</span>
    {refused ? null : <LockBadge lock={detail.lockState} />}
  </CreatorHeader>;
  const links = <p className="wa-page-sub"><a href="/creators/samples">Sample shipments</a>
    {shown === null ? null : <> · <a href={`/creators/records/${shown.creatorRecordId}`}>Creator record {shown.creatorRecordId}</a></>}</p>;
  if (lastImport?.status === 'failed') {
    return <main className="wa-stack" data-testid="creator-fulfillment">{header}{links}
      <ImportRefusal run={lastImport} withheld="The lane and what Amazon reported are not shown, because they would read as current." /></main>;
  }
  if (lane === null) {
    return <main className="wa-stack" data-testid="creator-fulfillment">{header}{links}
      <EmptyState variant="empty" data-creator-state="no-lane" title="No sample lane carries this key"
        body={`No sample lane in this organisation has the order key ${detail.derivedOrderKey}, so there is no order to read.`}
        action={<a href="/creators/samples">Sample shipments</a>} /></main>;
  }
  const reconciliation = lane.laneState === 'Reconciliation Required';
  const found = detail.settlement?.settlement === 'found' || lane.mcf !== null;
  return <main className="wa-stack" data-testid="creator-fulfillment" data-lane={lane.laneState} data-owner={lane.orderOwner}>
    {header}{links}
    {send === null ? null : <ArcanaOutcome send={send} lane={lane} />}
    {reconciliation ? <Reconciliation detail={detail} lane={lane} /> : null}
    {found ? <Fulfillment detail={detail} lane={lane} /> : null}
    {!reconciliation && !found ? <><ReservationHolds detail={detail} lane={lane} /><LockLine lane={lane} /></> : null}
    <Reads detail={detail} />
  </main>;
}

export default function Screen({ data }: { data: ScreenData }) {
  switch (data.view) {
    case 'ready': return <ReadyOrder detail={data.props.detail} send={data.props.send ?? null} />;
    case 'missing': return <main className="wa-stack" data-testid="creator-fulfillment"><CreatorHeader title={TITLE} subtitle="Creator Connections" />
      <EmptyState variant="empty" data-creator-state="order-missing" title="No such sample order"
        body="This address does not name a sample order key." action={<a href="/creators/samples">Sample shipments</a>} /></main>;
    case 'gated': return <main className="wa-stack"><CreatorHeader title={TITLE} subtitle="Creator Connections" /><CreatorGated /></main>;
    case 'error': return <CreatorLoadError title={TITLE} message={data.props.message} />;
  }
}
