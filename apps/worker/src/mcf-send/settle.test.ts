import { randomBytes, randomUUID } from 'node:crypto';
import type { CreatorMcfClaim, CreatorMcfOrderRead, CreatorMcfWorkerDecision } from '@wizard-ads/db/worker';
import { FulfillmentOutboundReader } from '@wizard-ads/sp-api';
import { describe, expect, it } from 'vitest';
import { marketplaceIdForCountry } from '../marketplaces.js';
import { FakeFulfillmentOutbound } from '../testing/fake-fulfillment-outbound.js';
import { assertMcfTickCounts, emptyMcfTickCounts } from './counts.js';
import type { McfLogEntry } from './loop.js';
import { MCF_LADDER_MS, createMcfPacer, mcfOrderRead, mcfReadAt, readMcfOrder, settleMcfClaim, type McfSettleDeps } from './settle.js';

const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const US = marketplaceIdForCountry('US')!;

function settleClaim(change: Partial<CreatorMcfClaim> = {}, settle: Partial<NonNullable<CreatorMcfClaim['settle']>> = {}): CreatorMcfClaim {
  const connection = randomUUID();
  const key = `CCS-${hex(16)}`;
  return {
    outboxId: randomUUID(), action: 'settle', leaseId: randomUUID(), leaseUntil: new Date(Date.now() + 120_000).toISOString(), attempts: 1,
    sendId: randomUUID(), orgId: randomUUID(), state: 'accepted',
    binding: { orgId: randomUUID(), creatorRecordId: 'CCR-SW-26-1001', asin: `B0${hex(4).toUpperCase()}`, derivedOrderKey: key,
      reservationId: `MCFR-${hex(8).toUpperCase()}` } as CreatorMcfClaim['binding'],
    sku: 'SYN-SKU-1', spapiConnectionId: connection, marketplaceId: US, keyId: hex(32), envelopeId: randomUUID(), envelopeSha256: hex(32), mask: null,
    preflight: { id: randomUUID(), runId: 'preflight-synthetic', completedAt: new Date().toISOString() },
    caps: { laneFeeCapMinor: 800, grantFeeCapMinor: 1500, grantCurrency: 'USD' }, approval: null,
    settle: { intentReservedAt: new Date(Date.now() - 60_000).toISOString(), acceptedAt: new Date(Date.now() - 59_000).toISOString(), reads: 0,
      ladderStart: new Date(Date.now() - 60_000).toISOString(), ...settle },
    ...change,
  };
}

/** A fake clock whose sleep advances time, so spacing is measured, not waited for. */
function fakeTime(start = Date.parse('2026-09-28T12:00:00Z')) {
  const time = { now: start, sleeps: [] as number[] };
  return {
    time,
    monotonic: () => time.now,
    clock: () => new Date(time.now),
    sleep: async (ms: number) => { time.sleeps.push(ms); time.now += ms; },
  };
}

function harness(options: { decision?: (lookup: CreatorMcfOrderRead) => CreatorMcfWorkerDecision; scope?: 'in' | 'out' } = {}) {
  const t = fakeTime();
  const fake = new FakeFulfillmentOutbound({ now: t.monotonic });
  const reader = new FulfillmentOutboundReader({ endpoint: 'https://fake-sp-api.invalid', accessTokenProvider: FakeFulfillmentOutbound.tokens(),
    userAgent: 'wp338e-test', fetch: fake.fetch });
  const calls = { recorded: [] as { sendId: string; lookup: CreatorMcfOrderRead; leaseId: string | null }[], released: [] as number[], marked: 0 };
  const logs: McfLogEntry[] = [];
  let authFailures = 0;
  const deps = (claim: CreatorMcfClaim): McfSettleDeps => ({
    store: {
      recordSettlement: async (sendId, lookup, leaseId) => {
        calls.recorded.push({ sendId, lookup, leaseId });
        return options.decision?.(lookup) ?? { decision: 'recorded', state: lookup.outcome === 'found' ? 'placed' : claim.state, ladderDue: false };
      },
      markLadderExhausted: async () => { calls.marked += 1; return { decision: 'escalated', state: 'accepted' }; },
      releaseClaim: async (_sendId, _lease, seconds) => { calls.released.push(seconds); return { decision: 'released', state: claim.state }; },
    },
    reader: () => reader,
    policy: () => ({ previewEnabled: false, dispatchEnabled: false,
      scope: options.scope === 'out' ? [`${randomUUID()}:${US}`] : [`${claim.spapiConnectionId}:${claim.marketplaceId}`] }),
    pacer: createMcfPacer({ spacingMs: 1000, monotonic: t.monotonic, sleep: t.sleep }),
    sleep: t.sleep, clock: t.clock, monotonic: t.monotonic,
    log: (_level, entry) => { logs.push(entry); },
    onAuthorizationFailure: () => { authFailures += 1; },
  });
  return { t, fake, reader, calls, logs, deps, auth: () => authFailures };
}

