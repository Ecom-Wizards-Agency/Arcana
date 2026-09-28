/**
 * The MCF unit's loop (WP-338e; DESIGN sections 3, 4.4, 8, 12, 14 and 16).
 *
 * Creating an Amazon order is an Amazon write under the ten clauses of
 * AGENTS.md. This loop is the only caller of getFulfillmentPreview and
 * createFulfillmentOrder, and it runs only in `wizard-ads-mcf.service`
 * (`src/mcf-main.ts`); the general worker never imports it.
 *
 * Each tick: a heartbeat with the scope and flags, the expiry sweep, the mask
 * purge once per UTC day, a retry of outcomes not yet recorded, then up to
 * `maxClaimsPerTick` claims of the work the policy allows. Counts are asserted
 * at the end of every tick.
 *
 * Preview (DESIGN 8): policy; open custody in memory, validate, recompute the
 * mask, check the country; getOrder must be not found; getFulfillmentPreview
 * with exactly the create's items and settings; record the address-free
 * preview (the ledger decides preview_ready or preview_refused).
 *
 * Dispatch (DESIGN 8, in this order): policy; open custody; re-read the
 * preview with the same inputs and record it (any difference is stale, no
 * POST); getOrder (found ends custody, no POST); policy; reserve the intent
 * (`dispatch_once`, after which this send is never POSTed again); policy, then
 * one createFulfillmentOrder with a 60-second timeout; record the outcome,
 * which destroys custody in the same transaction. Every 4xx is followed by
 * getOrder before the send is treated as not placed.
 *
 * Cancel (WP-338i, ./cancel.ts): under the dispatch flag, the guarded
 * cancelFulfillmentOrder of an order Arcana placed, when the loop is given a
 * cancel store. Without one it never claims cancel work.
 *
 * Nothing here logs, throws or persists a recipient value: log lines carry
 * `{event, sendId, state, counts, httpStatus, codes}` only, errors carry fixed
 * codes, and the opened recipient lives in local variables for one action.
 */
import { randomUUID } from 'node:crypto';
import { getSpApiRefreshToken, type DbHandle } from '@wizard-ads/db';
import {
  claimCreatorMcfOutbox, expireCreatorMcfCustody, markCreatorMcfLadderExhausted, purgeCreatorMcfMasks, readCreatorMcfCustody, recordCreatorMcfHeartbeat,
  recordCreatorMcfOutcome, recordCreatorMcfPreview, recordCreatorMcfSettlement, refuseCreatorMcfPreview, releaseCreatorMcfClaim,
  reserveCreatorMcfDispatch, type CreatorMcfClaim, type CreatorMcfHeartbeat, type CreatorMcfOrderRead, type CreatorMcfOutboxAction,
  type CreatorMcfPreviewRefusal, type CreatorMcfReservation, type CreatorMcfWorkerDecision,
} from '@wizard-ads/db/worker';
import {
  CREATOR_MCF_IRREVERSIBILITY, CREATOR_MCF_PACKING_SLIP_COMMENT, CREATOR_MCF_PREVIEW_VALID_MS, CreatorMcfPreview, SP_MARKETPLACE_MONEY_RULES,
  creatorMcfCanonicalJson, creatorMcfPreviewsDiffer, creatorMcfSha256Hex, type CreatorMcfProviderOutcome, type CreatorMcfRecipient,
  type CreatorMcfSendState,
} from '@wizard-ads/shared';
import {
  CREATOR_MCF_ORDER_SETTINGS, FULFILLMENT_OUTBOUND_WRITE_TIMEOUT_MS, FulfillmentOutboundError, FulfillmentOutboundReader, FulfillmentOutboundWriter,
  LwaRefreshTokenProvider, type CreatorMcfPreviewEvidence, type FetchLike, type SpApiAccessTokenProvider,
} from '@wizard-ads/sp-api';
import { spApiEndpointForRegion } from '../spapi-sqp.js';
import { McfCancelRunner, assertMcfCancelCounts, emptyMcfCancelCounts, type McfCancelCounts, type McfCancelStore } from './cancel.js';
import { assertMcfTickCounts, countDispatchClaim, countPreviewClaim, emptyMcfTickCounts, type McfDispatchEnding, type McfPreviewEnding,
  type McfTickCounts } from './counts.js';
import { openMcfCustody, type McfRecipientKeySource } from './custody.js';
import { MCF_SEND_POLICY_OFF, mcfClaimableActions, mcfStepAllowed, type McfSendPolicy } from './policy.js';
import { MCF_AMAZON_SPACING_MS, createMcfPacer, mcfOrderRead, mcfReadAt, mcfRetrySeconds, readMcfOrder, settleMcfClaim,
  type McfOrderReader, type McfPacer } from './settle.js';

// ---------------------------------------------------------------------------
// Limits.
// ---------------------------------------------------------------------------

/** The ledger leases a claim for 120 seconds and keeps a reservation's lease at least 90 seconds. */
export const MCF_POST_TIMEOUT_MS = FULFILLMENT_OUTBOUND_WRITE_TIMEOUT_MS;
/**
 * A POST may start at most this long after the reservation call began, so its
 * 60-second timeout (plus a bounded token wait) ends before the 90-second
 * reservation lease: a slow POST cannot outlive its lease.
 */
export const MCF_POST_START_BUDGET_MS = 15_000;
/** Access tokens: the LWA exchange, and the refresh-credential read behind it, are bounded. */
export const MCF_TOKEN_TIMEOUT_MS = 10_000;
/** getFulfillmentOrder has no timeout of its own; the unit bounds it. */
export const MCF_READ_TIMEOUT_MS = 15_000;
/** Reads after a POST stop starting once this long has passed since the reservation began. */
export const MCF_POST_READ_DEADLINE_MS = 80_000;
/** Pending outcomes older than this drop their read: the ledger accepts reads at most an hour old. */
const PENDING_LOOKUP_MAX_AGE_MS = 45 * 60 * 1000;
/** Pending outcomes are retried from memory for at most this long; the ladder settles the rest. */
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECORD_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Logging: fixed events and fields, so no free text can reach a line.
// ---------------------------------------------------------------------------

