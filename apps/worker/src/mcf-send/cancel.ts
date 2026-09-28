/**
 * The guarded Amazon cancel of the MCF unit (WP-338i; DESIGN sections 13 and
 * 16, clause 8 of AGENTS.md).
 *
 * Cancelling an Amazon order is an Amazon write under the ten clauses. This
 * file is the only caller of cancelFulfillmentOrder, and it runs only in
 * `wizard-ads-mcf.service` through the loop, under the dispatch flag.
 *
 * A cancel claim is one of two things:
 *
 *  - `preview`: an owner or admin pressed "Cancel in Amazon". One
 *    getFulfillmentOrder read of the send's order key, recorded by the ledger
 *    as an observation whatever it shows, and, when it shows Received or
 *    Planning, as an address-free cancel preview valid for 5 minutes.
 *  - `execute`: an owner or admin pressed "Cancel 1 order in Amazon". In this
 *    order: policy; read the order again; policy; hand that read to
 *    `reserve_creator_mcf_cancel`, which rechecks the approver, the grant and
 *    the send and grants exactly one request only while the read shows
 *    Received or Planning (Processing or later is cancel_refused); policy;
 *    one cancelFulfillmentOrder; record its answer.
 *
 * The answer settles nothing: HTTP 200 means Amazon took the request, and the
 * ledger moves the send to cancelled only on a later read of the key that
 * shows Cancelled. An ambiguous answer is recorded as such and settled by the
 * ladder's reads, never by a second request. A request that was reserved but
 * certainly never left (a flag turned off, a stop, the start budget, no token,
 * a writer refusal before sending) is recorded as unsent, which lets a cancel
 * from placed be pressed again; anything that may have reached Amazon is an
 * answer, never "unsent".
 *
 * No address is involved: a cancel carries only the order key, and the reads
 * are the reader's sanitized allowlist.
 */
import type { DbHandle } from '@wizard-ads/db';
import {
  recordCreatorMcfCancelOutcome, recordCreatorMcfCancelPreview, recordCreatorMcfCancelUnsent, releaseCreatorMcfClaim, reserveCreatorMcfCancel,
  type CreatorMcfCancelClaim, type CreatorMcfCancelReservation, type CreatorMcfCancelUnsentReason, type CreatorMcfClaim, type CreatorMcfOrderRead,
  type CreatorMcfWorkerDecision,
} from '@wizard-ads/db/worker';
import {
  CREATOR_MCF_CANCEL_PREVIEW_VALID_MS, CreatorMcfCancelPreview, creatorMcfCanonicalJson, creatorMcfSha256Hex, type CreatorMcfProviderOutcome,
} from '@wizard-ads/shared';
import { FulfillmentOutboundError, type FulfillmentOutboundWriter } from '@wizard-ads/sp-api';
import { McfCountsError, type McfTickCounts } from './counts.js';
import type { McfLog } from './loop.js';
import { mcfOrderRead, mcfReadAt, mcfRetrySeconds, readMcfOrder, type McfOrderReader, type McfPacer } from './settle.js';

/** A cancel request may start at most this long after the reservation call began, well inside the ledger's 2-minute fallback read. */
export const MCF_CANCEL_START_BUDGET_MS = 15_000;
/** Reads after a cancel request stop starting once this long has passed since the reservation began. */
export const MCF_CANCEL_READ_DEADLINE_MS = 80_000;
const RECORD_ATTEMPTS = 3;
/** Pending answers are retried from memory for at most this long; the ladder settles the send either way. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** The ledger accepts reads at most an hour old; an older pending read is dropped. */
const PENDING_LOOKUP_MAX_AGE_MS = 45 * 60 * 1000;

// ---------------------------------------------------------------------------
// Seams.
// ---------------------------------------------------------------------------

/** The ledger's service-role cancel functions (migration 20260928130000). */
export interface McfCancelStore {
  recordCancelPreview(sendId: string, leaseId: string, lookup: CreatorMcfOrderRead, preview: CreatorMcfCancelPreview | null): Promise<CreatorMcfWorkerDecision>;
  reserveCancel(sendId: string, leaseId: string, lookup: CreatorMcfOrderRead, requestDigest: string): Promise<CreatorMcfCancelReservation>;
  recordCancelOutcome(sendId: string, leaseId: string, outcome: CreatorMcfProviderOutcome, lookup: CreatorMcfOrderRead | null): Promise<CreatorMcfWorkerDecision>;
  recordCancelUnsent(sendId: string, leaseId: string, reason: CreatorMcfCancelUnsentReason): Promise<CreatorMcfWorkerDecision>;
  releaseClaim(sendId: string, leaseId: string, retrySeconds: number): Promise<CreatorMcfWorkerDecision>;
}