describe('MCF settlement reads', () => {
  it('records a not-found read with the flags off, as long as the scope covers the send', async () => {
    const h = harness();
    const claim = settleClaim({ state: 'uncertain' });
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, h.deps(claim), counts);
    expect(h.fake.operations).toEqual(['get']);
    expect(h.fake.posts).toBe(0);
    expect(h.calls.recorded).toHaveLength(1);
    const { lookup, leaseId } = h.calls.recorded[0]!;
    expect(leaseId).toBe(claim.leaseId);
    expect(Object.keys(lookup).sort()).toEqual(['operation', 'outcome', 'readAt']);
    expect(lookup).toMatchObject({ outcome: 'not_found', operation: 'getFulfillmentOrder' });
    expect(counts.settle).toMatchObject({ claimed: 1, recorded: 1, notFound: 1, found: 0, deferred: 0 });
    expect(() => assertMcfTickCounts(counts)).not.toThrow();
  });

  it('records a found order address-free: identity, status, items, shipments and packages only', async () => {
    const h = harness();
    const claim = settleClaim();
    const name = `Qzname${hex(4)}`;
    h.fake.seedOrder({ sellerFulfillmentOrderId: claim.binding.derivedOrderKey, status: 'Received', sellerSku: claim.sku, quantity: 1,
      destination: { name, addressLine1: `Qzstreet${hex(4)}`, city: `Qzcity${hex(4)}`, postalCode: 'QZ1234', countryCode: 'US' } });
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, h.deps(claim), counts);
    const lookup = h.calls.recorded[0]!.lookup;
    expect(lookup).toMatchObject({ outcome: 'found', operation: 'getFulfillmentOrder', status: 'Received', sellerFulfillmentOrderId: claim.binding.derivedOrderKey,
      items: [{ sellerSku: claim.sku, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }], shipments: [], packages: [] });
    expect(Object.keys(lookup).sort()).toEqual(['items', 'operation', 'outcome', 'packages', 'readAt', 'sellerFulfillmentOrderId', 'shipments', 'status']);
    // The fake echoed the destination; nothing of it reached the ledger or the log.
    expect(JSON.stringify([lookup, h.logs]).toLowerCase()).not.toContain(name.toLowerCase());
    expect(counts.settle).toMatchObject({ recorded: 1, found: 1 });
  });

  it('retries a throttled read at most three times, at least 1 second apart, and counts every 429', async () => {
    const h = harness();
    const claim = settleClaim();
    h.fake.readFailures = [{ kind: 'http', status: 429 }, { kind: 'http', status: 429 }];
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, h.deps(claim), counts);
    expect(h.fake.reads).toBe(3);
    expect(counts.send.readThrottled).toBe(2);
    expect(counts.amazonCalls).toBe(3);
    const gaps = h.fake.requests.slice(1).map((request, index) => request.at - h.fake.requests[index]!.at);
    expect(gaps.every((gap) => gap >= 1000)).toBe(true);
    expect(counts.settle).toMatchObject({ recorded: 1, notFound: 1 });
  });

  it('gives up after the third retry of a 429: the claim is released, nothing is recorded', async () => {
    const h = harness();
    const claim = settleClaim();
    h.fake.readFailures = Array.from({ length: 6 }, () => ({ kind: 'http' as const, status: 429 }));
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, h.deps(claim), counts);
    expect(h.fake.reads).toBe(4);
    expect(counts.send.readThrottled).toBe(4);
    expect(h.calls.recorded).toHaveLength(0);
    expect(h.calls.released).toHaveLength(1);
    expect(counts.settle).toMatchObject({ claimed: 1, deferred: 1, recorded: 0 });
    expect(() => assertMcfTickCounts(counts)).not.toThrow();
  });

  it.each([
    ['a transport failure', { kind: 'transport' as const }],
    ['a 500', { kind: 'http' as const, status: 500 }],
    ['a 400 for an unknown id', { kind: 'http' as const, status: 400 }],
  ])('%s is never taken for "not found": the read is released', async (_name, failure) => {
    const h = harness();
    const claim = settleClaim({ state: 'uncertain' });
    h.fake.readFailures = [failure];
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, h.deps(claim), counts);
    expect(h.calls.recorded).toHaveLength(0);
    expect(counts.settle.deferred).toBe(1);
  });

  it('flags an authorization failure for the heartbeat', async () => {
    const h = harness();
    const claim = settleClaim();
    h.fake.readFailures = [{ kind: 'http', status: 403 }];
    await settleMcfClaim(claim, h.deps(claim), emptyMcfTickCounts());
    expect(h.auth()).toBe(1);
  });

  it('marks ladder_exhausted when the ledger says the ladder is due, and only for accepted or uncertain sends', async () => {
    const due = harness({ decision: () => ({ decision: 'recorded', state: 'accepted', ladderDue: true }) });
    const claim = settleClaim();
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, due.deps(claim), counts);
    expect(due.calls.marked).toBe(1);
    expect(counts.settle.ladderExhausted).toBe(1);
    const conflict = harness({ decision: () => ({ decision: 'recorded', state: 'conflict', ladderDue: true }) });
    await settleMcfClaim(claim, conflict.deps(claim), emptyMcfTickCounts());
    expect(conflict.calls.marked).toBe(0);
    const early = harness({ decision: () => ({ decision: 'recorded', state: 'accepted', ladderDue: false }) });
    await settleMcfClaim(claim, early.deps(claim), emptyMcfTickCounts());
    expect(early.calls.marked).toBe(0);
  });

  it('marks a send read after 7 days even when the ledger did not flag it (a crash before the mark)', async () => {
    const h = harness({ decision: () => ({ decision: 'recorded', state: 'uncertain', ladderDue: false }) });
    const started = new Date(h.t.time.now - MCF_LADDER_MS - 60_000).toISOString();
    const claim = settleClaim({ state: 'uncertain' }, { ladderStart: started, intentReservedAt: started });
    await settleMcfClaim(claim, h.deps(claim), emptyMcfTickCounts());
    expect(h.calls.marked).toBe(1);
  });

  it('a scope that no longer covers the send stops the read', async () => {
    const h = harness({ scope: 'out' });
    const claim = settleClaim();
    const counts = emptyMcfTickCounts();
    await settleMcfClaim(claim, h.deps(claim), counts);
    expect(h.fake.requests).toHaveLength(0);
    expect(h.calls.released).toEqual([60]);
    expect(counts.settle.deferred).toBe(1);
  });

  it('a read after a reservation is never stamped before it', () => {
    const reservedAt = '2026-09-28T12:00:05.000Z';
    expect(mcfReadAt(new Date('2026-09-28T12:00:04.000Z'), reservedAt)).toBe('2026-09-28T12:00:05.001Z');
    expect(mcfReadAt(new Date('2026-09-28T12:00:09.000Z'), reservedAt)).toBe('2026-09-28T12:00:09.000Z');
    expect(mcfReadAt(new Date('2026-09-28T12:00:09.000Z'), null)).toBe('2026-09-28T12:00:09.000Z');
  });

  it('refuses to record a found order it cannot represent', () => {
    const key = `CCS-${hex(16)}`;
    const order = { sellerFulfillmentOrderId: key, status: 'Received' as const, receivedAt: null, statusUpdatedAt: null, items: [], shipments: [] };
    expect(mcfOrderRead({ outcome: 'found', order }, key, new Date().toISOString())).toBeNull();
    expect(mcfOrderRead({ outcome: 'found', order: { ...order, items: [{ sellerSku: 'S', quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }] } },
      `CCS-${hex(16)}`, new Date().toISOString())).toBeNull();
  });

  it('the pacer keeps calls at least the spacing apart', async () => {
    const t = fakeTime();
    const pacer = createMcfPacer({ spacingMs: 1000, monotonic: t.monotonic, sleep: t.sleep });
    const at: number[] = [];
    for (let index = 0; index < 4; index += 1) {
      await pacer.before();
      at.push(t.time.now);
      t.time.now += index === 1 ? 1500 : 200;
    }
    expect(at.slice(1).map((value, index) => value - at[index]!)).toEqual([1000, 1500, 1000]);
  });

  it('readMcfOrder stops starting attempts after its deadline', async () => {
    const h = harness();
    h.fake.readFailures = Array.from({ length: 6 }, () => ({ kind: 'http' as const, status: 429 }));
    const counts = emptyMcfTickCounts();
    const result = await readMcfOrder(h.reader, `CCS-${hex(16)}`, { pacer: createMcfPacer({ spacingMs: 1000, monotonic: h.t.monotonic, sleep: h.t.sleep }),
      sleep: h.t.sleep, monotonic: h.t.monotonic, counts, onAuthorizationFailure: () => {}, deadline: h.t.time.now + 2500 });
    expect(result).toMatchObject({ outcome: 'failed', code: 'read_deadline' });
    expect(h.fake.reads).toBe(2);
  });
});