export type McfLogEvent =
  | 'mcf_start' | 'mcf_stop' | 'mcf_tick' | 'mcf_fault' | 'mcf_policy_invalid' | 'mcf_heartbeat_failed' | 'mcf_sweep' | 'mcf_sweep_failed'
  | 'mcf_mask_purge' | 'mcf_mask_purge_failed' | 'mcf_preview' | 'mcf_dispatch' | 'mcf_deferred' | 'mcf_refused' | 'mcf_stale'
  | 'mcf_found_before_post' | 'mcf_reserve_refused' | 'mcf_post_withheld' | 'mcf_outcome' | 'mcf_outcome_pending' | 'mcf_late_outcome'
  | 'mcf_outcome_abandoned' | 'mcf_read_failed' | 'mcf_release_failed' | 'mcf_settle' | 'mcf_settle_deferred' | 'mcf_ladder_exhausted'
  | 'mcf_ladder_mark_failed' | 'mcf_action_failed' | 'mcf_cancel' | 'mcf_cancel_preview' | 'mcf_cancel_reserve_refused' | 'mcf_cancel_withheld'
  | 'mcf_cancel_outcome' | 'mcf_cancel_outcome_pending' | 'mcf_cancel_late_outcome' | 'mcf_cancel_outcome_abandoned';

export interface McfLogEntry {
  readonly event: McfLogEvent;
  readonly sendId?: string;
  readonly state?: CreatorMcfSendState | string | null;
  readonly counts?: Readonly<Record<string, number>>;
  readonly httpStatus?: number | null;
  readonly codes?: readonly string[];
}

export type McfLog = (level: 'info' | 'error', entry: McfLogEntry) => void;

const CODE = /^[A-Za-z0-9_.]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATE = /^[a-z_]{1,32}$/;

/**
 * Keeps only the allowed fields, in allowed shapes: an id-shaped send id, a
 * state word, integer counts, an HTTP status and provider-code-shaped codes.
 */
export function mcfLogLine(level: 'info' | 'error', entry: McfLogEntry, at: Date): string {
  const line: Record<string, unknown> = { at: at.toISOString(), level, event: entry.event };
  if (entry.sendId !== undefined && UUID.test(entry.sendId)) line['sendId'] = entry.sendId;
  if (typeof entry.state === 'string' && STATE.test(entry.state)) line['state'] = entry.state;
  if (entry.counts !== undefined) {
    line['counts'] = Object.fromEntries(Object.entries(entry.counts).filter(([key, value]) => /^[A-Za-z.]{1,64}$/.test(key) && Number.isSafeInteger(value)));
  }
  if (entry.httpStatus !== undefined && entry.httpStatus !== null && Number.isInteger(entry.httpStatus)) line['httpStatus'] = entry.httpStatus;
  if (entry.codes !== undefined) line['codes'] = entry.codes.filter((code) => CODE.test(code)).slice(0, 20);
  return JSON.stringify(line);
}

export function consoleMcfLog(clock: () => Date = () => new Date()): McfLog {
  return (level, entry) => {
    const line = mcfLogLine(level, entry, clock());
    if (level === 'error') console.error(line);
    else console.info(line);
  };
}

/** A fixed-code error of the loop; the message is the code. */
export class McfSendError extends Error {
  constructor(readonly code: string) {
    super(CODE.test(code) ? code : 'mcf_error');
    this.name = 'McfSendError';
  }
}

// ---------------------------------------------------------------------------
// Seams: the ledger and Amazon.
// ---------------------------------------------------------------------------

/** The ledger's service-role functions (WP-338d), one method each. */
export interface McfSendStore {
  claim(input: { claimant: string; scope: readonly string[]; actions: readonly CreatorMcfOutboxAction[] }): Promise<CreatorMcfClaim | null>;
  readCustody(sendId: string, leaseId: string): ReturnType<typeof readCreatorMcfCustody>;
  recordPreview(sendId: string, leaseId: string, preview: CreatorMcfPreview): Promise<CreatorMcfWorkerDecision>;
  refusePreview(sendId: string, leaseId: string, reason: CreatorMcfPreviewRefusal, codes: readonly string[]): Promise<CreatorMcfWorkerDecision>;
  releaseClaim(sendId: string, leaseId: string, retrySeconds: number): Promise<CreatorMcfWorkerDecision>;
  reserve(sendId: string, leaseId: string, requestDigest: string): Promise<CreatorMcfReservation>;
  recordOutcome(sendId: string, leaseId: string, outcome: CreatorMcfProviderOutcome, lookup: CreatorMcfOrderRead | null): Promise<CreatorMcfWorkerDecision>;
  recordSettlement(sendId: string, lookup: CreatorMcfOrderRead, leaseId: string | null): Promise<CreatorMcfWorkerDecision>;
  markLadderExhausted(sendId: string): Promise<CreatorMcfWorkerDecision>;
  expire(): Promise<{ expiredTtl: number; expiredUnclaimed: number; uncertainCrash: number }>;
  heartbeat(beat: CreatorMcfHeartbeat): Promise<void>;
  purgeMasks(): Promise<{ scheduled: number; backstop: number; purged: number }>;
}

/** The production ledger over the unit's database handle. */
export function postgresMcfSendStore(handle: Pick<DbHandle, 'sql'>): McfSendStore {
  return {
    claim: (input) => claimCreatorMcfOutbox(handle, input),
    readCustody: (sendId, leaseId) => readCreatorMcfCustody(handle, sendId, leaseId),
    recordPreview: (sendId, leaseId, preview) => recordCreatorMcfPreview(handle, sendId, leaseId, preview),
    refusePreview: (sendId, leaseId, reason, codes) => refuseCreatorMcfPreview(handle, sendId, leaseId, reason, codes),
    releaseClaim: (sendId, leaseId, retrySeconds) => releaseCreatorMcfClaim(handle, sendId, leaseId, retrySeconds),
    reserve: (sendId, leaseId, digest) => reserveCreatorMcfDispatch(handle, sendId, leaseId, digest),
    recordOutcome: (sendId, leaseId, outcome, lookup) => recordCreatorMcfOutcome(handle, sendId, leaseId, outcome, lookup),
    recordSettlement: (sendId, lookup, leaseId) => recordCreatorMcfSettlement(handle, sendId, lookup, leaseId),
    markLadderExhausted: (sendId) => markCreatorMcfLadderExhausted(handle, sendId),
    expire: () => expireCreatorMcfCustody(handle),
    heartbeat: (beat) => recordCreatorMcfHeartbeat(handle, beat),
    purgeMasks: () => purgeCreatorMcfMasks(handle),
  };
}

/** Amazon for one send's connection and marketplace: reads by key, the preview, the create and (WP-338i) the cancel. */
export interface McfAmazon {
  reader: McfOrderReader;
  writer: Pick<FulfillmentOutboundWriter, 'preview' | 'create'> & Partial<Pick<FulfillmentOutboundWriter, 'cancel'>>;
}
export type McfAmazonFactory = (target: { orgId: string; spapiConnectionId: string; marketplaceId: string }) => McfAmazon;

