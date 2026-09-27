/**
 * Settlement reads of the MCF unit (WP-338e; DESIGN section 8, step 10).
 *
 * An accepted, uncertain or conflicting send is settled only by reading
 * Amazon, never by another POST. The ledger schedules the ladder (about +1, +5,
 * +15 and +60 minutes, hourly to 24 hours, then every 6 hours to 7 days) as
 * settle work; each claim here is one getFulfillmentOrder read of the send's
 * CCS key, recorded through `record_creator_mcf_settlement`, which classifies
 * it. A send still accepted or uncertain after 7 days is marked
 * ladder_exhausted.
 *
 * Every Amazon call of the unit, reads included, goes through one pacer that
 * keeps calls at least 1 second apart (getFulfillmentOrder allows 2 a second,
 * shared with mcf.observe). A read answered 429 is retried at most 3 times with
 * backoff, and every 429 is counted. Reads carry no address: the reader copies
 * an allowlist, and `mcfOrderRead` keeps only what the ledger accepts.
 */
import type { CreatorMcfClaim, CreatorMcfOrderRead } from '@wizard-ads/db/worker';
import type { CreatorSamplePackage, FulfillmentOrderLookup } from '@wizard-ads/shared';
import { FulfillmentOutboundError, type FulfillmentOutboundReader } from '@wizard-ads/sp-api';
import type { McfTickCounts } from './counts.js';
import type { McfLog, McfSendStore } from './loop.js';
import { mcfStepAllowed, type McfSendPolicy } from './policy.js';

/** Minimum spacing between any two Amazon calls of the unit. */
export const MCF_AMAZON_SPACING_MS = 1000;
/** A read answered 429 is retried at most this many times. */
export const MCF_READ_THROTTLE_RETRIES = 3;
/** The ladder's length; a send still accepted or uncertain after it is escalated. */
export const MCF_LADDER_MS = 7 * 24 * 60 * 60 * 1000;
/** The ledger keeps at most 20 items and packages per read. */
const MAX_ITEMS = 20;

/** Keeps successive Amazon calls at least `spacingMs` apart. */
export interface McfPacer {
  before(): Promise<void>;
}

export function createMcfPacer(options: { spacingMs: number; monotonic: () => number; sleep: (ms: number) => Promise<void> }): McfPacer {
  let last: number | null = null;
  return {
    async before() {
      if (last !== null) {
        const wait = last + options.spacingMs - options.monotonic();
        if (wait > 0) await options.sleep(wait);
      }
      last = options.monotonic();
    },
  };
}

export type McfOrderReader = Pick<FulfillmentOutboundReader, 'getOrder'>;

export type McfReadFailure = 'read_throttled' | 'read_transport' | 'read_http' | 'read_invalid_response' | 'read_identity_conflict'
  | 'read_authentication' | 'read_invalid_request' | 'read_failed' | 'read_deadline';

export type McfOrderReadResult =
  | { readonly outcome: 'read'; readonly lookup: FulfillmentOrderLookup }
  | { readonly outcome: 'failed'; readonly code: McfReadFailure; readonly status: number | null };

export interface McfReadContext {
  pacer: McfPacer;
  sleep: (ms: number) => Promise<void>;
  monotonic: () => number;
  counts: McfTickCounts;
  onAuthorizationFailure: () => void;
  /** No new attempt starts after this monotonic time. */
  deadline?: number;
}

function readFailure(error: unknown): { code: McfReadFailure; status: number | null } {
  if (!(error instanceof FulfillmentOutboundError)) return { code: 'read_failed', status: null };
  switch (error.reason) {
    case 'http': return { code: 'read_http', status: error.status || null };
    case 'transport': return { code: 'read_transport', status: null };
    case 'invalid_response': return { code: 'read_invalid_response', status: null };
    case 'identity_conflict': return { code: 'read_identity_conflict', status: null };
    case 'authentication': return { code: 'read_authentication', status: null };
    case 'invalid_request': return { code: 'read_invalid_request', status: null };
  }
}

