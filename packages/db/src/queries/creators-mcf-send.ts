/**
 * Creator Connections round 3b (WP-338d, WP-338i): typed calls into the MCF send
 * ledger (migrations 20260928120000_creator_mcf_send and
 * 20260928130000_creator_mcf_cancel).
 *
 * Two surfaces, never mixed:
 *
 *  - Authenticated (exported from the package root): an owner or admin seals an
 *    address envelope, asks for a new preview, presses "Send N unit(s) via
 *    Amazon", withdraws, asks Amazon for the order id, releases an uncertain send
 *    with enough evidence, records a conflict as sent, asks for a cancel preview
 *    or presses "Cancel 1 order in Amazon". Owners, admins and
 *    analysts read the gate and the lane. Each call runs inside the verified
 *    actor's authenticated transaction; the SQL functions lock and recheck the
 *    membership themselves.
 *  - Service role (exported from `@wizard-ads/db/worker` only): the MCF unit's
 *    claim, custody read, preview record, reservation and outcome, the cancel
 *    preview, reservation and outcome, the start-up key id read, and the
 *    housekeeping sweep, purge, residue and alert summary.
 *
 * Nothing here calls Amazon, and nothing here ever holds a recipient's address:
 * the envelope is ciphertext, the mask is three coarse fields, and every
 * refusal is a fixed code.
 */
import {
  CreatorMcfCancelPreview, CreatorMcfMask, CreatorMcfPreview, CreatorMcfProviderOutcome, CreatorMcfRecipientBinding, CreatorMcfSealRequest, CreatorMcfSealedRecipient,
  CreatorMcfSendApproval, CreatorMcfSendOutcome, CreatorMcfSendState, CreatorSampleOrderKey, OrgActor, creatorMcfCanonicalJson,
  creatorMcfCancelConfirmation, creatorMcfSendOutcomeClass, type CreatorMcfEscalation, type CreatorMcfSendOutcomeClass, type CreatorSamplePackage,
  type FulfillmentOrderStatus, type FulfillmentShipmentObservation,
} from '@wizard-ads/shared';
import type { DbHandle, QuerySql } from '../client.js';
import { AgencyAccessDenied, withAuthenticatedActor } from './authenticated-actor.js';

const iso = (value: Date | string | null | undefined): string | null => value === null || value === undefined ? null : new Date(value).toISOString();

/** Every refusal the ledger's authenticated functions return, as a fixed code. */
export const CREATOR_MCF_REFUSALS = [
  'approval_invalid', 'envelope_invalid', 'binding_invalid', 'envelope_reused', 'binding_mismatch', 'lane_not_found', 'lane_not_reserved',
  'lane_not_runner', 'lane_changed', 'lane_sku_invalid', 'record_not_found', 'record_conflict', 'import_failed', 'preflight_missing',
  'preflight_hold', 'preflight_stale', 'preflight_mismatch', 'spapi_connection_count', 'grant_inactive', 'grant_ambiguous', 'key_unknown',
  'send_open', 'send_not_found', 'send_not_refreshable', 'custody_expired', 'request_reused', 'send_not_ready', 'preview_not_latest',
  'fingerprint_mismatch', 'preview_expired', 'confirmation_mismatch', 'preview_not_sendable', 'daily_cap_reached', 'send_not_withdrawable',
  'send_not_settleable', 'send_not_uncertain', 'order_found', 'release_evidence_insufficient', 'send_not_conflict', 'settlement_read_required',
  'send_not_cancellable', 'cancel_open', 'cancel_grant_inactive', 'cancel_preview_expired', 'order_not_cancellable', 'observation_stale',
] as const;
export type CreatorMcfRefusal = (typeof CREATOR_MCF_REFUSALS)[number];

/** An operator command's answer: done (possibly a replay of the same request), or refused with a code. */
export type CreatorMcfCommandResult<Outcome extends string> =
  | { outcome: 'refused'; reason: CreatorMcfRefusal }
  | { outcome: Outcome; sendId: string; state: CreatorMcfSendState; replay: boolean };

function refusal(value: unknown): CreatorMcfRefusal {
  const reason = String(value);
  if (!(CREATOR_MCF_REFUSALS as readonly string[]).includes(reason)) throw new Error('creator MCF ledger returned an unknown refusal');
  return reason as CreatorMcfRefusal;
}

function command<Outcome extends string>(raw: Record<string, unknown>, outcome: Outcome): CreatorMcfCommandResult<Outcome> {
  if (raw['outcome'] === 'refused') return { outcome: 'refused', reason: refusal(raw['reason']) };
  if (raw['outcome'] !== outcome) throw new Error('creator MCF ledger returned an unexpected outcome');
  return { outcome, sendId: String(raw['sendId']), state: CreatorMcfSendState.parse(raw['state']), replay: raw['replay'] === true };
}

/** One authenticated ledger call; a membership or role refusal is AgencyAccessDenied. */
async function asActor<T>(handle: Pick<DbHandle, 'sql'>, rawActor: OrgActor, run: (sql: QuerySql, actor: OrgActor) => Promise<T>): Promise<T> {
  const actor = OrgActor.parse(rawActor);
  try {
    return await withAuthenticatedActor(handle, actor, (sql) => run(sql, actor));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
    if (code === '42501') throw new AgencyAccessDenied();
    throw error;
  }
}

