/**
 * WP-338j: the MCF canary privacy suite.
 *
 * A synthetic recipient whose every field holds a unique token goes through
 * every path of the MCF send and cancel against the real ledger (migrations
 * 20260928120000 and 20260928130000), the real loop, the real SP-API reader and
 * writer and the fake Fulfillment Outbound provider in echo mode, which repeats
 * the destination in every answer that can carry text. After each path every
 * sink it could have written to is scanned for every token in plain,
 * case-folded, base64, base64url, hex and URL-encoded form (canary-scan.ts):
 * the console (the production loggers write there), thrown errors, every
 * argument and answer of the ledger, every result of the SP-API reader and
 * writer, every row of every table holding the organisation's id plus the
 * outbox and heartbeats, the MCP outcome read and the screens' lane read. At
 * the end the mcf.observe job runs through the job queue, the general worker's
 * housekeeping tick sends an alert, and a data-only export of every table in
 * every non-system schema is scanned for all tokens of all paths.
 *
 * The positive control: each path that reached "Amazon" with the recipient
 * must find every field's token in the fake provider's received requests, and
 * the scan must find each token in every encoding at every alignment.
 *
 * The deliberate injection: WP338J_INJECT_CANARY=log writes a base64 copy of a
 * token into a console log line during the first path, which must then fail
 * naming only the sink ("logs"). A test below proves the same without the
 * database.
 *
 * Synthetic data only: keys, ids and tokens are made at run time. The private
 * key lives in a temporary directory under the scratch TMPDIR for the run.
 */
import { createCipheriv, createECDH, createHmac, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import {
  approveCreatorMcfCancel, approveCreatorMcfSend, creatorSampleOrderKey, readCreatorMcfLane, readCreatorMcfSendOutcome, requestCreatorMcfCancelPreview,
  sealCreatorMcfRecipient as sealInLedger,
} from '@wizard-ads/db';
import { listCreatorMcfObserveScopes } from '@wizard-ads/db/worker';
import { asServiceRole, createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import {
  CREATOR_MCF_ENVELOPE_SUITE, CREATOR_MCF_HPKE_INFO, creatorMcfBase64UrlEncode, creatorMcfCancelConfirmation, creatorMcfRecipientAad,
  creatorMcfRecipientKeyId, creatorMcfSendConfirmation, importCreatorMcfRecipientKey, openCreatorMcfRecipient, sealCreatorMcfRecipient,
  type CreatorMcfMask, type CreatorMcfRecipient, type CreatorMcfRecipientBinding, type CreatorMcfSealedRecipient, type McfObserveJob,
} from '@wizard-ads/shared';
import { FulfillmentOutboundReader, FulfillmentOutboundWriter } from '@wizard-ads/sp-api';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { McfHousekeepingPass, postgresMcfHousekeepingStore } from '../mcf-housekeeping.js';
import { McfObservePass, observeCreatorMcfLanes, postgresMcfObserveStore } from '../mcf-observe.js';
import { PostgresWorkerStore } from '../store.js';
import {
  CANARY_ENCODINGS, CanaryLeakError, assertNoCanary, canaryHits, canaryPresent, encodeForCanaryControl, sinkText,
} from '../testing/canary-scan.js';
import { FakeFulfillmentOutbound } from '../testing/fake-fulfillment-outbound.js';
import { postgresMcfCancelStore, type McfCancelStore } from './cancel.js';
import { credentialDirectoryKeySource, mcfRecipientCredentialName } from './custody.js';
import { McfSendLoop, mcfLogLine, postgresMcfSendStore, type McfAmazonFactory } from './loop.js';

const ENDPOINT = 'https://fake-sp-api.invalid';
const INJECT = process.env['WP338J_INJECT_CANARY'];
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

// ===========================================================================
// The canary recipient.
// ===========================================================================

interface Canary {
  recipient: CreatorMcfRecipient;
  /** Every field value (country code aside) and its random core: the scan's needles. */
  tokens: string[];
}

/** Every text field holds a label and 16 random hex characters, with a space so URL encoding differs from plain. */
function canary(): Canary {
  const core = () => hex(8);
  const field = (label: string) => `Qz${label} ${core()}`;
  const postalCore = `Q${hex(5).toUpperCase()}`;
  const recipient: CreatorMcfRecipient = {
    name: field('name'), addressLine1: field('street'), addressLine2: field('unit'), addressLine3: field('floor'), city: field('city'),
    districtOrCounty: field('county'), stateOrRegion: field('state'), postalCode: `${postalCore} ${hex(3).toUpperCase()}`, countryCode: 'US',
  };
  const values = Object.entries(recipient).filter(([name]) => name !== 'countryCode').map(([, value]) => value);
  const cores = values.map((value) => value.split(' ')[0] === postalCore ? postalCore : value.split(' ')[1]!);
  return { recipient, tokens: [...values, ...cores] };
}

// ===========================================================================
// RFC 9180 base mode, for an envelope whose plaintext is not a valid recipient.
// ===========================================================================

const i2osp = (value: number, length: number) => { const out = Buffer.alloc(length); out.writeUIntBE(value, 0, length); return out; };
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(0x0010, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), i2osp(0x0010, 2), i2osp(0x0001, 2), i2osp(0x0001, 2)]);
const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) =>
  createHmac('sha256', salt).update(Buffer.concat([Buffer.from('HPKE-v1'), suite, Buffer.from(label), ikm])).digest();
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) => createHmac('sha256', prk)
  .update(Buffer.concat([i2osp(length, 2), Buffer.from('HPKE-v1'), suite, Buffer.from(label), info, Buffer.of(1)])).digest().subarray(0, length);

