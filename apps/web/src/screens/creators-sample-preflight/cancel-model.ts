/**
 * The guarded Amazon cancel's pure rules (WP-338i): whether cancel is on and
 * what is missing, whether the last known Amazon status still allows a cancel,
 * where a placed or conflicting send's cancel stands, and the words for every
 * cancel ending and refused read. Both the send section and the read-only
 * sample order page use these words.
 */
import { CREATOR_MCF_CANCEL_PREVIEW_VALID_MS, CreatorMcfCancellableStatus, type FulfillmentOrderStatus } from '@wizard-ads/shared';
import type { CreatorMcfLaneCancel, CreatorMcfLaneSend, CreatorMcfSendGate } from '@wizard-ads/db';
import { MISSING_WORDS } from './send-model';

/** Why cancel is off, one entry per missing element. Cancel does not need the recipient key or previews on. */
export type CancelMissing = 'unread' | 'connection' | 'grant' | 'cancel_class' | 'heartbeat' | 'scope' | 'dispatch_disabled';

export const CANCEL_MISSING_WORDS: Record<CancelMissing, string> = {
  unread: 'What cancel needs could not be read, so it counts as off.',
  connection: MISSING_WORDS.connection,
  grant: 'An active grant for that connection and marketplace. Nobody has issued one, or it expired or was revoked.',
  cancel_class: 'The cancel action on the active grant. The grant issued for this connection does not allow cancelling.',
  heartbeat: MISSING_WORDS.heartbeat,
  scope: MISSING_WORDS.scope,
  dispatch_disabled: MISSING_WORDS.dispatch_disabled,
};

/**
 * Cancel is on with exactly one connection, an active grant whose actions
 * include 'cancel', and a heartbeat under 5 minutes old with dispatch on and a
 * scope covering the connection and marketplace. Anything else is named.
 */
export function cancelMissing(gate: CreatorMcfSendGate | null): CancelMissing[] {
  if (gate === null) return ['unread'];
  const missing: CancelMissing[] = [];
  if (gate.missing.includes('connection')) missing.push('connection');
  // The gate's own 'grant' entry means "no grant carrying send"; a grant carrying cancel only is enough here.
  if (!gate.active) missing.push('grant');
  else if (!gate.actions.includes('cancel')) missing.push('cancel_class');
  for (const item of ['heartbeat', 'scope', 'dispatch_disabled'] as const) if (gate.missing.includes(item)) missing.push(item);
  return missing;
}

/** The states a cancel is offered from. */
export const CANCEL_ORIGINS: readonly CreatorMcfLaneSend['state'][] = ['placed', 'conflict'];

/**
 * What the last known Amazon status allows: `cancellable` (Received or
 * Planning), `picking` (Processing or later), `not_validated` (New), `ended`
 * (Cancelled, Invalid or Unfulfillable) or `unread`.
 */
export type StatusClass = 'cancellable' | 'picking' | 'not_validated' | 'ended' | 'unread';
export function statusClass(status: FulfillmentOrderStatus | null): StatusClass {
  if (status === null) return 'unread';
  if (CreatorMcfCancellableStatus.safeParse(status).success) return 'cancellable';
  if (status === 'Processing' || status === 'Complete' || status === 'CompletePartialled') return 'picking';
  if (status === 'New') return 'not_validated';
  return 'ended';
}

/** Why no cancel is offered for a status that does not allow one. */
export function statusWords(status: FulfillmentOrderStatus | null): string {
  switch (statusClass(status)) {
    case 'cancellable': return `Amazon holds the order as ${status}, so it can still be cancelled.`;
    case 'picking': return `Amazon is already picking this unit (${status}), so it can no longer be cancelled.`;
    case 'not_validated': return 'Amazon has not validated this order yet (New). A cancel is offered once it reads Received or Planning.';
    case 'ended': return `Amazon holds the order as ${status}, so there is nothing to cancel.`;
    case 'unread': return 'No Amazon status is recorded for this order, so no cancel is offered.';
  }
}

/** Whether the ledger would still accept a press on this cancel preview: before its validity and within 5 minutes of the read. */
export function cancelPreviewCurrent(preview: { readAt: string; validUntil: string }, now: string): boolean {
  const at = Date.parse(now);
  return at < Date.parse(preview.validUntil) && at < Date.parse(preview.readAt) + CREATOR_MCF_CANCEL_PREVIEW_VALID_MS;
}

/** An Amazon status as the ledger records it in lower case, in Amazon's casing. */
const STATUS_CASE: Record<string, FulfillmentOrderStatus> = {
  new: 'New', received: 'Received', planning: 'Planning', processing: 'Processing', complete: 'Complete', completepartialled: 'CompletePartialled',
  cancelled: 'Cancelled', invalid: 'Invalid', unfulfillable: 'Unfulfillable',
};
export const amazonCase = (status: string): string => STATUS_CASE[status.toLowerCase()] ?? status;

/**
 * How a cancel ended. `not_sent` (WP-338i review): the reserved request certainly did not take, because Amazon
 * answered 429 or 401/403 or the worker withheld it before it left. Listed here too so the words exist whether
 * or not the ledger's type names it yet.
 */