async function one(query: Promise<{ result: unknown }[]>): Promise<Record<string, unknown>> {
  const [row] = await query;
  if (row === undefined || row.result === null || typeof row.result !== 'object') throw new Error('creator MCF ledger returned no answer');
  return row.result as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Authenticated: owners and admins act; analysts read.
// ---------------------------------------------------------------------------

/**
 * Store the browser's sealed envelope for one lane. The body is parsed through
 * the strict shared CreatorMcfSealRequest first, so no plaintext field can reach
 * the database; the SQL function then compares the binding with the lane byte
 * for byte before storing anything.
 */
export async function sealCreatorMcfRecipient(handle: Pick<DbHandle, 'sql'>, actor: OrgActor,
  input: { creatorRecordId: string; asin: string; request: unknown }): Promise<CreatorMcfCommandResult<'sealed'> & { custodyExpiresAt?: string }> {
  const parsed = CreatorMcfSealRequest.safeParse(input.request);
  if (!parsed.success) return { outcome: 'refused', reason: 'envelope_invalid' };
  return asActor(handle, actor, async (sql, verified) => {
    const raw = await one(sql<{ result: unknown }[]>`select app.seal_creator_mcf_recipient(${verified.orgId}::uuid, ${input.creatorRecordId},
      ${input.asin}, ${JSON.stringify(parsed.data)}::text::jsonb) as result`);
    const result = command(raw, 'sealed');
    return result.outcome === 'sealed' && typeof raw['custodyExpiresAt'] === 'string'
      ? { ...result, custodyExpiresAt: iso(raw['custodyExpiresAt'])! } : result;
  });
}

/** "Preview again": from preview_ready or stale while custody is held. */
export async function refreshCreatorMcfPreview(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, sendId: string): Promise<CreatorMcfCommandResult<'previewing'>> {
  return asActor(handle, actor, async (sql, verified) => command(await one(sql<{ result: unknown }[]>`
    select app.refresh_creator_mcf_preview(${verified.orgId}::uuid, ${sendId}::uuid) as result`), 'previewing'));
}

/**
 * The press on "Send N unit(s) via Amazon", bound to one preview row by id and
 * fingerprint. The database recomputes the wording from the preview's own unit
 * count and refuses any other text.
 */
export async function approveCreatorMcfSend(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, approval: CreatorMcfSendApproval):
  Promise<CreatorMcfCommandResult<'approved'> & { claimDeadline?: string; units?: number }> {
  const parsed = CreatorMcfSendApproval.safeParse(approval);
  if (!parsed.success) return { outcome: 'refused', reason: 'approval_invalid' };
  const a = parsed.data;
  return asActor(handle, actor, async (sql, verified) => {
    const raw = await one(sql<{ result: unknown }[]>`select app.approve_creator_mcf_send(${verified.orgId}::uuid, ${a.sendId}::uuid,
      ${a.previewId}::uuid, ${a.previewFingerprint}, ${a.confirmation}, ${a.requestId}::uuid) as result`);
    const result = command(raw, 'approved');
    return result.outcome === 'approved' ? { ...result, claimDeadline: iso(raw['claimDeadline'] as string)!, units: Number(raw['units']) } : result;
  });
}

/** "Withdraw": any state that still holds custody, before dispatching. */
export async function withdrawCreatorMcfSend(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, sendId: string): Promise<CreatorMcfCommandResult<'withdrawn'>> {
  return asActor(handle, actor, async (sql, verified) => command(await one(sql<{ result: unknown }[]>`
    select app.withdraw_creator_mcf_send(${verified.orgId}::uuid, ${sendId}::uuid) as result`), 'withdrawn'));
}

/** "Ask Amazon for this order id": a settlement read now, for an accepted, uncertain or conflict send. */
export async function requestCreatorMcfSettleRead(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, sendId: string): Promise<CreatorMcfCommandResult<'requested'>> {
  return asActor(handle, actor, async (sql, verified) => {
    const raw = await one(sql<{ result: unknown }[]>`select app.request_creator_mcf_settle_read(${verified.orgId}::uuid, ${sendId}::uuid) as result`);
    return raw['outcome'] === 'requested' ? { outcome: 'requested', sendId, state: CreatorMcfSendState.parse(raw['state']), replay: false } : command(raw, 'requested');
  });
}

/** "Release as not created": uncertain only, with three post-reservation not-found reads over 30 minutes including a list read. */
export async function releaseCreatorMcfSend(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, sendId: string): Promise<CreatorMcfCommandResult<'released'>> {
  return asActor(handle, actor, async (sql, verified) => {
    const raw = await one(sql<{ result: unknown }[]>`select app.release_creator_mcf_send(${verified.orgId}::uuid, ${sendId}::uuid) as result`);
    return raw['outcome'] === 'released' ? { outcome: 'released', sendId, state: CreatorMcfSendState.parse(raw['state']), replay: false } : command(raw, 'released');
  });
}

/** "Record as sent": conflict only, with a validated read at most 30 minutes old. Idempotent on the request id. */
export async function resolveCreatorMcfConflict(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, sendId: string, requestId: string):
  Promise<CreatorMcfCommandResult<'placed'>> {
  return asActor(handle, actor, async (sql, verified) => command(await one(sql<{ result: unknown }[]>`
    select app.resolve_creator_mcf_conflict(${verified.orgId}::uuid, ${sendId}::uuid, ${requestId}::uuid) as result`), 'placed'));
}

/**
 * "Cancel in Amazon": asks the MCF worker for a cancel preview (one getOrder
 * read) of a placed or conflicting send. Needs an active grant with the action
 * class 'cancel'; idempotent while the read is queued.
 */
export async function requestCreatorMcfCancelPreview(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, sendId: string):
  Promise<CreatorMcfCommandResult<'cancel_preview_requested'>> {
  return asActor(handle, actor, async (sql, verified) => command(await one(sql<{ result: unknown }[]>`
    select app.request_creator_mcf_cancel_preview(${verified.orgId}::uuid, ${sendId}::uuid) as result`), 'cancel_preview_requested'));
}

/** The press on "Cancel 1 order in Amazon", bound to one cancel preview row by id and fingerprint. */
export interface CreatorMcfCancelApproval {
  sendId: string;
  previewId: string;
  previewFingerprint: string;
  /** Exactly creatorMcfCancelConfirmation(1): one send is one order. */
  confirmation: string;
  requestId: string;
}

const APPROVAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function cancelApproval(value: unknown): CreatorMcfCancelApproval | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = ['sendId', 'previewId', 'previewFingerprint', 'confirmation', 'requestId'];
  if (Object.keys(record).length !== keys.length || !keys.every((key) => typeof record[key] === 'string')) return null;
  const approval = record as unknown as CreatorMcfCancelApproval;
  return APPROVAL_UUID.test(approval.sendId) && APPROVAL_UUID.test(approval.previewId) && APPROVAL_UUID.test(approval.requestId)
    && /^[0-9a-f]{64}$/.test(approval.previewFingerprint) && approval.confirmation === creatorMcfCancelConfirmation(1) ? approval : null;
}

/**
 * The press on "Cancel 1 order in Amazon". The database recomputes the wording,
 * checks the cancel preview is the newest, unexpired (5 minutes) and still
 * Received or Planning, and that the grant carries 'cancel'. The send stays
 * placed or conflict until the worker reserves the one cancel request.
 */
