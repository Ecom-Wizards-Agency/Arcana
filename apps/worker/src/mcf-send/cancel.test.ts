/**
 * The MCF unit's guarded Amazon cancel (WP-338i). Part one drives the cancel
 * runner against a scripted ledger to prove the order of steps, the policy
 * re-checks, the single request after a reservation and what happens when the
 * ledger, the token or the flags fail. Part two drives the real loop against
 * the real ledger (migrations 20260928120000 and 20260928130000) and the fake
 * Fulfillment Outbound provider, one path per acceptance line, each with its
 * exact count of cancel requests at the wire.
 *
 * Synthetic data only: keys, ids and the recipient's unique tokens are made at
 * run time. The fake echoes the destination back in its answers; nothing of it
 * may reach a log line, a thrown message or a table row.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  approveCreatorMcfCancel, approveCreatorMcfSend, creatorSampleOrderKey, readCreatorMcfLane, requestCreatorMcfCancelPreview,
  sealCreatorMcfRecipient as sealInLedger,
} from '@wizard-ads/db';
import type {
  CreatorMcfCancelReservation, CreatorMcfCancelUnsentReason, CreatorMcfClaim, CreatorMcfOrderRead, CreatorMcfWorkerDecision,
} from '@wizard-ads/db/worker';
import { asServiceRole, createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import {
  creatorMcfCancelConfirmation, creatorMcfRecipientKeyId, creatorMcfSendConfirmation, sealCreatorMcfRecipient, type CreatorMcfCancelPreview,
  type CreatorMcfProviderOutcome, type CreatorMcfRecipient, type CreatorMcfRecipientBinding,
} from '@wizard-ads/shared';
import { FulfillmentOutboundError, FulfillmentOutboundReader, FulfillmentOutboundWriter, type SpApiAccessTokenProvider } from '@wizard-ads/sp-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketplaceIdForCountry } from '../marketplaces.js';
import { FakeFulfillmentOutbound } from '../testing/fake-fulfillment-outbound.js';
import {
  McfCancelRunner, assertMcfCancelCounts, emptyMcfCancelCounts, mcfCancelPreviewBody, mcfCancelRequestDigest, postgresMcfCancelStore,
  type McfCancelCounts, type McfCancelStore,
} from './cancel.js';
import { McfCountsError, emptyMcfTickCounts } from './counts.js';
import { credentialDirectoryKeySource, mcfRecipientCredentialName } from './custody.js';
import { McfSendLoop, mcfLogLine, postgresMcfSendStore, type McfAmazonFactory, type McfLogEntry } from './loop.js';
import { mcfClaimableActions } from './policy.js';
import { createMcfPacer } from './settle.js';

const US = marketplaceIdForCountry('US')!;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const token = (label: string) => `${label}${hex(4)}`;
const ENDPOINT = 'https://fake-sp-api.invalid';

function amazonOver(fake: FakeFulfillmentOutbound, tokens: SpApiAccessTokenProvider = FakeFulfillmentOutbound.tokens()): McfAmazonFactory {
  return () => ({
    reader: new FulfillmentOutboundReader({ endpoint: ENDPOINT, accessTokenProvider: tokens, userAgent: 'wp338i-test', fetch: fake.fetch }),
    writer: new FulfillmentOutboundWriter({ endpoint: ENDPOINT, accessTokenProvider: tokens, userAgent: 'wp338i-test', fetch: fake.fetch }),
  });
}

// ===========================================================================
// Part one: the runner against a scripted ledger.
// ===========================================================================

const KEY = `CCS-${hex(16)}`;
const SKU = `SYN-${hex(3).toUpperCase()}`;

function cancelClaim(mode: 'preview' | 'execute', now: Date): CreatorMcfClaim {
  const binding = { orgId: randomUUID(), creatorRecordId: 'CCR-SW-26-4001', asin: `B0${hex(4).toUpperCase()}`, derivedOrderKey: KEY,
    reservationId: `MCFR-${hex(8).toUpperCase()}` } as CreatorMcfRecipientBinding;
  const claim: CreatorMcfClaim = {
    outboxId: randomUUID(), action: 'cancel', leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 120_000).toISOString(), attempts: 1,
    sendId: randomUUID(), orgId: binding.orgId, state: 'placed', binding, sku: SKU, spapiConnectionId: randomUUID(), marketplaceId: US, keyId: hex(32),
    envelopeId: randomUUID(), envelopeSha256: hex(32), mask: null, preflight: { id: randomUUID(), runId: 'preflight-synthetic', completedAt: now.toISOString() },
    caps: { laneFeeCapMinor: 800, grantFeeCapMinor: 1500, grantCurrency: 'USD' }, approval: null, settle: null, cancel: { mode: 'preview', originState: 'placed' },
  };
  if (mode === 'preview') return claim;
  const read: CreatorMcfOrderRead = { outcome: 'found', operation: 'getFulfillmentOrder', status: 'Received', readAt: new Date(now.getTime() - 60_000).toISOString(),
    sellerFulfillmentOrderId: KEY, items: [{ sellerSku: SKU, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }], shipments: [], packages: [] };
  const preview = mcfCancelPreviewBody({ claim, lookup: read, previewId: randomUUID(), workerRevision: 'wp338i-test' })!;
  return { ...claim, cancel: { mode: 'execute', cancelId: randomUUID(), originState: 'placed', approvedAt: new Date(now.getTime() - 30_000).toISOString(),
    claimDeadline: new Date(now.getTime() + 14 * 60_000).toISOString(), previewId: preview.previewId, fingerprint: hex(32), preview } };
}

/** The ledger as a script: it answers the way the migration would for one send, and records what it was given. */
class ScriptedCancelLedger implements McfCancelStore {
  readonly calls: string[] = [];
  readonly previews: (CreatorMcfCancelPreview | null)[] = [];
  readonly lookups: CreatorMcfOrderRead[] = [];
  readonly outcomes: CreatorMcfProviderOutcome[] = [];
  readonly unsent: CreatorMcfCancelUnsentReason[] = [];
  reservation: CreatorMcfCancelReservation | null = null;
  reserveFails = false;
  outcomeFailures = 0;
  readonly releases: number[] = [];

