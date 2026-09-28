import { describe, expect, it } from 'vitest';
import {
  McfCountsError, assertMcfTickCounts, countDispatchClaim, countPreviewClaim, emptyMcfTickCounts, type McfDispatchEnding, type McfPreviewEnding,
} from './counts.js';

const PREVIEW_ENDINGS: McfPreviewEnding[] = ['previewed', 'refused', 'refused_recipient', 'deferred'];
const DISPATCH_ENDINGS: McfDispatchEnding[] = ['stale', 'found_before_post', 'accepted', 'rejected', 'uncertain', 'deferred', 'expired'];

describe('MCF tick counts', () => {
  it('an empty tick reconciles', () => {
    expect(() => assertMcfTickCounts(emptyMcfTickCounts())).not.toThrow();
  });

  it('every preview and dispatch ending lands in exactly one bucket and the identities hold', () => {
    const counts = emptyMcfTickCounts();
    for (const ending of PREVIEW_ENDINGS) countPreviewClaim(counts, ending);
    for (const ending of DISPATCH_ENDINGS) countDispatchClaim(counts, ending, 1);
    // The POSTs behind accepted, rejected and uncertain: two sent, one withheld.
    counts.amazonCreates = 2;
    counts.postWithheld = 1;
    counts.amazonCalls = 9;
    expect(() => assertMcfTickCounts(counts)).not.toThrow();
    expect(counts.send).toMatchObject({
      claimed: 11, previewed: 1, previewRefused: 2, previewRefusedRecipient: 1, stale: 1, foundBeforePost: 1, posted: 3, deferred: 2, expired: 1,
      accepted: 1, rejected: 1, uncertain: 1,
      // refused + refused_recipient + found_before_post + three posted + expired
      custodyDestroyed: 7,
      unitsRequested: 7, unitsAccepted: 1, unitsRejected: 1, unitsUncertain: 1, unitsStale: 1, unitsFoundBeforePost: 1, unitsDeferred: 1, unitsExpired: 1,
    });
  });

  it('an outcome kept in memory counts as deferred and still balances the POSTs', () => {
    const counts = emptyMcfTickCounts();
    countDispatchClaim(counts, 'deferred', 1);
    counts.amazonCreates = 1;
    counts.outcomePending = 1;
    counts.amazonCalls = 3;
    expect(() => assertMcfTickCounts(counts)).not.toThrow();
  });

  it.each([
    ['a posted send without its bucket', (c: ReturnType<typeof emptyMcfTickCounts>) => { c.send.claimed += 1; c.send.posted += 1; c.send.unitsRequested += 1; c.send.unitsAccepted += 1; c.send.custodyDestroyed += 1; c.amazonCreates += 1; c.amazonCalls += 1; },
      'posted = accepted + rejected + uncertain'],
    ['a claim in no bucket', (c: ReturnType<typeof emptyMcfTickCounts>) => { c.send.claimed += 1; },
      'claimed = previewed + previewRefused + stale + foundBeforePost + posted + deferred + expired'],
    ['a POST the counts never saw', (c: ReturnType<typeof emptyMcfTickCounts>) => { c.amazonCreates += 1; c.amazonCalls += 1; },
      'amazonCreates + postWithheld = posted + outcomePending'],
    ['a settle claim neither recorded nor deferred', (c: ReturnType<typeof emptyMcfTickCounts>) => { c.settle.claimed += 1; },
      'settle.claimed = settle.recorded + settle.deferred'],
    ['a recorded read neither found nor not found', (c: ReturnType<typeof emptyMcfTickCounts>) => { c.settle.claimed += 1; c.settle.recorded += 1; },
      'settle.recorded = settle.found + settle.notFound'],
    ['a negative count', (c: ReturnType<typeof emptyMcfTickCounts>) => { c.lateRecorded = -1; }, 'every count is a non-negative integer'],
    ['more POSTs than Amazon calls', (c: ReturnType<typeof emptyMcfTickCounts>) => { countDispatchClaim(c, 'accepted', 1); c.amazonCreates = 1; },
      'amazonCreates <= amazonCalls'],
  ])('a deliberate mismatch throws, naming the invariant: %s', (_name, spoil, invariant) => {
    const counts = emptyMcfTickCounts();
    spoil(counts);
    let caught: unknown;
    try { assertMcfTickCounts(counts); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(McfCountsError);
    expect((caught as McfCountsError).message).toContain(invariant);
    // Names only: no count value appears in the message.
    expect((caught as McfCountsError).message).not.toMatch(/\d/);
  });
});