/**
 * One getFulfillmentOrder read of `key`, paced, with at most 3 retries of a
 * 429 (1, 2 and 4 seconds of backoff on top of the pacing). Every 429 is
 * counted in `readThrottled`. Any other failure is returned, never thrown, as
 * a fixed code: a failed read is never taken for "not found".
 */
export async function readMcfOrder(reader: McfOrderReader, key: string, context: McfReadContext): Promise<McfOrderReadResult> {
  for (let attempt = 0; ; attempt += 1) {
    if (context.deadline !== undefined && context.monotonic() > context.deadline) return { outcome: 'failed', code: 'read_deadline', status: null };
    await context.pacer.before();
    context.counts.amazonCalls += 1;
    try {
      return { outcome: 'read', lookup: await reader.getOrder(key) };
    } catch (error) {
      const failure = readFailure(error);
      if (failure.code === 'read_http' && failure.status === 429) {
        context.counts.send.readThrottled += 1;
        if (attempt < MCF_READ_THROTTLE_RETRIES) {
          await context.sleep(1000 * 2 ** attempt);
          continue;
        }
        return { outcome: 'failed', code: 'read_throttled', status: 429 };
      }
      if (failure.code === 'read_authentication' || failure.status === 401 || failure.status === 403) context.onAuthorizationFailure();
      return { outcome: 'failed', ...failure };
    }
  }
}

/**
 * The read time to record: now, but never at or before `floor` (the
 * reservation). A read that follows a reservation happened after it, so a
 * worker clock behind the database's must not make the ledger discard it.
 */
export function mcfReadAt(now: Date, floor: string | null): string {
  const at = now.getTime();
  const minimum = floor === null ? Number.NEGATIVE_INFINITY : Date.parse(floor) + 1;
  return new Date(Math.max(at, minimum)).toISOString();
}

/**
 * The ledger's address-free shape of one read. The reader has already dropped
 * every recipient field; this keeps only identity, status, items, shipments and
 * their packages (carrier status marked unread: mcf.observe reads carriers).
 * Null when a found order cannot be recorded (no items, too many, or another id).
 */
export function mcfOrderRead(lookup: FulfillmentOrderLookup, key: string, readAt: string): CreatorMcfOrderRead | null {
  if (lookup.outcome === 'not_found') return { outcome: 'not_found', operation: 'getFulfillmentOrder', readAt };
  const order = lookup.order;
  if (order.sellerFulfillmentOrderId !== key || order.items.length === 0 || order.items.length > MAX_ITEMS) return null;
  const packages: CreatorSamplePackage[] = order.shipments.flatMap((shipment) => shipment.packages).slice(0, MAX_ITEMS).map((pkg) => ({
    packageNumber: pkg.packageNumber, carrierCode: pkg.carrierCode, trackingNumber: pkg.trackingNumber, estimatedArrivalAt: pkg.estimatedArrivalAt,
    carrierStatus: null, carrierStatusReadAt: null,
  }));
  return {
    outcome: 'found', operation: 'getFulfillmentOrder', status: order.status, readAt, sellerFulfillmentOrderId: key,
    items: order.items.map((item) => ({ sellerSku: item.sellerSku, quantity: item.quantity, cancelledQuantity: item.cancelledQuantity,
      unfulfillableQuantity: item.unfulfillableQuantity })),
    shipments: order.shipments.map((shipment) => ({ amazonShipmentId: shipment.amazonShipmentId, status: shipment.status,
      shippedAt: shipment.shippedAt, estimatedArrivalAt: shipment.estimatedArrivalAt,
      packages: shipment.packages.map((pkg) => ({ packageNumber: pkg.packageNumber, carrierCode: pkg.carrierCode,
        trackingNumber: pkg.trackingNumber, estimatedArrivalAt: pkg.estimatedArrivalAt })) })),
    packages,
  };
}

/** Seconds before released work is due again: doubling from `base`, at most `max`. */
export function mcfRetrySeconds(attempts: number, base: number, max: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 12);
  return Math.max(1, Math.min(max, base * 2 ** exponent));
}