  async recordCancelPreview(_sendId: string, _leaseId: string, lookup: CreatorMcfOrderRead, preview: CreatorMcfCancelPreview | null): Promise<CreatorMcfWorkerDecision> {
    this.calls.push('recordCancelPreview');
    this.lookups.push(lookup);
    this.previews.push(preview);
    return preview === null ? { decision: 'cancel_preview_refused', reason: 'status_processing', state: 'placed' }
      : { decision: 'cancel_preview_ready', previewId: preview.previewId, state: 'placed' };
  }
  async reserveCancel(sendId: string, _leaseId: string, lookup: CreatorMcfOrderRead, requestDigest: string): Promise<CreatorMcfCancelReservation> {
    this.calls.push('reserveCancel');
    this.lookups.push(lookup);
    if (this.reserveFails) throw new Error('the reservation committed but its answer was lost');
    return this.reservation ?? { decision: 'cancel_once', sendId, cancelId: randomUUID(), derivedOrderKey: KEY, marketplaceId: US,
      reservedAt: new Date().toISOString(), orderStatus: 'Received', requestDigest };
  }
  async recordCancelOutcome(_sendId: string, _leaseId: string, outcome: CreatorMcfProviderOutcome): Promise<CreatorMcfWorkerDecision> {
    this.calls.push('recordCancelOutcome');
    if (this.outcomeFailures > 0) { this.outcomeFailures -= 1; throw new Error('ledger unreachable'); }
    this.outcomes.push(outcome);
    return { decision: 'recorded', state: 'cancel_dispatching' };
  }
  async recordCancelUnsent(_sendId: string, _leaseId: string, reason: CreatorMcfCancelUnsentReason): Promise<CreatorMcfWorkerDecision> {
    this.calls.push('recordCancelUnsent');
    if (this.outcomeFailures > 0) { this.outcomeFailures -= 1; throw new Error('ledger unreachable'); }
    this.unsent.push(reason);
    return { decision: 'recorded', state: 'placed' };
  }
  async releaseClaim(_sendId: string, _leaseId: string, retrySeconds: number): Promise<CreatorMcfWorkerDecision> {
    this.calls.push('releaseClaim');
    this.releases.push(retrySeconds);
    return { decision: 'released' };
  }
}

