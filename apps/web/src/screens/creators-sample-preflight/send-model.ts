/**
 * The send section's pure rules (WP-338g): whether sending is on and what is
 * missing, whether a lane can take an address, and the words for every send
 * state, refusal and code. No address and no key material passes through here;
 * the mask is three coarse fields.
 */
import {
  CREATOR_MCF_PREVIEW_VALID_MS, CreatorMcfRecipientBinding, CreatorMcfReservationId, isTerminalState,
  type CreatorMcfMask, type CreatorMcfRecipientIssue, type CreatorMcfSendPreview, type CreatorMcfSendState, type CreatorPreflightDetail,
  type CreatorSampleLaneState,
} from '@wizard-ads/shared';
import type { CreatorMcfLaneSend, CreatorMcfLaneView, CreatorMcfRefusal, CreatorMcfSendGate } from '@wizard-ads/db';

/** OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY as the loader parsed it. Only the public half ever exists here. */
export type SendKey =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'ok'; keyId: string; jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string } };

/** Everything the send section needs; the loader reads it after the pre-flight. */
export interface SendData {
  /** Owners and admins act; analysts see every state without the controls. */
  canAct: boolean;
  orgId: string;
  /** Null when the gate could not be read. */
  gate: CreatorMcfSendGate | null;
  key: SendKey;
  /** Null when no lane carries this key. */
  mcf: CreatorMcfLaneView | null;
}

/** Why sending is off, one entry per missing element. */
export type SendMissing = 'unread' | 'connection' | 'grant' | 'heartbeat' | 'scope' | 'dispatch_disabled' | 'preview_disabled'
  | 'key_absent' | 'key_invalid' | 'key_not_granted';

export const MISSING_WORDS: Record<SendMissing, string> = {
  unread: 'What sending needs could not be read, so it counts as off.',
  connection: 'Exactly one active SP-API connection with a usable marketplace binding for this organisation.',
  grant: 'An active send grant for that connection and marketplace. Nobody has issued one, or it expired or was revoked.',
  heartbeat: 'A heartbeat from the MCF worker in the last 5 minutes.',
  scope: 'The MCF worker\'s scope covering this connection and marketplace.',
  dispatch_disabled: 'Dispatch switched on in the MCF worker.',
  preview_disabled: 'Previews switched on in the MCF worker, so a sealed address is read against Amazon.',
  key_absent: 'The recipient public key (OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY) in this deployment.',
  key_invalid: 'A valid recipient public key: the configured OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY does not parse, or its key id does not match the key.',
  key_not_granted: 'The grant listing this deployment\'s public key id, so a sealed address can be stored.',
};

/**
 * Sending is on only with an active grant, a parsed public key the grant
 * lists, and a heartbeat under 5 minutes old with dispatch on and a scope
 * covering the lane's connection and marketplace. Anything else is named.
 */
export function sendingMissing(gate: CreatorMcfSendGate | null, key: SendKey): SendMissing[] {
  const missing: SendMissing[] = [];
  if (gate === null) missing.push('unread');
  else {
    for (const item of gate.missing) missing.push(item);
    if (!gate.missing.includes('heartbeat') && gate.heartbeat !== null && !gate.heartbeat.previewEnabled) missing.push('preview_disabled');
  }
  if (key.status === 'absent') missing.push('key_absent');
  else if (key.status === 'invalid') missing.push('key_invalid');
  else if (gate !== null && gate.active && !gate.keyIds.includes(key.keyId)) missing.push('key_not_granted');
  return missing;
}

/** The pre-flight a send may start from: PASS and completed within the last 24 hours (the ledger's rule). */
export const PREFLIGHT_SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export type LaneBlock =
  | { kind: 'no_lane' }
  | { kind: 'not_reserved'; laneState: string }
  | { kind: 'arcana_owned' }
  | { kind: 'reservation_form' }
  | { kind: 'no_sku' }
  | { kind: 'record_conflict' }
  | { kind: 'preflight_missing' }
  | { kind: 'preflight_hold' }
  | { kind: 'preflight_old'; completedAt: string };

/**
 * Whether this lane is handed over to Arcana and may take an address, or why
 * not. The database rechecks every one of these when the envelope arrives.
 */
