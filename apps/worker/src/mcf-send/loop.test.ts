/**
 * The MCF unit's loop (WP-338e). Part one drives the loop against a scripted
 * ledger to prove the order of steps, the policy re-checks between them, the
 * single POST after a reservation and what happens when the ledger or the
 * token fails. Part two drives it against the real WP-338d ledger (a migrated
 * test database) and the fake Fulfillment Outbound provider, one path per
 * acceptance line, each with its exact POST count.
 *
 * Synthetic data only: keys, ids and the recipient's unique tokens are made at
 * run time. The fake echoes the recipient back in its answers; nothing of it
 * may reach a log line, a thrown message, a ledger argument or a table row.
 */
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveCreatorMcfSend, sealCreatorMcfRecipient as sealInLedger, creatorSampleOrderKey } from '@wizard-ads/db';
import type { CreatorMcfClaim, CreatorMcfHeartbeat, CreatorMcfOrderRead, CreatorMcfReservation, CreatorMcfWorkerDecision } from '@wizard-ads/db/worker';
import { asServiceRole, createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import {
  creatorMcfEnvelopeSha256, creatorMcfRecipientKeyId, creatorMcfSendConfirmation, sealCreatorMcfRecipient, type CreatorMcfPreview,
  type CreatorMcfProviderOutcome, type CreatorMcfRecipient, type CreatorMcfRecipientBinding, type CreatorMcfSealedRecipient,
} from '@wizard-ads/shared';
import { FulfillmentOutboundReader, FulfillmentOutboundWriter, type SpApiAccessTokenProvider } from '@wizard-ads/sp-api';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { marketplaceIdForCountry } from '../marketplaces.js';
import { FakeFulfillmentOutbound, type FakeRequest } from '../testing/fake-fulfillment-outbound.js';
import type { McfTickCounts } from './counts.js';
import { credentialDirectoryKeySource, mcfRecipientCredentialName, type McfCustodyRead } from './custody.js';
import {
  McfSendLoop, mcfArrivalDate, mcfLogLine, mcfPreviewBody, mcfRequestDigest, postgresMcfSendStore, type McfAmazonFactory, type McfLogEntry,
  type McfSendStore,
} from './loop.js';
import type { McfSendPolicy } from './policy.js';

const US = marketplaceIdForCountry('US')!;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const token = (label: string) => `${label}${hex(4)}`;
const ENDPOINT = 'https://fake-sp-api.invalid';

interface KeyPair { der: Buffer; jwk: Record<string, unknown>; keyId: string }
async function keyPair(): Promise<KeyPair> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const jwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  return { der: pair.privateKey.export({ format: 'der', type: 'pkcs8' }), jwk, keyId: await creatorMcfRecipientKeyId(jwk) };
}

function canaryRecipient(country: 'US' | 'CA' = 'US'): CreatorMcfRecipient {
  return country === 'US'
    ? { name: token('Qzname'), addressLine1: `${token('Qzstreet')} 12`, addressLine2: token('Qzunit'), city: token('Qzcity'),
      stateOrRegion: token('Qzstate'), postalCode: `QZ${hex(6).toUpperCase()}`, countryCode: 'US' }
    : { name: token('Qzname'), addressLine1: `${token('Qzstreet')} 9`, city: token('Qzcity'), postalCode: `QZ${hex(6).toUpperCase()}`, countryCode: 'CA' };
}
/** The recipient's tokens (every field long enough to be unique). */
const canaries = (recipient: CreatorMcfRecipient): string[] => Object.values(recipient).filter((value) => value.length >= 6);

/** Every place a recipient value must never appear. */
function assertNoCanary(recipient: CreatorMcfRecipient, sinks: Record<string, unknown>): void {
  for (const [sink, value] of Object.entries(sinks)) {
    const text = (typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase();
    for (const canary of canaries(recipient)) {
      const found = text.includes(canary.toLowerCase()) || text.includes(Buffer.from(canary).toString('base64').toLowerCase());
      expect(found, `${sink} holds a recipient value`).toBe(false);
    }
  }
}

function fakeTime(start = Date.parse('2026-09-28T12:00:00Z')) {
  const time = { now: start };
  return { time, monotonic: () => time.now, clock: () => new Date(time.now), sleep: async (ms: number) => { time.now += ms; } };
}

function amazonOver(fake: FakeFulfillmentOutbound, tokens: SpApiAccessTokenProvider = FakeFulfillmentOutbound.tokens()): McfAmazonFactory {
  return () => ({
    reader: new FulfillmentOutboundReader({ endpoint: ENDPOINT, accessTokenProvider: tokens, userAgent: 'wp338e-test', fetch: fake.fetch }),
    writer: new FulfillmentOutboundWriter({ endpoint: ENDPOINT, accessTokenProvider: tokens, userAgent: 'wp338e-test', fetch: fake.fetch }),
  });
}

// ===========================================================================
// Part one: a scripted ledger.
// ===========================================================================

interface Fixture {
  dir: string;
  key: KeyPair;
  recipient: CreatorMcfRecipient;
  binding: CreatorMcfRecipientBinding;
  envelope: CreatorMcfSealedRecipient;
  sha: string;
  connection: string;
  sku: string;
}

async function fixture(dir: string, key: KeyPair): Promise<Fixture> {
  const binding = { orgId: randomUUID(), creatorRecordId: `CCR-SW-26-${2000 + Math.floor(Math.random() * 7999)}`, asin: `B0${hex(4).toUpperCase()}`,
    derivedOrderKey: `CCS-${hex(16)}`, reservationId: `MCFR-${hex(8).toUpperCase()}` } as CreatorMcfRecipientBinding;
  const recipient = canaryRecipient();
  const envelope = await sealCreatorMcfRecipient(key.jwk, key.keyId, binding, recipient);
  return { dir, key, recipient, binding, envelope, sha: await creatorMcfEnvelopeSha256(envelope), connection: randomUUID(), sku: `SYN-${hex(3).toUpperCase()}` };
}

function baseClaim(fx: Fixture, action: 'preview' | 'dispatch', now: Date): CreatorMcfClaim {
  return {
    outboxId: randomUUID(), action, leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + 120_000).toISOString(), attempts: 1,
    sendId: randomUUID(), orgId: fx.binding.orgId, state: action === 'preview' ? 'previewing' : 'approved', binding: fx.binding, sku: fx.sku,
    spapiConnectionId: fx.connection, marketplaceId: US, keyId: fx.key.keyId, envelopeId: fx.envelope.envelopeId, envelopeSha256: fx.sha,
    mask: fx.envelope.mask, preflight: { id: randomUUID(), runId: 'preflight-synthetic', completedAt: new Date(now.getTime() - 60_000).toISOString() },
    caps: { laneFeeCapMinor: 800, grantFeeCapMinor: 1500, grantCurrency: 'USD' }, approval: null, settle: null,
  };
}

