/**
 * Per-tick counts of the MCF unit (WP-338e; DESIGN section 12, clause 6),
 * asserted at the end of every tick.
 *
 * `send` is the shared `CreatorMcfSendCounts` for preview and dispatch claims:
 * every claim ends in exactly one bucket, and units are those of dispatch
 * claims. The worker adds what the shared identities cannot see:
 *
 *  - amazonCreates: createFulfillmentOrder requests actually sent.
 *  - postWithheld: reservations after which the POST was not sent (a flag
 *    turned off, a stop, the lease too short, or no access token). The ledger
 *    records these as uncertain, because it cannot tell them apart from a lost
 *    answer; the ladder settles them by reads.
 *  - outcomePending: reserved dispatches whose outcome could not be recorded in
 *    this tick. They count as deferred and are retried from memory.
 *  - lateRecorded: pending outcomes recorded in this tick (outside the claim
 *    identities, because their claim was counted when it happened).
 *  - settle: settlement claims, which carry no address and no units.
 *
 * Every invariant has a fixed name, so a failure says which one broke and
 * never carries a value.
 */
import { assertCreatorMcfCounts, type CreatorMcfSendCounts } from '@wizard-ads/shared';

export type McfSendCountKey = keyof CreatorMcfSendCounts;

export interface McfSettleCounts {
  claimed: number;
  recorded: number;
  deferred: number;
  found: number;
  notFound: number;
  ladderExhausted: number;
}

export interface McfTickCounts {
  send: Record<McfSendCountKey, number>;
  amazonCreates: number;
  postWithheld: number;
  outcomePending: number;
  lateRecorded: number;
  /** Every Amazon request attempted: reads, previews and creates. */
  amazonCalls: number;
  settle: McfSettleCounts;
}

export function emptyMcfTickCounts(): McfTickCounts {
  return {
    send: {
      claimed: 0, previewed: 0, previewRefused: 0, previewRefusedRecipient: 0, stale: 0, foundBeforePost: 0, posted: 0, deferred: 0, expired: 0,
      accepted: 0, rejected: 0, uncertain: 0, custodyDestroyed: 0,
      unitsRequested: 0, unitsAccepted: 0, unitsRejected: 0, unitsUncertain: 0, unitsStale: 0, unitsFoundBeforePost: 0, unitsDeferred: 0,
      unitsExpired: 0, readThrottled: 0,
    },
    amazonCreates: 0, postWithheld: 0, outcomePending: 0, lateRecorded: 0, amazonCalls: 0,
    settle: { claimed: 0, recorded: 0, deferred: 0, found: 0, notFound: 0, ladderExhausted: 0 },
  };
}

/** How one preview claim ended. A refusal always ends custody (preview_refused holds none). */
export type McfPreviewEnding = 'previewed' | 'refused' | 'refused_recipient' | 'deferred';

export function countPreviewClaim(counts: McfTickCounts, ending: McfPreviewEnding): void {
  const send = counts.send;
  send.claimed += 1;
  if (ending === 'previewed') send.previewed += 1;
  else if (ending === 'deferred') send.deferred += 1;
  else {
    send.previewRefused += 1;
    send.custodyDestroyed += 1;
    if (ending === 'refused_recipient') send.previewRefusedRecipient += 1;
  }
}

/**
 * How one dispatch claim ended. `accepted`, `rejected` and `uncertain` are the
 * recorded first POST outcome (custody destroyed in the same transaction);
 * `found_before_post` and `expired` also end custody; `stale` and `deferred` keep it.
 */
export type McfDispatchEnding = 'stale' | 'found_before_post' | 'accepted' | 'rejected' | 'uncertain' | 'deferred' | 'expired';

export function countDispatchClaim(counts: McfTickCounts, ending: McfDispatchEnding, units: number): void {
  const send = counts.send;
  send.claimed += 1;
  send.unitsRequested += units;
  switch (ending) {
    case 'stale': send.stale += 1; send.unitsStale += units; break;
    case 'deferred': send.deferred += 1; send.unitsDeferred += units; break;
    case 'found_before_post': send.foundBeforePost += 1; send.unitsFoundBeforePost += units; send.custodyDestroyed += 1; break;
    case 'expired': send.expired += 1; send.unitsExpired += units; send.custodyDestroyed += 1; break;
    case 'accepted': send.posted += 1; send.accepted += 1; send.unitsAccepted += units; send.custodyDestroyed += 1; break;
    case 'rejected': send.posted += 1; send.rejected += 1; send.unitsRejected += units; send.custodyDestroyed += 1; break;
    case 'uncertain': send.posted += 1; send.uncertain += 1; send.unitsUncertain += units; send.custodyDestroyed += 1; break;
  }
}

/** The worker's own invariants, each by name. */
const WORKER_INVARIANTS: readonly (readonly [string, (counts: McfTickCounts) => boolean])[] = [
  ['amazonCreates + postWithheld = posted + outcomePending',
    (c) => c.amazonCreates + c.postWithheld === c.send.posted + c.outcomePending],
  ['outcomePending <= deferred', (c) => c.outcomePending <= c.send.deferred],
  ['amazonCreates <= amazonCalls', (c) => c.amazonCreates <= c.amazonCalls],
  ['settle.claimed = settle.recorded + settle.deferred', (c) => c.settle.claimed === c.settle.recorded + c.settle.deferred],
  ['settle.recorded = settle.found + settle.notFound', (c) => c.settle.recorded === c.settle.found + c.settle.notFound],
  ['settle.ladderExhausted <= settle.recorded', (c) => c.settle.ladderExhausted <= c.settle.recorded],
];

const NON_NEGATIVE = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

/** A fixed-text error naming the broken invariants. */
export class McfCountsError extends Error {
  constructor(readonly broken: readonly string[]) {
    super(`MCF tick counts do not reconcile: ${broken.join('; ')}`);
    this.name = 'McfCountsError';
  }
}

/** Throws unless the shared identities and the worker's invariants all hold. */
export function assertMcfTickCounts(counts: McfTickCounts): void {
  const broken: string[] = [];
  try {
    assertCreatorMcfCounts(counts.send);
  } catch (error) {
    broken.push(error instanceof Error ? error.message : 'creator MCF counts do not reconcile');
  }
  const scalars = [counts.amazonCreates, counts.postWithheld, counts.outcomePending, counts.lateRecorded, counts.amazonCalls,
    ...Object.values(counts.settle)];
  if (!scalars.every(NON_NEGATIVE)) broken.push('every count is a non-negative integer');
  for (const [name, holds] of WORKER_INVARIANTS) if (!holds(counts)) broken.push(name);
  if (broken.length > 0) throw new McfCountsError(broken);
}
