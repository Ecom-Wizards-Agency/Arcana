/**
 * The guarded Amazon cancel on the send section (WP-338i). A placed or
 * conflicting send whose last known Amazon status is Received or Planning is
 * offered "Cancel in Amazon", which asks the MCF worker for one getOrder read.
 * The read becomes a cancel preview, valid for 5 minutes, with the button
 * "Cancel 1 order in Amazon". The worker then reserves and sends the one cancel
 * request; only a later read showing Cancelled settles it.
 *
 * This module renders inside the client send section; it holds no state of its
 * own beyond the press's request id.
 */
import { useRef, type ReactNode } from 'react';
import { creatorMcfCancelConfirmation, type CreatorMcfCancelPreview } from '@wizard-ads/shared';
import type { CreatorMcfLaneCancel, CreatorMcfLaneSend, CreatorMcfLaneView } from '@wizard-ads/db';
import { Badge } from '../../ui/primitives';
import { formatTimestamp } from '../../ui/date-format';
import type { SendActionFailure, SendActionResult } from './send-actions';
import {
  CANCEL_ENDING_LABEL, CANCEL_MISSING_WORDS, CANCEL_ORIGINS, cancelAnswerWords, cancelEndingWords, cancelMissing, cancelOpen, cancelPreviewCurrent,
  cancelReasonWords, cancelRefusalWords, endingOf, notSentCause, statusClass, statusWords,
} from './cancel-model';
import { hhmm, type SendData } from './send-model';

/** The two cancel actions. Tests pass fakes; the section supplies the real server actions when the page did not. */
export interface CancelActions {
  requestCancelPreview(sendId: unknown): Promise<SendActionResult>;
  approveCancel(approval: unknown): Promise<SendActionResult>;
}

/**
 * The send card's command runner, shared so one message line and one pending flag cover every control. `words` turns a
 * refusal into the sentence shown; the cancel controls pass cancelRefusalWords so a refused cancel press is not described
 * in the send flow's words.
 */
export interface CancelCommand {
  pending: string | null;
  run(name: string, call: (() => Promise<SendActionResult>) | undefined, done?: string, words?: (reason: SendActionFailure) => string): Promise<void>;
}

const grid = { display: 'grid', gridTemplateColumns: 'minmax(10rem, max-content) 1fr', gap: '0.25rem 1.5rem', margin: 0 } as const;
const row = { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' } as const;
const at = (value: string | null, missing = 'a time not recorded') => value === null ? missing : formatTimestamp(value);

function Row({ label, children, fact }: { label: string; children: ReactNode; fact: string }) {
  return <><dt className="wa-page-sub">{label}</dt><dd style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }} data-fact={fact}>{children}</dd></>;
}

/**
 * Where a placed or conflicting send's cancel stands, newest first: an open
 * cancel, a queued read, a refused read, a cancel preview newer than the last
 * cancel, or nothing under way.
 */
export type CancelPhase =
  | { kind: 'open'; cancel: CreatorMcfLaneCancel; expired: boolean }
  | { kind: 'pending' }
  | { kind: 'read_refused'; refusal: NonNullable<CreatorMcfLaneSend['cancelPreviewRefusal']> }
  | { kind: 'preview'; preview: NonNullable<CreatorMcfLaneSend['latestCancelPreview']>; current: boolean }
  | { kind: 'idle' };

export function cancelPhase(send: CreatorMcfLaneSend, now: string): CancelPhase {
  const cancel = send.cancel;
  if (cancel !== null && cancel.endedAt === null) return { kind: 'open', cancel, expired: Date.parse(now) >= Date.parse(cancel.claimDeadline) };
  if (send.cancelPreviewPending) return { kind: 'pending' };
  if (send.cancelPreviewRefusal !== null) return { kind: 'read_refused', refusal: send.cancelPreviewRefusal };
  const preview = send.latestCancelPreview;
  // A preview read before the last cancel was pressed belongs to that cancel, never to a new one.
  if (preview !== null && (cancel === null || Date.parse(preview.readAt) > Date.parse(cancel.approvedAt))) {
    return { kind: 'preview', preview, current: cancelPreviewCurrent(preview, now) };
  }
  return { kind: 'idle' };
}