/** A dispatch claim whose approved preview is the fake's default answer. */
async function dispatchClaim(fx: Fixture, now: Date): Promise<CreatorMcfClaim> {
  const claim = baseClaim(fx, 'dispatch', now);
  const evidence = await amazonOver(new FakeFulfillmentOutbound())(claim).writer.preview({ marketplaceId: US,
    derivedOrderKey: fx.binding.derivedOrderKey, sellerSku: fx.sku, recipient: fx.recipient });
  if (evidence.outcome !== 'previewed') throw new Error('fake preview refused');
  const body = mcfPreviewBody({ kind: 'preview', claim, evidence, previewId: randomUUID(), readAt: new Date(now.getTime() - 120_000), workerRevision: 'wp338e-test' });
  if (!body.ok) throw new Error('preview body did not parse');
  return { ...claim, approval: { approvedAt: new Date(now.getTime() - 60_000).toISOString(), claimDeadline: new Date(now.getTime() + 14 * 60_000).toISOString(),
    units: 1, previewId: body.preview.previewId, fingerprint: hex(32), preview: body.preview } };
}

/** The ledger as a script: it answers every call the way the migration would for one send, and records what it was given. */
class ScriptedLedger implements McfSendStore {
  readonly calls: string[] = [];
  readonly args: unknown[] = [];
  claims: CreatorMcfClaim[] = [];
  custody: (McfCustodyRead & { expiresAt: string }) | null = null;
  reread: 'same' | 'stale' = 'same';
  reservation: ((claim: CreatorMcfClaim) => CreatorMcfReservation) | null = null;
  outcomeFailures = 0;
  readonly outcomes: { outcome: CreatorMcfProviderOutcome; lookup: CreatorMcfOrderRead | null }[] = [];
  readonly heartbeats: CreatorMcfHeartbeat[] = [];
  readonly releases: number[] = [];
  readonly refusals: string[] = [];
  expires = 0;
  purges = 0;
  hooks: { claim?: () => void; custody?: () => void; reserve?: () => void | Promise<void> } = {};
  private current: CreatorMcfClaim | null = null;
  constructor(private readonly now: () => Date) {}

  private note(name: string, ...args: unknown[]) { this.calls.push(name); this.args.push(args); }
  async claim() {
    this.note('claim');
    this.current = this.claims.shift() ?? null;
    if (this.current !== null) this.hooks.claim?.();
    return this.current;
  }
  async readCustody(sendId: string, leaseId: string) { this.note('readCustody', sendId, leaseId); this.hooks.custody?.(); return this.custody; }
  async recordPreview(sendId: string, leaseId: string, preview: CreatorMcfPreview): Promise<CreatorMcfWorkerDecision> {
    this.note('recordPreview', sendId, leaseId, preview);
    if (preview.kind === 'preview') return { decision: 'preview_ready', state: 'preview_ready' };
    return this.reread === 'same' ? { decision: 'same', state: 'approved' } : { decision: 'stale', state: 'stale' };
  }
  async refusePreview(sendId: string, leaseId: string, reason: string, codes: readonly string[]): Promise<CreatorMcfWorkerDecision> {
    this.note('refusePreview', sendId, leaseId, reason, codes);
    this.refusals.push(reason);
    return this.current?.action === 'dispatch' ? { decision: 'expired', state: 'expired' } : { decision: 'preview_refused', state: 'preview_refused' };
  }
  async releaseClaim(sendId: string, leaseId: string, seconds: number): Promise<CreatorMcfWorkerDecision> {
    this.note('releaseClaim', sendId, leaseId, seconds);
    this.releases.push(seconds);
    return { decision: 'released', state: this.current?.state ?? 'approved' };
  }
  async reserve(sendId: string, leaseId: string, digest: string): Promise<CreatorMcfReservation> {
    this.note('reserve', sendId, leaseId, digest);
    const claim = this.current!;
    const answer = this.reservation?.(claim) ?? { decision: 'dispatch_once', sendId, derivedOrderKey: claim.binding.derivedOrderKey, sku: claim.sku, quantity: 1,
      marketplaceId: claim.marketplaceId, approvedAt: claim.approval!.approvedAt, reservedAt: this.now().toISOString(),
      leaseUntil: new Date(this.now().getTime() + 90_000).toISOString(), requestDigest: digest };
    await this.hooks.reserve?.();
    return answer;
  }
  async recordOutcome(sendId: string, leaseId: string, outcome: CreatorMcfProviderOutcome, lookup: CreatorMcfOrderRead | null): Promise<CreatorMcfWorkerDecision> {
    this.note('recordOutcome', sendId, leaseId, outcome, lookup);
    if (this.outcomeFailures > 0) { this.outcomeFailures -= 1; throw new Error('ledger unreachable'); }
    this.outcomes.push({ outcome, lookup });
    const state = outcome.outcome === 'accepted' || (outcome.outcome === 'rejected' && lookup?.outcome === 'found') ? 'accepted'
      : outcome.outcome === 'rejected' ? 'rejected' : 'uncertain';
    return { decision: 'recorded', state };
  }
  async recordSettlement(sendId: string, lookup: CreatorMcfOrderRead, leaseId: string | null): Promise<CreatorMcfWorkerDecision> {
    this.note('recordSettlement', sendId, lookup, leaseId);
    return { decision: 'recorded', state: lookup.outcome === 'found' ? 'placed' : (this.current?.state ?? 'uncertain'), ladderDue: false };
  }
  async markLadderExhausted(sendId: string): Promise<CreatorMcfWorkerDecision> { this.note('markLadderExhausted', sendId); return { decision: 'escalated' }; }
  async expire() { this.note('expire'); this.expires += 1; return { expiredTtl: 0, expiredUnclaimed: 0, uncertainCrash: 0 }; }
  async heartbeat(beat: CreatorMcfHeartbeat) { this.note('heartbeat', beat); this.heartbeats.push(beat); }
  async purgeMasks() { this.note('purgeMasks'); this.purges += 1; return { scheduled: 0, backstop: 0, purged: 0 }; }
}