/** Seals any plaintext to the key, bound to the lane, exactly as the browser seals a recipient (DHKEM P-256, HKDF-SHA256, AES-128-GCM). */
function sealPlaintext(key: KeyPair, binding: CreatorMcfRecipientBinding, mask: CreatorMcfMask, plaintext: string): CreatorMcfSealedRecipient {
  const pkRm = Buffer.concat([Buffer.of(4), Buffer.from(key.jwk['x'] as string, 'base64url'), Buffer.from(key.jwk['y'] as string, 'base64url')]);
  const ephemeral = createECDH('prime256v1');
  const enc = ephemeral.generateKeys();
  const eaePrk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', ephemeral.computeSecret(pkRm));
  const sharedSecret = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', Buffer.concat([enc, pkRm]), 32);
  const context = Buffer.concat([Buffer.of(0), labeledExtract(HPKE_SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)),
    labeledExtract(HPKE_SUITE, Buffer.alloc(0), 'info_hash', Buffer.from(CREATOR_MCF_HPKE_INFO))]);
  const scheduleKey = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', Buffer.alloc(0));
  const envelopeId = randomUUID();
  const cipher = createCipheriv('aes-128-gcm', labeledExpand(HPKE_SUITE, scheduleKey, 'key', context, 16), labeledExpand(HPKE_SUITE, scheduleKey, 'base_nonce', context, 12));
  cipher.setAAD(creatorMcfRecipientAad({ ...binding, envelopeId, keyId: key.keyId, mask }));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, suite: CREATOR_MCF_ENVELOPE_SUITE, envelopeId, keyId: key.keyId, enc: creatorMcfBase64UrlEncode(enc),
    ciphertext: creatorMcfBase64UrlEncode(ciphertext), mask };
}

/** A plaintext the worker must refuse after opening it: a bidi control, a phone field and an unknown field whose name is itself a token. */
function invalidPlaintext(c: Canary, extra: string): string {
  const r = c.recipient;
  return JSON.stringify({ name: `${r.name}‮`, addressLine1: r.addressLine1, city: r.city, stateOrRegion: r.stateOrRegion, postalCode: r.postalCode,
    countryCode: 'US', phone: r.addressLine2, [extra]: r.addressLine3 });
}

interface KeyPair { der: Buffer; jwk: Record<string, unknown>; keyId: string }
async function keyPair(): Promise<KeyPair> {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const exported = pair.publicKey.export({ format: 'jwk' });
  const jwk = { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y };
  return { der: pair.privateKey.export({ format: 'der', type: 'pkcs8' }), jwk, keyId: await creatorMcfRecipientKeyId(jwk) };
}

// ===========================================================================
// Part one: the scan itself (no database).
// ===========================================================================