/** Whether the send section should re-read itself soon because a cancel read or an open cancel is in flight. */
export function cancelWaiting(send: CreatorMcfLaneSend): boolean {
  return CANCEL_ORIGINS.includes(send.state) && (send.cancelPreviewPending || cancelOpen(send.cancel));
}

function CancelOff({ data }: { data: SendData }) {
  const missing = cancelMissing(data.gate);
  const beat = data.gate?.heartbeat ?? null;
  return <section className="wa-banner wa-banner--warn" data-testid="cancel-off" style={{ display: 'block' }}>
    <strong>Cancel in Amazon is off, so there is no cancel button.</strong>{' '}Cancel needs every one of these, and
    {' '}{missing.length === 1 ? 'this one is' : 'these are'} missing:
    <ul style={{ margin: '0.25rem 0 0', paddingLeft: '1.25rem' }}>{missing.map((item) => <li key={item} data-missing={item}>{CANCEL_MISSING_WORDS[item]}
      {item === 'heartbeat' ? ` Last heartbeat: ${beat === null ? 'never' : formatTimestamp(beat.beatAt)}.` : ''}</li>)}</ul>
  </section>;
}

const itemLine = (preview: CreatorMcfCancelPreview) => preview.items.map((item) => `${item.quantity} × ${item.sellerSku}`).join(', ');

function PreviewCard({ preview, current, children }: {
  preview: NonNullable<CreatorMcfLaneSend['latestCancelPreview']>; current: boolean; children: ReactNode;
}) {
  const body = preview.preview;
  return <section className="wa-card" data-testid="cancel-preview" data-current={current ? 'true' : 'false'} aria-label="What the cancel will do">
    <div className="wa-card__body wa-stack">
      <h2 className="wa-card__title" style={{ margin: 0 }}>{current ? 'What the cancel will do' : 'The cancel preview is too old'}</h2>
      <dl style={grid}>
        <Row label="Order id" fact="order-id"><code>{body.derivedOrderKey}</code></Row>
        <Row label="Amazon status" fact="status">{body.existingOrder.status}</Row>
        <Row label="Items" fact="items">{itemLine(body)}</Row>
        <Row label="Total" fact="total">{body.totalUnits} {body.totalUnits === 1 ? 'unit' : 'units'}</Row>
        <Row label="Read" fact="read">Amazon · getFulfillmentOrder · {formatTimestamp(preview.readAt)}</Row>
        <Row label="Valid until" fact="valid-until">{formatTimestamp(preview.validUntil)}</Row>
      </dl>
      <p style={{ margin: 0 }} data-testid="cancel-meaning">A cancel asks Amazon to stop this order, and Amazon can still refuse it if picking starts first.</p>
      {children}
    </div>
  </section>;
}

/**
 * The cancel part of a placed or conflicting send's card: the step under way
 * and, for owners and admins, the one control that step allows.
 */