export async function approveCreatorMcfCancel(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, input: unknown):
  Promise<CreatorMcfCommandResult<'cancel_approved'> & { cancelId?: string; claimDeadline?: string }> {
  const a = cancelApproval(input);
  if (a === null) return { outcome: 'refused', reason: 'approval_invalid' };
  return asActor(handle, actor, async (sql, verified) => {
    const raw = await one(sql<{ result: unknown }[]>`select app.approve_creator_mcf_cancel(${verified.orgId}::uuid, ${a.sendId}::uuid,
      ${a.previewId}::uuid, ${a.previewFingerprint}, ${a.confirmation}, ${a.requestId}::uuid) as result`);
    const result = command(raw, 'cancel_approved');
    return result.outcome === 'cancel_approved'
      ? { ...result, cancelId: String(raw['cancelId']), claimDeadline: iso(raw['claimDeadline'] as string)! } : result;
  });
}

export type CreatorMcfGateMissing = 'connection' | 'grant' | 'heartbeat' | 'scope' | 'dispatch_disabled';
export interface CreatorMcfSendGate {
  /** An unrevoked, unexpired grant for the org's one SP-API connection and marketplace. */
  active: boolean;
  /** Everything sending needs except the browser's public key, which the web checks itself. */
  sendingOn: boolean;
  missing: CreatorMcfGateMissing[];
  actions: ('send' | 'cancel')[];
  expiresAt: string | null;
  keyIds: string[];
  spapiConnectionId: string | null;
  marketplaceId: string | null;
  maxFeeMinor: number | null;
  currency: string | null;
  /** Units approved today (UTC) that still hold the cap; null without a grant. */
  unitsToday: number | null;
  maxUnitsPerDay: number | null;
  heartbeat: {
    beatAt: string; previewEnabled: boolean; dispatchEnabled: boolean; scopeCovers: boolean; workerRevision: string;
    lastAuthorizationFailureAt: string | null;
  } | null;
  /** Live custody rows past expiry and live rows behind a custody-free send, for this org. Both should be 0. */
  residue: { expiredLive: number; custodyFreeLive: number };
}

const numberOrNull = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/** What sending needs, for owners, admins and analysts. */
export async function readCreatorMcfSendGate(handle: Pick<DbHandle, 'sql'>, actor: OrgActor): Promise<CreatorMcfSendGate> {
  return asActor(handle, actor, async (sql, verified) => {
    const raw = await one(sql<{ result: unknown }[]>`select app.creator_mcf_send_gate(${verified.orgId}::uuid) as result`);
    const beat = raw['heartbeat'] as Record<string, unknown> | null;
    const residue = raw['residue'] as Record<string, unknown>;
    return {
      active: raw['active'] === true, sendingOn: raw['sendingOn'] === true, missing: raw['missing'] as CreatorMcfGateMissing[],
      actions: raw['actions'] as ('send' | 'cancel')[], expiresAt: iso(raw['expiresAt'] as string | null), keyIds: raw['keyIds'] as string[],
      spapiConnectionId: (raw['spapiConnectionId'] as string | null) ?? null, marketplaceId: (raw['marketplaceId'] as string | null) ?? null,
      maxFeeMinor: numberOrNull(raw['maxFeeMinor']), currency: (raw['currency'] as string | null) ?? null,
      unitsToday: numberOrNull(raw['unitsToday']), maxUnitsPerDay: numberOrNull(raw['maxUnitsPerDay']),
      heartbeat: beat === null ? null : {
        beatAt: iso(beat['beatAt'] as string)!, previewEnabled: beat['previewEnabled'] === true, dispatchEnabled: beat['dispatchEnabled'] === true,
        scopeCovers: beat['scopeCovers'] === true, workerRevision: String(beat['workerRevision']),
        lastAuthorizationFailureAt: iso(beat['lastAuthorizationFailureAt'] as string | null),
      },
      residue: { expiredLive: Number(residue['expiredLive']), custodyFreeLive: Number(residue['custodyFreeLive']) },
    };
  });
}

export interface CreatorMcfLaneSend {
  sendId: string;
  state: CreatorMcfSendState;
  stateReason: string | null;
  stateChangedAt: string;
  /** Null once purged ("destination purged"). */
  mask: CreatorMcfMask | null;
  /** Null when no custody is held. */
  custodyExpiresAt: string | null;
  escalatedAt: string | null;
  escalationReason: CreatorMcfEscalation | null;
  approvedAt: string | null;
  claimDeadline: string | null;
  units: number | null;
  intentReservedAt: string | null;
  providerOutcome: 'accepted' | 'rejected' | 'uncertain' | null;
  providerReason: string | null;
  providerStatus: number | null;
  providerCodes: string[] | null;
  amazonStatus: FulfillmentOrderStatus | null;
  acceptedAt: string | null;
  placedAt: string | null;
  createdAt: string;
  latestPreview: { previewId: string; fingerprint: string; preview: CreatorMcfPreview; readAt: string; validUntil: string } | null;
  events: { event: string; actorType: 'user' | 'worker' | 'system'; beforeState: string | null; afterState: string | null; reason: string | null;
    codes: string[]; httpStatus: number | null; at: string }[];
  /** The send's newest cancel (WP-338i), open or ended; null when "Cancel 1 order in Amazon" was never pressed. */
  cancel: CreatorMcfLaneCancel | null;
  /** The newest cancel preview: a getOrder read showing Received or Planning, valid for 5 minutes. */
  latestCancelPreview: { previewId: string; fingerprint: string; preview: CreatorMcfCancelPreview; readAt: string; validUntil: string } | null;
  /** A cancel preview read is queued for the worker and no cancel is open. */
  cancelPreviewPending: boolean;
  /** Why the newest cancel preview request did not become a preview (for example status_processing); null otherwise. */
  cancelPreviewRefusal: { reason: string | null; codes: string[]; at: string } | null;
}

/**
 * cancelled and not_honoured follow a request that may have taken; not_sent is a reserved request that certainly did not take
 * (withheld before it left, or answered 429 or 401/403); refused and expired end before any reservation.
 */