export interface McfSettleDeps {
  store: Pick<McfSendStore, 'recordSettlement' | 'markLadderExhausted' | 'releaseClaim'>;
  reader: (claim: CreatorMcfClaim) => McfOrderReader;
  policy: () => McfSendPolicy;
  pacer: McfPacer;
  sleep: (ms: number) => Promise<void>;
  clock: () => Date;
  monotonic: () => number;
  log: McfLog;
  onAuthorizationFailure: () => void;
}

/** One settle claim: read the key, record the read, and escalate a ladder that ran out. Never throws. */
export async function settleMcfClaim(claim: CreatorMcfClaim, deps: McfSettleDeps, counts: McfTickCounts): Promise<void> {
  counts.settle.claimed += 1;
  const sendId = claim.sendId;
  const defer = async (code: string, retrySeconds: number | null): Promise<void> => {
    counts.settle.deferred += 1;
    if (retrySeconds !== null) {
      try {
        await deps.store.releaseClaim(sendId, claim.leaseId, retrySeconds);
      } catch {
        deps.log('error', { event: 'mcf_release_failed', sendId, codes: ['settle'] });
      }
    }
    deps.log('info', { event: 'mcf_settle_deferred', sendId, state: claim.state, codes: [code] });
  };
  let policy: McfSendPolicy;
  try {
    policy = deps.policy();
  } catch {
    return defer('policy_invalid', 60);
  }
  if (!mcfStepAllowed(policy, 'read', claim.spapiConnectionId, claim.marketplaceId)) return defer('scope', 60);
  let reader: McfOrderReader;
  try {
    reader = deps.reader(claim);
  } catch {
    return defer('amazon_unavailable', mcfRetrySeconds(claim.attempts, 60, 1800));
  }
  const key = claim.binding.derivedOrderKey;
  const read = await readMcfOrder(reader, key, { pacer: deps.pacer, sleep: deps.sleep, monotonic: deps.monotonic, counts,
    onAuthorizationFailure: deps.onAuthorizationFailure });
  if (read.outcome === 'failed') {
    deps.log('info', { event: 'mcf_read_failed', sendId, httpStatus: read.status, codes: [read.code] });
    return defer(read.code, mcfRetrySeconds(claim.attempts, 60, 1800));
  }
  const order = mcfOrderRead(read.lookup, key, mcfReadAt(deps.clock(), claim.settle?.intentReservedAt ?? null));
  if (order === null) return defer('read_unusable', mcfRetrySeconds(claim.attempts, 60, 1800));
  let decision;
  try {
    decision = await deps.store.recordSettlement(sendId, order, claim.leaseId);
  } catch {
    return defer('record_failed', 60);
  }
  if (decision.decision !== 'recorded') return defer(typeof decision['reason'] === 'string' ? `settle_${decision['reason']}` : 'settle_refused', null);
  counts.settle.recorded += 1;
  if (order.outcome === 'found') counts.settle.found += 1;
  else counts.settle.notFound += 1;
  const state = decision.state;
  const ladderStart = claim.settle?.ladderStart ?? null;
  const overdue = ladderStart !== null && deps.clock().getTime() >= Date.parse(ladderStart) + MCF_LADDER_MS;
  if ((decision['ladderDue'] === true || overdue) && (state === 'accepted' || state === 'uncertain')) {
    try {
      const marked = await deps.store.markLadderExhausted(sendId);
      if (marked.decision === 'escalated') {
        counts.settle.ladderExhausted += 1;
        deps.log('info', { event: 'mcf_ladder_exhausted', sendId, state });
      }
    } catch {
      deps.log('error', { event: 'mcf_ladder_mark_failed', sendId, state });
    }
  }
  deps.log('info', { event: 'mcf_settle', sendId, state: state ?? null,
    codes: [order.outcome === 'found' ? `status_${order.status.toLowerCase()}` : 'not_found'] });
}