/** Rejects when the inner provider takes longer than `timeoutMs`; the writer then reports that nothing was sent. */
export function boundedAccessTokenProvider(inner: SpApiAccessTokenProvider, timeoutMs: number): SpApiAccessTokenProvider {
  return {
    getAccessToken() {
      let timer: NodeJS.Timeout | undefined;
      const expired = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McfSendError('token_timeout')), timeoutMs);
      });
      const pending = inner.getAccessToken();
      pending.catch(() => {});
      return Promise.race([pending, expired]).finally(() => clearTimeout(timer));
    },
    ...(inner.invalidate === undefined ? {} : { invalidate: () => inner.invalidate?.() }),
  };
}

/** Adds a timeout to every request that does not already carry a signal. */
export function timeoutFetch(fetchImpl: FetchLike, timeoutMs: number): FetchLike {
  return (input, init) => fetchImpl(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
}

/**
 * Production Amazon: the regional SP-API endpoint of the send's marketplace, the
 * connection's refresh credential read from Vault through the database, one
 * cached and bounded access-token provider per connection shared by reads and
 * writes, reads bounded by MCF_READ_TIMEOUT_MS and writes by the writer's
 * 60-second limit.
 */
export function spApiMcfAmazonFactory(input: {
  handle: Pick<DbHandle, 'sql'>;
  lwaClientId: string;
  lwaClientSecret: string;
  userAgent?: string;
  fetch?: FetchLike;
}): McfAmazonFactory {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const tokens = new Map<string, SpApiAccessTokenProvider>();
  const { lwaClientId, lwaClientSecret: lwaKey } = input;
  return (target) => {
    const rule = SP_MARKETPLACE_MONEY_RULES[target.marketplaceId];
    if (rule === undefined) throw new McfSendError('marketplace_unknown');
    const cacheKey = `${target.orgId}:${target.spapiConnectionId}`;
    let token = tokens.get(cacheKey);
    if (token === undefined) {
      token = boundedAccessTokenProvider(new LwaRefreshTokenProvider({
        clientId: lwaClientId, clientSecret: lwaKey,
        refreshTokenProvider: () => getSpApiRefreshToken(input.handle, { orgId: target.orgId, connectionId: target.spapiConnectionId }),
        fetch: timeoutFetch(fetchImpl, MCF_TOKEN_TIMEOUT_MS),
      }), MCF_TOKEN_TIMEOUT_MS);
      tokens.set(cacheKey, token);
    }
    const common = { endpoint: spApiEndpointForRegion(rule.region), accessTokenProvider: token,
      userAgent: input.userAgent ?? 'WizardAds/1.0 (Language=TypeScript)' };
    return {
      reader: new FulfillmentOutboundReader({ ...common, fetch: timeoutFetch(fetchImpl, MCF_READ_TIMEOUT_MS) }),
      writer: new FulfillmentOutboundWriter({ ...common, fetch: fetchImpl, timeoutMs: MCF_POST_TIMEOUT_MS }),
    };
  };
}

// ---------------------------------------------------------------------------
// Pure pieces: the one date conversion, the preview body and the request digest.
// ---------------------------------------------------------------------------

/**
 * The one conversion of Amazon's arrival timestamps to the preview's calendar
 * days, used for the preview and for the dispatch re-read alike: the UTC date.
 */
export function mcfArrivalDate(timestamp: string | null): string | null {
  if (timestamp === null) return null;
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new McfSendError('preview_invalid');
  return new Date(ms).toISOString().slice(0, 10);
}

/** The address-free preview row for one Amazon preview answer. Parsed through the strict shared schema; null if it does not parse. */
export function mcfPreviewBody(input: {
  kind: 'preview' | 'dispatch_reread';
  claim: CreatorMcfClaim;
  evidence: CreatorMcfPreviewEvidence;
  previewId: string;
  readAt: Date;
  workerRevision: string;
}): { ok: true; preview: CreatorMcfPreview } | { ok: false; code: 'fee_missing' | 'preview_invalid' } {
  const { claim, evidence } = input;
  if (evidence.isFulfillable && evidence.fees === null) return { ok: false, code: 'fee_missing' };
  let earliestArrivalDate: string | null;
  let latestArrivalDate: string | null;
  try {
    earliestArrivalDate = mcfArrivalDate(evidence.earliestArrivalAt);
    latestArrivalDate = mcfArrivalDate(evidence.latestArrivalAt);
  } catch {
    return { ok: false, code: 'preview_invalid' };
  }
  const readAt = input.readAt.toISOString();
  const parsed = CreatorMcfPreview.safeParse({
    previewId: input.previewId, sendId: claim.sendId, derivedOrderKey: claim.binding.derivedOrderKey, reservationId: claim.binding.reservationId,
    spapiConnectionId: claim.spapiConnectionId, marketplaceId: claim.marketplaceId, readAt,
    validUntil: new Date(input.readAt.getTime() + CREATOR_MCF_PREVIEW_VALID_MS).toISOString(), workerRevision: input.workerRevision,
    kind: input.kind, preflightRunId: claim.preflight.runId, preflightCompletedAt: claim.preflight.completedAt, asin: claim.binding.asin,
    items: evidence.items.map((item) => ({ sellerSku: item.sellerSku, sellerFulfillmentOrderItemId: item.sellerFulfillmentOrderItemId, quantity: item.quantity })),
    totalUnits: evidence.items.reduce((sum, item) => sum + item.quantity, 0),
    shippingSpeedCategory: evidence.shippingSpeedCategory, fulfillmentAction: evidence.fulfillmentAction, fulfillmentPolicy: evidence.fulfillmentPolicy,
    featureConstraints: [], existingOrder: 'none', isFulfillable: evidence.isFulfillable, fees: evidence.fees,
    unfulfillableReasons: [...evidence.unfulfillableReasons], earliestArrivalDate, latestArrivalDate,
    laneFeeCapMinor: claim.caps.laneFeeCapMinor, grantFeeCapMinor: claim.caps.grantFeeCapMinor, grantCurrency: claim.caps.grantCurrency,
    envelopeSha256: claim.envelopeSha256, keyId: claim.keyId, irreversibility: CREATOR_MCF_IRREVERSIBILITY,
  });
  return parsed.success ? { ok: true, preview: parsed.data } : { ok: false, code: 'preview_invalid' };
}

/**
 * The reservation's request digest: SHA-256 of the canonical JSON of the
 * create request without its destination, plus the envelope's ciphertext
 * digest. Never a digest of the address.
 */
export async function mcfRequestDigest(input: { marketplaceId: string; derivedOrderKey: string; sellerSku: string; approvedAt: string;
  envelopeSha256: string }): Promise<string> {
  const text = creatorMcfCanonicalJson({
    v: 1, marketplaceId: input.marketplaceId, sellerFulfillmentOrderId: input.derivedOrderKey, displayableOrderId: input.derivedOrderKey,
    displayableOrderDate: new Date(input.approvedAt).toISOString(), displayableOrderComment: CREATOR_MCF_PACKING_SLIP_COMMENT,
    shippingSpeedCategory: CREATOR_MCF_ORDER_SETTINGS.shippingSpeedCategory, fulfillmentAction: CREATOR_MCF_ORDER_SETTINGS.fulfillmentAction,
    fulfillmentPolicy: CREATOR_MCF_ORDER_SETTINGS.fulfillmentPolicy,
    items: [{ sellerSku: input.sellerSku, sellerFulfillmentOrderItemId: `${input.derivedOrderKey}-1`, quantity: 1 }],
    envelopeSha256: input.envelopeSha256,
  });
  return creatorMcfSha256Hex(new TextEncoder().encode(text));
}

// ---------------------------------------------------------------------------
// The loop.
// ---------------------------------------------------------------------------

export interface McfSendLoopOptions {
  store: McfSendStore;
  /** The ledger's cancel functions (WP-338i). Without them the loop claims no cancel work. */
  cancelStore?: McfCancelStore;
  amazon: McfAmazonFactory;
  keys: McfRecipientKeySource;
  /** Read again before every step: a flag turned off stops the next Amazon call. A throw means everything off. */
  policy: () => McfSendPolicy;
  /** Heartbeat worker id and claimant prefix: `^[A-Za-z0-9._:-]{1,70}$`. */
  workerId: string;
  /** `^[A-Za-z0-9._-]{1,64}$`. */
  workerRevision: string;
  log?: McfLog;
  clock?: () => Date;
  monotonic?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  maxClaimsPerTick?: number;
  heartbeatIntervalMs?: number;
  spacingMs?: number;
  postStartBudgetMs?: number;
}

/** A POST outcome not yet recorded: address-free, kept in memory and retried each tick. */
interface PendingOutcome {
  readonly sendId: string;
  readonly leaseId: string;
  outcome: CreatorMcfProviderOutcome;
  lookup: CreatorMcfOrderRead | null;
  readonly since: number;
}

const FOUND_STATES: ReadonlySet<string> = new Set(['accepted', 'placed', 'conflict', 'failed_by_amazon']);

export class McfSendLoop {
  private stopping = false;
  private lastHeartbeatAt: number | null = null;
  private lastPurgeDay: string | null = null;
  private lastAuthorizationFailureAt: string | null = null;
  private readonly pending: PendingOutcome[] = [];
  private readonly pacer: McfPacer;
  private readonly log: McfLog;
  private readonly clock: () => Date;
  private readonly monotonic: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly claimant: string;
  private readonly cancel: McfCancelRunner | null;

  constructor(private readonly options: McfSendLoopOptions) {
    if (!/^[A-Za-z0-9._:-]{1,70}$/.test(options.workerId) || !/^[A-Za-z0-9._-]{1,64}$/.test(options.workerRevision)) {
      throw new McfSendError('worker_identity_invalid');
    }
    this.log = options.log ?? consoleMcfLog();
    this.clock = options.clock ?? (() => new Date());
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newId = options.newId ?? randomUUID;
    this.pacer = createMcfPacer({ spacingMs: options.spacingMs ?? MCF_AMAZON_SPACING_MS, monotonic: this.monotonic, sleep: this.sleep });
    this.claimant = `${options.workerId}:mcf`;
    this.cancel = options.cancelStore === undefined ? null : new McfCancelRunner({
      store: options.cancelStore, amazon: (claim) => this.amazonFor(claim),
      allowed: (gate, claim) => this.allowed(gate, claim), stopping: () => this.stopping, pacer: this.pacer, sleep: this.sleep, clock: this.clock,
      monotonic: this.monotonic, newId: this.newId, workerRevision: options.workerRevision, log: this.log,
      onAuthorizationFailure: () => this.authorizationFailed(),
    });
  }

  /** No new Amazon call starts after this; a POST already sent finishes and is recorded. */
  stop(): void {
    this.stopping = true;
  }

  /** Outcomes (create and cancel answers) still waiting to be recorded (address-free). */
  pendingOutcomes(): number {
    return this.pending.length + (this.cancel?.pendingOutcomes() ?? 0);
  }

  /** One more attempt at recording pending outcomes, for a stop: what stays pending is left to the ladder. */
  async drain(): Promise<number> {
    await this.retryPending(emptyMcfTickCounts());
    await this.cancel?.retryPending(emptyMcfCancelCounts());
    return this.pendingOutcomes();
  }

  private readPolicy(): McfSendPolicy {
    try {
      return this.options.policy();
    } catch {
      this.log('error', { event: 'mcf_policy_invalid' });
      return MCF_SEND_POLICY_OFF;
    }
  }

  private allowed(gate: 'preview' | 'dispatch' | 'read', claim: Pick<CreatorMcfClaim, 'spapiConnectionId' | 'marketplaceId'>): boolean {
    if (this.stopping && gate !== 'read') return false;
    return mcfStepAllowed(this.readPolicy(), gate, claim.spapiConnectionId, claim.marketplaceId);
  }

  private authorizationFailed(): void {
    this.lastAuthorizationFailureAt = this.clock().toISOString();
  }

  /** One pass. Returns the tick's reconciled counts; throws McfCountsError if they do not reconcile. */
  async tick(): Promise<McfTickCounts> {
    const counts = emptyMcfTickCounts();
    const cancelCounts = emptyMcfCancelCounts();
    const policy = this.readPolicy();
    await this.housekeeping(policy);
    await this.retryPending(counts);
    await this.cancel?.retryPending(cancelCounts);
    const max = this.options.maxClaimsPerTick ?? 10;
    for (let index = 0; index < max && !this.stopping; index += 1) {
      const current = this.readPolicy();
      const actions = mcfClaimableActions(current).filter((action) => action !== 'cancel' || this.cancel !== null);
      if (actions.length === 0) break;
      const claim = await this.options.store.claim({ claimant: this.claimant, scope: current.scope, actions });
      if (claim === null) break;
      if (claim.action === 'settle') await this.settle(claim, counts);
      else if (claim.action === 'preview') await this.preview(claim, counts);
      else if (claim.action === 'dispatch') await this.dispatch(claim, counts);
      else if (this.cancel !== null) await this.cancel.run(claim, counts, cancelCounts);
      else await this.release(claim, 'cancel_unsupported', 600);
    }
    assertMcfTickCounts(counts);
    assertMcfCancelCounts(cancelCounts);
    if (cancelCounts.claimed + cancelCounts.lateRecorded > 0) this.logCancel(cancelCounts);
    if (counts.send.claimed + counts.settle.claimed + counts.lateRecorded > 0) {
      this.log('info', { event: 'mcf_tick', counts: { ...counts.send, amazonCreates: counts.amazonCreates, postWithheld: counts.postWithheld,
        outcomePending: counts.outcomePending, lateRecorded: counts.lateRecorded, amazonCalls: counts.amazonCalls,
        'settle.claimed': counts.settle.claimed, 'settle.recorded': counts.settle.recorded, 'settle.deferred': counts.settle.deferred,
        'settle.found': counts.settle.found, 'settle.notFound': counts.settle.notFound, 'settle.ladderExhausted': counts.settle.ladderExhausted } });
    }
    return counts;
  }

  private logCancel(counts: McfCancelCounts): void {
    this.log('info', { event: 'mcf_cancel', counts: { ...counts } });
  }

  // -------------------------------------------------------------------------
  // Heartbeat, sweep and the daily mask purge. Failures are logged by code only.
  // -------------------------------------------------------------------------

  private async housekeeping(policy: McfSendPolicy): Promise<void> {
    const now = this.monotonic();
    if (this.lastHeartbeatAt === null || now - this.lastHeartbeatAt >= (this.options.heartbeatIntervalMs ?? 30_000)) {
      try {
        await this.options.store.heartbeat({ workerId: this.options.workerId, scope: policy.scope, previewEnabled: policy.previewEnabled && !this.stopping,
          dispatchEnabled: policy.dispatchEnabled && !this.stopping, workerRevision: this.options.workerRevision,
          lastAuthorizationFailureAt: this.lastAuthorizationFailureAt });
        this.lastHeartbeatAt = now;
      } catch {
        this.log('error', { event: 'mcf_heartbeat_failed' });
      }
    }
    try {
      const swept = await this.options.store.expire();
      if (swept.expiredTtl + swept.expiredUnclaimed + swept.uncertainCrash > 0) this.log('info', { event: 'mcf_sweep', counts: swept });
    } catch {
      this.log('error', { event: 'mcf_sweep_failed' });
    }
    const day = this.clock().toISOString().slice(0, 10);
    if (this.lastPurgeDay !== day) {
      try {
        const purged = await this.options.store.purgeMasks();
        this.lastPurgeDay = day;
        this.log('info', { event: 'mcf_mask_purge', counts: purged });
      } catch {
        this.log('error', { event: 'mcf_mask_purge_failed' });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Shared steps.
  // -------------------------------------------------------------------------

  private async release(claim: CreatorMcfClaim, code: string, retrySeconds: number): Promise<void> {
    try {
      await this.options.store.releaseClaim(claim.sendId, claim.leaseId, retrySeconds);
    } catch {
      this.log('error', { event: 'mcf_release_failed', sendId: claim.sendId, codes: [code] });
    }
    this.log('info', { event: 'mcf_deferred', sendId: claim.sendId, state: claim.state, codes: [code] });
  }

  private backoff(claim: CreatorMcfClaim): number {
    return mcfRetrySeconds(claim.attempts, 30, 600);
  }

  private amazonFor(claim: CreatorMcfClaim): McfAmazon {
    return this.options.amazon({ orgId: claim.orgId, spapiConnectionId: claim.spapiConnectionId, marketplaceId: claim.marketplaceId });
  }

  private readContext(counts: McfTickCounts, deadline?: number) {
    return { pacer: this.pacer, sleep: this.sleep, monotonic: this.monotonic, counts, onAuthorizationFailure: () => this.authorizationFailed(),
      ...(deadline === undefined ? {} : { deadline }) };
  }

  /** getFulfillmentPreview for exactly what the create sends; failures come back as codes. */
  private async amazonPreview(amazon: McfAmazon, claim: CreatorMcfClaim, recipient: CreatorMcfRecipient, counts: McfTickCounts):
    Promise<{ kind: 'evidence'; evidence: CreatorMcfPreviewEvidence } | { kind: 'refused'; status: number; reason: string; codes: readonly string[] }
      | { kind: 'failed'; code: string; status: number | null }> {
    await this.pacer.before();
    counts.amazonCalls += 1;
    try {
      const result = await amazon.writer.preview({ marketplaceId: claim.marketplaceId, derivedOrderKey: claim.binding.derivedOrderKey,
        sellerSku: claim.sku, recipient });
      if (result.outcome === 'previewed') return { kind: 'evidence', evidence: result };
      if (result.reason === 'authorization') this.authorizationFailed();
      return { kind: 'refused', status: result.status, reason: result.reason, codes: result.codes };
    } catch (error) {
      if (error instanceof FulfillmentOutboundError) {
        if (error.reason === 'authentication') this.authorizationFailed();
        return { kind: 'failed', code: `preview_${error.reason}`, status: error.status || null };
      }
      return { kind: 'failed', code: 'preview_failed', status: null };
    }
  }

  // -------------------------------------------------------------------------
  // Preview.
  // -------------------------------------------------------------------------

  private async preview(claim: CreatorMcfClaim, counts: McfTickCounts): Promise<void> {
    let ending: McfPreviewEnding;
    try {
      ending = await this.previewSteps(claim, counts);
    } catch (error) {
      this.log('error', { event: 'mcf_action_failed', sendId: claim.sendId, codes: ['preview', error instanceof McfSendError ? error.code : 'unexpected'] });
      await this.release(claim, 'preview_failed', this.backoff(claim));
      ending = 'deferred';
    }
    countPreviewClaim(counts, ending);
  }

  private async refuse(claim: CreatorMcfClaim, reason: CreatorMcfPreviewRefusal, codes: readonly string[]): Promise<CreatorMcfWorkerDecision> {
    const decision = await this.options.store.refusePreview(claim.sendId, claim.leaseId, reason, codes);
    this.log('info', { event: 'mcf_refused', sendId: claim.sendId, state: decision.state ?? null, codes: [reason, ...codes] });
    return decision;
  }

  private async previewSteps(claim: CreatorMcfClaim, counts: McfTickCounts): Promise<McfPreviewEnding> {
    // 1. Policy (the claim itself holds the 120-second lease).
    if (!this.allowed('preview', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    // 2. Custody: open in memory, validate, recompute the mask, check the country.
    const custody = await this.options.store.readCustody(claim.sendId, claim.leaseId);
    if (custody === null) { await this.release(claim, 'custody_unavailable', this.backoff(claim)); return 'deferred'; }
    const opened = await openMcfCustody({ claim, custody, keys: this.options.keys });
    if (opened.status === 'refused') {
      const decision = await this.refuse(claim, opened.reason, opened.codes);
      if (decision.decision !== 'preview_refused') return 'deferred';
      return opened.recipientRelated ? 'refused_recipient' : 'refused';
    }
    // The plaintext lives in this action's locals only and is passed to Amazon, never stored.
    const recipient = opened.recipient;
    const amazon = this.amazonFor(claim);
    // 3. getOrder(key): an existing order refuses the preview.
    if (!this.allowed('preview', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const read = await readMcfOrder(amazon.reader, claim.binding.derivedOrderKey, this.readContext(counts));
    if (read.outcome === 'failed') {
      this.log('info', { event: 'mcf_read_failed', sendId: claim.sendId, httpStatus: read.status, codes: [read.code] });
      await this.release(claim, read.code, this.backoff(claim));
      return 'deferred';
    }
    if (read.lookup.outcome === 'found') {
      const decision = await this.refuse(claim, 'order_exists', []);
      return decision.decision === 'preview_refused' ? 'refused' : 'deferred';
    }
    // 4. getFulfillmentPreview.
    if (!this.allowed('preview', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const answer = await this.amazonPreview(amazon, claim, recipient, counts);
    if (answer.kind === 'failed') { await this.release(claim, answer.code, this.backoff(claim)); return 'deferred'; }
    if (answer.kind === 'refused') {
      if (answer.reason === 'throttled' || answer.reason === 'authorization') {
        await this.release(claim, `preview_${answer.reason}`, this.backoff(claim));
        return 'deferred';
      }
      const decision = await this.refuse(claim, 'provider_refused', answer.codes);
      return decision.decision === 'preview_refused' ? 'refused' : 'deferred';
    }
    // 5 and 6. Record the address-free preview; the ledger checks the fee against both caps and decides.
    const body = mcfPreviewBody({ kind: 'preview', claim, evidence: answer.evidence, previewId: this.newId(), readAt: this.clock(),
      workerRevision: this.options.workerRevision });
    if (!body.ok) {
      const decision = await this.refuse(claim, 'provider_refused', [body.code]);
      return decision.decision === 'preview_refused' ? 'refused' : 'deferred';
    }
    const decision = await this.options.store.recordPreview(claim.sendId, claim.leaseId, body.preview);
    this.log('info', { event: 'mcf_preview', sendId: claim.sendId, state: decision.state ?? null,
      codes: Array.isArray(decision['codes']) ? (decision['codes'] as string[]) : [] });
    if (decision.decision === 'preview_ready') return 'previewed';
    if (decision.decision === 'preview_refused') return 'refused';
    return 'deferred';
  }

  // -------------------------------------------------------------------------
  // Dispatch.
  // -------------------------------------------------------------------------

  private async dispatch(claim: CreatorMcfClaim, counts: McfTickCounts): Promise<void> {
    const units = claim.approval?.units ?? 0;
    let ending: McfDispatchEnding;
    try {
      ending = await this.dispatchSteps(claim, counts);
    } catch (error) {
      // A throw here comes before the POST: postOnce never throws. It may come after a reservation committed whose
      // answer was lost; releasing the claim then leaves the send dispatching with posts = 1, so no claim can POST it
      // again, and the sweep makes it uncertain(crash) when its lease ends.
      this.log('error', { event: 'mcf_action_failed', sendId: claim.sendId, codes: ['dispatch', error instanceof McfSendError ? error.code : 'unexpected'] });
      await this.release(claim, 'dispatch_failed', this.backoff(claim));
      ending = 'deferred';
    }
    countDispatchClaim(counts, ending, units);
  }

  private async dispatchSteps(claim: CreatorMcfClaim, counts: McfTickCounts): Promise<McfDispatchEnding> {
    const approval = claim.approval;
    // 1. Policy; the claim was refused past the claim deadline by the ledger.
    if (!this.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    // 2. The approved preview: one unit of the lane's SKU under the send's key. The ledger checks the lane at reservation.
    const approved = approval?.preview;
    if (approval === null || approved === undefined || approved.kind !== 'preview' || approval.units !== 1 || approved.totalUnits !== 1
      || approved.sendId !== claim.sendId || approved.derivedOrderKey !== claim.binding.derivedOrderKey || approved.items[0]?.sellerSku !== claim.sku
      || approved.marketplaceId !== claim.marketplaceId || approved.spapiConnectionId !== claim.spapiConnectionId) {
      await this.release(claim, 'approval_unsupported', 600);
      return 'deferred';
    }
    // 3. Custody: open, validate, recompute the mask.
    const custody = await this.options.store.readCustody(claim.sendId, claim.leaseId);
    if (custody === null) { await this.release(claim, 'custody_unavailable', this.backoff(claim)); return 'deferred'; }
    const opened = await openMcfCustody({ claim, custody, keys: this.options.keys });
    if (opened.status === 'refused') {
      const decision = await this.refuse(claim, opened.reason, opened.codes);
      return decision.decision === 'expired' ? 'expired' : 'deferred';
    }
    // The plaintext lives in this action's locals only and is passed to Amazon, never stored.
    const recipient = opened.recipient;
    const amazon = this.amazonFor(claim);
    // 4. Re-read the preview with the same inputs. Any difference is stale: no POST, custody kept within its TTL.
    if (!this.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const answer = await this.amazonPreview(amazon, claim, recipient, counts);
    if (answer.kind === 'failed') { await this.release(claim, answer.code, this.backoff(claim)); return 'deferred'; }
    if (answer.kind === 'refused') {
      if (answer.reason === 'throttled' || answer.reason === 'authorization') {
        await this.release(claim, `reread_${answer.reason}`, this.backoff(claim));
        return 'deferred';
      }
      const decision = await this.refuse(claim, 'provider_refused', answer.codes);
      return decision.decision === 'expired' ? 'expired' : 'deferred';
    }
    const body = mcfPreviewBody({ kind: 'dispatch_reread', claim, evidence: answer.evidence, previewId: this.newId(), readAt: this.clock(),
      workerRevision: this.options.workerRevision });
    if (!body.ok) { await this.release(claim, `reread_${body.code}`, this.backoff(claim)); return 'deferred'; }
    const differs = creatorMcfPreviewsDiffer(approved, body.preview);
    const reread = await this.options.store.recordPreview(claim.sendId, claim.leaseId, body.preview);
    if (reread.decision === 'stale') {
      this.log('info', { event: 'mcf_stale', sendId: claim.sendId, state: 'stale', codes: differs });
      return 'stale';
    }
    if (reread.decision !== 'same') return 'deferred';
    if (differs.length > 0) {
      // The ledger compares more strictly than the shared function; a disagreement is never a reason to POST.
      await this.release(claim, 'reread_disagreement', 600);
      return 'deferred';
    }
    // 5. getOrder(key) before the POST. Found: classified, custody destroyed, no POST. A read error defers.
    if (!this.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const read = await readMcfOrder(amazon.reader, claim.binding.derivedOrderKey, this.readContext(counts));
    if (read.outcome === 'failed') {
      this.log('info', { event: 'mcf_read_failed', sendId: claim.sendId, httpStatus: read.status, codes: [read.code] });
      await this.release(claim, read.code, this.backoff(claim));
      return 'deferred';
    }
    if (read.lookup.outcome === 'found') {
      const order = mcfOrderRead(read.lookup, claim.binding.derivedOrderKey, this.clock().toISOString());
      if (order === null) { await this.release(claim, 'read_unusable', this.backoff(claim)); return 'deferred'; }
      const decision = await this.options.store.recordSettlement(claim.sendId, order, claim.leaseId);
      this.log('info', { event: 'mcf_found_before_post', sendId: claim.sendId, state: decision.state ?? null, codes: [`status_${order.outcome === 'found' ? order.status.toLowerCase() : 'none'}`] });
      return decision.decision === 'recorded' && FOUND_STATES.has(String(decision.state)) ? 'found_before_post' : 'deferred';
    }
    // 6. Policy, then 7. the reservation: the database's clause-9 recheck and the one permission to POST.
    if (!this.allowed('dispatch', claim)) { await this.release(claim, 'policy_off', 60); return 'deferred'; }
    const createInput = { marketplaceId: claim.marketplaceId, derivedOrderKey: claim.binding.derivedOrderKey, sellerSku: claim.sku,
      displayableOrderDate: approval.approvedAt };
    const digest = await mcfRequestDigest({ ...createInput, approvedAt: approval.approvedAt, envelopeSha256: claim.envelopeSha256 });
    const reserveStartedAt = this.monotonic();
    const reservation = await this.options.store.reserve(claim.sendId, claim.leaseId, digest);
    if (reservation.decision === 'already_reserved') {
      this.log('error', { event: 'mcf_reserve_refused', sendId: claim.sendId, state: reservation.state, codes: ['already_reserved'] });
      return 'deferred';
    }
    if (reservation.decision === 'refused') {
      this.log('info', { event: 'mcf_reserve_refused', sendId: claim.sendId, state: reservation.state ?? null, codes: [reservation.reason] });
      if (reservation.state === 'expired' || reservation.state === 'expired_unclaimed') return 'expired';
      if (reservation.state === 'stale') return 'stale';
      if (reservation.state === 'approved') await this.release(claim, `reserve_${reservation.reason}`, this.backoff(claim));
      return 'deferred';
    }
    // 8 and 9. Reserved: this send gets at most this one POST, now or never.
    return await this.postOnce(claim, amazon, { ...createInput, recipient }, reservation, reserveStartedAt, counts);
  }

  /**
   * After `dispatch_once`: the last policy check, the single POST, the getOrder
   * that must follow any 4xx, and the outcome record. Never throws; never
   * POSTs twice. A POST that is not sent is recorded as uncertain, because the
   * ledger cannot tell it from a lost answer; the ladder settles it by reads.
   */
  private async postOnce(claim: CreatorMcfClaim, amazon: McfAmazon,
    input: { marketplaceId: string; derivedOrderKey: CreatorMcfClaim['binding']['derivedOrderKey']; sellerSku: string; displayableOrderDate: string;
      recipient: CreatorMcfRecipient },
    reservation: Extract<CreatorMcfReservation, { decision: 'dispatch_once' }>, reserveStartedAt: number, counts: McfTickCounts): Promise<McfDispatchEnding> {
    let outcome: CreatorMcfProviderOutcome | null = null;
    let withheld: string | null = null;
    try {
      if (reservation.derivedOrderKey !== input.derivedOrderKey || reservation.sku !== input.sellerSku || reservation.quantity !== 1
        || reservation.marketplaceId !== input.marketplaceId || Date.parse(reservation.approvedAt) !== Date.parse(input.displayableOrderDate)) {
        withheld = 'reservation_mismatch';
      } else if (!this.allowed('dispatch', claim)) {
        withheld = this.stopping ? 'stopping' : 'policy_off';
      } else if (this.monotonic() - reserveStartedAt > (this.options.postStartBudgetMs ?? MCF_POST_START_BUDGET_MS)) {
        withheld = 'lease_budget';
      } else {
        await this.pacer.before();
        counts.amazonCalls += 1;
        try {
          outcome = await amazon.writer.create({ marketplaceId: input.marketplaceId, derivedOrderKey: input.derivedOrderKey, sellerSku: input.sellerSku,
            recipient: input.recipient, displayableOrderDate: reservation.approvedAt });
          counts.amazonCreates += 1;
        } catch (error) {
          // The writer throws only before a request leaves: nothing was sent.
          withheld = error instanceof FulfillmentOutboundError && error.reason === 'authentication' ? 'token_unavailable' : 'request_invalid';
          if (withheld === 'token_unavailable') this.authorizationFailed();
        }
      }
    } catch {
      withheld ??= 'post_failed';
    }
    if (outcome === null) {
      counts.postWithheld += 1;
      this.log('error', { event: 'mcf_post_withheld', sendId: claim.sendId, state: 'dispatching', codes: [withheld ?? 'post_failed'] });
      outcome = { outcome: 'uncertain', cause: 'crash', status: null };
      return this.recordFirstOutcome(claim, outcome, null, counts);
    }
    let lookup: CreatorMcfOrderRead | null = null;
    if (outcome.outcome === 'rejected') {
      const rejected = outcome;
      let code = 'read_unusable';
      try {
        if (rejected.reason === 'authorization') this.authorizationFailed();
        // Every 4xx is followed by getOrder before the send is treated as not placed.
        const read = this.allowed('read', claim)
          ? await readMcfOrder(amazon.reader, reservation.derivedOrderKey, this.readContext(counts, reserveStartedAt + MCF_POST_READ_DEADLINE_MS))
          : { outcome: 'failed' as const, code: 'scope' as const, status: null };
        if (read.outcome === 'read') lookup = mcfOrderRead(read.lookup, reservation.derivedOrderKey, mcfReadAt(this.clock(), reservation.reservedAt));
        else code = read.code;
      } catch {
        lookup = null;
        code = 'read_failed';
      }
      if (lookup === null && rejected.reason !== 'authorization') {
        // Without a read, a 4xx does not prove the order is absent: record it as unknown and let the ladder settle it.
        this.log('info', { event: 'mcf_read_failed', sendId: claim.sendId, httpStatus: rejected.status, codes: ['rejection_unconfirmed', code] });
        outcome = { outcome: 'uncertain', cause: 'decode', status: rejected.status };
      }
    }
    // Recording is attempted whatever happened above: the POST's answer is the ledger's evidence.
    return this.recordFirstOutcome(claim, outcome, lookup, counts);
  }

  /** Records the first POST outcome (custody destroyed in the same transaction), retrying a few times; keeps it in memory if the ledger is unreachable. */
  private async recordFirstOutcome(claim: CreatorMcfClaim, outcome: CreatorMcfProviderOutcome, lookup: CreatorMcfOrderRead | null,
    counts: McfTickCounts): Promise<McfDispatchEnding> {
    for (let attempt = 0; attempt < RECORD_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.sleep(1000 * 2 ** (attempt - 1));
      try {
        const decision = await this.options.store.recordOutcome(claim.sendId, claim.leaseId, outcome, lookup);
        const state = String(decision.state ?? '');
        this.log('info', { event: 'mcf_outcome', sendId: claim.sendId, state, httpStatus: outcome.status,
          codes: [outcome.outcome, ...(outcome.outcome === 'rejected' ? [outcome.reason, ...outcome.codes] : outcome.outcome === 'uncertain' ? [outcome.cause] : []),
            ...(lookup === null ? [] : [lookup.outcome])] });
        if (FOUND_STATES.has(state)) return 'accepted';
        if (state === 'rejected') return 'rejected';
        return 'uncertain';
      } catch {
        // Retried below, then kept in memory.
      }
    }
    this.pending.push({ sendId: claim.sendId, leaseId: claim.leaseId, outcome, lookup, since: this.monotonic() });
    counts.outcomePending += 1;
    this.log('error', { event: 'mcf_outcome_pending', sendId: claim.sendId, state: 'dispatching', httpStatus: outcome.status, codes: [outcome.outcome] });
    return 'deferred';
  }

  /**
   * Outcomes the ledger could not take are retried each tick. If the sweep has
   * meanwhile moved the send to uncertain(crash), the ledger records the answer
   * late: a 200 moves it to accepted, anything else leaves it to the ladder.
   */
  private async retryPending(counts: McfTickCounts): Promise<void> {
    for (const entry of [...this.pending]) {
      const age = this.monotonic() - entry.since;
      if (age > PENDING_MAX_AGE_MS) {
        this.pending.splice(this.pending.indexOf(entry), 1);
        this.log('error', { event: 'mcf_outcome_abandoned', sendId: entry.sendId, codes: [entry.outcome.outcome] });
        continue;
      }
      if (age > PENDING_LOOKUP_MAX_AGE_MS && entry.lookup !== null) {
        entry.lookup = null;
        if (entry.outcome.outcome === 'rejected' && entry.outcome.reason !== 'authorization') {
          entry.outcome = { outcome: 'uncertain', cause: 'decode', status: entry.outcome.status };
        }
      }
      try {
        const decision = await this.options.store.recordOutcome(entry.sendId, entry.leaseId, entry.outcome, entry.lookup);
        this.pending.splice(this.pending.indexOf(entry), 1);
        counts.lateRecorded += 1;
        this.log('info', { event: 'mcf_late_outcome', sendId: entry.sendId, state: decision.state ?? null, httpStatus: entry.outcome.status,
          codes: [decision.decision, entry.outcome.outcome] });
      } catch {
        // Still unreachable: kept for the next tick.
      }
    }
  }

  // -------------------------------------------------------------------------
  // Settle.
  // -------------------------------------------------------------------------

  private async settle(claim: CreatorMcfClaim, counts: McfTickCounts): Promise<void> {
    const store = this.options.store;
    await settleMcfClaim(claim, {
      store: {
        // WP-338i: a read that finds the 7-day ladder over marks it in the same transaction (the worker's own mark then answers
        // unchanged), so the escalation is counted and logged from the read's answer.
        recordSettlement: async (sendId, lookup, leaseId) => {
          const decision = await store.recordSettlement(sendId, lookup, leaseId);
          if (decision.decision === 'recorded' && decision['ladderMarked'] === true) {
            counts.settle.ladderExhausted += 1;
            this.log('info', { event: 'mcf_ladder_exhausted', sendId, state: decision.state ?? null });
          }
          return decision;
        },
        markLadderExhausted: (sendId) => store.markLadderExhausted(sendId),
        releaseClaim: (sendId, leaseId, retrySeconds) => store.releaseClaim(sendId, leaseId, retrySeconds),
      },
      reader: (target) => this.amazonFor(target).reader,
      policy: () => this.readPolicy(),
      pacer: this.pacer, sleep: this.sleep, clock: this.clock, monotonic: this.monotonic, log: this.log,
      onAuthorizationFailure: () => this.authorizationFailed(),
    }, counts);
  }
}

export function createMcfSendLoop(options: McfSendLoopOptions): McfSendLoop {
  return new McfSendLoop(options);
}

/**
 * Runs `tick` every `intervalMs` after the previous one ends, and owns the
 * active tick so a stop waits for a POST in flight to be recorded.
 */
export function startMcfSendPolling(loop: Pick<McfSendLoop, 'tick' | 'stop' | 'drain'>, intervalMs: number, log: McfLog) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  const run = () => {
    active = loop.tick().then(() => undefined).catch((error: unknown) => {
      log('error', { event: 'mcf_fault', codes: [error instanceof McfSendError ? error.code : error instanceof Error && error.name === 'McfCountsError' ? 'counts' : 'tick'] });
    }).finally(() => {
      if (!stopped) timer = setTimeout(run, intervalMs);
    });
  };
  run();
  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      loop.stop();
      await active;
      try {
        await loop.drain();
      } catch {
        log('error', { event: 'mcf_fault', codes: ['drain'] });
      }
    },
  };
}