describe('the canary scan', () => {
  it('finds every token in every encoding at every byte alignment, inside JSON and inside a larger encoded value', () => {
    const c = canary();
    let checked = 0;
    for (const token of c.tokens) {
      for (const encoding of CANARY_ENCODINGS) {
        for (const prefix of ['', 'x', 'xy', '{"payload":"']) {
          const encoded = encodeForCanaryControl(`${prefix}${token}","more":"synthetic"}`, encoding);
          const hits = canaryHits([token], { sink: `before ${encoded} after` });
          expect(hits.map((hit) => hit.encoding), `${encoding} at offset ${prefix.length}`).toContain(encoding);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(c.tokens.length * CANARY_ENCODINGS.length * 4);
    // The variants beyond the six controls: form encoding, a Buffer as console prints it, base64 of a re-cased token.
    const token0 = c.tokens[0]!;
    const variants: [string, string][] = [
      ['url', `q=${encodeURIComponent(token0).replace(/%20/g, '+')}&x=1`],
      ['hex', format(Buffer.from(`x${token0}`))],
      ['base64', Buffer.from(`ab${token0.toUpperCase()}`).toString('base64')],
      ['base64url', Buffer.from(`a${token0.toLowerCase()}`).toString('base64url')],
    ];
    for (const [encoding, text] of variants) expect(canaryHits([token0], { sink: text }).map((hit) => hit.encoding), encoding).toContain(encoding);
    // Bytes, errors with causes, maps and nested values are all searched.
    const token = c.tokens[0]!;
    expect(canaryPresent([token], Buffer.from(`\u0000${token}\u0001`, 'latin1'))).toBe(true);
    expect(canaryPresent([token], new Error('outer', { cause: new Error(token) }))).toBe(true);
    expect(canaryPresent([token], new Map([['k', { deep: [token] }]]))).toBe(true);
    expect(canaryPresent([token], { bytes: new Uint8Array(Buffer.from(token)) })).toBe(true);
    expect(canaryPresent(c.tokens, [mcfLogLine('info', { event: 'mcf_tick', counts: { claimed: 1 } }, new Date()), randomUUID(), hex(32)])).toBe(false);
  });

  it('the deliberate injection: a token in a log line fails the scan, and the failure names the sink and nothing else', () => {
    const c = canary();
    const clean = [mcfLogLine('info', { event: 'mcf_tick', sendId: randomUUID(), counts: { claimed: 1, posted: 1 } }, new Date())];
    expect(() => assertNoCanary(c.tokens, { logs: clean, rows: [{ state: 'placed' }] })).not.toThrow();
    let checked = 0;
    for (const encoding of CANARY_ENCODINGS) {
      const injected = [...clean, JSON.stringify({ event: 'mcf_tick', note: encodeForCanaryControl(c.tokens[checked % c.tokens.length]!, encoding) })];
      let failure: unknown = null;
      try { assertNoCanary(c.tokens, { logs: injected, rows: [{ state: 'placed' }] }); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CanaryLeakError);
      expect((failure as CanaryLeakError).message).toBe('recipient canary found in sink: logs');
      // What a failing run prints (message and stack) holds no form of any token.
      expect(canaryPresent(c.tokens, [(failure as Error).message, (failure as Error).stack])).toBe(false);
      checked += 1;
    }
    expect(checked).toBe(CANARY_ENCODINGS.length);
  });

  it('seals an arbitrary plaintext the way the browser does: the worker\'s opener reads it back', async () => {
    const key = await keyPair();
    const c = canary();
    const binding = { orgId: randomUUID(), creatorRecordId: 'CCR-SW-26-7001', asin: 'B0QZ7K3M2Q', derivedOrderKey: `CCS-${hex(16)}`,
      reservationId: `MCFR-${hex(8).toUpperCase()}` } as CreatorMcfRecipientBinding;
    const opener = await importCreatorMcfRecipientKey(new Uint8Array(key.der), key.jwk);
    const valid = sealPlaintext(key, binding, { countryCode: 'US', postalPrefix: c.recipient.postalCode.slice(0, 2), lines: 3 }, JSON.stringify(c.recipient));
    expect(await openCreatorMcfRecipient(opener, valid, binding)).toMatchObject({ status: 'opened', recipient: c.recipient });
    const invalid = sealPlaintext(key, binding, valid.mask, invalidPlaintext(c, c.tokens.at(-1)!));
    const opened = await openCreatorMcfRecipient(opener, invalid, binding);
    expect(opened.status).toBe('recipient_invalid');
    assertNoCanary(c.tokens, { issues: opened });
    // The shared sealer's envelope has the same shape.
    const shared = await sealCreatorMcfRecipient(key.jwk, key.keyId, binding, c.recipient);
    expect(Object.keys(shared).sort()).toEqual(Object.keys(valid).sort());
  });
});

// ===========================================================================
// Part two: every path against the real ledger.
// ===========================================================================

const available = await databaseAvailable();
const OWNER = randomUUID();

interface Org { id: string; connection: string; marketplace: string; scope: string }
interface Lane { org: Org; record: string; asin: string; key: string; reservation: string; sku: string }
interface Recorded { calls: unknown[]; results: unknown[]; thrown: unknown[] }

/** Every call through `target`'s methods is recorded: arguments, answers and thrown errors. */
function recorded<T extends object>(target: T, into: Recorded): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value: unknown = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        into.calls.push([String(property), args]);
        let result: unknown;
        try {
          result = (value as (...inner: unknown[]) => unknown).apply(object, args);
        } catch (error) {
          into.thrown.push(error);
          throw error;
        }
        if (result instanceof Promise) {
          return result.then((answer: unknown) => { into.results.push([String(property), answer]); return answer; },
            (error: unknown) => { into.thrown.push(error); throw error; });
        }
        into.results.push([String(property), result]);
        return result;
      };
    },
  });
}