describe('the cancel runner against a scripted ledger', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  function setup(options: { tokens?: SpApiAccessTokenProvider; dispatch?: () => boolean; stopping?: () => boolean; status?: 'Received' | 'Processing';
    throwAfterCancel?: boolean } = {}) {
    const fake = new FakeFulfillmentOutbound({ now: () => now.getTime() });
    fake.seedOrder({ sellerFulfillmentOrderId: KEY, status: options.status ?? 'Received', sellerSku: SKU, quantity: 1 });
    const ledger = new ScriptedCancelLedger();
    const logs: McfLogEntry[] = [];
    const amazon = amazonOver(fake, options.tokens);
    let time = now.getTime();
    const runner = new McfCancelRunner({
      store: ledger, amazon: (claim) => {
        const real = amazon({ orgId: claim.orgId, spapiConnectionId: claim.spapiConnectionId, marketplaceId: claim.marketplaceId });
        return options.throwAfterCancel !== true ? real : { reader: real.reader, writer: { cancel: async (key) => {
          await real.writer.cancel!(key);
          throw new Error('synthetic failure after the request left');
        } } };
      },
      allowed: (gate) => gate === 'read' || (options.dispatch?.() ?? true), stopping: options.stopping ?? (() => false),
      pacer: createMcfPacer({ spacingMs: 0, monotonic: () => time, sleep: async () => {} }), sleep: async (ms) => { time += ms; },
      clock: () => new Date(time), monotonic: () => time, newId: randomUUID, workerRevision: 'wp338i-test',
      log: (_level, entry) => { logs.push(entry); }, onAuthorizationFailure: () => {},
    });
    return { fake, ledger, logs, runner, tick: emptyMcfTickCounts(), counts: emptyMcfCancelCounts() };
  }

  it('preview: one read, a cancel preview from it (Received), and no request', async () => {
    const s = setup();
    await s.runner.run(cancelClaim('preview', now), s.tick, s.counts);
    expect(s.fake.operations).toEqual(['get']);
    expect(s.ledger.calls).toEqual(['recordCancelPreview']);
    expect(s.ledger.previews[0]).toMatchObject({ kind: 'cancel_preview', existingOrder: { status: 'Received' }, totalUnits: 1,
      items: [{ sellerSku: SKU, sellerFulfillmentOrderItemId: `${KEY}-1`, quantity: 1 }] });
    expect(s.counts).toMatchObject({ claimed: 1, previewed: 1, amazonCancels: 0 });
    assertMcfCancelCounts(s.counts);
  });

  it('preview: Processing is recorded without a preview', async () => {
    const s = setup({ status: 'Processing' });
    await s.runner.run(cancelClaim('preview', now), s.tick, s.counts);
    expect(s.ledger.previews).toEqual([null]);
    expect(s.counts).toMatchObject({ claimed: 1, previewRefused: 1 });
    expect(s.fake.cancels).toBe(0);
  });

  it('execute: re-reads, then reserves with that read, then sends exactly one request, then records its answer', async () => {
    const s = setup();
    await s.runner.run(cancelClaim('execute', now), s.tick, s.counts);
    expect(s.fake.operations).toEqual(['get', 'cancel']);
    expect(s.ledger.calls).toEqual(['reserveCancel', 'recordCancelOutcome']);
    expect(s.ledger.lookups[0]).toMatchObject({ outcome: 'found', status: 'Received' });
    expect(s.ledger.outcomes).toEqual([{ outcome: 'accepted', status: 200 }]);
    expect(s.fake.requests.find((request) => request.operation === 'cancel')).toMatchObject({ method: 'PUT', body: null,
      path: ['', 'fba', 'outbound', '2020-07-01', 'fulfillmentOrders', KEY, 'cancel'].join('/') });
    expect(s.counts).toMatchObject({ claimed: 1, reserved: 1, amazonCancels: 1, accepted: 1, withheld: 0 });
    assertMcfCancelCounts(s.counts);
  });

  it('execute: a refused or already-held reservation sends nothing', async () => {
    for (const reservation of [{ decision: 'refused', reason: 'cancel_refused', ending: 'status_processing', orderStatus: 'Processing', state: 'placed' },
      { decision: 'already_reserved', state: 'cancel_dispatching' }, { decision: 'refused', reason: 'lease', state: 'placed' }] as const) {
      const s = setup();
      s.ledger.reservation = reservation as CreatorMcfCancelReservation;
      await s.runner.run(cancelClaim('execute', now), s.tick, s.counts);
      expect(s.fake.cancels).toBe(0);
      expect(s.ledger.calls).toEqual(['reserveCancel']);
      expect(s.counts).toMatchObject(reservation.decision === 'refused' && reservation.reason === 'cancel_refused' ? { refused: 1 } : { deferred: 1 });
      assertMcfCancelCounts(s.counts);
    }
  });

  it('execute: the dispatch flag turned off before the reservation, or at the request, stops it; after a reservation it is recorded as unsent', async () => {
    let dispatch = true;
    const before = setup({ dispatch: () => dispatch });
    before.fake.onRequest = () => { dispatch = false; };
    await before.runner.run(cancelClaim('execute', now), before.tick, before.counts);
    expect(before.ledger.calls).toEqual(['releaseClaim']);
    expect(before.counts).toMatchObject({ deferred: 1, reserved: 0 });
    expect(before.fake.cancels).toBe(0);

    let open = true;
    const after = setup({ dispatch: () => open });
    after.ledger.reserveCancel = async function (this: ScriptedCancelLedger, sendId, leaseId, lookup, digest) {
      const answer = await ScriptedCancelLedger.prototype.reserveCancel.call(this, sendId, leaseId, lookup, digest);
      open = false;
      return answer;
    };
    await after.runner.run(cancelClaim('execute', now), after.tick, after.counts);
    expect(after.fake.cancels).toBe(0);
    expect(after.ledger.outcomes).toEqual([]);
    expect(after.ledger.unsent).toEqual(['policy_off']);
    expect(after.counts).toMatchObject({ reserved: 1, withheld: 1, unsent: 1, uncertain: 0, amazonCancels: 0 });
    assertMcfCancelCounts(after.counts);

    const stopping = setup({ stopping: () => true });
    await stopping.runner.run(cancelClaim('execute', now), stopping.tick, stopping.counts);
    expect(stopping.fake.cancels).toBe(0);
    expect(stopping.ledger.unsent).toEqual(['stopping']);
    expect(stopping.counts).toMatchObject({ reserved: 1, withheld: 1, unsent: 1 });
  });

  it('execute: a writer failure other than no-token or bad-input may follow the request, so it is recorded as uncertain, never as unsent', async () => {
    const s = setup({ throwAfterCancel: true });
    await s.runner.run(cancelClaim('execute', now), s.tick, s.counts);
    expect(s.fake.cancels).toBe(1);
    expect(s.ledger.unsent).toEqual([]);
    expect(s.ledger.outcomes).toEqual([{ outcome: 'uncertain', cause: 'decode', status: null }]);
    expect(s.counts).toMatchObject({ reserved: 1, amazonCancels: 1, withheld: 0, uncertain: 1, unsent: 0 });
    assertMcfCancelCounts(s.counts);
  });

  it('execute: a reservation whose answer is lost is released and never followed by a request', async () => {
    const s = setup();
    s.ledger.reserveFails = true;
    await s.runner.run(cancelClaim('execute', now), s.tick, s.counts);
    expect(s.fake.operations).toEqual(['get']);
    expect(s.fake.cancels).toBe(0);
    expect(s.ledger.calls).toEqual(['reserveCancel', 'releaseClaim']);
    expect(s.counts).toMatchObject({ claimed: 1, deferred: 1, reserved: 0, amazonCancels: 0 });
    assertMcfCancelCounts(s.counts);
  });

  it('execute: without an access token the re-read defers; a token lost after the reservation means no request, recorded as unsent', async () => {
    const none = setup({ tokens: { getAccessToken: async () => { throw new FulfillmentOutboundError('authentication'); } } });
    await none.runner.run(cancelClaim('execute', now), none.tick, none.counts);
    expect(none.ledger.calls).toEqual(['releaseClaim']);
    expect(none.counts).toMatchObject({ deferred: 1, reserved: 0 });
    expect(none.fake.requests).toEqual([]);
    // The re-read gets a token; the request does not, so it never leaves.
    let asked = 0;
    const lost = setup({ tokens: { getAccessToken: async () => {
      asked += 1;
      if (asked > 1) throw new FulfillmentOutboundError('authentication');
      return ['synthetic', 'access', 'value'].join('-');
    } } });
    await lost.runner.run(cancelClaim('execute', now), lost.tick, lost.counts);
    expect(lost.fake.operations).toEqual(['get']);
    expect(lost.fake.cancels).toBe(0);
    expect(lost.ledger.unsent).toEqual(['token_unavailable']);
    expect(lost.counts).toMatchObject({ reserved: 1, withheld: 1, unsent: 1, amazonCancels: 0 });
    assertMcfCancelCounts(lost.counts);
  });

  it('execute: an answer the ledger cannot take is kept in memory and recorded late, without a second request', async () => {
    const s = setup();
    s.ledger.outcomeFailures = 3;
    await s.runner.run(cancelClaim('execute', now), s.tick, s.counts);
    expect(s.fake.cancels).toBe(1);
    expect(s.counts).toMatchObject({ reserved: 1, amazonCancels: 1, outcomePending: 1, accepted: 0 });
    assertMcfCancelCounts(s.counts);
    expect(s.runner.pendingOutcomes()).toBe(1);
    const next = emptyMcfCancelCounts();
    await s.runner.retryPending(next);
    expect(next.lateRecorded).toBe(1);
    expect(s.runner.pendingOutcomes()).toBe(0);
    expect(s.ledger.outcomes).toEqual([{ outcome: 'accepted', status: 200 }]);
    expect(s.fake.cancels).toBe(1);
  });

  it('execute: a 4xx is followed by a read, and without one it is recorded as uncertain', async () => {
    const s = setup();
    s.fake.cancelAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'] }];
    await s.runner.run(cancelClaim('execute', now), s.tick, s.counts);
    expect(s.fake.operations).toEqual(['get', 'cancel', 'get']);
    expect(s.ledger.outcomes).toEqual([{ outcome: 'rejected', status: 400, codes: ['InvalidInput'], reason: 'validation' }]);
    // The read after the 4xx fails: a refusal without its read proves nothing, so it is recorded as unknown.
    const t = setup();
    t.fake.cancelAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'] }];
    t.fake.onRequest = (request) => { if (request.operation === 'cancel') t.fake.readFailures = [{ kind: 'transport' }]; };
    await t.runner.run(cancelClaim('execute', now), t.tick, t.counts);
    expect(t.fake.cancels).toBe(1);
    expect(t.ledger.outcomes).toEqual([{ outcome: 'uncertain', cause: 'decode', status: 400 }]);
  });

  it('counts: every invariant is named when it breaks', () => {
    const counts: McfCancelCounts = { ...emptyMcfCancelCounts(), claimed: 2, reserved: 1, amazonCancels: 1 };
    expect(() => assertMcfCancelCounts(counts)).toThrow(McfCountsError);
    try { assertMcfCancelCounts(counts); } catch (error) {
      expect((error as McfCountsError).broken).toEqual(['cancel.claimed = previewed + previewRefused + refused + deferred + reserved',
        'cancel.reserved = accepted + rejected + uncertain + unsent + outcomePending']);
    }
  });

  it('pure pieces: the preview refuses what it cannot describe; the digest is fixed and address-free', async () => {
    const claim = cancelClaim('preview', now);
    const read = (change: Partial<Extract<CreatorMcfOrderRead, { outcome: 'found' }>>): CreatorMcfOrderRead => ({ outcome: 'found',
      operation: 'getFulfillmentOrder', status: 'Planning', readAt: now.toISOString(), sellerFulfillmentOrderId: KEY,
      items: [{ sellerSku: SKU, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }], shipments: [], packages: [], ...change });
    expect(mcfCancelPreviewBody({ claim, lookup: read({}), previewId: randomUUID(), workerRevision: 'r' })).toMatchObject({ existingOrder: { status: 'Planning' },
      validUntil: new Date(now.getTime() + 5 * 60_000).toISOString() });
    for (const change of [{ status: 'New' as const }, { status: 'Processing' as const }, { status: 'Cancelled' as const },
      { items: [{ sellerSku: SKU, quantity: 0, cancelledQuantity: 0, unfulfillableQuantity: 0 }] },
      { items: Array.from({ length: 21 }, () => ({ sellerSku: SKU, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 })) }]) {
      expect(mcfCancelPreviewBody({ claim, lookup: read(change), previewId: randomUUID(), workerRevision: 'r' })).toBeNull();
    }
    expect(mcfCancelPreviewBody({ claim, lookup: { outcome: 'not_found', operation: 'getFulfillmentOrder', readAt: now.toISOString() },
      previewId: randomUUID(), workerRevision: 'r' })).toBeNull();
    const digest = await mcfCancelRequestDigest({ marketplaceId: US, derivedOrderKey: KEY });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await mcfCancelRequestDigest({ marketplaceId: US, derivedOrderKey: KEY })).toBe(digest);
    expect(await mcfCancelRequestDigest({ marketplaceId: US, derivedOrderKey: `CCS-${hex(16)}` })).not.toBe(digest);
  });

  it('the policy offers cancel work only under the dispatch flag (the loop without a cancel store is part two)', () => {
    expect(mcfClaimableActions({ previewEnabled: true, dispatchEnabled: false, scope: [`${randomUUID()}:${US}`] })).not.toContain('cancel');
    expect(mcfClaimableActions({ previewEnabled: false, dispatchEnabled: true, scope: [`${randomUUID()}:${US}`] })).toContain('cancel');
  });
});