export type CancelEnding = NonNullable<CreatorMcfLaneCancel['ending']> | 'not_sent';
export const endingOf = (cancel: CreatorMcfLaneCancel): CancelEnding | null => cancel.ending as CancelEnding | null;
export const CANCEL_ENDING_LABEL: Record<CancelEnding, string> = {
  cancelled: 'cancelled', not_honoured: 'not honoured', refused: 'refused', expired: 'expired', not_sent: 'not sent',
};

/** Why a reserved cancel request did not take. */
const NOT_SENT_WORDS: Record<string, string> = {
  rejected_throttled: 'Amazon throttled the cancel request (HTTP 429)',
  rejected_authorization: 'Amazon refused the cancel request for authorization (HTTP 401 or 403)',
  reservation_mismatch: 'The worker withheld the cancel request: the reservation did not match the approved cancel',
  stopping: 'The worker withheld the cancel request: it was stopping',
  policy_off: 'The worker withheld the cancel request: cancel is switched off in the worker',
  lease_budget: 'The worker withheld the cancel request: too little time was left on its lease',
  token_unavailable: 'The worker withheld the cancel request: it had no Amazon access token',
  request_invalid: 'The worker withheld the cancel request: the request failed its own checks',
  cancel_failed: 'The worker withheld the cancel request: it could not be built or sent',
};
/** What happened to the request, ending "so nothing changed at Amazon." */
export function notSentCause(reason: string | null): string {
  const cause = reason === null ? 'The cancel request was not sent' : NOT_SENT_WORDS[reason] ?? `The cancel request was not sent (${reason})`;
  return `${cause}, so nothing changed at Amazon.`;
}
export const notSentWords = (reason: string | null): string =>
  `${notSentCause(reason)} The order can be cancelled again while it is Received or Planning.`;

/** Why a cancel read or a cancel was refused, from its reason code. Unknown codes show as the code. */
export function cancelReasonWords(reason: string | null): string {
  if (reason === null) return 'The ledger recorded no reason.';
  const status = reason.startsWith('status_') ? STATUS_CASE[reason.slice('status_'.length)] : undefined;
  if (status !== undefined) {
    switch (statusClass(status)) {
      case 'picking': return `Amazon is already picking this unit (${status}), so it can no longer be cancelled.`;
      case 'not_validated': return 'Amazon has not validated this order yet (New), so it cannot be cancelled yet.';
      case 'ended': return `Amazon already holds the order as ${status}, so there is nothing to cancel.`;
      default: return `Amazon holds the order as ${status}.`;
    }
  }
  const words: Record<string, string> = {
    order_not_found: 'Amazon has no order under this id.',
    state_changed: 'The send changed state after the read was asked for, so the read no longer applies.',
    order_shape: 'The order Amazon returned does not match this send\'s SKU and one unit, so Arcana does not cancel it from here.',
    authority_changed: 'Authority changed after the approval.',
    grant_inactive: 'The grant carrying cancel was revoked or expired while the read was queued.',
    grant_revoked: 'The grant carrying cancel was revoked or replaced after the approval.',
    claim_deadline: 'The worker did not take the cancel by its deadline.',
  };
  return words[reason] ?? reason;
}

/** An unreserved cancel still open. */
export const cancelOpen = (cancel: CreatorMcfLaneCancel | null): boolean => cancel !== null && cancel.endedAt === null;

/** Amazon's answer to the one cancel request, as far as it is recorded. HTTP 200 is not proof. */
export function cancelAnswerWords(cancel: CreatorMcfLaneCancel): string {
  const http = cancel.providerStatus === null ? '' : `HTTP ${cancel.providerStatus}`;
  switch (cancel.providerOutcome) {
    case null: return 'No answer recorded yet.';
    case 'accepted': return `Accepted (${http || 'HTTP status not recorded'}). That is not proof: only a read showing Cancelled settles it.`;
    case 'uncertain': return `No answer Arcana can read as accepted or rejected${cancel.providerReason === null ? '' : ` (${cancel.providerReason})`}.`;
    case 'rejected': {
      const codes = cancel.providerCodes ?? [];
      return `Rejected${codes.length === 0 ? ' with no code' : `: ${codes.join(', ')}`}${http === '' && cancel.providerReason === null ? ''
        : ` (${[http, cancel.providerReason].filter(Boolean).join(', ')})`}.`;
    }
  }
}

/** One ended cancel in a sentence. */
export function cancelEndingWords(cancel: CreatorMcfLaneCancel): string {
  switch (endingOf(cancel)) {
    case 'cancelled': return 'Amazon cancelled the order at Arcana\'s request.';
    case 'not_honoured': return `Amazon did not cancel: the order reached ${cancel.endingReason === null ? 'a later status' : amazonCase(cancel.endingReason)}.`;
    case 'refused': return `The cancel was refused before any request reached Amazon. ${cancelReasonWords(cancel.endingReason)}`;
    case 'expired': return 'The cancel expired: the worker did not take it by its deadline, so nothing was sent to Amazon.';
    case 'not_sent': return notSentWords(cancel.endingReason);
    case null: return 'The cancel is still open.';
  }
}