export type CreatorMcfCancelEnding = 'cancelled' | 'not_honoured' | 'not_sent' | 'refused' | 'expired';
export interface CreatorMcfLaneCancel {
  cancelId: string;
  /** The send's state at the press. */
  originState: 'placed' | 'conflict';
  approvedAt: string;
  /** The worker must reserve the cancel by then, or it ends expired and nothing is sent. */
  claimDeadline: string;
  /** When the worker was granted the one cancel request; null before. */
  reservedAt: string | null;
  providerOutcome: 'accepted' | 'rejected' | 'uncertain' | null;
  providerReason: string | null;
  providerStatus: number | null;
  providerCodes: string[] | null;
  endedAt: string | null;
  /** See CreatorMcfCancelEnding. Null while open. */
  ending: CreatorMcfCancelEnding | null;
  endingReason: string | null;
}
export interface CreatorMcfLaneView {
  lane: {
    creatorRecordId: string; asin: string; derivedOrderKey: string; sku: string | null; reservationId: string | null; laneState: string;
    orderOwner: 'runner' | 'arcana'; feeCapCents: number | null; mcfStatus: FulfillmentOrderStatus | null;
    settlement: { settlement: 'found' | 'not_found' | 'escalated'; notFoundProbes: number; lastProbeAt: string } | null;
  };
  /** The lane's newest send, or null when nothing was sealed for it. */
  send: CreatorMcfLaneSend | null;
}

function laneCancel(raw: Record<string, unknown> | null | undefined): CreatorMcfLaneCancel | null {
  if (raw === null || raw === undefined) return null;
  return {
    cancelId: String(raw['cancelId']), originState: raw['originState'] === 'conflict' ? 'conflict' : 'placed',
    approvedAt: iso(raw['approvedAt'] as string)!, claimDeadline: iso(raw['claimDeadline'] as string)!, reservedAt: iso(raw['reservedAt'] as string | null),
    providerOutcome: (raw['providerOutcome'] as CreatorMcfLaneCancel['providerOutcome']) ?? null,
    providerReason: (raw['providerReason'] as string | null) ?? null, providerStatus: numberOrNull(raw['providerStatus']),
    providerCodes: (raw['providerCodes'] as string[] | null) ?? null, endedAt: iso(raw['endedAt'] as string | null),
    ending: (raw['ending'] as CreatorMcfCancelEnding | null) ?? null, endingReason: (raw['endingReason'] as string | null) ?? null,
  };
}

/** The lane and its newest send, sanitized, for owners, admins and analysts. Null when the lane does not exist. */
export async function readCreatorMcfLane(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, creatorRecordId: string, asin: string): Promise<CreatorMcfLaneView | null> {
  return asActor(handle, actor, async (sql, verified) => {
    const [row] = await sql<{ result: Record<string, unknown> | null }[]>`select app.read_creator_mcf_lane(${verified.orgId}::uuid, ${creatorRecordId},
      ${asin}) as result`;
    const raw = row?.result ?? null;
    if (raw === null) return null;
    const lane = raw['lane'] as Record<string, unknown>;
    const settlement = lane['settlement'] as Record<string, unknown> | null;
    const send = raw['send'] as Record<string, unknown> | null;
    const preview = send?.['latestPreview'] as Record<string, unknown> | null | undefined;
    const cancelPreview = send?.['latestCancelPreview'] as Record<string, unknown> | null | undefined;
    const refusalRead = send?.['cancelPreviewRefusal'] as Record<string, unknown> | null | undefined;
    return {
      lane: {
        creatorRecordId: String(lane['creatorRecordId']), asin: String(lane['asin']), derivedOrderKey: CreatorSampleOrderKey.parse(lane['derivedOrderKey']),
        sku: (lane['sku'] as string | null) ?? null, reservationId: (lane['reservationId'] as string | null) ?? null, laneState: String(lane['laneState']),
        orderOwner: lane['orderOwner'] === 'arcana' ? 'arcana' : 'runner', feeCapCents: numberOrNull(lane['feeCapCents']),
        mcfStatus: (lane['mcfStatus'] as FulfillmentOrderStatus | null) ?? null,
        settlement: settlement === null ? null : { settlement: settlement['settlement'] as 'found' | 'not_found' | 'escalated',
          notFoundProbes: Number(settlement['notFoundProbes']), lastProbeAt: iso(settlement['lastProbeAt'] as string)! },
      },
      send: send === null ? null : {
        sendId: String(send['sendId']), state: CreatorMcfSendState.parse(send['state']), stateReason: (send['stateReason'] as string | null) ?? null,
        stateChangedAt: iso(send['stateChangedAt'] as string)!, mask: send['mask'] === null ? null : CreatorMcfMask.parse(send['mask']),
        custodyExpiresAt: iso(send['custodyExpiresAt'] as string | null), escalatedAt: iso(send['escalatedAt'] as string | null),
        escalationReason: (send['escalationReason'] as CreatorMcfEscalation | null) ?? null, approvedAt: iso(send['approvedAt'] as string | null),
        claimDeadline: iso(send['claimDeadline'] as string | null), units: numberOrNull(send['units']),
        intentReservedAt: iso(send['intentReservedAt'] as string | null),
        providerOutcome: (send['providerOutcome'] as CreatorMcfLaneSend['providerOutcome']) ?? null,
        providerReason: (send['providerReason'] as string | null) ?? null, providerStatus: numberOrNull(send['providerStatus']),
        providerCodes: (send['providerCodes'] as string[] | null) ?? null, amazonStatus: (send['amazonStatus'] as FulfillmentOrderStatus | null) ?? null,
        acceptedAt: iso(send['acceptedAt'] as string | null), placedAt: iso(send['placedAt'] as string | null), createdAt: iso(send['createdAt'] as string)!,
        latestPreview: preview === null || preview === undefined ? null : {
          previewId: String(preview['previewId']), fingerprint: String(preview['fingerprint']), preview: CreatorMcfPreview.parse(preview['body']),
          readAt: iso(preview['readAt'] as string)!, validUntil: iso(preview['validUntil'] as string)!,
        },
        events: (send['events'] as Record<string, unknown>[]).map((event) => ({
          event: String(event['event']), actorType: event['actorType'] as 'user' | 'worker' | 'system',
          beforeState: (event['beforeState'] as string | null) ?? null, afterState: (event['afterState'] as string | null) ?? null,
          reason: (event['reason'] as string | null) ?? null, codes: event['codes'] as string[], httpStatus: numberOrNull(event['httpStatus']),
          at: iso(event['at'] as string)!,
        })),
        cancel: laneCancel(send['cancel'] as Record<string, unknown> | null | undefined),
        latestCancelPreview: cancelPreview === null || cancelPreview === undefined ? null : {
          previewId: String(cancelPreview['previewId']), fingerprint: String(cancelPreview['fingerprint']),
          preview: CreatorMcfCancelPreview.parse(cancelPreview['body']), readAt: iso(cancelPreview['readAt'] as string)!,
          validUntil: iso(cancelPreview['validUntil'] as string)!,
        },
        cancelPreviewPending: send['cancelPreviewPending'] === true,
        cancelPreviewRefusal: refusalRead === null || refusalRead === undefined ? null : {
          reason: (refusalRead['reason'] as string | null) ?? null, codes: refusalRead['codes'] as string[], at: iso(refusalRead['at'] as string)!,
        },
      },
    };
  });
}