export function laneBlock(detail: CreatorPreflightDetail, now: string): LaneBlock | null {
  const lane = detail.lane;
  if (lane === null) return { kind: 'no_lane' };
  if (lane.orderOwner === 'arcana') return { kind: 'arcana_owned' };
  if (lane.laneState !== 'Reserved' || lane.reservationId === null) return { kind: 'not_reserved', laneState: lane.laneState };
  if (!CreatorMcfReservationId.safeParse(lane.reservationId).success) return { kind: 'reservation_form' };
  if (lane.sku === null) return { kind: 'no_sku' };
  if (detail.lockState === 'Conflict') return { kind: 'record_conflict' };
  const preflight = detail.preflight;
  if (preflight === null) return { kind: 'preflight_missing' };
  if (preflight.result !== 'PASS') return { kind: 'preflight_hold' };
  if (Date.parse(now) - Date.parse(preflight.completedAt) > PREFLIGHT_SEND_WINDOW_MS) return { kind: 'preflight_old', completedAt: preflight.completedAt };
  return null;
}

/** The lane the browser seals for; null when any part is missing or out of shape. */
export function sealBinding(detail: CreatorPreflightDetail, orgId: string): CreatorMcfRecipientBinding | null {
  const lane = detail.lane;
  if (lane === null) return null;
  const parsed = CreatorMcfRecipientBinding.safeParse({
    orgId, creatorRecordId: lane.creatorRecordId, asin: lane.asin, derivedOrderKey: lane.derivedOrderKey, reservationId: lane.reservationId,
  });
  return parsed.success ? parsed.data : null;
}

/** Lane states in which Arcana's send can still move: the samples list reads the ledger for these lanes only. */
export const SEND_LANE_STATES: readonly CreatorSampleLaneState[] = ['Reserved', 'Verified for Submit', 'Reconciliation Required'];

/** A send that ended before any POST; the lane may take a new address. */
export const ENDED_BEFORE_POST: readonly CreatorMcfSendState[] = ['preview_refused', 'withdrawn', 'expired', 'expired_unclaimed', 'not_created'];
/** Sealed but not yet approved: typing the address again supersedes it. */
export const SUPERSEDABLE: readonly CreatorMcfSendState[] = ['sealed', 'previewing', 'preview_ready', 'stale'];
/** States in which custody is held and Withdraw is offered. */
export const WITHDRAWABLE: readonly CreatorMcfSendState[] = ['sealed', 'previewing', 'preview_ready', 'stale', 'approved'];
/** States the worker moves on its own; the screen refreshes while one is showing. */
export const WAITING: readonly CreatorMcfSendState[] = ['sealed', 'previewing', 'approved', 'dispatching', 'accepted', 'uncertain', 'conflict',
  'cancel_requested', 'cancel_dispatching'];

/** Whether a new address may be typed for this lane given its newest send. */
export function mayTakeAddress(send: CreatorMcfLaneSend | null): boolean {
  return send === null || ENDED_BEFORE_POST.includes(send.state) || SUPERSEDABLE.includes(send.state);
}

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'neutral';
/** The headline for each send state (DESIGN §2 step 7 and §9). */
export const SEND_STATE_WORDS: Record<CreatorMcfSendState, { title: string; tone: Tone }> = {
  sealed: { title: 'Address sealed, waiting for the worker to read a preview', tone: 'info' },
  previewing: { title: 'Address sealed, the worker is reading a preview from Amazon', tone: 'info' },
  preview_ready: { title: 'Preview ready', tone: 'info' },
  stale: { title: 'The order behind this preview changed between reading it and sending', tone: 'bad' },
  approved: { title: 'Approved, waiting for the worker', tone: 'info' },
  dispatching: { title: 'The worker is placing the order with Amazon', tone: 'info' },
  accepted: { title: 'Accepted by Amazon', tone: 'info' },
  uncertain: { title: 'Outcome unknown', tone: 'bad' },
  conflict: { title: 'Amazon has a different order under this id', tone: 'bad' },
  placed: { title: 'Placed', tone: 'good' },
  cancel_requested: { title: 'Cancel requested', tone: 'warn' },
  cancel_dispatching: { title: 'The worker is asking Amazon to cancel', tone: 'warn' },
  preview_refused: { title: 'Preview refused', tone: 'bad' },
  withdrawn: { title: 'Withdrawn', tone: 'neutral' },
  expired: { title: 'Expired', tone: 'neutral' },
  expired_unclaimed: { title: 'Expired unclaimed', tone: 'neutral' },
  rejected: { title: 'Rejected by Amazon', tone: 'bad' },
  not_created: { title: 'Released as not created', tone: 'neutral' },
  failed_by_amazon: { title: 'Failed by Amazon', tone: 'bad' },
  failed_after_placement: { title: 'Failed after placement', tone: 'bad' },
  cancelled: { title: 'Cancelled in Amazon', tone: 'neutral' },
};