describe.skipIf(!available)('the MCF canary privacy suite against the real ledger, loop, job queue and housekeeping', () => {
  let db: TestDatabase;
  let dir: string;
  let key: KeyPair;
  let recordNumber = 7100;
  /** Everything written to the console during the suite: the loop's and housekeeping's production loggers write here. */
  const consoleLines: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  const allTokens: string[] = [];
  const allThrown: unknown[] = [];
  const fakes = new Map<string, FakeFulfillmentOutbound>();
  const ran: { path: string; sinks: string[]; recipientRequests: number }[] = [];
  let uncertainForAlert: string | null = null;
  let injected = false;
  const conflictsForAlert: string[] = [];

  beforeAll(async () => {
    db = await createTestDatabase('wp338j_mcf_privacy');
    dir = await mkdtemp(join(tmpdir(), 'wp338j-privacy-keys-'));
    key = await keyPair();
    await writeFile(join(dir, mcfRecipientCredentialName(key.keyId)), key.der);
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      // Both what the console would print and every structured field of its arguments.
      spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { consoleLines.push(`${format(...args)}\n${sinkText(args)}`); }));
    }
  }, 240_000);
  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function backdate(run: (sql: TestDatabase['sql']) => Promise<unknown>) {
    await db.sql.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await run(sql as unknown as TestDatabase['sql']);
    });
  }

  async function newOrg(): Promise<Org> {
    const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`mcf-privacy-${hex(3)}`}, ${OWNER}, 'owner') as id`;
    const id = row!.id;
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = gen_random_uuid() where org_id = ${id}`);
    await db.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${id}`;
    const [binding] = await db.sql<{ connection_id: string; marketplace_id: string }[]>`select connection_id, marketplace_id
      from public.spapi_profile_bindings where org_id = ${id}`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids,
        max_units_per_day, max_fee_minor, currency, enabled_by, expires_at)
      values (${id}, ${binding!.connection_id}, ${binding!.marketplace_id}, ${['send', 'cancel']}::text[], ${[key.keyId]}::text[],
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

  /** One lane, one sealed send and one loop over an echoing fake, with every ledger and provider call recorded. */
  async function start(path: string, options: { plaintext?: 'invalid'; writerTimeoutMs?: number; wrapCancel?: (store: McfCancelStore) => McfCancelStore } = {}) {
    const org = await newOrg();
    const lane = await newLane(org);
    const c = canary();
    const extraToken = `Qzextra${hex(8)}`;
    c.tokens.push(extraToken);
    allTokens.push(...c.tokens);
    const binding = { orgId: org.id, creatorRecordId: lane.record, asin: lane.asin, derivedOrderKey: lane.key, reservationId: lane.reservation } as CreatorMcfRecipientBinding;
    const envelope = options.plaintext === 'invalid'
      ? sealPlaintext(key, binding, { countryCode: 'US', postalPrefix: c.recipient.postalCode.slice(0, 2), lines: 1 }, invalidPlaintext(c, extraToken))
      : await sealCreatorMcfRecipient(key.jwk, key.keyId, binding, c.recipient);
    const sealed = await sealInLedger(db, { orgId: org.id, userId: OWNER }, { creatorRecordId: lane.record, asin: lane.asin, request: { binding, envelope } });
    if (sealed.outcome !== 'sealed') throw new Error(`seal refused: ${sealed.reason}`);
    const fake = new FakeFulfillmentOutbound({ echo: true });
    fakes.set(org.id, fake);
    const ledger: Recorded = { calls: [], results: [], thrown: [] };
    const provider: Recorded = { calls: [], results: [], thrown: [] };
    const tokens = FakeFulfillmentOutbound.tokens();
    // What the fake answered, headers and bodies and failures: the second positive control (the adversary really echoed).
    const answers: string[] = [];
    const fetch: typeof fake.fetch = async (input, init) => {
      try {
        const response = await fake.fetch(input, init);
        answers.push(`${JSON.stringify([...response.headers.entries()])}\n${await response.clone().text()}`);
        return response;
      } catch (error) {
        answers.push(sinkText(error));
        throw error;
      }
    };
    const amazon: McfAmazonFactory = () => ({
      reader: recorded(new FulfillmentOutboundReader({ endpoint: ENDPOINT, accessTokenProvider: tokens, userAgent: 'wp338j-test', fetch }), provider),
      writer: recorded(new FulfillmentOutboundWriter({ endpoint: ENDPOINT, accessTokenProvider: tokens, userAgent: 'wp338j-test', fetch,
        ...(options.writerTimeoutMs === undefined ? {} : { timeoutMs: options.writerTimeoutMs }) }), provider),
    });
    const cancelStore = postgresMcfCancelStore(db);
    const flags = { preview: true, dispatch: false };
    // No `log` option: the loop writes through its production console logger.
    const loop = new McfSendLoop({ store: recorded(postgresMcfSendStore(db), ledger),
      cancelStore: recorded(options.wrapCancel?.(cancelStore) ?? cancelStore, ledger), amazon, keys: credentialDirectoryKeySource(dir),
      policy: () => ({ previewEnabled: flags.preview, dispatchEnabled: flags.dispatch, scope: [org.scope] }),
      workerId: 'wp338j-privacy', workerRevision: 'wp338j', sleep: async () => {} });
    const thrown: unknown[] = [];
    const tick = async () => {
      try { return await loop.tick(); } catch (error) { thrown.push(error); return null; }
    };
    return { path, org, lane, canary: c, sendId: sealed.sendId, fake, answers, flags, loop, tick, ledger, provider, thrown, logStart: consoleLines.length };
  }
  type Run = Awaited<ReturnType<typeof start>>;
  const actor = (r: Run) => ({ orgId: r.org.id, userId: OWNER });

  async function send(sendId: string) {
    const [row] = await db.sql<{ state: string; state_reason: string | null; posts: number; provider_reason: string | null; amazon_status: string | null }[]>`
      select state, state_reason, posts, provider_reason, amazon_status from public.creator_mcf_sends where id = ${sendId}`;
    return row!;
  }
  async function custodyRows(sendId?: string): Promise<number> {
    const [row] = sendId === undefined
      ? await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody`
      : await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${sendId}`;
    return row!.n;
  }
  async function residue() {
    const [row] = await db.sql<{ expired_live: number; custody_free_live: number }[]>`select * from app.creator_mcf_custody_residue()`;
    return [row!.expired_live, row!.custody_free_live];
  }
  async function settleNow(sendId: string) {
    await db.sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${sendId} and action = 'settle' and completed_at is null`;
  }

  /** Every row of every table that holds the organisation's id, plus its outbox rows and the unit's heartbeats. */
  async function orgRows(orgId: string): Promise<{ table: string; rows: string[] }[]> {
    const tables = await db.sql<{ schema: string; name: string }[]>`select c.table_schema as schema, c.table_name as name
      from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.column_name = 'org_id' and t.table_type = 'BASE TABLE' and c.table_schema not in ('pg_catalog', 'information_schema')
      order by 1, 2`;
    const out: { table: string; rows: string[] }[] = [];
    for (const table of tables) {
      const found = await db.sql.unsafe<{ row: string }[]>(`select t::text as row from ${quoted(table.schema)}.${quoted(table.name)} t where t.org_id = $1`, [orgId]);
      out.push({ table: `${table.schema}.${table.name}`, rows: found.map((entry) => entry.row) });
    }
    const outbox = await db.sql<{ row: string }[]>`select o::text as row from public.creator_mcf_outbox o join public.creator_mcf_sends s on s.id = o.send_id
      where s.org_id = ${orgId}`;
    const heartbeats = await db.sql<{ row: string }[]>`select h::text as row from app.creator_mcf_worker_heartbeats h`;
    out.push({ table: 'public.creator_mcf_outbox', rows: outbox.map((entry) => entry.row) }, { table: 'app.creator_mcf_worker_heartbeats',
      rows: heartbeats.map((entry) => entry.row) });
    return out;
  }

  /** What every path ends with: its custody gone, and no token in any sink; the positive control where the recipient reached "Amazon". */
  async function finish(r: Run, expected: { recipientRequests: boolean }) {
    expect(await custodyRows(r.sendId)).toBe(0);
    if (INJECT === 'log' && !injected) {
      injected = true;
      console.info(JSON.stringify({ event: 'mcf_tick', note: Buffer.from(r.canary.tokens[0]!).toString('base64') }));
    }
    const tables = await orgRows(r.org.id);
    const sinks: Record<string, unknown> = {
      logs: consoleLines.slice(r.logStart),
      thrown: [...r.thrown, ...r.ledger.thrown, ...r.provider.thrown],
      ledgerArguments: r.ledger.calls,
      ledgerAnswers: r.ledger.results,
      providerResults: r.provider.results,
      rows: tables,
      outboxRows: tables.find((table) => table.table === 'public.creator_mcf_outbox')!.rows,
      auditRows: tables.filter((table) => table.table.includes('audit')),
      mcpOutcome: [await readCreatorMcfSendOutcome(db.sql, r.org.id, { derivedOrderKey: r.lane.key }),
        await readCreatorMcfSendOutcome(db.sql, r.org.id, { creatorRecordId: r.lane.record, asin: r.lane.asin })],
      screenLaneRead: await readCreatorMcfLane(db, actor(r), r.lane.record, r.lane.asin),
    };
    allThrown.push(...(sinks['thrown'] as unknown[]));
    // Every table that holds the organisation's rows was read (counted, not assumed).
    expect(tables.filter((table) => table.rows.length > 0).map((table) => table.table))
      .toEqual(expect.arrayContaining(['public.creator_mcf_sends', 'public.creator_mcf_send_events', 'public.creator_sample_shipments']));
    // The sinks were live: the production logger wrote this path's ticks to the console, and the ledger was called.
    expect((sinks['logs'] as string[]).filter((line) => line.includes('"event":"mcf_tick"')).length).toBeGreaterThan(0);
    expect(r.ledger.calls.length).toBeGreaterThan(0);
    assertNoCanary(r.canary.tokens, sinks);
    const bodies = r.fake.requests.filter((request) => request.operation === 'preview' || request.operation === 'create').map((request) => request.body);
    if (expected.recipientRequests) {
      // Positive control: every field's value reached the fake Amazon, so the scan above had something real to miss.
      expect(bodies.length).toBeGreaterThan(0);
      for (const [field, value] of Object.entries(r.canary.recipient)) {
        if (field !== 'countryCode') expect(bodies.some((body) => body?.includes(value)), `${field} in a received request`).toBe(true);
      }
      expect(canaryPresent(r.canary.tokens, bodies)).toBe(true);
      // And the fake echoed the destination back in its answers, so the reader and writer had it to drop.
      expect(canaryPresent(r.canary.tokens, r.answers)).toBe(true);
      expect(r.provider.results.length).toBeGreaterThan(0);
    } else {
      expect(bodies).toHaveLength(0);
    }
    ran.push({ path: r.path, sinks: Object.keys(sinks), recipientRequests: bodies.length });
  }

  /** Seal (done), preview tick, approve as the owner. */
  async function approved(r: Run) {
    expect((await r.tick())?.send.previewed).toBe(1);
    const [preview] = await db.sql<{ id: string; fingerprint: string; total_units: number }[]>`select id, fingerprint, total_units
      from public.creator_mcf_send_previews where send_id = ${r.sendId} and kind = 'preview' order by recorded_at desc limit 1`;
    expect((await approveCreatorMcfSend(db, actor(r), { sendId: r.sendId, previewId: preview!.id, previewFingerprint: preview!.fingerprint, totalUnits: 1,
      confirmation: creatorMcfSendConfirmation(preview!.total_units), requestId: randomUUID() })).outcome).toBe('approved');
    r.flags.dispatch = true;
  }

  /** To placed: preview, approve, one POST, one settling read. */
  async function placed(r: Run) {
    await approved(r);
    await r.tick();
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
  }

  /** "Cancel in Amazon", the worker's preview read, and "Cancel 1 order in Amazon". */
  async function approvedCancel(r: Run) {
    expect(await requestCreatorMcfCancelPreview(db, actor(r), r.sendId)).toMatchObject({ outcome: 'cancel_preview_requested' });
    await r.tick();
    const preview = (await readCreatorMcfLane(db, actor(r), r.lane.record, r.lane.asin))!.send!.latestCancelPreview;
    expect(preview).not.toBeNull();
    expect(await approveCreatorMcfCancel(db, actor(r), { sendId: r.sendId, previewId: preview!.previewId, previewFingerprint: preview!.fingerprint,
      confirmation: creatorMcfCancelConfirmation(1), requestId: randomUUID() })).toMatchObject({ outcome: 'cancel_approved' });
  }

  it('seal, preview, approve, 200 and a settling read after a throttled one: placed, one POST', async () => {
    const r = await start('seal, preview, approve, 200, settle');
    await approved(r);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'accepted', posts: 1 });
    r.fake.readFailures = [{ kind: 'http', status: 429 }];
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed', amazon_status: 'Received' });
    expect(r.fake.posts).toBe(1);
    expect(r.thrown).toEqual([]);
    await finish(r, { recipientRequests: true });
  });

  it('duplicate 400 (the order already exists under the key): the read finds it, placed, one POST', async () => {
    const r = await start('duplicate 400');
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'], creates: true }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed', posts: 1 });
    expect(r.fake.operations.slice(-2)).toEqual(['create', 'get']);
    await finish(r, { recipientRequests: true });
  });

  it('other 400: the read finds nothing, rejected(validation), one POST', async () => {
    const r = await start('other 400');
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'] }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'rejected', provider_reason: 'validation' });
    expect(r.fake.posts).toBe(1);
    await finish(r, { recipientRequests: true });
  });

  it('429: rejected(throttled), one POST', async () => {
    const r = await start('429');
    await approved(r);
    r.fake.createAnswers = [{ kind: 'http', status: 429, codes: ['QuotaExceeded'] }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'rejected', provider_reason: 'throttled' });
    expect(r.fake.posts).toBe(1);
    await finish(r, { recipientRequests: true });
  });

  it('timeout: the writer aborts a hanging POST, uncertain; the ladder\'s read settles it as placed; one POST', async () => {
    const r = await start('timeout', { writerTimeoutMs: 200 });
    await approved(r);
    r.fake.createAnswers = [{ kind: 'hang', creates: true }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', provider_reason: 'transport' });
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    expect(r.fake.posts).toBe(1);
    await finish(r, { recipientRequests: true });
  });

  it('a lost answer (transport) with nothing at Amazon: uncertain, and the ladder\'s read and a 500 read echo it back', async () => {
    const r = await start('transport, uncertain');
    await approved(r);
    r.fake.createAnswers = [{ kind: 'transport' }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain', provider_reason: 'transport' });
    r.fake.readFailures = [{ kind: 'http', status: 500 }];
    await settleNow(r.sendId);
    await r.tick();
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'uncertain' });
    expect(r.fake.posts).toBe(1);
    uncertainForAlert = r.sendId;
    await finish(r, { recipientRequests: true });
  });

  it('conflict: another SKU is already under the key before the POST; no POST', async () => {
    const r = await start('conflict');
    await approved(r);
    r.fake.seedOrder({ sellerFulfillmentOrderId: r.lane.key, status: 'Received', sellerSku: 'OTHER-SKU', quantity: 1,
      destination: { ...r.canary.recipient } });
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'conflict', posts: 0 });
    expect(r.fake.posts).toBe(0);
    conflictsForAlert.push(r.sendId);
    await finish(r, { recipientRequests: true });
  });

  it('Amazon refuses the address at preview (a 400 echoing it): preview_refused with codes only', async () => {
    const r = await start('preview 400');
    r.fake.previewAnswers = [{ kind: 'http', status: 400, codes: ['InvalidDestinationAddress'] }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'provider_refused' });
    await finish(r, { recipientRequests: true });
  });

  it('a decrypted plaintext that fails validation: refused as recipient_invalid with field and rule codes, before any Amazon call', async () => {
    const r = await start('invalid plaintext', { plaintext: 'invalid' });
    const counts = await r.tick();
    expect(counts?.send).toMatchObject({ claimed: 1, previewRefused: 1, previewRefusedRecipient: 1 });
    expect(await send(r.sendId)).toMatchObject({ state: 'preview_refused', state_reason: 'recipient_invalid' });
    const [event] = await db.sql<{ codes: string[] }[]>`select codes from public.creator_mcf_send_events where send_id = ${r.sendId} and event = 'preview_refused'`;
    expect(event!.codes).toEqual(expect.arrayContaining(['phone.forbidden_field', 'recipient.unknown_field']));
    expect(r.fake.requests).toHaveLength(0);
    await finish(r, { recipientRequests: false });
  });

  it('cancel: the preview read, 200 and a read showing Cancelled', async () => {
    const r = await start('cancel 200');
    await placed(r);
    await approvedCancel(r);
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled', state_reason: 'operator_cancelled_in_amazon' });
    await finish(r, { recipientRequests: true });
  });

  it('cancel: a 4xx echoing the destination, then a read, then Cancelled after all', async () => {
    const r = await start('cancel 4xx');
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'http', status: 400, codes: ['InvalidInput'], cancels: true }];
    await r.tick();
    expect(r.fake.cancels).toBe(1);
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled' });
    await finish(r, { recipientRequests: true });
  });

  it('cancel: a 429 is not sent; the send is placed again', async () => {
    const r = await start('cancel 429');
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'http', status: 429, codes: ['QuotaExceeded'] }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'placed' });
    const [row] = await db.sql<{ ending: string | null }[]>`select ending from app.creator_mcf_cancels where send_id = ${r.sendId}`;
    expect(row!.ending).toBe('not_sent');
    await finish(r, { recipientRequests: true });
  });

  it('cancel: a lost answer (transport) is settled by reads, never sent again', async () => {
    const r = await start('cancel transport');
    await placed(r);
    await approvedCancel(r);
    r.fake.cancelAnswers = [{ kind: 'transport', cancels: true }];
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancel_dispatching' });
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled' });
    expect(r.fake.cancels).toBe(1);
    await finish(r, { recipientRequests: true });
  });

  it('cancel: withheld after its reservation (the flag turned off) is recorded as not sent', async () => {
    let flip: (() => void) | null = null;
    const r = await start('cancel not_sent', { wrapCancel: (store) => ({ ...store, reserveCancel: async (...args) => {
      const answer = await store.reserveCancel(...args);
      flip?.();
      return answer;
    } }) });
    await placed(r);
    await approvedCancel(r);
    flip = () => { r.flags.dispatch = false; };
    await r.tick();
    expect(r.fake.cancels).toBe(0);
    const [row] = await db.sql<{ ending: string | null; ending_reason: string | null }[]>`select ending, ending_reason from app.creator_mcf_cancels
      where send_id = ${r.sendId}`;
    expect(row).toEqual({ ending: 'not_sent', ending_reason: 'policy_off' });
    await finish(r, { recipientRequests: true });
  });

  it('cancel from conflict while Received: Cancelled', async () => {
    const r = await start('cancel from conflict');
    await approved(r);
    r.fake.seedOrder({ sellerFulfillmentOrderId: r.lane.key, status: 'Received', sellerSku: 'OTHER-SKU', quantity: 1,
      destination: { ...r.canary.recipient } });
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'conflict' });
    await approvedCancel(r);
    await r.tick();
    await settleNow(r.sendId);
    await r.tick();
    expect(await send(r.sendId)).toMatchObject({ state: 'cancelled' });
    await finish(r, { recipientRequests: true });
  });

  it('after every path: the mcf.observe job, a housekeeping tick with an alert, and a data-only export of every schema hold no token', async () => {
    expect(ran.map((entry) => entry.path)).toHaveLength(15);
    expect(allTokens.length).toBe(15 * 17);

    // The job queue: the observe pass enqueues one mcf.observe job per organisation with a lane to read; each job reads
    // through the echoing fake of its organisation and records observations; the job's result is stored on its row.
    const jobLogs: string[] = [];
    const logger = { info: (...args: unknown[]) => { jobLogs.push(sinkText(args)); }, error: (...args: unknown[]) => { jobLogs.push(sinkText(args)); } };
    const queue = new PostgresWorkerStore(db, { info: (message, details) => { jobLogs.push(sinkText([message, details])); } });
    const enqueued = await new McfObservePass(() => listCreatorMcfObserveScopes(db), queue, 30 * 60_000, logger).runOnce();
    const [observable] = await db.sql<{ n: number }[]>`select count(distinct org_id)::int as n from public.creator_sample_shipments
      where lane_state in ('Verified for Submit', 'Reconciliation Required', 'Confirmed')`;
    expect(observable!.n).toBeGreaterThanOrEqual(5);
    expect(enqueued?.enqueued).toBe(observable!.n);
    const jobs = await queue.claim('wp338j-observe', 50, ['mcf.observe']);
    expect(jobs).toHaveLength(enqueued!.enqueued);
    const observeProvider: Recorded = { calls: [], results: [], thrown: [] };
    const observeStore: Recorded = { calls: [], results: [], thrown: [] };
    const observeAnswers: string[] = [];
    let observed = 0;
    for (const job of jobs) {
      const fake = fakes.get(job.orgId) ?? new FakeFulfillmentOutbound({ echo: true });
      const fetch: typeof fake.fetch = async (input, init) => {
        try {
          const response = await fake.fetch(input, init);
          observeAnswers.push(`${JSON.stringify([...response.headers.entries()])}\n${await response.clone().text()}`);
          return response;
        } catch (error) {
          observeAnswers.push(sinkText(error));
          throw error;
        }
      };
      const reader = recorded(new FulfillmentOutboundReader({ endpoint: ENDPOINT, accessTokenProvider: FakeFulfillmentOutbound.tokens(),
        userAgent: 'wp338j-test', fetch }), observeProvider);
      try {
        const result = await observeCreatorMcfLanes({ reader, store: recorded(postgresMcfObserveStore(db), observeStore), pause: async () => {} },
          job.payload as McfObserveJob, job.id);
        observed += result.found + result.notFound;
        await queue.finish(job.id, 'succeeded', { result });
      } catch (error) {
        allThrown.push(error);
        await queue.finish(job.id, 'failed', { error: error instanceof Error ? error.message : 'unexpected' });
      }
    }
    expect(observed).toBeGreaterThan(0);
    // Positive control: the observe reads got the destination echoed back, so the reader had it to drop.
    expect(canaryPresent(allTokens, observeAnswers)).toBe(true);
    expect(observeStore.calls.length).toBeGreaterThan(0);
    const jobRows = await db.sql<{ row: string }[]>`select j::text as row from public.sync_jobs j where job_type = 'mcf.observe'`;
    expect(jobRows).toHaveLength(jobs.length);

    // The general worker's housekeeping tick: an uncertain send older than 15 minutes and a conflict raise an alert,
    // posted to a webhook; a second pass without a webhook logs the same message.
    expect(uncertainForAlert).not.toBeNull();
    await backdate((sql) => sql`update public.creator_mcf_sends set state_changed_at = now() - interval '20 minutes' where id = ${uncertainForAlert!}`);
    // The tenant fixture seals one placeholder send per organisation (zero bytes, no recipient). Their custody is let run
    // past its two hours, so the tick's own sweep must end it: the custody table is empty only if the sweep works.
    const [fixtureCustody] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where key_id <> ${key.keyId}`;
    expect(fixtureCustody!.n).toBeGreaterThanOrEqual(15);
    expect(await custodyRows()).toBe(fixtureCustody!.n);
    await backdate((sql) => sql`update app.creator_mcf_recipient_custody set created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
      where key_id <> ${key.keyId}`);
    const posted: string[] = [];
    const housekeepingLogs: string[] = [];
    const hkLogger = { info: (...args: unknown[]) => { housekeepingLogs.push(sinkText(args)); }, warn: (...args: unknown[]) => { housekeepingLogs.push(sinkText(args)); },
      error: (...args: unknown[]) => { housekeepingLogs.push(sinkText(args)); } };
    const housekeepingStore: Recorded = { calls: [], results: [], thrown: [] };
    const withWebhook = new McfHousekeepingPass({ store: recorded(postgresMcfHousekeepingStore(db), housekeepingStore), logger: hkLogger,
      config: { webhookUrl: 'https://alerts.invalid/synthetic-hook', samplesUrl: 'https://arcana.invalid/creators/samples' },
      fetch: async (_url, init) => { posted.push(String(init.body)); return new Response(null, { status: 204 }); } });
    const tick = await withWebhook.runOnce();
    expect(tick).toMatchObject({ alert: 'changed', delivery: 'sent', expire: { expiredTtl: fixtureCustody!.n } });
    const codes = tick!.conditions === 'failed' ? [] : tick!.conditions.map((condition) => condition.code);
    expect(codes).toEqual(expect.arrayContaining(['uncertain_over_15m', 'conflict']));
    expect(posted).toHaveLength(1);
    // Positive control for the alert: it names the sends it is about.
    expect(posted[0]).toContain(uncertainForAlert!);
    for (const id of conflictsForAlert) expect(posted[0]).toContain(id);
    const withoutWebhook = new McfHousekeepingPass({ store: recorded(postgresMcfHousekeepingStore(db), housekeepingStore), logger: hkLogger,
      config: { webhookUrl: null, samplesUrl: '/creators/samples' } });
    expect(await withoutWebhook.runOnce()).toMatchObject({ alert: 'changed', delivery: 'no_webhook' });
    expect(housekeepingLogs.some((line) => line.includes(uncertainForAlert!))).toBe(true);
    expect(housekeepingStore.calls.length).toBeGreaterThanOrEqual(5);

    // Custody is empty and the residue is (0, 0).
    expect(await custodyRows()).toBe(0);
    expect(await residue()).toEqual([0, 0]);

    // A data-only export of every table in every non-system schema, one text row per table row (what pg_dump --data-only
    // would print for these values: bytea as hex, json and text verbatim).
    const tables = await db.sql<{ schema: string; name: string }[]>`select n.nspname as schema, c.relname as name from pg_class c
      join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and not c.relispartition
        and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
      order by 1, 2`;
    const dump: string[] = [];
    const perTable = new Map<string, number>();
    for (const table of tables) {
      const rows = await db.sql.unsafe<{ row: string }[]>(`select t::text as row from ${quoted(table.schema)}.${quoted(table.name)} t`);
      perTable.set(`${table.schema}.${table.name}`, rows.length);
      dump.push(`-- ${table.schema}.${table.name}`, ...rows.map((entry) => entry.row));
    }
    const dumpedRows = [...perTable.values()].reduce((sum, n) => sum + n, 0);
    const names = tables.map((table) => `${table.schema}.${table.name}`);
    expect(names).toEqual(expect.arrayContaining(['public.creator_mcf_sends', 'public.creator_mcf_send_events', 'public.creator_mcf_send_previews',
      'public.creator_mcf_outbox', 'public.creator_mcf_observations', 'app.creator_mcf_recipient_custody', 'app.creator_mcf_cancels',
      'app.creator_mcf_worker_heartbeats', 'public.sync_jobs', 'public.audit_log', 'public.creator_action_log', 'public.creator_sample_shipments']));
    expect(dumpedRows).toBeGreaterThan(200);
    // The tables a leak would land in were read with rows in them, not merely listed.
    for (const table of ['public.creator_mcf_sends', 'public.creator_mcf_send_events', 'public.creator_mcf_send_previews', 'public.creator_mcf_outbox',
      'public.creator_mcf_observations', 'app.creator_mcf_cancels', 'app.creator_mcf_worker_heartbeats', 'public.sync_jobs', 'public.creator_action_log',
      'public.creator_sample_shipments', 'app.creator_mcf_grants']) {
      expect(perTable.get(table), table).toBeGreaterThan(0);
    }

    assertNoCanary(allTokens, {
      logs: consoleLines,
      jobLogs,
      housekeepingLogs,
      alertMessages: posted,
      thrown: [...allThrown, ...observeProvider.thrown, ...observeStore.thrown, ...housekeepingStore.thrown],
      jobRows: jobRows.map((entry) => entry.row),
      observeReads: observeProvider.results,
      observeLedger: [observeStore.calls, observeStore.results],
      housekeepingLedger: [housekeepingStore.calls, housekeepingStore.results],
      dataOnlyExport: dump,
    });
    // The fake Amazon holds every path's recipient (the positive control over the whole run), and the scan finds it there.
    const received = [...fakes.values()].flatMap((fake) => fake.requests.map((request) => request.body));
    expect(canaryPresent(allTokens, received)).toBe(true);
    expect(ran.filter((entry) => entry.recipientRequests > 0)).toHaveLength(14);
  });
});

/** A double-quoted identifier. */
function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