interface OutcomeRow {
  state: string; escalated_at: Date | null; derived_order_key: string; amazon_status: string | null; accepted_at: Date | null;
  placed_at: Date | null; reservation_id: string; lane_settlement: string | null;
}

/**
 * The MCP read (creators.sample_send_outcome, WP-338h): the lane's newest send
 * as CreatorMcfSendOutcome, inside the caller's authenticated transaction and
 * under tenant RLS. No mask, fee or address. `escalated` is the send's own flag,
 * or WP-334's not-found escalation on the lane while the send is uncertain.
 */
export async function readCreatorMcfSendOutcome(sql: QuerySql, orgId: string,
  target: { creatorRecordId: string; asin: string } | { derivedOrderKey: string }): Promise<CreatorMcfSendOutcome | null> {
  const key = 'derivedOrderKey' in target ? target.derivedOrderKey : null;
  if (key !== null && !CreatorSampleOrderKey.safeParse(key).success) return null;
  const rows = key !== null
    ? await sql<OutcomeRow[]>`select s.state, s.escalated_at, s.derived_order_key, s.amazon_status, s.accepted_at, s.placed_at, s.reservation_id,
          l.mcf_settlement as lane_settlement
        from public.creator_mcf_sends s join public.creator_sample_shipments l
          on l.org_id = s.org_id and l.creator_record_id = s.creator_record_id and l.asin = s.asin
        where s.org_id = ${orgId} and s.derived_order_key = ${key} order by s.created_at desc, s.id desc limit 1`
    : await sql<OutcomeRow[]>`select s.state, s.escalated_at, s.derived_order_key, s.amazon_status, s.accepted_at, s.placed_at, s.reservation_id,
          l.mcf_settlement as lane_settlement
        from public.creator_mcf_sends s join public.creator_sample_shipments l
          on l.org_id = s.org_id and l.creator_record_id = s.creator_record_id and l.asin = s.asin
        where s.org_id = ${orgId} and s.creator_record_id = ${(target as { creatorRecordId: string }).creatorRecordId}
          and s.asin = ${(target as { asin: string }).asin}
        order by s.created_at desc, s.id desc limit 1`;
  const row = rows[0];
  if (row === undefined) return null;
  const state = CreatorMcfSendState.parse(row.state);
  const outcomeClass: CreatorMcfSendOutcomeClass = creatorMcfSendOutcomeClass(state);
  return CreatorMcfSendOutcome.parse({
    derivedOrderKey: row.derived_order_key, state, class: outcomeClass,
    escalated: row.escalated_at !== null || (state === 'uncertain' && row.lane_settlement === 'escalated'),
    mcfStatus: row.amazon_status, acceptedAt: iso(row.accepted_at), placedAt: iso(row.placed_at), reservationId: row.reservation_id,
  });
}

// ---------------------------------------------------------------------------
// Service role: the MCF unit and housekeeping. Exported from @wizard-ads/db/worker only.
// ---------------------------------------------------------------------------

async function serviceCall(handle: Pick<DbHandle, 'sql'>, query: (sql: DbHandle['sql']) => Promise<{ result: unknown }[]>): Promise<Record<string, unknown> | null> {
  const [row] = await query(handle.sql);
  return row === undefined || row.result === null ? null : row.result as Record<string, unknown>;
}

async function serviceAnswer(handle: Pick<DbHandle, 'sql'>, query: (sql: DbHandle['sql']) => Promise<{ result: unknown }[]>): Promise<Record<string, unknown>> {
  const raw = await serviceCall(handle, query);
  if (raw === null) throw new Error('creator MCF ledger returned no answer');
  return raw;
}

export type CreatorMcfOutboxAction = 'preview' | 'dispatch' | 'settle' | 'cancel';

/** One leased piece of work and what the worker needs for it. No ciphertext: that is readCreatorMcfCustody. */
export interface CreatorMcfClaim {
  outboxId: string;
  action: CreatorMcfOutboxAction;
  leaseId: string;
  leaseUntil: string;
  attempts: number;
  sendId: string;
  orgId: string;
  state: CreatorMcfSendState;
  binding: CreatorMcfRecipientBinding;
  sku: string;
  spapiConnectionId: string;
  marketplaceId: string;
  keyId: string;
  envelopeId: string;
  envelopeSha256: string;
  /** Preview and dispatch only. */
  mask: CreatorMcfMask | null;
  preflight: { id: string; runId: string; completedAt: string };
  caps: { laneFeeCapMinor: number | null; grantFeeCapMinor: number | null; grantCurrency: string | null };
  /** Dispatch only: the approved preview the re-read must equal. */
  approval: { approvedAt: string; claimDeadline: string; units: number; previewId: string; fingerprint: string; preview: CreatorMcfPreview } | null;
  /** Settle only. For a cancel_dispatching send, `intentReservedAt` and `ladderStart` are the cancel's reservation: only a later read counts. */
  settle: { intentReservedAt: string | null; acceptedAt: string | null; reads: number; ladderStart: string } | null;
  /**
   * Cancel only (absent on other claims). `preview`: read the order and record a cancel preview.
   * `execute`: an approved cancel to reserve and send, with the preview the operator approved.
   */
  cancel?: CreatorMcfCancelClaim | null;
}

export type CreatorMcfCancelClaim =
  | { mode: 'preview'; originState: 'placed' | 'conflict' }
  | { mode: 'execute'; cancelId: string; originState: 'placed' | 'conflict'; approvedAt: string; claimDeadline: string; previewId: string;
      fingerprint: string; preview: CreatorMcfCancelPreview };