/** Why a send ended or waits, from its state reason. Unknown reasons show as their code. */
export const STATE_REASON_WORDS: Record<string, string> = {
  operator: 'An owner or admin withdrew it.',
  superseded: 'A newer address was sealed for this lane, so this one was withdrawn.',
  ttl: 'The sealed address reached its 2-hour limit and was destroyed.',
  authority_changed: 'Authority changed after sealing.',
  grant_revoked: 'The send grant was revoked or replaced after sealing.',
  lane_changed: 'The runner changed the lane after sealing.',
  unopenable: 'The worker could not open the sealed address at dispatch, so nothing was sent.',
  claim_deadline: 'The worker did not claim the approval within 15 minutes, so nothing was sent.',
  crash: 'The worker stopped while the order request may have reached Amazon.',
  released: 'An owner or admin released it after Amazon answered not found on enough reads.',
  not_sendable: 'Amazon\'s answer could not be sent under the caps.',
  order_exists: 'Amazon already holds an order under this id, so no second one was requested.',
  recipient_invalid: 'The address did not pass Arcana\'s rules after opening.',
  mask_mismatch: 'The sealed address did not match its mask.',
  envelope_invalid: 'The sealed envelope was out of shape.',
  envelope_unopenable: 'The worker could not open the sealed address.',
  key_mismatch: 'The sealed address was sealed to a different key.',
  key_unavailable: 'The worker does not hold the key this address was sealed to.',
  country_not_allowed: 'The destination country is not in the grant\'s marketplace.',
  provider_refused: 'Amazon refused the preview.',
  dispatch_reread_differs: 'The re-read just before sending differed from the approved preview.',
  caps_changed: 'The fee no longer fits the caps as they stand at dispatch.',
};

/** Codes a refused preview carries (the ledger's own, plus field.rule codes for an address), in words. */
const CODE_WORDS: Record<string, string> = {
  not_fulfillable: 'Amazon cannot fulfil this unit',
  fee_missing: 'Amazon returned no fee estimate',
  grant_inactive: 'no active send grant',
  currency_mismatch: 'the fee is in a different currency from the grant',
  fee_over_grant_cap: 'the fee is over the grant\'s cap',
  lane_cap_missing: 'the lane has no fee cap',
  fee_over_lane_cap: 'the fee is over the lane\'s cap',
  InvalidDestinationAddress: 'Amazon refused the destination address',
};
const FIELD_WORDS: Record<string, string> = {
  name: 'name', addressLine1: 'address line 1', addressLine2: 'address line 2', addressLine3: 'address line 3', city: 'city',
  districtOrCounty: 'district or county', stateOrRegion: 'state or region', postalCode: 'postal code', countryCode: 'country', phone: 'phone',
  email: 'email',
};
const RULE_WORDS: Record<CreatorMcfRecipientIssue['rule'], string> = {
  required: 'is required', invalid_type: 'is not text', too_short: 'is too short', too_long: 'is longer than 60 characters',
  invalid_format: 'has characters Arcana does not accept', invalid_value: 'is not accepted', unknown_field: 'is not a field Arcana accepts',
  forbidden_field: 'must not be sent', city_required: 'is required outside Japan', state_required: 'is required for a US address',
  malformed: 'could not be read',
};

export function issueWords(issue: CreatorMcfRecipientIssue): string {
  return `${issue.field === null ? 'The address' : capitalise(FIELD_WORDS[issue.field] ?? issue.field)} ${RULE_WORDS[issue.rule]}`;
}