export function CancelControls({ send, view, data, actions, command, now }: {
  send: CreatorMcfLaneSend; view: CreatorMcfLaneView; data: SendData; actions: CancelActions | undefined; command: CancelCommand; now: string;
}) {
  /** One request id per cancel preview: a double press replays, and a press on a new preview is a new request. */
  const approveRequest = useRef<{ previewId: string; id: string } | null>(null);
  if (!CANCEL_ORIGINS.includes(send.state)) return null;
  const act = data.canAct;
  const on = cancelMissing(data.gate).length === 0;
  const status = send.amazonStatus ?? view.lane.mcfStatus;
  const allowed = statusClass(status) === 'cancellable';
  const phase = cancelPhase(send, now);
  const busy = command.pending !== null;
  const ask = (label: string, testid: string) => <button type="button" className="wa-btn" data-testid={testid} disabled={busy}
    onClick={() => { void command.run('cancel-read', actions && (() => actions.requestCancelPreview(send.sendId)),
      'The MCF worker will read this order from Amazon before a cancel.', cancelRefusalWords); }}>{label}</button>;
  /** The offer the rule allows now: the read button, why cancel is off, or why the status no longer allows one. */
  const offer = (label: string, testid: string) => {
    if (!act) return null;
    if (!allowed) return <p className="wa-page-sub" data-testid="cancel-not-allowed" data-status={status ?? 'unread'} style={{ margin: 0 }}>{statusWords(status)}</p>;
    if (!on) return <CancelOff data={data} />;
    return <p style={row} data-testid="cancel-offer">{ask(label, testid)}
      <span className="wa-page-sub">Arcana first reads the order from Amazon; the cancel needs its own press on that read.</span></p>;
  };
  const ending = send.cancel === null ? null : endingOf(send.cancel);
  const ended = send.cancel !== null && ending !== null
    ? <p style={{ margin: 0 }} data-testid="cancel-ended" data-ending={ending} data-reason={send.cancel.endingReason ?? 'none'}>
      <Badge tone={ending === 'expired' || ending === 'not_sent' ? 'neutral' : 'bad'}>Last cancel {CANCEL_ENDING_LABEL[ending]}</Badge>{' '}
      {cancelEndingWords(send.cancel)}
      {send.cancel.ending === 'not_honoured' ? ` Amazon's answer to the request: ${cancelAnswerWords(send.cancel)}` : ''}
      {send.cancel.endedAt === null ? '' : ` Ended ${formatTimestamp(send.cancel.endedAt)}.`}</p> : null;

  const step = (() => {
    switch (phase.kind) {
      case 'open':
        return phase.expired
          ? <div className="wa-stack" style={{ gap: '0.35rem' }}>
            <p style={{ margin: 0 }} data-testid="cancel-approved" data-expired="true">The cancel approved at {formatTimestamp(phase.cancel.approvedAt)} expired at
              {' '}{hhmm(phase.cancel.claimDeadline)}: the worker did not take it in time, so nothing was sent to Amazon.</p>
            {act && on && allowed ? <p style={row}>{ask('Read again', 'cancel-read-again')}</p> : null}
          </div>
          : <p style={{ margin: 0 }} data-testid="cancel-approved" data-expired="false">Cancel approved at {formatTimestamp(phase.cancel.approvedAt)}. The worker
            re-reads the order and sends the one cancel request; if it has not taken it by {hhmm(phase.cancel.claimDeadline)} the cancel expires and nothing
            is sent to Amazon.</p>;
      case 'pending':
        return <p style={{ margin: 0 }} data-testid="cancel-reading">Reading this order from Amazon before a cancel. This page refreshes on its own.</p>;
      case 'read_refused':
        return <div className="wa-stack" style={{ gap: '0.35rem' }}>
          <p style={{ margin: 0 }} data-testid="cancel-read-refused" data-reason={phase.refusal.reason ?? 'none'}>The read at {formatTimestamp(phase.refusal.at)} did
            {' '}not allow a cancel. {cancelReasonWords(phase.refusal.reason)}{phase.refusal.codes.length === 0 ? ''
              : <> Codes: {phase.refusal.codes.map((code) => <code key={code}>{code} </code>)}.</>}</p>
          {act && on ? <p style={row}>{ask('Read again', 'cancel-read-again')}</p> : act ? <CancelOff data={data} /> : null}
        </div>;
      case 'preview': {
        if (!phase.current) {
          return <PreviewCard preview={phase.preview} current={false}>
            <p className="wa-page-sub" data-testid="cancel-preview-old" style={{ margin: 0 }}>This read is older than 5 minutes or past its validity, so it
              cannot be approved. Read the order again.</p>
            {act && on ? <p style={row}>{ask('Read again', 'cancel-read-again')}</p> : act ? <CancelOff data={data} /> : null}
          </PreviewCard>;
        }
        const confirmation = creatorMcfCancelConfirmation(1);
        const latest = phase.preview;
        const press = () => {
          if (approveRequest.current?.previewId !== latest.previewId) approveRequest.current = { previewId: latest.previewId, id: globalThis.crypto.randomUUID() };
          const approval = { sendId: send.sendId, previewId: latest.previewId, previewFingerprint: latest.fingerprint, confirmation,
            requestId: approveRequest.current.id };
          void command.run('cancel', actions && (() => actions.approveCancel(approval)), undefined, cancelRefusalWords);
        };
        return <PreviewCard preview={latest} current>
          {!act ? null : !on ? <CancelOff data={data} /> : !allowed
            ? <p className="wa-page-sub" data-testid="cancel-not-allowed" data-status={status ?? 'unread'} style={{ margin: 0 }}>{statusWords(status)}</p>
            : <p style={row}><button type="button" className="wa-btn wa-btn--danger" data-testid="cancel-button" disabled={busy} onClick={press}>{confirmation}</button></p>}
        </PreviewCard>;
      }
      case 'idle':
        return offer('Cancel in Amazon', 'cancel-in-amazon');
    }
  })();
  return <section className="wa-stack" style={{ gap: '0.5rem' }} data-testid="mcf-cancel" data-cancel-phase={phase.kind} aria-label="Cancel in Amazon">
    {ended}
    {step}
  </section>;
}