// ===========================================================================
// Part two: the real loop, the real ledger and the fake provider.
// ===========================================================================

const available = await databaseAvailable();
const OWNER = randomUUID();

interface KeyPair { der: Buffer; jwk: Record<string, unknown>; keyId: string }
async function keyPair(): Promise<KeyPair> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const jwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  return { der: pair.privateKey.export({ format: 'der', type: 'pkcs8' }), jwk, keyId: await creatorMcfRecipientKeyId(jwk) };
}
function canaryRecipient(): CreatorMcfRecipient {
  return { name: token('Qzname'), addressLine1: `${token('Qzstreet')} 12`, addressLine2: token('Qzunit'), city: token('Qzcity'),
    stateOrRegion: token('Qzstate'), postalCode: `QZ${hex(6).toUpperCase()}`, countryCode: 'US' };
}

interface Org { id: string; connection: string; marketplace: string; scope: string }
interface Lane { org: Org; record: string; asin: string; key: string; reservation: string; sku: string }

describe.skipIf(!available)('the guarded cancel against the real ledger', () => {
  let db: TestDatabase;
  let dir: string;
  let key: KeyPair;
  let recordNumber = 5000;

  beforeAll(async () => {
    db = await createTestDatabase('wp338i_mcf_cancel');
    dir = await mkdtemp(join(tmpdir(), 'wp338i-ledger-keys-'));
    key = await keyPair();
    await writeFile(join(dir, mcfRecipientCredentialName(key.keyId)), key.der);
  }, 240_000);
  afterAll(async () => {
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    if (!db) return;
    await db.sql`update public.creator_mcf_outbox set completed_at = now() where completed_at is null`;
  });

  async function newOrg(actions: string[] = ['send', 'cancel']): Promise<Org> {
    const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`mcf-cancel-${hex(3)}`}, ${OWNER}, 'owner') as id`;
    const id = row!.id;
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = gen_random_uuid() where org_id = ${id}`);
    await db.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${id}`;
    const [binding] = await db.sql<{ connection_id: string; marketplace_id: string }[]>`select connection_id, marketplace_id
      from public.spapi_profile_bindings where org_id = ${id}`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids,
        max_units_per_day, max_fee_minor, currency, enabled_by, expires_at)
      values (${id}, ${binding!.connection_id}, ${binding!.marketplace_id}, ${actions}::text[], ${[key.keyId]}::text[],
        20, 1500, 'USD', 'synthetic operator', now() + interval '30 days')`;
    return { id, connection: binding!.connection_id, marketplace: binding!.marketplace_id, scope: `${binding!.connection_id}:${binding!.marketplace_id}` };
  }

  async function newLane(org: Org): Promise<Lane> {
    const record = `CCR-SW-26-${recordNumber++}`;
    const asin = `B0${hex(4).toUpperCase()}`;
    const reservation = `MCFR-${hex(8).toUpperCase()}`;
    const sku = `SYN-${hex(3).toUpperCase()}`;
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, thread_fp, record_state, lock_state,
        runner_version, created_on, source, source_digest)
      values (${org.id}, ${record}, 'Synthetic brand', 'campaign-synthetic-1', ${hex(32)}, 'Active', 'Unlocked', 1, '2026-09-01', 'control-runner', ${hex(32)})`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state,
        fee_cents, fee_cap_cents, reserved_at, source, source_digest)
      values (${org.id}, ${record}, ${asin}, ${sku}, 'campaign-synthetic-1', ${reservation}, 'Reserved', 620, 800, now() - interval '10 minutes',
        'control-runner', ${hex(32)})`;
    await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, result, errors,
        required_next_state, detail, started_at, completed_at, source, source_digest)
      values (${org.id}, ${`preflight-${hex(6)}`}, 'preflight', ${record}, ${asin}, 'PASS', ${[]}::text[], 'Locked for MCF',
        ${JSON.stringify({ sku, quantity: 1 })}::jsonb, date_trunc('milliseconds', now()) - interval '65 seconds',
        date_trunc('milliseconds', now()) - interval '60 seconds', 'mcp', ${hex(32)})`;
    return { org, record, asin, key: creatorSampleOrderKey(org.id, record, asin), reservation, sku };
  }

  /** A lane with a sealed send, and a loop over the fake provider with the cancel store. Flags start with previews on only. */
  async function run(options: { wrap?: (store: McfCancelStore) => McfCancelStore; withCancel?: boolean; actions?: string[] } = {}) {
    const org = await newOrg(options.actions);
    const lane = await newLane(org);
    const recipient = canaryRecipient();
    const binding = { orgId: org.id, creatorRecordId: lane.record, asin: lane.asin, derivedOrderKey: lane.key, reservationId: lane.reservation } as CreatorMcfRecipientBinding;
    const envelope = await sealCreatorMcfRecipient(key.jwk, key.keyId, binding, recipient);
    const sealed = await sealInLedger(db, { orgId: org.id, userId: OWNER }, { creatorRecordId: lane.record, asin: lane.asin, request: { binding, envelope } });
    if (sealed.outcome !== 'sealed') throw new Error(`seal refused: ${sealed.reason}`);
    const fake = new FakeFulfillmentOutbound();
    const flags = { preview: true, dispatch: false };
    const logs: string[] = [];
    const thrown: string[] = [];
    const cancelStore = options.wrap?.(postgresMcfCancelStore(db)) ?? postgresMcfCancelStore(db);
    const loop = new McfSendLoop({ store: postgresMcfSendStore(db), ...(options.withCancel === false ? {} : { cancelStore }), amazon: amazonOver(fake),
      keys: credentialDirectoryKeySource(dir), policy: () => ({ previewEnabled: flags.preview, dispatchEnabled: flags.dispatch, scope: [org.scope] }),
      workerId: 'wp338i-ledger-test', workerRevision: 'wp338i', sleep: async () => {},
      log: (level, entry) => { logs.push(mcfLogLine(level, entry, new Date())); } });
    const cancelLogs = () => logs.filter((line) => line.includes('"event":"mcf_cancel"')).map((line) => JSON.parse(line) as { counts: McfCancelCounts });
    const tick = async () => {
      try { return await loop.tick(); } catch (error) { thrown.push(error instanceof Error ? error.message : String(error)); return null; }
    };
    return { org, lane, recipient, sendId: sealed.sendId, fake, flags, logs, thrown, loop, tick, cancelLogs };
  }
  type Run = Awaited<ReturnType<typeof run>>;

  async function send(sendId: string) {
    const [row] = await db.sql<{ state: string; state_reason: string | null; posts: number; amazon_status: string | null; escalation_reason: string | null }[]>`
      select state, state_reason, posts, amazon_status, escalation_reason from public.creator_mcf_sends where id = ${sendId}`;
    return row!;
  }
  async function laneRow(l: Lane) {
    const [row] = await db.sql<{ lane_state: string; cancellation_reason: string | null; order_owner: string }[]>`select lane_state, cancellation_reason,
      order_owner from public.creator_sample_shipments where org_id = ${l.org.id} and creator_record_id = ${l.record} and asin = ${l.asin}`;
    return row!;
  }
  async function cancels(sendId: string) {
    return db.sql<{ puts: number; provider_outcome: string | null; ending: string | null; ending_reason: string | null }[]>`select puts, provider_outcome,
      ending, ending_reason from app.creator_mcf_cancels where send_id = ${sendId} order by approved_at`;
  }
  async function settleNow(sendId: string) {
    await db.sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${sendId} and action = 'settle' and completed_at is null`;
  }
  async function rows(orgId: string): Promise<string[]> {
    const found = await db.sql<{ row: string }[]>`
      select row_to_json(s)::text as row from public.creator_mcf_sends s where s.org_id = ${orgId}
      union all select row_to_json(p)::text from public.creator_mcf_send_previews p where p.org_id = ${orgId}
      union all select row_to_json(e)::text from public.creator_mcf_send_events e where e.org_id = ${orgId}
      union all select row_to_json(c)::text from app.creator_mcf_cancels c where c.org_id = ${orgId}
      union all select row_to_json(x)::text from public.creator_mcf_observations x where x.org_id = ${orgId}`;
    return found.map((entry) => entry.row);
  }
  function assertNoCanary(r: Run, sinks: Record<string, unknown>) {
    const canaries = Object.values(r.recipient).filter((value) => value.length >= 6);
    for (const [sink, value] of Object.entries(sinks)) {
      const text = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase();
      for (const canary of canaries) expect(text.includes(canary.toLowerCase()), `${sink} holds a recipient value`).toBe(false);
    }
  }

  /** Seal, preview, approve, one POST, and a read: the send is placed (or conflict, when Amazon already holds another SKU under the key). */
  async function placed(r: Run, existing?: { sku: string }) {
    expect((await r.tick())?.send.previewed).toBe(1);
    const [preview] = await db.sql<{ id: string; fingerprint: string; total_units: number }[]>`select id, fingerprint, total_units
      from public.creator_mcf_send_previews where send_id = ${r.sendId} and kind = 'preview' order by recorded_at desc limit 1`;
    expect((await approveCreatorMcfSend(db, { orgId: r.org.id, userId: OWNER }, { sendId: r.sendId, previewId: preview!.id,
      previewFingerprint: preview!.fingerprint, totalUnits: 1, confirmation: creatorMcfSendConfirmation(preview!.total_units), requestId: randomUUID() })).outcome)
      .toBe('approved');
    r.flags.dispatch = true;
    if (existing !== undefined) r.fake.seedOrder({ sellerFulfillmentOrderId: r.lane.key, status: 'Received', sellerSku: existing.sku, quantity: 1 });
    await r.tick();
    if (existing === undefined) {
      await settleNow(r.sendId);
      await r.tick();
      expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    } else {
      expect(await send(r.sendId)).toMatchObject({ state: 'conflict' });
    }
  }

  const actor = (r: Run) => ({ orgId: r.org.id, userId: OWNER });

  /** "Cancel in Amazon", the worker's preview tick, and "Cancel 1 order in Amazon" on the preview it recorded. */
  async function approvedCancel(r: Run) {
    expect(await requestCreatorMcfCancelPreview(db, actor(r), r.sendId)).toMatchObject({ outcome: 'cancel_preview_requested' });
    await r.tick();
    const view = await readCreatorMcfLane(db, actor(r), r.lane.record, r.lane.asin);
    const preview = view!.send!.latestCancelPreview;
    expect(preview).not.toBeNull();
    const approval = await approveCreatorMcfCancel(db, actor(r), { sendId: r.sendId, previewId: preview!.previewId, previewFingerprint: preview!.fingerprint,
      confirmation: creatorMcfCancelConfirmation(1), requestId: randomUUID() });
    expect(approval).toMatchObject({ outcome: 'cancel_approved' });
  }

  it('happy path: a read for the preview, a re-read before the request, exactly one request, then a read settles it as Cancelled', async () => {
    const r = await run();
    await placed(r);
    const creates = r.fake.posts;
    await approvedCancel(r);
    expect(r.fake.cancels).toBe(0);
    const before = r.fake.operations.length;
    await r.tick();
    expect(r.fake.operations.slice(before)).toEqual(['get', 'cancel']);
    expect(r.fake.cancels).toBe(1);
    expect(await send(r.sendId)).toMatchObject({ state: 'cancel_dispatching' });
    // The fake cancelled it; the ledger waits for a read that says so.
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled', state_reason: 'operator_cancelled_in_amazon', amazon_status: 'Cancelled' });
    expect(await laneRow(r.lane)).toEqual({ lane_state: 'Cancelled', cancellation_reason: 'operator_cancelled_in_amazon', order_owner: 'arcana' });
    expect(await cancels(r.sendId)).toEqual([{ puts: 1, provider_outcome: 'accepted', ending: 'cancelled', ending_reason: 'operator_cancelled_in_amazon' }]);
    for (let index = 0; index < 3; index += 1) await r.tick();
    expect(r.fake.cancels).toBe(1);
    expect(r.fake.posts).toBe(creates);
    const counted = r.cancelLogs().map((line) => line.counts);
    expect(counted.reduce((sum, c) => sum + c.amazonCancels, 0)).toBe(1);
    expect(counted.reduce((sum, c) => sum + c.previewed, 0)).toBe(1);
    expect(r.thrown).toEqual([]);
    const [custody] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${r.sendId}`;
    expect(custody!.n).toBe(0);
    assertNoCanary(r, { logs: r.logs, rows: await rows(r.org.id) });
  });

  it('the re-read shows Processing: cancel_refused, no request, the send stays placed', async () => {
    const r = await run();
    await placed(r);
    await approvedCancel(r);
    r.fake.orders.get(r.lane.key)!.status = 'Processing';
    await r.tick();
    expect(r.fake.cancels).toBe(0);
    expect(await send(r.sendId)).toMatchObject({ state: 'placed', amazon_status: 'Processing' });
    expect(await cancels(r.sendId)).toEqual([{ puts: 0, provider_outcome: null, ending: 'refused', ending_reason: 'status_processing' }]);
    expect(r.cancelLogs().at(-1)?.counts).toMatchObject({ claimed: 1, refused: 1, reserved: 0 });
  });

  it('an ambiguous request (5xx) is settled by reads and never sent again', async () => {
    const r = await run();
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'http', status: 503, cancels: false }];
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    expect(await send(r.sendId)).toMatchObject({ state: 'cancel_dispatching' });
    expect(await cancels(r.sendId)).toMatchObject([{ puts: 1, provider_outcome: 'uncertain', ending: null }]);
    for (let index = 0; index < 3; index += 1) {
      await settleNow(r.sendId);
      await r.tick();
    }
    expect(await send(r.sendId)).toMatchObject({ state: 'cancel_dispatching', amazon_status: 'Received' });
    // Amazon did cancel after all; the next read settles it. Still one request.
    r.fake.orders.get(r.lane.key)!.status = 'Cancelled';
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled' });
    expect(r.fake.cancels).toBe(1);
  });

  it('a lost answer (transport) whose order then goes to Processing ends placed, not honoured, with one request', async () => {
    const r = await run();
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'transport', cancels: false }];
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    r.fake.orders.get(r.lane.key)!.status = 'Processing';
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed', amazon_status: 'Processing' });
    expect(await cancels(r.sendId)).toEqual([{ puts: 1, provider_outcome: 'uncertain', ending: 'not_honoured', ending_reason: 'processing' }]);
    expect(await laneRow(r.lane)).toMatchObject({ lane_state: 'Confirmed' });
    expect(r.fake.cancels).toBe(1);
  });

  it('a throttled request (429) from placed ends not_sent and the send is placed again; a new press can then cancel it, one request per press', async () => {
    const r = await run();
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'http', status: 429, codes: ['QuotaExceeded'] }];
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    expect(await cancels(r.sendId)).toEqual([{ puts: 1, provider_outcome: 'rejected', ending: 'not_sent', ending_reason: 'rejected_throttled' }]);
    await approvedCancel(r);
    await r.tick();
    expect(r.fake.cancels).toBe(2);
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled' });
    expect((await cancels(r.sendId)).map((row) => [row.puts, row.ending])).toEqual([[1, 'not_sent'], [1, 'cancelled']]);
  });

  it('a request withheld after its reservation (the flag turned off) is recorded as not sent; nothing reached Amazon', async () => {
    let flip: (() => void) | null = null;
    const r = await run({ wrap: (store) => ({ ...store, reserveCancel: async (...args) => {
      const answer = await store.reserveCancel(...args);
      flip?.();
      return answer;
    } }) });
    await placed(r);
    await approvedCancel(r);
    flip = () => { r.flags.dispatch = false; };
    await r.tick();
    expect(r.fake.cancels).toBe(0);
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    expect(await cancels(r.sendId)).toEqual([{ puts: 1, provider_outcome: null, ending: 'not_sent', ending_reason: 'policy_off' }]);
    expect(r.cancelLogs().at(-1)?.counts).toMatchObject({ reserved: 1, withheld: 1, unsent: 1, amazonCancels: 0 });
  });

  it('a 4xx is followed by a read; the refusal is recorded with its codes only and the send waits for a settling read', async () => {
    const r = await run();
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'] }];
    const before = r.fake.operations.length;
    await r.tick();
    expect(r.fake.operations.slice(before)).toEqual(['get', 'cancel', 'get']);
    expect(await cancels(r.sendId)).toMatchObject([{ puts: 1, provider_outcome: 'rejected', ending: null }]);
    expect(await send(r.sendId)).toMatchObject({ state: 'cancel_dispatching' });
    assertNoCanary(r, { logs: r.logs, rows: await rows(r.org.id) });
  });

  it('the dispatch flag turned off during the re-read stops the request; turned on again, one request follows', async () => {
    const r = await run();
    await placed(r);
    await approvedCancel(r);
    r.fake.onRequest = (request) => { if (request.operation === 'get') r.flags.dispatch = false; };
    await r.tick();
    r.fake.onRequest = undefined;
    expect(r.fake.cancels).toBe(0);
    expect(await cancels(r.sendId)).toMatchObject([{ puts: 0, ending: null }]);
    await r.tick();
    expect(r.fake.cancels).toBe(0);
    r.flags.dispatch = true;
    await db.sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${r.sendId} and action = 'cancel' and completed_at is null`;
    await r.tick();
    expect(r.fake.cancels).toBe(1);
  });

  it('an answer the ledger cannot take stays in memory; the read queued at the reservation settles the send; the answer lands late; one request', async () => {
    let reachable = false;
    const r = await run({ wrap: (store) => ({ ...store, recordCancelOutcome: async (...args) => {
      if (!reachable) throw new Error('ledger unreachable');
      return store.recordCancelOutcome(...args);
    } }) });
    await placed(r);
    await approvedCancel(r);
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    expect(r.loop.pendingOutcomes()).toBe(1);
    expect(r.cancelLogs().at(-1)?.counts).toMatchObject({ reserved: 1, amazonCancels: 1, outcomePending: 1 });
    expect(await cancels(r.sendId)).toMatchObject([{ puts: 1, provider_outcome: null }]);
    // No cancel work is left to claim: the reservation completed it.
    expect(await db.sql`select 1 from public.creator_mcf_outbox where send_id = ${r.sendId} and action = 'cancel' and completed_at is null`).toHaveLength(0);
    const [queued] = await db.sql<{ due: boolean }[]>`select available_at > now() + interval '100 seconds' as due from public.creator_mcf_outbox
      where send_id = ${r.sendId} and action = 'settle' and completed_at is null`;
    expect(queued!.due).toBe(true);
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled' });
    reachable = true;
    await r.tick();
    expect(r.loop.pendingOutcomes()).toBe(0);
    expect(await cancels(r.sendId)).toMatchObject([{ puts: 1, provider_outcome: 'accepted', ending: 'cancelled' }]);
    const [late] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events where send_id = ${r.sendId}
      and event = 'cancel_late_outcome'`;
    expect(late!.n).toBe(1);
    expect(r.fake.cancels).toBe(1);
  });

  it('cancels from conflict while Received; a conflict still New gets no preview and no request', async () => {
    const r = await run();
    await placed(r, { sku: 'OTHER-SKU' });
    await approvedCancel(r);
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled', escalation_reason: 'conflict' });
    expect(await laneRow(r.lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'operator_cancelled_in_amazon' });

    const n = await run();
    await placed(n, { sku: 'OTHER-SKU' });
    n.fake.orders.get(n.lane.key)!.status = 'New';
    expect(await requestCreatorMcfCancelPreview(db, actor(n), n.sendId)).toMatchObject({ outcome: 'cancel_preview_requested' });
    await n.tick();
    const view = await readCreatorMcfLane(db, actor(n), n.lane.record, n.lane.asin);
    expect(view!.send).toMatchObject({ state: 'conflict', latestCancelPreview: null, cancelPreviewRefusal: { reason: 'status_new' } });
    expect(n.fake.cancels).toBe(0);
  });

  it('without the dispatch flag, without a cancel store or without the grant class, no cancel work is claimed', async () => {
    const off = await run();
    await placed(off);
    off.flags.dispatch = false;
    await requestCreatorMcfCancelPreview(db, actor(off), off.sendId);
    const reads = off.fake.reads;
    await off.tick();
    expect(off.fake.reads).toBe(reads);
    expect(off.cancelLogs()).toEqual([]);

    const bare = await run({ withCancel: false });
    await placed(bare);
    await requestCreatorMcfCancelPreview(db, actor(bare), bare.sendId);
    const bareReads = bare.fake.reads;
    await bare.tick();
    expect(bare.fake.reads).toBe(bareReads);

    const sendOnly = await run({ actions: ['send'] });
    await placed(sendOnly);
    expect(await requestCreatorMcfCancelPreview(db, actor(sendOnly), sendOnly.sendId)).toEqual({ outcome: 'refused', reason: 'cancel_grant_inactive' });
  });
});