function cancelClaim(raw: Record<string, unknown> | null | undefined): CreatorMcfCancelClaim | null {
  if (raw === null || raw === undefined) return null;
  const originState = raw['originState'] === 'conflict' ? 'conflict' : 'placed';
  if (raw['mode'] !== 'execute') return { mode: 'preview', originState };
  return {
    mode: 'execute', cancelId: String(raw['cancelId']), originState, approvedAt: iso(raw['approvedAt'] as string)!,
    claimDeadline: iso(raw['claimDeadline'] as string)!, previewId: String(raw['previewId']), fingerprint: String(raw['fingerprint']),
    preview: CreatorMcfCancelPreview.parse(raw['preview']),
  };
}

/** Claims the next due work in scope (runs the expiry sweep first). Null when nothing is due. */
export async function claimCreatorMcfOutbox(handle: Pick<DbHandle, 'sql'>, input: { claimant: string; scope: readonly string[];
  actions: readonly CreatorMcfOutboxAction[] }): Promise<CreatorMcfClaim | null> {
  const raw = await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.claim_creator_mcf_outbox(${input.claimant},
    ${[...input.scope]}::text[], ${[...input.actions]}::text[]) as result`);
  if (raw === null) return null;
  const preflight = raw['preflight'] as Record<string, unknown>;
  const caps = raw['caps'] as Record<string, unknown>;
  const approval = raw['approval'] as Record<string, unknown> | null;
  const settle = raw['settle'] as Record<string, unknown> | null;
  return {
    outboxId: String(raw['outboxId']), action: raw['action'] as CreatorMcfOutboxAction, leaseId: String(raw['leaseId']),
    leaseUntil: iso(raw['leaseUntil'] as string)!, attempts: Number(raw['attempts']), sendId: String(raw['sendId']), orgId: String(raw['orgId']),
    state: CreatorMcfSendState.parse(raw['state']), binding: CreatorMcfRecipientBinding.parse(raw['binding']), sku: String(raw['sku']),
    spapiConnectionId: String(raw['spapiConnectionId']), marketplaceId: String(raw['marketplaceId']), keyId: String(raw['keyId']),
    envelopeId: String(raw['envelopeId']), envelopeSha256: String(raw['envelopeSha256']),
    mask: raw['mask'] === null || raw['mask'] === undefined ? null : CreatorMcfMask.parse(raw['mask']),
    preflight: { id: String(preflight['id']), runId: String(preflight['runId']), completedAt: iso(preflight['completedAt'] as string)! },
    caps: { laneFeeCapMinor: numberOrNull(caps['laneFeeCapMinor']), grantFeeCapMinor: numberOrNull(caps['grantFeeCapMinor']),
      grantCurrency: (caps['grantCurrency'] as string | null) ?? null },
    approval: approval === null || approval === undefined ? null : {
      approvedAt: iso(approval['approvedAt'] as string)!, claimDeadline: iso(approval['claimDeadline'] as string)!, units: Number(approval['units']),
      previewId: String(approval['previewId']), fingerprint: String(approval['fingerprint']), preview: CreatorMcfPreview.parse(approval['preview']),
    },
    settle: settle === null || settle === undefined ? null : {
      intentReservedAt: iso(settle['intentReservedAt'] as string | null), acceptedAt: iso(settle['acceptedAt'] as string | null),
      reads: Number(settle['reads']), ladderStart: iso(settle['ladderStart'] as string)!,
    },
    ...(raw['action'] === 'cancel' ? { cancel: cancelClaim(raw['cancel'] as Record<string, unknown> | null) } : {}),
  };
}

/** The sealed envelope for one open preview or dispatch lease, parsed through the strict shared schemas. Null without a live lease. */
export async function readCreatorMcfCustody(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string): Promise<{
  binding: CreatorMcfRecipientBinding; envelope: CreatorMcfSealedRecipient; ciphertextSha256: string; expiresAt: string;
} | null> {
  const raw = await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.read_creator_mcf_custody(${sendId}::uuid, ${leaseId}::uuid) as result`);
  if (raw === null) return null;
  return {
    binding: CreatorMcfRecipientBinding.parse(raw['binding']), envelope: CreatorMcfSealedRecipient.parse(raw['envelope']),
    ciphertextSha256: String(raw['ciphertextSha256']), expiresAt: iso(raw['expiresAt'] as string)!,
  };
}

export type CreatorMcfWorkerDecision = { decision: string; state?: CreatorMcfSendState; reason?: string } & Record<string, unknown>;

function decision(raw: Record<string, unknown> | null): CreatorMcfWorkerDecision {
  if (raw === null || typeof raw['decision'] !== 'string') throw new Error('creator MCF ledger returned no decision');
  return { ...raw, decision: raw['decision'], ...(raw['state'] === undefined ? {} : { state: CreatorMcfSendState.parse(raw['state']) }) };
}

/**
 * Records one preview (kind `preview` or `dispatch_reread`) as the canonical JSON
 * its fingerprint covers. The database decides preview_ready or preview_refused
 * for a preview, and same or stale for a re-read.
 */
export async function recordCreatorMcfPreview(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, preview: CreatorMcfPreview): Promise<CreatorMcfWorkerDecision> {
  const text = creatorMcfCanonicalJson(CreatorMcfPreview.parse(preview));
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.record_creator_mcf_preview(${sendId}::uuid,
    ${leaseId}::uuid, ${text}) as result`));
}

export type CreatorMcfPreviewRefusal = 'order_exists' | 'recipient_invalid' | 'mask_mismatch' | 'envelope_invalid' | 'envelope_unopenable'
  | 'key_mismatch' | 'key_unavailable' | 'country_not_allowed' | 'provider_refused';

/** A refusal without a sendable Amazon answer. Custody is destroyed. Codes are fixed codes only (field.rule or provider codes). */
export async function refuseCreatorMcfPreview(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, reason: CreatorMcfPreviewRefusal,
  codes: readonly string[]): Promise<CreatorMcfWorkerDecision> {
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.refuse_creator_mcf_preview(${sendId}::uuid,
    ${leaseId}::uuid, ${reason}, ${[...codes]}::text[]) as result`));
}