/** A send the worker is cancelling, or cancelled: what happened so far, with no control. */
export function CancelProgress({ send, view }: { send: CreatorMcfLaneSend; view: CreatorMcfLaneView }) {
  const cancel = send.cancel;
  /**
   * A cancel from a conflict whose request did not take stayed cancel_dispatching until a read settled it under WP-338i.
   * Since WP-338p such a send returns to conflict at once, so only a cancel recorded before then shows this note.
   */
  const notSent = (cancel !== null && endingOf(cancel) === 'not_sent')
    || send.events.some((event) => event.event === 'cancel_not_sent' && (cancel === null || Date.parse(event.at) >= Date.parse(cancel.approvedAt)));
  switch (send.state) {
    case 'cancel_requested':
      return <p style={{ margin: 0 }} data-testid="cancel-note">Cancel requested{cancel === null ? '' : ` at ${formatTimestamp(cancel.approvedAt)}`}. The worker has
        not sent the cancel request yet. Nothing else can change this send until it settles.</p>;
    case 'cancel_dispatching':
      return <div className="wa-stack" style={{ gap: '0.35rem' }} data-testid="cancel-note">
        <dl style={grid} data-testid="cancel-dispatching">
          <Row label="Cancel approved" fact="approved">{at(cancel?.approvedAt ?? null)}</Row>
          <Row label="Request reserved" fact="reserved">{at(cancel?.reservedAt ?? null, 'reserved, time not recorded')}</Row>
          <Row label="Amazon's answer so far" fact="answer">{cancel === null ? 'No answer recorded yet.' : cancelAnswerWords(cancel)}</Row>
        </dl>
        <p style={{ margin: 0 }}>The worker sent the one cancel request. Arcana waits for a read of this order that shows Cancelled, and never sends the request
          a second time. This page refreshes on its own.</p>
        {notSent ? <p style={{ margin: 0 }} data-testid="cancel-not-sent" data-reason={cancel?.endingReason ?? 'none'}>{cancel !== null && endingOf(cancel) === 'not_sent'
          ? notSentCause(cancel.endingReason) : 'The cancel request did not take, so nothing changed at Amazon.'} This cancel was recorded before a conflict
          whose cancel did not take went straight back to conflict, so this send waits here for a read of the order: ask Amazon for this order id.</p> : null}
      </div>;
    case 'cancelled':
      return <p style={{ margin: 0 }} data-testid="cancel-note">Cancelled in Amazon at Arcana&apos;s request
        {cancel?.endedAt ? `: a read showing Cancelled was recorded at ${formatTimestamp(cancel.endedAt)}` : ''}. {view.lane.laneState === 'Cancelled' ? 'The lane is Cancelled with the reason operator_cancelled_in_amazon.'
        : `The lane reads ${view.lane.laneState}.`}</p>;
    default:
      return null;
  }
}