export function postgresMcfCancelStore(handle: Pick<DbHandle, 'sql'>): McfCancelStore {
  return {
    recordCancelPreview: (sendId, leaseId, lookup, preview) => recordCreatorMcfCancelPreview(handle, sendId, leaseId, lookup, preview),
    reserveCancel: (sendId, leaseId, lookup, digest) => reserveCreatorMcfCancel(handle, sendId, leaseId, lookup, digest),
    recordCancelOutcome: (sendId, leaseId, outcome, lookup) => recordCreatorMcfCancelOutcome(handle, sendId, leaseId, outcome, lookup),
    recordCancelUnsent: (sendId, leaseId, reason) => recordCreatorMcfCancelUnsent(handle, sendId, leaseId, reason),
    releaseClaim: (sendId, leaseId, retrySeconds) => releaseCreatorMcfClaim(handle, sendId, leaseId, retrySeconds),
  };
}

/** Amazon for one send: reads by key, and the cancel (absent on a writer that cannot cancel). */
export interface McfCancelAmazon {
  reader: McfOrderReader;
  writer: Partial<Pick<FulfillmentOutboundWriter, 'cancel'>>;
}

// ---------------------------------------------------------------------------
// Counts (clause 6), asserted at the end of every tick.
// ---------------------------------------------------------------------------

export interface McfCancelCounts {
  /** Cancel claims taken. */
  claimed: number;
  /** Preview reads recorded as a cancel preview. */
  previewed: number;
  /** Preview reads recorded without a preview (not found, New, Processing or later, the send moved). */
  previewRefused: number;
  /** Executions the ledger refused and ended before any request (re-read not cancellable, approver, grant, send, deadline). */
  refused: number;
  /** Claims given back or left without an ending. */
  deferred: number;
  /** Executions granted the one cancel request. */
  reserved: number;
  /** cancelFulfillmentOrder requests actually sent. */
  amazonCancels: number;
  /** Reservations whose request was not sent. */
  withheld: number;
  /** Recorded answers, by class. */
  accepted: number;
  rejected: number;
  uncertain: number;
  /** Withheld requests recorded as unsent. */
  unsent: number;
  /** Answers (or unsent records) the ledger could not take this tick; retried from memory. */
  outcomePending: number;
  /** Pending answers recorded this tick (their claim was counted when it happened). */
  lateRecorded: number;
}

export function emptyMcfCancelCounts(): McfCancelCounts {
  return { claimed: 0, previewed: 0, previewRefused: 0, refused: 0, deferred: 0, reserved: 0, amazonCancels: 0, withheld: 0, accepted: 0,
    rejected: 0, uncertain: 0, unsent: 0, outcomePending: 0, lateRecorded: 0 };
}

const CANCEL_INVARIANTS: readonly (readonly [string, (counts: McfCancelCounts) => boolean])[] = [
  ['cancel.claimed = previewed + previewRefused + refused + deferred + reserved',
    (c) => c.claimed === c.previewed + c.previewRefused + c.refused + c.deferred + c.reserved],
  ['cancel.reserved = amazonCancels + withheld', (c) => c.reserved === c.amazonCancels + c.withheld],
  ['cancel.reserved = accepted + rejected + uncertain + unsent + outcomePending',
    (c) => c.reserved === c.accepted + c.rejected + c.uncertain + c.unsent + c.outcomePending],
  ['cancel.unsent <= withheld', (c) => c.unsent <= c.withheld],
];

/** Throws McfCountsError naming every broken cancel invariant. */
export function assertMcfCancelCounts(counts: McfCancelCounts): void {
  const broken: string[] = [];
  if (!Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)) broken.push('every cancel count is a non-negative integer');
  for (const [name, holds] of CANCEL_INVARIANTS) if (!holds(counts)) broken.push(name);
  if (broken.length > 0) throw new McfCountsError(broken);
}

// ---------------------------------------------------------------------------
// Pure pieces.
// ---------------------------------------------------------------------------

/**
 * The address-free cancel preview for one found read: its status, its items in
 * Amazon's order with positional line ids, the unit total and 5 minutes of
 * validity. Null when the read is not a cancellable order the shared schema can
 * describe (not found, not Received or Planning, a line of 0 or over 20 units).
 */