/** A code in words; a `field.rule` code in field words; anything else as the code itself. */
export function codeWords(code: string): string {
  if (CODE_WORDS[code] !== undefined) return CODE_WORDS[code];
  const [field, rule] = code.split('.');
  if (field !== undefined && rule !== undefined && FIELD_WORDS[field] !== undefined && rule in RULE_WORDS) {
    return `${capitalise(FIELD_WORDS[field])} ${RULE_WORDS[rule as CreatorMcfRecipientIssue['rule']]}`;
  }
  return code;
}

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Every ledger refusal as a sentence the operator can act on. */
export const REFUSAL_WORDS: Record<CreatorMcfRefusal | 'forbidden' | 'unavailable' | 'invalid', string> = {
  approval_invalid: 'The press did not carry a valid approval.',
  envelope_invalid: 'The sealed address was out of shape and was not stored.',
  binding_invalid: 'The lane the address was sealed for was out of shape.',
  envelope_reused: 'This sealed address was already used. Type the address again.',
  binding_mismatch: 'The lane changed since this page was read. Reload the page and type the address again.',
  lane_not_found: 'No sample lane carries this key.',
  lane_not_reserved: 'The runner has not reserved this lane, so it cannot take an address.',
  lane_not_runner: 'Arcana already owns this lane.',
  lane_changed: 'The runner changed this lane after the address was sealed.',
  lane_sku_invalid: 'The lane\'s SKU is missing or out of shape.',
  record_not_found: 'The creator record is not registered.',
  record_conflict: 'The creator record is locked in Conflict.',
  import_failed: 'The last control-runner import failed, so nothing here reads as current.',
  preflight_missing: 'No pre-flight is recorded for this lane.',
  preflight_hold: 'The newest pre-flight holds this lane.',
  preflight_stale: 'The pre-flight is older than 24 hours. The runner must run it again.',
  preflight_mismatch: 'The pre-flight names a different SKU or quantity from the lane.',
  spapi_connection_count: 'This organisation does not have exactly one usable SP-API connection.',
  grant_inactive: 'No active send grant covers this connection and marketplace.',
  grant_ambiguous: 'More than one send grant matches; sending stays off until one remains.',
  key_unknown: 'The grant does not list the key this address was sealed to.',
  send_open: 'Another send for this lane is already approved or in flight.',
  send_not_found: 'That send no longer exists.',
  send_not_refreshable: 'This send cannot be previewed again in its current state.',
  custody_expired: 'The sealed address expired. Type it again.',
  request_reused: 'That press was already used for a different approval.',
  send_not_ready: 'The preview is no longer ready to send.',
  preview_not_latest: 'A newer preview replaced the one on screen. Reload the page.',
  fingerprint_mismatch: 'The preview changed after it was shown. Reload the page.',
  preview_expired: 'The preview is older than 30 minutes. Preview again.',
  confirmation_mismatch: 'The button text did not match the preview\'s unit count.',
  preview_not_sendable: 'The preview cannot be sent under the fee caps or fulfillability.',
  daily_cap_reached: 'Today\'s unit cap (UTC) is reached.',
  send_not_withdrawable: 'This send can no longer be withdrawn.',
  send_not_settleable: 'Amazon can be asked only while the outcome is open.',
  send_not_uncertain: 'Only an unknown outcome can be released.',
  order_found: 'A read after the reservation found the order, so it cannot be released as not created.',
  release_evidence_insufficient: 'Not enough evidence yet: release needs three not-found reads after the reservation, over at least 30 minutes, including one full order list read.',
  send_not_conflict: 'This send is no longer in conflict.',
  settlement_read_required: 'Record as sent needs a read at most 30 minutes old that found the order in a validated status. Ask Amazon first.',
  forbidden: 'Only owners and admins can do this.',
  unavailable: 'The request did not complete. Nothing is shown as done; reload to see the current state.',
  invalid: 'The request was out of shape and was refused.',
};

/** The masked destination: country, the first two postal characters and the line count. Never more. */
export function maskText(mask: CreatorMcfMask): string {
  return `${mask.countryCode} · ${mask.postalPrefix}••• · ${mask.lines} ${mask.lines === 1 ? 'line' : 'lines'}`;
}

/** hh:mm in UTC. */
export const hhmm = (value: string) => `${new Date(value).toISOString().slice(11, 16)} UTC`;

/** Whether the ledger would still accept a press on this preview: before its validity and within 30 minutes of the read. */
export function previewCurrent(preview: Pick<CreatorMcfSendPreview, 'readAt' | 'validUntil'>, now: string): boolean {
  const at = Date.parse(now);
  return at < Date.parse(preview.validUntil) && at < Date.parse(preview.readAt) + CREATOR_MCF_PREVIEW_VALID_MS;
}

/** Minor units with the currency; null is "not given", never 0.00. */
export function minor(amount: number | null, currency: string | null): string {
  if (amount === null) return 'not given';
  return `${(amount / 100).toFixed(2)}${currency === null ? '' : ` ${currency}`}`;
}

/** Up to three initials from a typed name, for the sealed card in this tab only. */
export function initialsOf(name: string): string {
  return name.trim().split(/\s+/u).filter(Boolean).slice(0, 3).map((part) => `${Array.from(part)[0]!.toUpperCase()}.`).join(' ');
}

/** The newest event that moved the send into its current state, for its codes and time. */
export function arrivalEvent(send: CreatorMcfLaneSend): CreatorMcfLaneSend['events'][number] | null {
  return send.events.find((event) => event.afterState === send.state && event.beforeState !== send.state && event.event !== 'custody_destroyed')
    ?? null;
}

export function isOpenSend(send: CreatorMcfLaneSend | null): boolean {
  return send !== null && !isTerminalState(send.state);
}