describe('MCF send loop against a scripted ledger', () => {
  let dir: string;
  let key: KeyPair;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wp338e-loop-keys-'));
    key = await keyPair();
    await writeFile(join(dir, mcfRecipientCredentialName(key.keyId)), key.der);
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function setup(options: { action: 'preview' | 'dispatch'; tokens?: SpApiAccessTokenProvider; scopeOverride?: string[] }) {
    const t = fakeTime();
    const fx = await fixture(dir, key);
    const fake = new FakeFulfillmentOutbound({ now: t.monotonic });
    const ledger = new ScriptedLedger(t.clock);
    const claim = options.action === 'preview' ? baseClaim(fx, 'preview', t.clock()) : await dispatchClaim(fx, t.clock());
    ledger.claims = [claim];
    ledger.custody = { binding: fx.binding, envelope: fx.envelope, ciphertextSha256: fx.sha, expiresAt: new Date(t.time.now + 3_600_000).toISOString() };
    const flags = { preview: true, dispatch: true };
    const logs: string[] = [];
    const entries: McfLogEntry[] = [];
    const policy = (): McfSendPolicy => ({ previewEnabled: flags.preview, dispatchEnabled: flags.dispatch,
      scope: options.scopeOverride ?? [`${fx.connection}:${US}`] });
    const loop = new McfSendLoop({ store: ledger, amazon: amazonOver(fake, options.tokens), keys: credentialDirectoryKeySource(dir), policy,
      workerId: 'wp338e-test', workerRevision: 'wp338e', clock: t.clock, monotonic: t.monotonic, sleep: t.sleep,
      log: (level, entry) => { entries.push(entry); logs.push(mcfLogLine(level, entry, t.clock())); } });
    const sinks = () => ({ logs, ledgerArguments: ledger.args });
    return { t, fx, fake, ledger, claim, flags, loop, logs, entries, sinks };
  }

  it('previews in design order: custody opened, getOrder, then getFulfillmentPreview, then the address-free record', async () => {
    const s = await setup({ action: 'preview' });
    const counts = await s.loop.tick();
    expect(s.fake.operations).toEqual(['get', 'preview']);
    expect(s.ledger.calls.filter((call) => !['heartbeat', 'expire', 'purgeMasks'].includes(call))).toEqual(['claim', 'readCustody', 'recordPreview', 'claim']);
    const recorded = s.ledger.args[s.ledger.calls.indexOf('recordPreview')] as [string, string, CreatorMcfPreview];
    expect(recorded[2]).toMatchObject({ kind: 'preview', totalUnits: 1, isFulfillable: true, fees: { totalMinor: 620, currency: 'USD' },
      earliestArrivalDate: '2026-10-02', latestArrivalDate: '2026-10-05', laneFeeCapMinor: 800, grantFeeCapMinor: 1500, keyId: key.keyId });
    expect(counts.send).toMatchObject({ claimed: 1, previewed: 1 });
    expect(s.fake.posts).toBe(0);
    // Positive control: the recipient reached the fake Amazon, and nowhere else.
    expect(s.fake.requests.find((request) => request.operation === 'preview')!.body).toContain(s.fx.recipient.name);
    assertNoCanary(s.fx.recipient, s.sinks());
  });

  it('dispatches in design order with exactly one POST', async () => {
    const s = await setup({ action: 'dispatch' });
    const counts = await s.loop.tick();
    expect(s.fake.operations).toEqual(['preview', 'get', 'create']);
    expect(s.fake.posts).toBe(1);
    expect(s.ledger.calls.filter((call) => !['heartbeat', 'expire', 'purgeMasks'].includes(call)))
      .toEqual(['claim', 'readCustody', 'recordPreview', 'reserve', 'recordOutcome', 'claim']);
    expect(s.ledger.outcomes).toEqual([{ outcome: { outcome: 'accepted', status: 200 }, lookup: null }]);
    expect(counts.send).toMatchObject({ claimed: 1, posted: 1, accepted: 1, unitsRequested: 1, unitsAccepted: 1, custodyDestroyed: 1 });
    expect(counts.amazonCreates).toBe(1);
    const digest = (s.ledger.args[s.ledger.calls.indexOf('reserve')] as string[])[2]!;
    expect(digest).toBe(await mcfRequestDigest({ marketplaceId: US, derivedOrderKey: s.fx.binding.derivedOrderKey, sellerSku: s.fx.sku,
      approvedAt: s.claim.approval!.approvedAt, envelopeSha256: s.fx.sha }));
    const body = JSON.parse(s.fake.requests.find((request) => request.operation === 'create')!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ sellerFulfillmentOrderId: s.fx.binding.derivedOrderKey, displayableOrderId: s.fx.binding.derivedOrderKey,
      fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', items: [{ sellerSku: s.fx.sku, quantity: 1 }] });
    assertNoCanary(s.fx.recipient, s.sinks());
  });

  describe('a flag turned off between steps stops the next Amazon call', () => {
    it.each([
      ['preview: before custody is read', 'preview', 'claim', [], 0],
      ['preview: after custody is opened, before getOrder', 'preview', 'custody', [], 0],
      ['preview: during getOrder, before getFulfillmentPreview', 'preview', 'get', ['get'], 0],
      ['dispatch: before custody is read', 'dispatch', 'claim', [], 0],
      ['dispatch: after custody is opened, before the re-read', 'dispatch', 'custody', [], 0],
      ['dispatch: during the re-read, before getOrder', 'dispatch', 'preview', ['preview'], 0],
      ['dispatch: during getOrder, before the reservation', 'dispatch', 'get', ['preview', 'get'], 0],
    ] as const)('%s', async (_name, action, at, operations, posts) => {
      const s = await setup({ action });
      const off = () => { s.flags.preview = false; s.flags.dispatch = false; };
      if (at === 'claim') s.ledger.hooks.claim = off;
      if (at === 'custody') s.ledger.hooks.custody = off;
      if (at === 'get' || at === 'preview') s.fake.onRequest = (request: FakeRequest) => { if (request.operation === at) off(); };
      const counts = await s.loop.tick();
      expect(s.fake.operations).toEqual(operations);
      expect(s.fake.posts).toBe(posts);
      expect(s.ledger.calls).not.toContain('reserve');
      expect(s.ledger.releases).toEqual([60]);
      expect(counts.send.deferred).toBe(1);
    });

    it('dispatch: turned off after the reservation, before the POST: nothing is sent, the send is recorded as unknown for the ladder', async () => {
      const s = await setup({ action: 'dispatch' });
      s.ledger.hooks.reserve = () => { s.flags.dispatch = false; };
      const counts = await s.loop.tick();
      expect(s.fake.operations).toEqual(['preview', 'get']);
      expect(s.fake.posts).toBe(0);
      expect(s.ledger.outcomes).toEqual([{ outcome: { outcome: 'uncertain', cause: 'crash', status: null }, lookup: null }]);
      expect(counts).toMatchObject({ amazonCreates: 0, postWithheld: 1 });
      expect(counts.send).toMatchObject({ posted: 1, uncertain: 1 });
      expect(s.entries.find((entry) => entry.event === 'mcf_post_withheld')?.codes).toEqual(['policy_off']);
    });

    it('a stop requested after the reservation withholds the POST the same way', async () => {
      const s = await setup({ action: 'dispatch' });
      s.ledger.hooks.reserve = () => { s.loop.stop(); };
      const counts = await s.loop.tick();
      expect(s.fake.posts).toBe(0);
      expect(counts.postWithheld).toBe(1);
      expect(s.entries.find((entry) => entry.event === 'mcf_post_withheld')?.codes).toEqual(['stopping']);
    });
  });

  it('a claim outside the scope is given back without any Amazon call', async () => {
    const s = await setup({ action: 'dispatch', scopeOverride: [`${randomUUID()}:${US}`] });
    // The ledger filters by scope; this scripted claim ignores it, so the loop must refuse on its own.
    const counts = await s.loop.tick();
    expect(s.fake.requests).toHaveLength(0);
    expect(s.ledger.calls).not.toContain('readCustody');
    expect(counts.send.deferred).toBe(1);
  });

  it('a POST that could not start early enough after the reservation is withheld, so it cannot outlive its lease', async () => {
    const s = await setup({ action: 'dispatch' });
    s.ledger.hooks.reserve = () => { s.t.time.now += 16_000; };
    const counts = await s.loop.tick();
    expect(s.fake.posts).toBe(0);
    expect(counts.postWithheld).toBe(1);
    expect(s.entries.find((entry) => entry.event === 'mcf_post_withheld')?.codes).toEqual(['lease_budget']);
  });

  it('no access token at the POST: nothing is sent, the outcome is unknown, and the heartbeat reports the failure', async () => {
    let fail = false;
    const tokens: SpApiAccessTokenProvider = { getAccessToken: async () => { if (fail) throw new Error('lwa down'); return 'synthetic-access'; } };
    const s = await setup({ action: 'dispatch', tokens });
    s.ledger.hooks.reserve = () => { fail = true; };
    const counts = await s.loop.tick();
    expect(s.fake.posts).toBe(0);
    expect(counts.postWithheld).toBe(1);
    expect(s.entries.find((entry) => entry.event === 'mcf_post_withheld')?.codes).toEqual(['token_unavailable']);
    s.t.time.now += 31_000;
    await s.loop.tick();
    expect(s.ledger.heartbeats.at(-1)?.lastAuthorizationFailureAt).not.toBeNull();
  });

  it('a 4xx whose getOrder cannot be read is recorded as unknown, never as rejected', async () => {
    const s = await setup({ action: 'dispatch' });
    s.fake.createAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'] }];
    s.fake.onRequest = (request) => {
      if (request.operation === 'create') s.fake.readFailures = Array.from({ length: 5 }, () => ({ kind: 'transport' as const }));
    };
    const counts = await s.loop.tick();
    expect(s.fake.posts).toBe(1);
    expect(s.ledger.outcomes).toEqual([{ outcome: { outcome: 'uncertain', cause: 'decode', status: 400 }, lookup: null }]);
    expect(counts.send).toMatchObject({ posted: 1, uncertain: 1 });
  });

  it('a 401 on the POST is rejected(authorization), still followed by getOrder, and flagged', async () => {
    const s = await setup({ action: 'dispatch' });
    s.fake.createAnswers = [{ kind: 'http', status: 401, codes: ['Unauthorized'] }];
    const counts = await s.loop.tick();
    expect(s.fake.operations).toEqual(['preview', 'get', 'create', 'get']);
    expect(s.ledger.outcomes[0]).toMatchObject({ outcome: { outcome: 'rejected', status: 401, reason: 'authorization', codes: ['Unauthorized'] },
      lookup: { outcome: 'not_found' } });
    expect(counts.send.rejected).toBe(1);
    s.t.time.now += 31_000;
    await s.loop.tick();
    expect(s.ledger.heartbeats.at(-1)?.lastAuthorizationFailureAt).not.toBeNull();
  });

  it('an outcome the ledger cannot take is kept in memory and recorded later; the POST is never repeated', async () => {
    const s = await setup({ action: 'dispatch' });
    s.ledger.outcomeFailures = 3;
    const first = await s.loop.tick();
    expect(s.fake.posts).toBe(1);
    expect(first).toMatchObject({ amazonCreates: 1, outcomePending: 1 });
    expect(first.send).toMatchObject({ posted: 0, deferred: 1, unitsDeferred: 1 });
    expect(s.loop.pendingOutcomes()).toBe(1);
    const second = await s.loop.tick();
    expect(second.lateRecorded).toBe(1);
    expect(s.loop.pendingOutcomes()).toBe(0);
    expect(s.ledger.outcomes).toEqual([{ outcome: { outcome: 'accepted', status: 200 }, lookup: null }]);
    expect(s.fake.posts).toBe(1);
  });

  it('a re-read the ledger calls the same but the shared comparison does not is never a reason to POST', async () => {
    const s = await setup({ action: 'dispatch' });
    s.fake.previewAnswers = [{ kind: 'ok', feeValue: '6.50' }];
    s.ledger.reread = 'same';
    const counts = await s.loop.tick();
    expect(s.fake.posts).toBe(0);
    expect(s.ledger.calls).not.toContain('reserve');
    expect(s.ledger.releases).toEqual([600]);
    expect(counts.send.deferred).toBe(1);
  });

  it('a reservation the ledger refuses, or already holds, never leads to a POST', async () => {
    for (const reservation of [
      { decision: 'already_reserved', state: 'dispatching' },
      { decision: 'refused', reason: 'grant_revoked', state: 'expired' },
      { decision: 'refused', reason: 'stale', state: 'stale' },
      { decision: 'refused', reason: 'reread_missing', state: 'approved' },
    ] as CreatorMcfReservation[]) {
      const s = await setup({ action: 'dispatch' });
      s.ledger.reservation = () => reservation;
      const counts = await s.loop.tick();
      expect(s.fake.posts).toBe(0);
      expect(s.ledger.calls).not.toContain('recordOutcome');
      expect(counts.send.posted).toBe(0);
    }
  });

  it('keeps the heartbeat every 30 seconds with the scope and flags, sweeps every tick and purges masks once per UTC day', async () => {
    const s = await setup({ action: 'preview' });
    s.ledger.claims = [];
    await s.loop.tick();
    s.t.time.now += 10_000;
    await s.loop.tick();
    expect(s.ledger.heartbeats).toHaveLength(1);
    expect(s.ledger.heartbeats[0]).toMatchObject({ workerId: 'wp338e-test', scope: [`${s.fx.connection}:${US}`], previewEnabled: true, dispatchEnabled: true,
      workerRevision: 'wp338e', lastAuthorizationFailureAt: null });
    s.t.time.now += 25_000;
    s.flags.dispatch = false;
    await s.loop.tick();
    expect(s.ledger.heartbeats).toHaveLength(2);
    expect(s.ledger.heartbeats[1]).toMatchObject({ dispatchEnabled: false });
    expect(s.ledger.expires).toBe(3);
    expect(s.ledger.purges).toBe(1);
    s.t.time.now += 24 * 60 * 60 * 1000;
    await s.loop.tick();
    expect(s.ledger.purges).toBe(2);
  });

  it('log lines keep only the allowed fields', () => {
    const line = JSON.parse(mcfLogLine('info', { event: 'mcf_outcome', sendId: 'not a uuid', state: 'Some State!', httpStatus: 400,
      codes: ['InvalidInput', 'has space', 'x'.repeat(65)], counts: { posted: 1, 'bad key!': 2 } } as McfLogEntry, new Date(0))) as Record<string, unknown>;
    expect(Object.keys(line).sort()).toEqual(['at', 'codes', 'counts', 'event', 'httpStatus', 'level']);
    expect(line['codes']).toEqual(['InvalidInput']);
    expect(line['counts']).toEqual({ posted: 1 });
  });

  it('converts arrival windows to dates with one function for the preview and the re-read', () => {
    expect(mcfArrivalDate('2026-10-02T07:00:00Z')).toBe('2026-10-02');
    expect(mcfArrivalDate('2026-10-02T23:59:59-07:00')).toBe('2026-10-03');
    expect(mcfArrivalDate(null)).toBeNull();
    expect(() => mcfArrivalDate('not a date')).toThrow('preview_invalid');
  });
});

// ===========================================================================
// Part two: the real ledger (WP-338d migration) and the fake provider.
// ===========================================================================

const available = await databaseAvailable();
const OWNER = randomUUID();

interface Org { id: string; connection: string; marketplace: string; scope: string }
interface Lane { org: Org; record: string; asin: string; key: string; reservation: string; sku: string }

describe.skipIf(!available)('MCF send loop against the real ledger', () => {
  let db: TestDatabase;
  let dir: string;
  let key: KeyPair;
  let unfiled: KeyPair;
  let recordNumber = 3000;

  beforeAll(async () => {
    db = await createTestDatabase('wp338e_mcf_loop');
    dir = await mkdtemp(join(tmpdir(), 'wp338e-ledger-keys-'));
    key = await keyPair();
    unfiled = await keyPair();
    await writeFile(join(dir, mcfRecipientCredentialName(key.keyId)), key.der);
  }, 240_000);
  afterAll(async () => {
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    if (!db) return;
    // Each test sees only its own org's work (scope), but the sweep is global: settle earlier dispatching sends first.
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where state = 'dispatching'`);
  });

  async function backdate(run: (sql: TestDatabase['sql']) => Promise<unknown>) {
    await db.sql.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await run(sql as unknown as TestDatabase['sql']);
    });
  }

  async function newOrg(): Promise<Org> {
    const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`mcf-loop-${hex(3)}`}, ${OWNER}, 'owner') as id`;
    const id = row!.id;
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = gen_random_uuid() where org_id = ${id}`);
    await db.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${id}`;
    const [binding] = await db.sql<{ connection_id: string; marketplace_id: string }[]>`select connection_id, marketplace_id
      from public.spapi_profile_bindings where org_id = ${id}`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids,
        max_units_per_day, max_fee_minor, currency, enabled_by, expires_at)
      values (${id}, ${binding!.connection_id}, ${binding!.marketplace_id}, ${['send', 'cancel']}::text[], ${[key.keyId, unfiled.keyId]}::text[],
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

  async function run(options: { country?: 'US' | 'CA'; sealKey?: KeyPair; wrap?: (store: McfSendStore) => McfSendStore } = {}) {
    const org = await newOrg();
    const lane = await newLane(org);
    const recipient = canaryRecipient(options.country);
    const sealKey = options.sealKey ?? key;
    const binding = { orgId: org.id, creatorRecordId: lane.record, asin: lane.asin, derivedOrderKey: lane.key, reservationId: lane.reservation } as CreatorMcfRecipientBinding;
    const envelope = await sealCreatorMcfRecipient(sealKey.jwk, sealKey.keyId, binding, recipient);
    const sealed = await sealInLedger(db, { orgId: org.id, userId: OWNER }, { creatorRecordId: lane.record, asin: lane.asin, request: { binding, envelope } });
    if (sealed.outcome !== 'sealed') throw new Error(`seal refused: ${sealed.reason}`);
    const fake = new FakeFulfillmentOutbound();
    const flags = { preview: true, dispatch: false };
    const logs: string[] = [];
    const thrown: string[] = [];
    const store = options.wrap?.(postgresMcfSendStore(db)) ?? postgresMcfSendStore(db);
    const makeLoop = () => new McfSendLoop({ store, amazon: amazonOver(fake), keys: credentialDirectoryKeySource(dir),
      policy: () => ({ previewEnabled: flags.preview, dispatchEnabled: flags.dispatch, scope: [org.scope] }),
      workerId: 'wp338e-ledger-test', workerRevision: 'wp338e', sleep: async () => {},
      log: (level, entry) => { logs.push(mcfLogLine(level, entry, new Date())); } });
    const loop = makeLoop();
    const tick = async (target: McfSendLoop = loop): Promise<McfTickCounts | null> => {
      try { return await target.tick(); } catch (error) { thrown.push(error instanceof Error ? error.message : String(error)); return null; }
    };
    return { org, lane, recipient, sendId: sealed.sendId, fake, flags, logs, thrown, loop, makeLoop, tick };
  }
  type Run = Awaited<ReturnType<typeof run>>;

  async function send(sendId: string) {
    const [row] = await db.sql<{ state: string; state_reason: string | null; posts: number; provider_outcome: string | null; provider_reason: string | null;
      escalation_reason: string | null; custody_destroyed_reason: string | null }[]>`select state, state_reason, posts, provider_outcome, provider_reason,
      escalation_reason, custody_destroyed_reason from public.creator_mcf_sends where id = ${sendId}`;
    return row!;
  }
  async function lane(l: Lane) {
    const [row] = await db.sql<{ lane_state: string; order_owner: string; runner_order_id: string | null }[]>`select lane_state, order_owner, runner_order_id
      from public.creator_sample_shipments where org_id = ${l.org.id} and creator_record_id = ${l.record} and asin = ${l.asin}`;
    return row!;
  }
  async function custodyRows(sendId: string): Promise<number> {
    const [row] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${sendId}`;
    return row!.n;
  }
  async function residue() {
    const [row] = await db.sql<{ expired_live: number; custody_free_live: number }[]>`select * from app.creator_mcf_custody_residue()`;
    return [row!.expired_live, row!.custody_free_live];
  }
  async function rows(orgId: string): Promise<string[]> {
    const found = await db.sql<{ row: string }[]>`
      select row_to_json(s)::text as row from public.creator_mcf_sends s where s.org_id = ${orgId}
      union all select row_to_json(p)::text from public.creator_mcf_send_previews p where p.org_id = ${orgId}
      union all select row_to_json(e)::text from public.creator_mcf_send_events e where e.org_id = ${orgId}
      union all select row_to_json(o)::text from public.creator_mcf_outbox o join public.creator_mcf_sends s on s.id = o.send_id where s.org_id = ${orgId}
      union all select row_to_json(x)::text from public.creator_mcf_observations x where x.org_id = ${orgId}
      union all select row_to_json(l)::text from public.creator_sample_shipments l where l.org_id = ${orgId}
      union all select row_to_json(a)::text from public.creator_action_log a where a.org_id = ${orgId}
      union all select row_to_json(h)::text from app.creator_mcf_worker_heartbeats h`;
    return found.map((entry) => entry.row);
  }
  /** Settle work is scheduled seconds or minutes ahead; make it due now. */
  async function settleNow(sendId: string) {
    await db.sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${sendId} and action = 'settle' and completed_at is null`;
  }

  /** Seal, preview (tick), approve as the owner. */
  async function approved(r: Run) {
    const counts = await r.tick();
    expect(counts?.send.previewed).toBe(1);
    const [preview] = await db.sql<{ id: string; fingerprint: string; total_units: number }[]>`select id, fingerprint, total_units
      from public.creator_mcf_send_previews where send_id = ${r.sendId} and kind = 'preview' order by recorded_at desc limit 1`;
    const result = await approveCreatorMcfSend(db, { orgId: r.org.id, userId: OWNER }, { sendId: r.sendId, previewId: preview!.id,
      previewFingerprint: preview!.fingerprint, totalUnits: 1, confirmation: creatorMcfSendConfirmation(preview!.total_units), requestId: randomUUID() });
    expect(result.outcome).toBe('approved');
    r.flags.dispatch = true;
  }

  /** What every path ends with: no custody, no residue, and no recipient value anywhere but in the fake's received requests. */
  async function finish(r: Run) {
    expect(await custodyRows(r.sendId)).toBe(0);
    expect(await residue()).toEqual([0, 0]);
    assertNoCanary(r.recipient, { logs: r.logs, thrown: r.thrown, rows: await rows(r.org.id) });
    const creates = r.fake.requests.filter((request) => request.operation === 'create' || request.operation === 'preview');
    if (creates.length > 0) expect(creates.some((request) => request.body?.includes(r.recipient.name))).toBe(true);
  }

  it('happy path: preview, approval, one POST, then a read settles it as placed', async () => {
    const r = await run();
    await approved(r);
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ claimed: 1, posted: 1, accepted: 1, unitsAccepted: 1 });
    expect(r.fake.posts).toBe(1);
    expect(await send(r.sendId)).toMatchObject({ state: 'accepted', posts: 1, provider_outcome: 'accepted', custody_destroyed_reason: 'post_outcome' });
    await settleNow(r.sendId);
    const settled = await r.tick();
    expect(settled?.settle).toMatchObject({ claimed: 1, recorded: 1, found: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    expect(await lane(r.lane)).toMatchObject({ lane_state: 'Confirmed', order_owner: 'arcana', runner_order_id: r.lane.key });
    expect(r.fake.posts).toBe(1);
    expect(r.thrown).toEqual([]);
    await finish(r);
  });

  it.each([
    ['the fee went up', { kind: 'ok' as const, feeValue: '6.50' }],
    ['the fee went down', { kind: 'ok' as const, feeValue: '5.90' }],
    ['the arrival window changed', { kind: 'ok' as const, earliestArrival: '2026-10-03T07:00:00Z' }],
    ['the unit is no longer fulfillable', { kind: 'ok' as const, fulfillable: false }],
  ])('%s: stale with 0 POSTs, custody kept for a new preview', async (_name, answer) => {
    const r = await run();
    await approved(r);
    r.fake.previewAnswers = [answer];
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ claimed: 1, stale: 1, unitsStale: 1, posted: 0 });
    expect(r.fake.posts).toBe(0);
    expect(await send(r.sendId)).toMatchObject({ state: 'stale', posts: 0 });
    expect(await custodyRows(r.sendId)).toBe(1);
    assertNoCanary(r.recipient, { logs: r.logs, rows: await rows(r.org.id) });
  });

  it('found before the POST: classified, custody destroyed, 0 POSTs', async () => {
    const r = await run();
    await approved(r);
    r.fake.seedOrder({ sellerFulfillmentOrderId: r.lane.key, status: 'Received', sellerSku: r.lane.sku, quantity: 1 });
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ foundBeforePost: 1, unitsFoundBeforePost: 1, posted: 0 });
    expect(r.fake.posts).toBe(0);
    expect(await send(r.sendId)).toMatchObject({ state: 'placed', posts: 0, custody_destroyed_reason: 'found_before_post' });
    await finish(r);
  });

  it('a 5xx is uncertain with 1 POST; the next read finds the order and it is placed', async () => {
    const r = await run();
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 503, creates: true }];
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ posted: 1, uncertain: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', provider_reason: 'http_5xx' });
    expect(await lane(r.lane)).toMatchObject({ lane_state: 'Reconciliation Required' });
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a 4xx then a read that finds the order is a success with 1 POST', async () => {
    const r = await run();
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'], creates: true }];
    const counts = await r.tick();
    expect(r.fake.operations.slice(-2)).toEqual(['create', 'get']);
    expect(counts?.send).toMatchObject({ posted: 1, accepted: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'placed', posts: 1, provider_outcome: 'rejected' });
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a 4xx then a read that finds nothing is rejected with 1 POST, and the lane goes back to the runner', async () => {
    const r = await run();
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'] }];
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ posted: 1, rejected: 1, unitsRejected: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'rejected', provider_reason: 'validation' });
    expect(await lane(r.lane)).toMatchObject({ lane_state: 'Reserved', order_owner: 'runner' });
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a 429 then a read that finds nothing is rejected(throttled) with 1 POST', async () => {
    const r = await run();
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 429, codes: ['QuotaExceeded'] }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'rejected', provider_reason: 'throttled' });
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a crash after the reservation, before the POST: the sweep makes it uncertain(crash) and nothing ever POSTs it', async () => {
    const r = await run({ wrap: (store) => ({ ...store, reserve: async (...args) => { await store.reserve(...args); return new Promise<never>(() => {}); } }) });
    await approved(r);
    void r.loop.tick();
    for (let attempt = 0; attempt < 50 && (await send(r.sendId)).state !== 'dispatching'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await send(r.sendId)).toMatchObject({ state: 'dispatching', posts: 1 });
    // The process is gone. After its lease, a restarted unit sweeps and reads; it never POSTs this send.
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${r.sendId}`);
    const restarted = r.makeLoop();
    await r.tick(restarted);
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', state_reason: 'crash', custody_destroyed_reason: 'lease_expired' });
    await settleNow(r.sendId);
    await r.tick(restarted);
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain' });
    expect(r.fake.posts).toBe(0);
    await finish(r);
  });

  it('a crash after the POST, before its outcome is recorded: still one POST, and the ladder finds the order', async () => {
    const r = await run();
    await approved(r);
    const hung = new FakeFulfillmentOutbound({ onRequest: (request) => (request.operation === 'create' ? new Promise<never>(() => {}) : undefined) });
    const crashing = new McfSendLoop({ store: postgresMcfSendStore(db), amazon: amazonOver(hung), keys: credentialDirectoryKeySource(dir),
      policy: () => ({ previewEnabled: true, dispatchEnabled: true, scope: [r.org.scope] }), workerId: 'wp338e-crash-test', workerRevision: 'wp338e',
      sleep: async () => {}, log: (level, entry) => { r.logs.push(mcfLogLine(level, entry, new Date())); } });
    void crashing.tick();
    for (let attempt = 0; attempt < 50 && hung.posts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(hung.posts).toBe(1);
    // Amazon did take it.
    r.fake.seedOrder({ sellerFulfillmentOrderId: r.lane.key, status: 'Received', sellerSku: r.lane.sku, quantity: 1 });
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${r.sendId}`);
    await r.tick(r.makeLoop());
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', state_reason: 'crash' });
    await settleNow(r.sendId);
    await r.tick(r.makeLoop());
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    expect(hung.posts + r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a reservation that commits but whose answer is lost: no POST, no second claim, and the sweep makes it uncertain(crash)', async () => {
    const r = await run({ wrap: (store) => ({ ...store, reserve: async (...args) => { await store.reserve(...args); throw new Error('connection lost'); } }) });
    await approved(r);
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ claimed: 1, deferred: 1, posted: 0 });
    expect(r.fake.posts).toBe(0);
    expect(await send(r.sendId)).toMatchObject({ state: 'dispatching', posts: 1 });
    // The released dispatch work comes due again: the claim finds the send no longer approved and closes it without a POST.
    await db.sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${r.sendId} and action = 'dispatch' and completed_at is null`;
    await r.tick();
    const [open] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_outbox
      where send_id = ${r.sendId} and action = 'dispatch' and completed_at is null`;
    expect(open!.n).toBe(0);
    expect(r.fake.posts).toBe(0);
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${r.sendId}`);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', state_reason: 'crash' });
    expect(r.fake.posts).toBe(0);
    await finish(r);
  });

  it.each([
    ['a lost answer (transport)', { kind: 'transport' as const }, 'transport', 'request_timeout'],
    ['a 408', { kind: 'http' as const, status: 408 }, 'http_408', 'request_timeout'],
    ['an undecodable 200', { kind: 'undecodable' as const }, 'decode', 'outcome_unknown'],
  ])('%s is uncertain with 1 POST and waits for the ladder', async (_name, answer, reason, reconciliation) => {
    const r = await run();
    await approved(r);
    r.fake.createAnswers = [answer];
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ posted: 1, uncertain: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', provider_reason: reason, custody_destroyed_reason: 'post_outcome' });
    const [row] = await db.sql<{ reconciliation_reason: string | null }[]>`select reconciliation_reason from public.creator_sample_shipments
      where org_id = ${r.org.id} and creator_record_id = ${r.lane.record} and asin = ${r.lane.asin}`;
    expect(row!.reconciliation_reason).toBe(reconciliation);
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a late 200 after the sweep marked the send uncertain(crash) is accepted; the POST count stays 1', async () => {
    let down = false;
    const r = await run({ wrap: (store) => ({ ...store, recordOutcome: async (...args) => { if (down) throw new Error('ledger unreachable'); return store.recordOutcome(...args); } }) });
    await approved(r);
    down = true;
    const first = await r.tick();
    expect(first).toMatchObject({ amazonCreates: 1, outcomePending: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'dispatching' });
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${r.sendId}`);
    down = false;
    const second = await r.tick();
    expect(second?.lateRecorded).toBe(1);
    expect(await send(r.sendId)).toMatchObject({ state: 'accepted', state_reason: 'late_accepted', provider_outcome: 'accepted' });
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('a send still accepted after 7 days of reads is marked ladder_exhausted', async () => {
    const r = await run();
    await approved(r);
    r.fake.createAnswers = [{ kind: 'ok', status: 'New' }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'accepted' });
    await backdate((sql) => sql`update public.creator_mcf_sends set intent_reserved_at = now() - interval '7 days 1 minute',
      accepted_at = now() - interval '7 days 1 minute' where id = ${r.sendId}`);
    await settleNow(r.sendId);
    const counts = await r.tick();
    expect(counts?.settle).toMatchObject({ recorded: 1, found: 1, ladderExhausted: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'accepted', escalation_reason: 'ladder_exhausted' });
    expect(r.fake.posts).toBe(1);
    await finish(r);
  });

  it('refuses without any Amazon call: a key the unit does not hold, and an address outside the marketplace', async () => {
    const noKey = await run({ sealKey: unfiled });
    const refusedKey = await noKey.tick();
    expect(refusedKey?.send).toMatchObject({ claimed: 1, previewRefused: 1 });
    expect(await send(noKey.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'key_unavailable' });
    expect(noKey.fake.requests).toHaveLength(0);
    await finish(noKey);
    const abroad = await run({ country: 'CA' });
    const refusedCountry = await abroad.tick();
    expect(refusedCountry?.send).toMatchObject({ previewRefused: 1, previewRefusedRecipient: 1 });
    expect(await send(abroad.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'country_not_allowed' });
    expect(abroad.fake.requests).toHaveLength(0);
    await finish(abroad);
  });

  it.each([
    ['a fee over the lane cap', { kind: 'ok' as const, feeValue: '9.00' }, 'fee_over_lane_cap'],
    ['a unit Amazon cannot fulfil', { kind: 'ok' as const, fulfillable: false }, 'not_fulfillable'],
  ])('the ledger refuses a preview with %s; custody is destroyed', async (_name, answer, code) => {
    const r = await run();
    r.fake.previewAnswers = [answer];
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ claimed: 1, previewRefused: 1, custodyDestroyed: 1 });
    const [event] = await db.sql<{ codes: string[] }[]>`select codes from public.creator_mcf_send_events where send_id = ${r.sendId} and event = 'preview_refused'`;
    expect(event!.codes).toContain(code);
    expect(await send(r.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'not_sendable', custody_destroyed_reason: 'preview_refused' });
    await finish(r);
  });

  it('a 4xx at preview (an address Amazon refuses) ends the send with the provider codes only', async () => {
    const r = await run();
    r.fake.previewAnswers = [{ kind: 'http', status: 400, codes: ['InvalidDestinationAddress'] }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'provider_refused' });
    const [event] = await db.sql<{ codes: string[] }[]>`select codes from public.creator_mcf_send_events where send_id = ${r.sendId} and event = 'preview_refused'`;
    expect(event!.codes).toEqual(['InvalidDestinationAddress']);
    await finish(r);
  });

  it('a mask changed on the send row cannot be opened: refused before any Amazon call', async () => {
    const r = await run();
    await backdate((sql) => sql`update public.creator_mcf_sends set mask = jsonb_set(mask, '{lines}', '3') where id = ${r.sendId}`);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'envelope_unopenable' });
    expect(r.fake.requests).toHaveLength(0);
    await finish(r);
  });

  it('a scope that does not cover the send claims nothing', async () => {
    const r = await run();
    const outside = new McfSendLoop({ store: postgresMcfSendStore(db), amazon: amazonOver(r.fake), keys: credentialDirectoryKeySource(dir),
      policy: () => ({ previewEnabled: true, dispatchEnabled: true, scope: [`${randomUUID()}:${US}`] }), workerId: 'wp338e-scope-test',
      workerRevision: 'wp338e', sleep: async () => {}, log: () => {} });
    const counts = await outside.tick();
    expect(counts.send.claimed).toBe(0);
    expect(r.fake.requests).toHaveLength(0);
    expect(await send(r.sendId)).toMatchObject({ state: 'sealed' });
  });
});