export function mcfCancelPreviewBody(input: { claim: CreatorMcfClaim; lookup: CreatorMcfOrderRead; previewId: string; workerRevision: string }):
  CreatorMcfCancelPreview | null {
  const { claim, lookup } = input;
  if (lookup.outcome !== 'found' || (lookup.status !== 'Received' && lookup.status !== 'Planning')) return null;
  const parsed = CreatorMcfCancelPreview.safeParse({
    previewId: input.previewId, sendId: claim.sendId, derivedOrderKey: claim.binding.derivedOrderKey, reservationId: claim.binding.reservationId,
    spapiConnectionId: claim.spapiConnectionId, marketplaceId: claim.marketplaceId, readAt: lookup.readAt,
    validUntil: new Date(Date.parse(lookup.readAt) + CREATOR_MCF_CANCEL_PREVIEW_VALID_MS).toISOString(), workerRevision: input.workerRevision,
    kind: 'cancel_preview', existingOrder: { status: lookup.status },
    items: lookup.items.map((item, index) => ({ sellerSku: item.sellerSku, sellerFulfillmentOrderItemId: `${claim.binding.derivedOrderKey}-${index + 1}`,
      quantity: item.quantity })),
    totalUnits: lookup.items.reduce((sum, item) => sum + item.quantity, 0),
  });
  return parsed.success ? parsed.data : null;
}