/** Gives a lease back without an outcome; the work is due again after `retrySeconds`. A dispatch stays approved. */
export async function releaseCreatorMcfClaim(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, retrySeconds: number): Promise<CreatorMcfWorkerDecision> {
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.release_creator_mcf_claim(${sendId}::uuid,
    ${leaseId}::uuid, ${retrySeconds}::integer) as result`));
}

export type CreatorMcfReservation =
  | { decision: 'dispatch_once'; sendId: string; derivedOrderKey: string; sku: string; quantity: number; marketplaceId: string; approvedAt: string;
      reservedAt: string; leaseUntil: string; requestDigest: string }
  | { decision: 'already_reserved'; state: CreatorMcfSendState }
  | { decision: 'refused'; reason: string; state?: CreatorMcfSendState };

/**
 * The clause-9 recheck and the one permission to POST. `requestDigest` must be
 * computed over the address-free parts of the create request only.
 */
export async function reserveCreatorMcfDispatch(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, requestDigest: string): Promise<CreatorMcfReservation> {
  const raw = decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.reserve_creator_mcf_dispatch(${sendId}::uuid,
    ${leaseId}::uuid, ${requestDigest}) as result`));
  if (raw.decision === 'dispatch_once') {
    return {
      decision: 'dispatch_once', sendId: String(raw['sendId']), derivedOrderKey: String(raw['derivedOrderKey']), sku: String(raw['sku']),
      quantity: Number(raw['quantity']), marketplaceId: String(raw['marketplaceId']), approvedAt: iso(raw['approvedAt'] as string)!,
      reservedAt: iso(raw['reservedAt'] as string)!, leaseUntil: iso(raw['leaseUntil'] as string)!, requestDigest: String(raw['requestDigest']),
    };
  }
  if (raw.decision === 'already_reserved') return { decision: 'already_reserved', state: raw.state! };
  return { decision: 'refused', reason: String(raw['reason']), ...(raw.state === undefined ? {} : { state: raw.state }) };
}

/** One read of the send's order key, as the worker's reader returns it with every recipient field dropped. */
export type CreatorMcfOrderRead =
  | { outcome: 'found'; operation: 'getFulfillmentOrder'; status: FulfillmentOrderStatus; readAt: string; sellerFulfillmentOrderId?: string;
      items: { sellerSku: string; quantity: number; cancelledQuantity?: number; unfulfillableQuantity?: number }[];
      shipments: FulfillmentShipmentObservation[]; packages: CreatorSamplePackage[] }
  | { outcome: 'not_found'; operation: 'getFulfillmentOrder' | 'listAllFulfillmentOrders'; readAt: string };

/** The first POST outcome; custody is destroyed in the same transaction. A 4xx other than 401/403 needs the getOrder read that followed it. */
export async function recordCreatorMcfOutcome(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, outcome: CreatorMcfProviderOutcome,
  lookup: CreatorMcfOrderRead | null = null): Promise<CreatorMcfWorkerDecision> {
  const parsed = CreatorMcfProviderOutcome.parse(outcome);
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.record_creator_mcf_outcome(${sendId}::uuid,
    ${leaseId}::uuid, ${JSON.stringify(parsed)}::text::jsonb, ${lookup === null ? null : JSON.stringify(lookup)}::text::jsonb) as result`));
}

/** One settlement read (or the read before the POST, under the dispatch lease), classified. */
export async function recordCreatorMcfSettlement(handle: Pick<DbHandle, 'sql'>, sendId: string, lookup: CreatorMcfOrderRead,
  leaseId: string | null = null): Promise<CreatorMcfWorkerDecision> {
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.record_creator_mcf_settlement(${sendId}::uuid,
    ${JSON.stringify(lookup)}::text::jsonb, ${leaseId}::uuid) as result`));
}

// ---------------------------------------------------------------------------
// Service role: the guarded cancel (WP-338i).
// ---------------------------------------------------------------------------

/**
 * Records the worker's cancel preview read under its cancel lease: the getOrder
 * read (recorded as an observation whatever it shows) and, when it shows
 * Received or Planning, the address-free cancel preview built from it. The
 * ledger answers cancel_preview_ready, or cancel_preview_refused with a reason
 * (order_not_found, status_<status>, state_changed, order_shape).
 */
export async function recordCreatorMcfCancelPreview(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, lookup: CreatorMcfOrderRead,
  preview: CreatorMcfCancelPreview | null): Promise<CreatorMcfWorkerDecision> {
  const text = preview === null ? null : creatorMcfCanonicalJson(CreatorMcfCancelPreview.parse(preview));
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.record_creator_mcf_cancel_preview(${sendId}::uuid,
    ${leaseId}::uuid, ${JSON.stringify(lookup)}::text::jsonb, ${text}) as result`));
}

export type CreatorMcfCancelReservation =
  | { decision: 'cancel_once'; sendId: string; cancelId: string; derivedOrderKey: string; marketplaceId: string; reservedAt: string;
      orderStatus: 'Received' | 'Planning'; requestDigest: string }
  | { decision: 'already_reserved'; state: CreatorMcfSendState }
  | { decision: 'refused'; reason: string; ending?: string; orderStatus?: FulfillmentOrderStatus | null; state?: CreatorMcfSendState };

/**
 * The clause-9 recheck and the one permission to send the cancel request, with
 * the worker's re-read of the order taken after the approval. `requestDigest`
 * covers the address-free cancel request only.
 */
export async function reserveCreatorMcfCancel(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, lookup: CreatorMcfOrderRead,
  requestDigest: string): Promise<CreatorMcfCancelReservation> {
  const raw = decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.reserve_creator_mcf_cancel(${sendId}::uuid,
    ${leaseId}::uuid, ${JSON.stringify(lookup)}::text::jsonb, ${requestDigest}) as result`));
  if (raw.decision === 'cancel_once') {
    return {
      decision: 'cancel_once', sendId: String(raw['sendId']), cancelId: String(raw['cancelId']), derivedOrderKey: String(raw['derivedOrderKey']),
      marketplaceId: String(raw['marketplaceId']), reservedAt: iso(raw['reservedAt'] as string)!,
      orderStatus: raw['orderStatus'] === 'Planning' ? 'Planning' : 'Received', requestDigest: String(raw['requestDigest']),
    };
  }
  if (raw.decision === 'already_reserved') return { decision: 'already_reserved', state: raw.state! };
  return {
    decision: 'refused', reason: String(raw['reason']),
    ...(typeof raw['ending'] === 'string' ? { ending: raw['ending'] } : {}),
    ...(raw['orderStatus'] === undefined ? {} : { orderStatus: (raw['orderStatus'] as FulfillmentOrderStatus | null) ?? null }),
    ...(raw.state === undefined ? {} : { state: raw.state }),
  };
}