/** The reservation's digest: SHA-256 of the canonical, address-free cancel request (the operation, the key and the marketplace). */
export async function mcfCancelRequestDigest(input: { marketplaceId: string; derivedOrderKey: string }): Promise<string> {
  const text = creatorMcfCanonicalJson({ v: 1, operation: 'cancelFulfillmentOrder', sellerFulfillmentOrderId: input.derivedOrderKey,
    marketplaceId: input.marketplaceId });
  return creatorMcfSha256Hex(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// The runner.
// ---------------------------------------------------------------------------

export interface McfCancelRunnerOptions {
  store: McfCancelStore;
  amazon: (claim: CreatorMcfClaim) => McfCancelAmazon;
  /** Read again before every step: whether the dispatch flag and scope (or, for the reads after a request, the scope) still allow it. */
  allowed: (gate: 'dispatch' | 'read', claim: CreatorMcfClaim) => boolean;
  /** True once the unit is stopping: no new request starts. */
  stopping: () => boolean;
  pacer: McfPacer;
  sleep: (ms: number) => Promise<void>;
  clock: () => Date;
  monotonic: () => number;
  newId: () => string;
  workerRevision: string;
  log: McfLog;
  onAuthorizationFailure: () => void;
  startBudgetMs?: number;
}

/** What the ledger is told after a reservation: the request's answer, or that it never left. */
type CancelRecord =
  | { kind: 'answer'; outcome: CreatorMcfProviderOutcome; lookup: CreatorMcfOrderRead | null }
  | { kind: 'unsent'; reason: CreatorMcfCancelUnsentReason };

/** A cancel record not yet taken by the ledger: address-free, kept in memory and retried each tick. */
interface PendingCancelOutcome {
  readonly sendId: string;
  readonly leaseId: string;
  record: CancelRecord;
  readonly since: number;
}

type ExecuteEnding = 'refused' | 'deferred' | 'reserved';

/** Runs cancel claims; one per unit, owned by the loop. */
export class McfCancelRunner {
  private readonly pending: PendingCancelOutcome[] = [];

  constructor(private readonly options: McfCancelRunnerOptions) {}

  /** Answers still waiting to be recorded (address-free). */
  pendingOutcomes(): number {
    return this.pending.length;
  }

  /** One cancel claim. Never throws; the counts say how it ended. */
  async run(claim: CreatorMcfClaim, tick: McfTickCounts, counts: McfCancelCounts): Promise<void> {
    counts.claimed += 1;
    const cancel = claim.cancel ?? null;
    try {
      if (cancel === null) {
        await this.release(claim, 'cancel_claim_invalid', 600);
        counts.deferred += 1;
      } else if (cancel.mode === 'preview') {
        const ending = await this.preview(claim, tick);
        counts[ending] += 1;
      } else {
        const ending = await this.execute(claim, cancel, tick, counts);
        counts[ending] += 1;
      }
    } catch {
      // A throw here comes before any request, or after one whose answer is already pending in memory.
      this.options.log('error', { event: 'mcf_action_failed', sendId: claim.sendId, codes: ['cancel'] });
      await this.release(claim, 'cancel_failed', this.backoff(claim));
      counts.deferred += 1;
    }
  }

  private backoff(claim: CreatorMcfClaim): number {
    return mcfRetrySeconds(claim.attempts, 30, 600);
  }

  private async release(claim: CreatorMcfClaim, code: string, retrySeconds: number): Promise<void> {
    try {
      await this.options.store.releaseClaim(claim.sendId, claim.leaseId, retrySeconds);
    } catch {
      this.options.log('error', { event: 'mcf_release_failed', sendId: claim.sendId, codes: [code] });
    }
    this.options.log('info', { event: 'mcf_deferred', sendId: claim.sendId, state: claim.state, codes: [code] });
  }

  private readContext(tick: McfTickCounts, deadline?: number) {
    return { pacer: this.options.pacer, sleep: this.options.sleep, monotonic: this.options.monotonic, counts: tick,
      onAuthorizationFailure: this.options.onAuthorizationFailure, ...(deadline === undefined ? {} : { deadline }) };
  }

  /** "Cancel in Amazon": one read of the key, recorded, and a preview when it shows Received or Planning. */
  private async preview(claim: CreatorMcfClaim, tick: McfTickCounts): Promise<'previewed' | 'previewRefused' | 'deferred'> {
    if (!this.options.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const key = claim.binding.derivedOrderKey;
    const amazon = this.options.amazon(claim);
    const read = await readMcfOrder(amazon.reader, key, this.readContext(tick));
    if (read.outcome === 'failed') {
      this.options.log('info', { event: 'mcf_read_failed', sendId: claim.sendId, httpStatus: read.status, codes: [read.code] });
      await this.release(claim, read.code, this.backoff(claim));
      return 'deferred';
    }
    const lookup = mcfOrderRead(read.lookup, key, mcfReadAt(this.options.clock(), null));
    if (lookup === null) { await this.release(claim, 'read_unusable', this.backoff(claim)); return 'deferred'; }
    const preview = mcfCancelPreviewBody({ claim, lookup, previewId: this.options.newId(), workerRevision: this.options.workerRevision });
    const decision = await this.options.store.recordCancelPreview(claim.sendId, claim.leaseId, lookup, preview);
    this.options.log('info', { event: 'mcf_cancel_preview', sendId: claim.sendId, state: decision.state ?? null,
      codes: [decision.decision, ...(typeof decision['reason'] === 'string' ? [decision['reason']] : [])] });
    if (decision.decision === 'cancel_preview_ready' || decision.decision === 'unchanged') return 'previewed';
    if (decision.decision === 'cancel_preview_refused') return 'previewRefused';
    // A press arrived while this read ran: give the lease back so the execution reads again at once.
    if (decision['reason'] === 'cancel_open') await this.release(claim, 'cancel_open', 1);
    return 'deferred';
  }

  /** "Cancel 1 order in Amazon": re-read, reserve, one request, record. */
  private async execute(claim: CreatorMcfClaim, cancel: Extract<CreatorMcfCancelClaim, { mode: 'execute' }>, tick: McfTickCounts,
    counts: McfCancelCounts): Promise<ExecuteEnding> {
    const key = claim.binding.derivedOrderKey;
    const approved = cancel.preview;
    if (approved.sendId !== claim.sendId || approved.derivedOrderKey !== key || approved.marketplaceId !== claim.marketplaceId
      || approved.spapiConnectionId !== claim.spapiConnectionId) {
      await this.release(claim, 'approval_unsupported', 600);
      return 'deferred';
    }
    // 1. Policy.
    if (!this.options.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const amazon = this.options.amazon(claim);
    const writer = amazon.writer;
    if (writer.cancel === undefined) { await this.release(claim, 'cancel_unsupported', 600); return 'deferred'; }
    // 2. The re-read, taken after the press (the ledger refuses one from before it).
    const read = await readMcfOrder(amazon.reader, key, this.readContext(tick));
    if (read.outcome === 'failed') {
      this.options.log('info', { event: 'mcf_read_failed', sendId: claim.sendId, httpStatus: read.status, codes: [read.code] });
      await this.release(claim, read.code, this.backoff(claim));
      return 'deferred';
    }
    const lookup = mcfOrderRead(read.lookup, key, mcfReadAt(this.options.clock(), cancel.approvedAt));
    if (lookup === null) { await this.release(claim, 'read_unusable', this.backoff(claim)); return 'deferred'; }
    // 3. Policy, then 4. the reservation: the database's clause-9 recheck with this read, and the one permission to send.
    if (!this.options.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const digest = await mcfCancelRequestDigest({ marketplaceId: claim.marketplaceId, derivedOrderKey: key });
    const reserveStartedAt = this.options.monotonic();
    const reservation = await this.options.store.reserveCancel(claim.sendId, claim.leaseId, lookup, digest);
    if (reservation.decision === 'already_reserved') {
      this.options.log('error', { event: 'mcf_cancel_reserve_refused', sendId: claim.sendId, state: reservation.state, codes: ['already_reserved'] });
      return 'deferred';
    }
    if (reservation.decision === 'refused') {
      this.options.log('info', { event: 'mcf_cancel_reserve_refused', sendId: claim.sendId, state: reservation.state ?? null,
        codes: [reservation.reason, ...(reservation.ending === undefined ? [] : [reservation.ending])] });
      return reservation.reason === 'lease' || reservation.reason === 'no_cancel' || reservation.reason === 'send_not_found' ? 'deferred' : 'refused';
    }
    // 5 and 6. Reserved: this cancel gets at most this one request, now or never.
    await this.sendOnce(claim, writer as Pick<FulfillmentOutboundWriter, 'cancel'>, amazon.reader, reservation, reserveStartedAt, tick, counts);
    return 'reserved';
  }

  /**
   * After `cancel_once`: the last policy check, the single request, the
   * getOrder that must follow a 4xx, and the answer recorded. Never throws;
   * never sends twice.
   */
  private async sendOnce(claim: CreatorMcfClaim, writer: Pick<FulfillmentOutboundWriter, 'cancel'>, reader: McfOrderReader,
    reservation: Extract<CreatorMcfCancelReservation, { decision: 'cancel_once' }>, reserveStartedAt: number, tick: McfTickCounts,
    counts: McfCancelCounts): Promise<void> {
    const key = claim.binding.derivedOrderKey;
    let outcome: CreatorMcfProviderOutcome | null = null;
    let withheld: CreatorMcfCancelUnsentReason | null = null;
    try {
      if (reservation.derivedOrderKey !== key || reservation.marketplaceId !== claim.marketplaceId || reservation.sendId !== claim.sendId) {
        withheld = 'reservation_mismatch';
      } else if (this.options.stopping() || !this.options.allowed('dispatch', claim)) {
        withheld = this.options.stopping() ? 'stopping' : 'policy_off';
      } else if (this.options.monotonic() - reserveStartedAt > (this.options.startBudgetMs ?? MCF_CANCEL_START_BUDGET_MS)) {
        withheld = 'lease_budget';
      } else {
        await this.options.pacer.before();
        tick.amazonCalls += 1;
        try {
          outcome = await writer.cancel(key);
          counts.amazonCancels += 1;
        } catch (error) {
          if (error instanceof FulfillmentOutboundError && (error.reason === 'authentication' || error.reason === 'invalid_request')) {
            // The writer raises these two only before the request leaves (no token; input or options it could not build): nothing was sent.
            withheld = error.reason === 'authentication' ? 'token_unavailable' : 'request_invalid';
            if (withheld === 'token_unavailable') this.options.onAuthorizationFailure();
          } else {
            // Anything else may have come after the request left: an answer of unknown meaning, never "unsent"; reads settle it.
            outcome = { outcome: 'uncertain', cause: 'decode', status: null };
            counts.amazonCancels += 1;
          }
        }
      }
    } catch {
      withheld ??= 'cancel_failed';
    }
    if (outcome === null) {
      // The request never left: the writer throws only before sending, and every other branch skipped it.
      counts.withheld += 1;
      this.options.log('error', { event: 'mcf_cancel_withheld', sendId: claim.sendId, state: 'cancel_dispatching', codes: [withheld ?? 'cancel_failed'] });
      await this.recordFirst(claim, { kind: 'unsent', reason: withheld ?? 'cancel_failed' }, counts);
      return;
    }
    let lookup: CreatorMcfOrderRead | null = null;
    if (outcome.outcome === 'rejected') {
      const rejected = outcome;
      let code = 'read_unusable';
      try {
        if (rejected.reason === 'authorization') this.options.onAuthorizationFailure();
        // Every 4xx is followed by getOrder: the order's status says what the refusal meant.
        const read = this.options.allowed('read', claim)
          ? await readMcfOrder(reader, key, this.readContext(tick, reserveStartedAt + MCF_CANCEL_READ_DEADLINE_MS))
          : { outcome: 'failed' as const, code: 'scope' as const, status: null };
        if (read.outcome === 'read') lookup = mcfOrderRead(read.lookup, key, mcfReadAt(this.options.clock(), reservation.reservedAt));
        else code = read.code;
      } catch {
        lookup = null;
        code = 'read_failed';
      }
      if (lookup === null && rejected.reason !== 'authorization') {
        this.options.log('info', { event: 'mcf_read_failed', sendId: claim.sendId, httpStatus: rejected.status, codes: ['cancel_rejection_unconfirmed', code] });
        outcome = { outcome: 'uncertain', cause: 'decode', status: rejected.status };
      }
    }
    await this.recordFirst(claim, { kind: 'answer', outcome, lookup }, counts);
  }

  private count(counts: McfCancelCounts, record: CancelRecord): void {
    if (record.kind === 'unsent') counts.unsent += 1;
    else if (record.outcome.outcome === 'accepted') counts.accepted += 1;
    else if (record.outcome.outcome === 'rejected') counts.rejected += 1;
    else counts.uncertain += 1;
  }

  private store(sendId: string, leaseId: string, record: CancelRecord): Promise<CreatorMcfWorkerDecision> {
    return record.kind === 'unsent' ? this.options.store.recordCancelUnsent(sendId, leaseId, record.reason)
      : this.options.store.recordCancelOutcome(sendId, leaseId, record.outcome, record.lookup);
  }

  private codes(record: CancelRecord): string[] {
    if (record.kind === 'unsent') return ['unsent', record.reason];
    const { outcome, lookup } = record;
    return [outcome.outcome, ...(outcome.outcome === 'rejected' ? [outcome.reason, ...outcome.codes] : outcome.outcome === 'uncertain' ? [outcome.cause] : []),
      ...(lookup === null ? [] : [lookup.outcome])];
  }

  /** Records the request's answer (or that it never left), retrying a few times; keeps it in memory if the ledger is unreachable. */
  private async recordFirst(claim: CreatorMcfClaim, record: CancelRecord, counts: McfCancelCounts): Promise<void> {
    const httpStatus = record.kind === 'answer' ? record.outcome.status : null;
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.options.sleep(1000 * 2 ** (attempt - 1));
      try {
        const decision = await this.store(claim.sendId, claim.leaseId, record);
        this.options.log('info', { event: 'mcf_cancel_outcome', sendId: claim.sendId, state: decision.state ?? null, httpStatus, codes: this.codes(record) });
        this.count(counts, record);
        return;
      } catch {
        // Retried below, then kept in memory.
      }
    }
    this.pending.push({ sendId: claim.sendId, leaseId: claim.leaseId, record, since: this.options.monotonic() });
    counts.outcomePending += 1;
    this.options.log('error', { event: 'mcf_cancel_outcome_pending', sendId: claim.sendId, state: 'cancel_dispatching', httpStatus,
      codes: this.codes(record).slice(0, 2) });
  }

  /** Answers the ledger could not take are retried each tick; reads settle the send meanwhile, and a late answer is kept as evidence. */
  async retryPending(counts: McfCancelCounts): Promise<void> {
    for (const entry of [...this.pending]) {
      const age = this.options.monotonic() - entry.since;
      if (age > PENDING_MAX_AGE_MS) {
        this.pending.splice(this.pending.indexOf(entry), 1);
        this.options.log('error', { event: 'mcf_cancel_outcome_abandoned', sendId: entry.sendId, codes: this.codes(entry.record).slice(0, 2) });
        continue;
      }
      const record = entry.record;
      if (age > PENDING_LOOKUP_MAX_AGE_MS && record.kind === 'answer' && record.lookup !== null) {
        const outcome = record.outcome;
        entry.record = { kind: 'answer', lookup: null,
          outcome: outcome.outcome === 'rejected' && outcome.reason !== 'authorization' ? { outcome: 'uncertain', cause: 'decode', status: outcome.status } : outcome };
      }
      try {
        const decision = await this.store(entry.sendId, entry.leaseId, entry.record);
        this.pending.splice(this.pending.indexOf(entry), 1);
        counts.lateRecorded += 1;
        this.options.log('info', { event: 'mcf_cancel_late_outcome', sendId: entry.sendId, state: decision.state ?? null,
          httpStatus: entry.record.kind === 'answer' ? entry.record.outcome.status : null, codes: [decision.decision, ...this.codes(entry.record).slice(0, 2)] });
      } catch {
        // Still unreachable: kept for the next tick.
      }
    }
  }
}