/**
 * The cancel request's answer, recorded once under the reserved lease. A 4xx other than 401/403 needs the getOrder read that followed it.
 * An answer arriving after the cancel ended is `late_recorded` with the cancel's `ending`; after `not_sent` it contradicts the ledger.
 */
export async function recordCreatorMcfCancelOutcome(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, outcome: CreatorMcfProviderOutcome,
  lookup: CreatorMcfOrderRead | null = null): Promise<CreatorMcfWorkerDecision> {
  const parsed = CreatorMcfProviderOutcome.parse(outcome);
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.record_creator_mcf_cancel_outcome(${sendId}::uuid,
    ${leaseId}::uuid, ${JSON.stringify(parsed)}::text::jsonb, ${lookup === null ? null : JSON.stringify(lookup)}::text::jsonb) as result`));
}

/** Why a reserved cancel request was not sent, as the worker knows it (the request never left). */
export type CreatorMcfCancelUnsentReason = 'reservation_mismatch' | 'stopping' | 'policy_off' | 'lease_budget' | 'token_unavailable' | 'request_invalid'
  | 'cancel_failed';

/**
 * A reserved cancel request the worker did not send. The send returns to the state the cancel was pressed from (placed, or
 * conflict with its escalation kept) and the cancel ends not_sent, so the operator may cancel again.
 */
export async function recordCreatorMcfCancelUnsent(handle: Pick<DbHandle, 'sql'>, sendId: string, leaseId: string, reason: CreatorMcfCancelUnsentReason):
  Promise<CreatorMcfWorkerDecision> {
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.record_creator_mcf_cancel_unsent(${sendId}::uuid,
    ${leaseId}::uuid, ${reason}) as result`));
}

/** The recipient key ids of every active grant in `scope`, so the MCF unit can refuse to start without a key file for each. */
export async function readCreatorMcfActiveKeyIds(handle: Pick<DbHandle, 'sql'>, scope: readonly string[]): Promise<string[]> {
  const [row] = await handle.sql<{ ids: string[] | null }[]>`select app.creator_mcf_active_key_ids(${[...scope]}::text[]) as ids`;
  return (row?.ids ?? []).map(String);
}

/** Escalates an accepted or uncertain send Amazon has not settled in 7 days. */
export async function markCreatorMcfLadderExhausted(handle: Pick<DbHandle, 'sql'>, sendId: string): Promise<CreatorMcfWorkerDecision> {
  return decision(await serviceCall(handle, (sql) => sql<{ result: unknown }[]>`select app.mark_creator_mcf_ladder_exhausted(${sendId}::uuid) as result`));
}

/** The expiry sweep's three rules; returns how many sends each moved. */
export async function expireCreatorMcfCustody(handle: Pick<DbHandle, 'sql'>): Promise<{ expiredTtl: number; expiredUnclaimed: number; uncertainCrash: number }> {
  const raw = await serviceAnswer(handle, (sql) => sql<{ result: unknown }[]>`select app.expire_creator_mcf_custody() as result`);
  return { expiredTtl: Number(raw['expiredTtl']), expiredUnclaimed: Number(raw['expiredUnclaimed']), uncertainCrash: Number(raw['uncertainCrash']) };
}

/** Proof of deletion: live custody rows past expiry, and live rows behind a custody-free send. Both must be 0. */
export async function readCreatorMcfCustodyResidue(handle: Pick<DbHandle, 'sql'>): Promise<{ expiredLive: number; custodyFreeLive: number }> {
  const [row] = await handle.sql<{ expired_live: number; custody_free_live: number }[]>`select * from app.creator_mcf_custody_residue()`;
  if (row === undefined) throw new Error('creator MCF custody residue returned nothing');
  return { expiredLive: Number(row.expired_live), custodyFreeLive: Number(row.custody_free_live) };
}

export interface CreatorMcfHeartbeat {
  workerId: string;
  /** `<spapiConnectionUuid>:<marketplaceId>` pairs, no duplicates. */
  scope: readonly string[];
  previewEnabled: boolean;
  dispatchEnabled: boolean;
  workerRevision: string;
  lastAuthorizationFailureAt: string | null;
}

export async function recordCreatorMcfHeartbeat(handle: Pick<DbHandle, 'sql'>, beat: CreatorMcfHeartbeat): Promise<void> {
  await handle.sql`select app.record_creator_mcf_heartbeat(${beat.workerId}, ${[...beat.scope]}::text[], ${beat.previewEnabled},
    ${beat.dispatchEnabled}, ${beat.workerRevision}, ${beat.lastAuthorizationFailureAt}::timestamptz)`;
}

/**
 * Nulls masks 30 days after the send ended or delivery was observed, and at most 37 days after
 * sealing for a send that does neither (`backstop`).
 */
export async function purgeCreatorMcfMasks(handle: Pick<DbHandle, 'sql'>): Promise<{ scheduled: number; backstop: number; purged: number }> {
  const raw = await serviceAnswer(handle, (sql) => sql<{ result: unknown }[]>`select app.purge_creator_mcf_masks() as result`);
  return { scheduled: Number(raw['scheduled']), backstop: Number(raw['backstop']), purged: Number(raw['purged']) };
}

export type CreatorMcfAlertCode = 'uncertain_over_15m' | 'lane_escalated' | 'ladder_exhausted' | 'conflict' | 'heartbeat_stale'
  | 'custody_residue' | 'authorization_failure';
export interface CreatorMcfAlertSummary {
  generatedAt: string;
  /** Every condition, active or not; active means count > 0. Send ids only, at most 50 per condition. */
  conditions: { code: CreatorMcfAlertCode; count: number; sendIds: string[] }[];
}

export async function readCreatorMcfAlertSummary(handle: Pick<DbHandle, 'sql'>): Promise<CreatorMcfAlertSummary> {
  const raw = await serviceAnswer(handle, (sql) => sql<{ result: unknown }[]>`select app.creator_mcf_alert_summary() as result`);
  return {
    generatedAt: iso(raw['generatedAt'] as string)!,
    conditions: (raw['conditions'] as Record<string, unknown>[]).map((condition) => ({
      code: condition['code'] as CreatorMcfAlertCode, count: Number(condition['count']), sendIds: (condition['sendIds'] as string[]).map(String),
    })),
  };
}
