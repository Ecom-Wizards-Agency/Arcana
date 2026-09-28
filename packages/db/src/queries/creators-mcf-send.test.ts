/**
 * WP-338d against a migrated database: the MCF send ledger (migration
 * 20260928120000_creator_mcf_send), and WP-338i's guarded Amazon cancel with
 * its ledger follow-ups (migration 20260928130000_creator_mcf_cancel). Privileges on custody and grants, every
 * refusal of seal, approve and reserve, custody destroyed on every
 * custody-ending transition, the expiry sweep without a scheduler, the lane
 * ownership seam against the runner's import and MCP upsert, WP-334's
 * escalation, classification, the late outcome, the org purge, the mask purge,
 * and the wording shared with TypeScript. Synthetic values only: ids, keys and
 * envelopes are generated at run time and every envelope is random bytes
 * except one real HPKE seal whose plaintext is random tokens.
 */
import { randomBytes, randomUUID, type webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CREATOR_MCF_ENVELOPE_SUITE, CREATOR_MCF_IRREVERSIBILITY, CREATOR_MCF_SEND_TRANSITIONS, CreatorMcfSendState, canTransitionCreatorMcfSend,
  creatorMcfBase64UrlEncode, creatorMcfCancelConfirmation, type CreatorMcfCancelPreview, creatorMcfPreviewFingerprint, creatorMcfRecipientKeyId, creatorMcfSendConfirmation, importCreatorMcfRecipientKey,
  isCustodyHeldState, isTerminalState, openCreatorMcfRecipient, sealCreatorMcfRecipient as sealEnvelope, type CreatorMcfPreview,
} from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, migrationFiles, type TestDatabase } from '../testing/harness.js';
import { asAnon, asServiceRole, asUser } from '../testing/rls.js';
import { AgencyAccessDenied, withAuthenticatedActor } from './authenticated-actor.js';
import { creatorSampleOrderKey, persistCreatorImport, readCreatorSampleShipments, writeCreatorMcpRows, type CreatorShipmentWrite } from './creators.js';
import { recordCreatorMcfObservation } from './creators-samples.js';
import { createRequestDatabase } from './request-client.js';
import {
  approveCreatorMcfCancel, approveCreatorMcfSend, claimCreatorMcfOutbox, expireCreatorMcfCustody, markCreatorMcfLadderExhausted, purgeCreatorMcfMasks,
  readCreatorMcfActiveKeyIds, readCreatorMcfAlertSummary, readCreatorMcfCustody, readCreatorMcfCustodyResidue, readCreatorMcfLane,
  readCreatorMcfSendGate, readCreatorMcfSendOutcome, recordCreatorMcfCancelOutcome, recordCreatorMcfCancelPreview, recordCreatorMcfHeartbeat,
  recordCreatorMcfOutcome, recordCreatorMcfPreview, recordCreatorMcfSettlement, refreshCreatorMcfPreview, refuseCreatorMcfPreview,
  recordCreatorMcfCancelUnsent, releaseCreatorMcfClaim, releaseCreatorMcfSend, requestCreatorMcfCancelPreview, requestCreatorMcfSettleRead,
  reserveCreatorMcfCancel,
  reserveCreatorMcfDispatch, resolveCreatorMcfConflict, sealCreatorMcfRecipient, withdrawCreatorMcfSend, type CreatorMcfClaim,
  type CreatorMcfOrderRead, type CreatorMcfOutboxAction,
} from './creators-mcf-send.js';

const available = await databaseAvailable();
const MIGRATION = '20260928120000_creator_mcf_send.sql';
const CANCEL_MIGRATION = '20260928130000_creator_mcf_cancel.sql';
const PREVIOUS = '20260927120000_creator_sample_preflight_observation.sql';

const OWNER = randomUUID();
const ADMIN = randomUUID();
const ANALYST = randomUUID();
const VIEWER = randomUUID();
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const b64 = (bytes: Uint8Array) => creatorMcfBase64UrlEncode(bytes);
const ONE = 'Send 1 unit via Amazon';
let recordNumber = 1000;
let KEY_ID = '';
let OTHER_KEY_ID = '';

interface Org { id: string; connection: string; marketplace: string; scope: string }
interface Lane { org: Org; record: string; asin: string; key: string; reservation: string; sku: string }

describe.skipIf(!available)('Creator MCF send ledger', () => {
  let db: TestDatabase;
  let main: Org;
  let capOrg: Org;

  const actor = (org: Org, userId = OWNER) => ({ orgId: org.id, userId });

  async function newOrg(slug: string, grant: { units?: number; actions?: string[]; keys?: string[] } | null = {}): Promise<Org> {
    const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`${slug}-${hex(3)}`}, ${OWNER}, 'owner') as id`;
    const id = row!.id;
    for (const [user, role] of [[ADMIN, 'admin'], [ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await db.sql`select public.auth_user_stub(${user})`;
      await db.sql`insert into public.org_members(org_id, user_id, role) values (${id}, ${user}, ${role})`;
    }
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active', vault_secret_id = gen_random_uuid()
      where org_id = ${id}`);
    await db.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${id}`;
    const [binding] = await db.sql<{ connection_id: string; marketplace_id: string }[]>`select connection_id, marketplace_id
      from public.spapi_profile_bindings where org_id = ${id}`;
    const org = { id, connection: binding!.connection_id, marketplace: binding!.marketplace_id,
      scope: `${binding!.connection_id}:${binding!.marketplace_id}` };
    if (grant !== null) await regrant(org, grant);
    return org;
  }

  async function regrant(org: Org, grant: { units?: number; actions?: string[]; keys?: string[]; enabledAt?: string; expiresAt?: string } = {}) {
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org.id} and revoked_at is null`;
    await db.sql`insert into app.creator_mcf_grants(org_id, spapi_connection_id, marketplace_id, action_classes, recipient_key_ids,
        max_units_per_day, max_fee_minor, currency, enabled_by, enabled_at, expires_at)
      values (${org.id}, ${org.connection}, ${org.marketplace}, ${grant.actions ?? ['send', 'cancel']}::text[], ${grant.keys ?? [KEY_ID]}::text[],
        ${grant.units ?? 20}, 1500, 'USD', 'synthetic operator', ${grant.enabledAt ?? new Date().toISOString()}::timestamptz,
        ${grant.expiresAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString()}::timestamptz)`;
  }

  async function newLane(org: Org, change: { laneState?: string; reservation?: string | null; lock?: string; sku?: string; preflight?: boolean } = {}): Promise<Lane> {
    const record = `CCR-SW-26-${recordNumber++}`;
    const asin = `B0${hex(4).toUpperCase()}`;
    const reservation = change.reservation === undefined ? `MCFR-${hex(8).toUpperCase()}` : change.reservation;
    const sku = change.sku ?? `SYN-${hex(3).toUpperCase()}`;
    await db.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, thread_fp, record_state, lock_state,
        runner_version, created_on, source, source_digest)
      values (${org.id}, ${record}, 'Synthetic brand', 'campaign-synthetic-1', ${hex(32)}, 'Active', ${change.lock ?? 'Unlocked'}, 1,
        '2026-09-01', 'control-runner', ${hex(32)})`;
    await db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state,
        fee_cents, fee_cap_cents, reserved_at, source, source_digest)
      values (${org.id}, ${record}, ${asin}, ${sku}, 'campaign-synthetic-1', ${reservation}, ${change.laneState ?? 'Reserved'}, 620, 800,
        now() - interval '10 minutes', 'control-runner', ${hex(32)})`;
    if (change.preflight !== false) await preflight(org, record, asin, 'PASS', sku);
    return { org, record, asin, key: creatorSampleOrderKey(org.id, record, asin), reservation: reservation ?? '', sku };
  }

  async function preflight(org: Org, record: string, asin: string, result: 'PASS' | 'HOLD', sku: string, completedAgo = '1 minute') {
    await db.sql`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin, result, errors,
        required_next_state, detail, started_at, completed_at, source, source_digest)
      values (${org.id}, ${`preflight-${hex(6)}`}, 'preflight', ${record}, ${asin}, ${result},
        ${result === 'PASS' ? [] : ['selected_sku_not_mcf_fulfillable']}::text[], ${result === 'PASS' ? 'Locked for MCF' : 'Conflict or Held'},
        ${JSON.stringify({ sku, quantity: 1 })}::text::jsonb, date_trunc('milliseconds', now()) - ${completedAgo}::interval - interval '5 seconds',
        date_trunc('milliseconds', now()) - ${completedAgo}::interval, 'mcp', ${hex(32)})`;
  }

  const envelope = (change: Record<string, unknown> = {}) => ({
    v: 1, suite: CREATOR_MCF_ENVELOPE_SUITE, envelopeId: randomUUID(), keyId: KEY_ID,
    enc: b64(Uint8Array.of(4, ...randomBytes(64))), ciphertext: b64(randomBytes(48)), mask: { countryCode: 'US', postalPrefix: '94', lines: 2 },
    ...change,
  });
  const binding = (lane: Lane) => ({ orgId: lane.org.id, creatorRecordId: lane.record, asin: lane.asin, derivedOrderKey: lane.key,
    reservationId: lane.reservation });

  async function seal(lane: Lane, userId = OWNER, env: Record<string, unknown> = envelope()) {
    return sealCreatorMcfRecipient(db, actor(lane.org, userId), { creatorRecordId: lane.record, asin: lane.asin, request: { binding: binding(lane), envelope: env } });
  }
  async function sealRaw(lane: Lane, request: unknown): Promise<Record<string, unknown>> {
    const [row] = await asUser(db, OWNER, (sql) => sql<{ result: Record<string, unknown> }[]>`select app.seal_creator_mcf_recipient(
      ${lane.org.id}::uuid, ${lane.record}, ${lane.asin}, ${JSON.stringify(request)}::text::jsonb) as result`);
    return row!.result;
  }

  async function claimFor(org: Org, sendId: string, action: CreatorMcfOutboxAction): Promise<CreatorMcfClaim> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const claim = await claimCreatorMcfOutbox(db, { claimant: 'wp338d-test', scope: [org.scope], actions: [action] });
      if (claim === null) break;
      if (claim.sendId === sendId) return claim;
      await releaseCreatorMcfClaim(db, claim.sendId, claim.leaseId, 3600);
    }
    throw new Error(`no ${action} work for the send`);
  }

  function preview(claim: CreatorMcfClaim, lane: Lane, change: Partial<Record<string, unknown>> = {}): CreatorMcfPreview {
    const readAt = new Date();
    return {
      previewId: randomUUID(), sendId: claim.sendId, derivedOrderKey: lane.key, reservationId: lane.reservation,
      spapiConnectionId: claim.spapiConnectionId, marketplaceId: claim.marketplaceId, readAt: readAt.toISOString(),
      validUntil: new Date(readAt.getTime() + 30 * 60_000).toISOString(), workerRevision: 'wp338d-test', kind: 'preview',
      preflightRunId: claim.preflight.runId, preflightCompletedAt: claim.preflight.completedAt, asin: lane.asin,
      items: [{ sellerSku: lane.sku, sellerFulfillmentOrderItemId: `${lane.key}-1`, quantity: 1 }], totalUnits: 1,
      shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', featureConstraints: [], existingOrder: 'none',
      isFulfillable: true, fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 620 }], totalMinor: 620, currency: 'USD' },
      unfulfillableReasons: [], earliestArrivalDate: '2026-10-02', latestArrivalDate: '2026-10-05',
      laneFeeCapMinor: claim.caps.laneFeeCapMinor, grantFeeCapMinor: claim.caps.grantFeeCapMinor, grantCurrency: claim.caps.grantCurrency,
      envelopeSha256: claim.envelopeSha256, keyId: claim.keyId, irreversibility: CREATOR_MCF_IRREVERSIBILITY, ...change,
    } as CreatorMcfPreview;
  }

  async function previewReady(lane: Lane, change: Partial<Record<string, unknown>> = {}) {
    const sealed = await seal(lane);
    if (sealed.outcome !== 'sealed') throw new Error(`seal refused: ${sealed.reason}`);
    const claim = await claimFor(lane.org, sealed.sendId, 'preview');
    const body = preview(claim, lane, change);
    const recorded = await recordCreatorMcfPreview(db, claim.sendId, claim.leaseId, body);
    expect(recorded.decision).toBe('preview_ready');
    return { sendId: sealed.sendId, preview: body, fingerprint: String(recorded['fingerprint']), claim };
  }

  async function approved(lane: Lane, userId = OWNER) {
    const ready = await previewReady(lane);
    const result = await approveCreatorMcfSend(db, actor(lane.org, userId), { sendId: ready.sendId, previewId: ready.preview.previewId,
      previewFingerprint: ready.fingerprint, totalUnits: 1, confirmation: ONE, requestId: randomUUID() });
    expect(result.outcome).toBe('approved');
    return ready;
  }

  const reread = (claim: CreatorMcfClaim, change: Partial<Record<string, unknown>> = {}) => {
    const readAt = new Date();
    return recordCreatorMcfPreview(db, claim.sendId, claim.leaseId, { ...claim.approval!.preview, previewId: randomUUID(), kind: 'dispatch_reread',
      readAt: readAt.toISOString(), validUntil: new Date(readAt.getTime() + 30 * 60_000).toISOString(), ...change } as CreatorMcfPreview);
  };

  async function dispatchClaimed(lane: Lane, userId = OWNER) {
    const ready = await approved(lane, userId);
    const claim = await claimFor(lane.org, ready.sendId, 'dispatch');
    return { ...ready, claim };
  }

  async function dispatching(lane: Lane) {
    const run = await dispatchClaimed(lane);
    expect((await reread(run.claim)).decision).toBe('same');
    const reserved = await reserveCreatorMcfDispatch(db, run.sendId, run.claim.leaseId, hex(32));
    expect(reserved.decision).toBe('dispatch_once');
    return run;
  }

  const found = (lane: Lane, status: string, change: Partial<Record<string, unknown>> = {}): CreatorMcfOrderRead => ({
    outcome: 'found', operation: 'getFulfillmentOrder', status, readAt: new Date().toISOString(), sellerFulfillmentOrderId: lane.key,
    items: [{ sellerSku: lane.sku, quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }], shipments: [], packages: [], ...change,
  } as CreatorMcfOrderRead);
  const notFound = (operation: 'getFulfillmentOrder' | 'listAllFulfillmentOrders' = 'getFulfillmentOrder', readAt = new Date()): CreatorMcfOrderRead =>
    ({ outcome: 'not_found', operation, readAt: readAt.toISOString() });

  /** Moves timestamps as the owner with triggers off; the only way a test can age a row. */
  async function backdate(run: (sql: postgres.TransactionSql) => Promise<unknown>) {
    await db.sql.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      await run(sql);
    });
  }

  async function sendRow(sendId: string) {
    const [row] = await db.sql<{ state: string; state_reason: string | null; custody_destroyed_reason: string | null; posts: number;
      approved_units: number | null; mask: unknown; ciphertext_sha256: string; escalation_reason: string | null; mask_purge_after: Date | null;
      provider_outcome: string | null; amazon_status: string | null }[]>`select state, state_reason, custody_destroyed_reason, posts,
      approved_units, mask, ciphertext_sha256, escalation_reason, mask_purge_after, provider_outcome, amazon_status
      from public.creator_mcf_sends where id = ${sendId}`;
    return row!;
  }
  async function laneRow(lane: Lane) {
    const [row] = await db.sql<{ lane_state: string; order_owner: string; runner_order_id: string | null; verified_at: Date | null;
      confirmed_at: Date | null; cancellation_reason: string | null; reconciliation_reason: string | null; mcf_not_found_probes: number;
      mcf_settlement: string | null; reservation_id: string | null }[]>`select lane_state, order_owner, runner_order_id, verified_at, confirmed_at,
      cancellation_reason, reconciliation_reason, mcf_not_found_probes, mcf_settlement, reservation_id
      from public.creator_sample_shipments where org_id = ${lane.org.id} and creator_record_id = ${lane.record} and asin = ${lane.asin}`;
    return row!;
  }
  async function ledgerCounts(orgId: string) {
    const [row] = await db.sql<{ sends: number; custody: number; outbox: number; events: number; previews: number }[]>`select
      (select count(*)::int from public.creator_mcf_sends where org_id = ${orgId}) as sends,
      (select count(*)::int from app.creator_mcf_recipient_custody where org_id = ${orgId}) as custody,
      (select count(*)::int from public.creator_mcf_outbox o join public.creator_mcf_sends s on s.id = o.send_id where s.org_id = ${orgId}) as outbox,
      (select count(*)::int from public.creator_mcf_send_events where org_id = ${orgId}) as events,
      (select count(*)::int from public.creator_mcf_send_previews where org_id = ${orgId}) as previews`;
    return row!;
  }
  async function custodyProof(sendId: string) {
    const [custody] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${sendId}`;
    const tombstones = await db.sql<{ reason: string; digest: string }[]>`select reason, digests->>'ciphertextSha256' as digest
      from public.creator_mcf_send_events where send_id = ${sendId} and event = 'custody_destroyed'`;
    return { custody: custody!.n, tombstones, residue: await readCreatorMcfCustodyResidue(db) };
  }

  beforeAll(async () => {
    db = await createTestDatabase('wp338d_mcf_send');
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
    KEY_ID = await creatorMcfRecipientKeyId(await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey));
    OTHER_KEY_ID = hex(32);
    main = await newOrg('mcf-main');
    capOrg = await newOrg('mcf-cap', { units: 1 });
  }, 240_000);
  afterAll(async () => { await db?.drop(); });
  // Each test starts from a quiet ledger: an earlier test's dispatching send is settled as a crash by the
  // sweep, and earlier open work is closed, so claims and sweep counts see only this test's sends.
  beforeEach(async () => {
    if (!db) return;
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where state = 'dispatching'`);
    await expireCreatorMcfCustody(db);
    await db.sql`update public.creator_mcf_outbox set completed_at = now() where completed_at is null`;
  });

  it('(15) applies after 20260927120000, followed by the cancel migration as the newest, and schedules both jobs where cron.schedule exists', async () => {
    const files = await migrationFiles();
    expect(files.at(-1)).toBe(CANCEL_MIGRATION);
    expect(files.indexOf(MIGRATION)).toBe(files.indexOf(PREVIOUS) + 1);
    expect(files.indexOf(CANCEL_MIGRATION)).toBe(files.indexOf(MIGRATION) + 1);
    const jobs = await db.sql<{ jobname: string; schedule: string; command: string }[]>`select jobname, schedule, command from cron.job
      where jobname like 'wizard-ads-creator-mcf-%' order by jobname`;
    expect(jobs).toEqual([
      { jobname: 'wizard-ads-creator-mcf-expire', schedule: '*/5 * * * *', command: 'select app.expire_creator_mcf_custody()' },
      { jobname: 'wizard-ads-creator-mcf-mask-purge', schedule: '20 3 * * *', command: 'select app.purge_creator_mcf_masks()' },
    ]);
  });

  it('(15) on a fresh database without pg_cron the migration applies after 20260927120000 and logs the notice', async () => {
    const fresh = await createTestDatabase('wp338d_no_cron', { throughMigration: PREVIOUS, applyFixture: false });
    try {
      await fresh.sql`drop function cron.schedule(text, text, text)`;
      const notices: string[] = [];
      const sql = postgres(fresh.connectionString, { max: 1, onnotice: (notice) => { notices.push(String(notice['message'])); } });
      try {
        await sql.unsafe(await readFile(fileURLToPath(new URL(`../../../../supabase/migrations/${MIGRATION}`, import.meta.url)), 'utf8'));
      } finally {
        await sql.end({ timeout: 5 });
      }
      expect(notices.filter((notice) => notice.startsWith('cron.schedule() not present; creator MCF custody expiry and mask purge not scheduled'))).toHaveLength(1);
      const [state] = await fresh.sql<{ jobs: number; functions: number; tables: number }[]>`select
        (select count(*)::int from cron.job where jobname like 'wizard-ads-creator-mcf-%') as jobs,
        (select count(*)::int from pg_proc where pronamespace = 'app'::regnamespace and proname in ('expire_creator_mcf_custody',
          'purge_creator_mcf_masks', 'seal_creator_mcf_recipient', 'reserve_creator_mcf_dispatch')) as functions,
        (select count(*)::int from pg_class where oid in (to_regclass('app.creator_mcf_recipient_custody'), to_regclass('app.creator_mcf_grants'),
          to_regclass('public.creator_mcf_sends'), to_regclass('public.creator_mcf_outbox'))) as tables`;
      expect(state).toEqual({ jobs: 0, functions: 4, tables: 4 });
    } finally {
      await fresh.drop();
    }
  }, 240_000);

  it('binds jsonb through the web request client (default serializers) as objects, not double-encoded strings', async () => {
    // The web's handle is createRequestDatabase (openWebDatabase), which keeps postgres' default serializers.
    const web = createRequestDatabase(db.connectionString);
    try {
      const org = await newOrg('mcf-request-client');
      const lane = await newLane(org);
      const sealed = await sealCreatorMcfRecipient(web, actor(org), { creatorRecordId: lane.record, asin: lane.asin,
        request: { binding: binding(lane), envelope: envelope() } });
      expect(sealed).toMatchObject({ outcome: 'sealed', state: 'sealed' });
      const sendId = sealed.outcome === 'sealed' ? sealed.sendId : '';
      const [stored] = await db.sql<{ mask: string; mask_country: string }[]>`select jsonb_typeof(mask) as mask, mask->>'countryCode' as mask_country
        from public.creator_mcf_sends where id = ${sendId}`;
      expect(stored).toEqual({ mask: 'object', mask_country: 'US' });
      // Service-role jsonb binds: the outcome and the settlement read, through the same client.
      const claim = await claimFor(org, sendId, 'preview');
      expect((await recordCreatorMcfPreview(web, sendId, claim.leaseId, preview(claim, lane))).decision).toBe('preview_ready');
      const ready = await readCreatorMcfLane(web, actor(org), lane.record, lane.asin);
      const approval = await approveCreatorMcfSend(web, actor(org), { sendId, previewId: ready!.send!.latestPreview!.previewId,
        previewFingerprint: ready!.send!.latestPreview!.fingerprint, totalUnits: 1, confirmation: ONE, requestId: randomUUID() });
      expect(approval.outcome).toBe('approved');
      const dispatch = await claimFor(org, sendId, 'dispatch');
      expect((await reread(dispatch)).decision).toBe('same');
      expect((await reserveCreatorMcfDispatch(web, sendId, dispatch.leaseId, hex(32))).decision).toBe('dispatch_once');
      expect(await recordCreatorMcfOutcome(web, sendId, dispatch.leaseId, { outcome: 'rejected', status: 400, codes: ['DuplicateOrder'],
        reason: 'validation' }, found(lane, 'New'))).toEqual({ decision: 'recorded', state: 'accepted' });
      const shipments = [{ amazonShipmentId: 'shipment-9', status: 'PENDING', shippedAt: null, estimatedArrivalAt: null,
        packages: [{ packageNumber: 9, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-9', estimatedArrivalAt: null }] }];
      expect(await recordCreatorMcfSettlement(web, sendId, found(lane, 'Received', { shipments } as never))).toMatchObject({ state: 'placed' });
      const reads = await db.sql<{ shipments: string | null; status: string | null }[]>`select jsonb_typeof(shipments) as shipments, mcf_status as status
        from public.creator_mcf_observations where org_id = ${org.id} and observation_key like ${`mcf-send:${sendId}:%`} order by recorded_at, observation_key`;
      expect(reads).toEqual([{ shipments: 'array', status: 'New' }, { shipments: 'array', status: 'Received' }]);
      expect(await sendRow(sendId)).toMatchObject({ state: 'placed', provider_outcome: 'rejected', amazon_status: 'Received' });
    } finally {
      await web.close();
    }
  });

  it('(1) gives anon, authenticated and service_role no privilege on custody, grants or heartbeats, with RLS on', async () => {
    const rows = await db.sql<{ relation: string; role: string; privileged: boolean; columns: boolean; rls: boolean }[]>`
      select c.oid::regclass::text as relation, r.role,
        has_table_privilege(r.role, c.oid, 'SELECT') or has_table_privilege(r.role, c.oid, 'INSERT') or has_table_privilege(r.role, c.oid, 'UPDATE')
          or has_table_privilege(r.role, c.oid, 'DELETE') or has_table_privilege(r.role, c.oid, 'TRUNCATE')
          or has_table_privilege(r.role, c.oid, 'REFERENCES') or has_table_privilege(r.role, c.oid, 'TRIGGER') as privileged,
        has_any_column_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES') as columns, c.relrowsecurity as rls
      from pg_class c cross join unnest(array['anon', 'authenticated', 'service_role']) r(role)
      where c.oid in ('app.creator_mcf_recipient_custody'::regclass, 'app.creator_mcf_grants'::regclass, 'app.creator_mcf_worker_heartbeats'::regclass,
        'app.creator_mcf_cancels'::regclass)
      order by 1, 2`;
    expect(rows).toHaveLength(12);
    expect(rows.filter((row) => row.privileged || row.columns || !row.rls)).toEqual([]);
    for (const run of [(fn: (sql: postgres.Sql) => Promise<unknown>) => asUser(db, OWNER, fn as never), (fn: (sql: postgres.Sql) => Promise<unknown>) =>
      asServiceRole(db, fn as never), (fn: (sql: postgres.Sql) => Promise<unknown>) => asAnon(db, fn as never)]) {
      await expect(run((sql) => sql`select count(*) from app.creator_mcf_recipient_custody`)).rejects.toMatchObject({ code: '42501' });
      await expect(run((sql) => sql`select count(*) from app.creator_mcf_grants`)).rejects.toMatchObject({ code: '42501' });
      await expect(run((sql) => sql`select count(*) from app.creator_mcf_cancels`)).rejects.toMatchObject({ code: '42501' });
    }
    const tables = await db.sql<{ relation: string; role: string; readable: boolean; writable: boolean }[]>`
      select t.relation, r.role, has_table_privilege(r.role, t.relation, 'SELECT') as readable,
        has_table_privilege(r.role, t.relation, 'INSERT') or has_table_privilege(r.role, t.relation, 'UPDATE')
          or has_table_privilege(r.role, t.relation, 'DELETE') or has_table_privilege(r.role, t.relation, 'TRUNCATE') as writable
      from unnest(array['public.creator_mcf_sends', 'public.creator_mcf_send_previews', 'public.creator_mcf_send_events', 'public.creator_mcf_outbox']) t(relation)
      cross join unnest(array['anon', 'authenticated', 'service_role']) r(role) order by 1, 2`;
    expect(tables.filter((row) => row.writable)).toEqual([]);
    expect(tables.filter((row) => row.readable).map((row) => `${row.relation}:${row.role}`)).toEqual([
      'public.creator_mcf_outbox:service_role', 'public.creator_mcf_send_events:authenticated', 'public.creator_mcf_send_events:service_role',
      'public.creator_mcf_send_previews:authenticated', 'public.creator_mcf_send_previews:service_role',
      'public.creator_mcf_sends:authenticated', 'public.creator_mcf_sends:service_role']);
    const grants = await db.sql<{ proname: string; role: string }[]>`select p.proname, role.rolname as role from pg_proc p
      cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl join pg_roles role on role.oid = acl.grantee
      where p.pronamespace = 'app'::regnamespace and p.proname like '%creator_mcf%' and role.rolname in ('anon', 'authenticated', 'service_role', 'public')
      order by 2, 1`;
    expect(grants.filter((grant) => grant.role === 'anon')).toEqual([]);
    expect(grants.filter((grant) => grant.role === 'authenticated').map((grant) => grant.proname).sort()).toEqual([
      'approve_creator_mcf_cancel', 'approve_creator_mcf_send', 'creator_mcf_cancel_confirmation', 'creator_mcf_send_confirmation',
      'creator_mcf_send_gate', 'read_creator_mcf_lane', 'refresh_creator_mcf_preview', 'release_creator_mcf_send', 'request_creator_mcf_cancel_preview',
      'request_creator_mcf_settle_read', 'resolve_creator_mcf_conflict', 'seal_creator_mcf_recipient', 'withdraw_creator_mcf_send']);
    expect(grants.filter((grant) => grant.role === 'service_role').map((grant) => grant.proname).sort()).toEqual([
      'claim_creator_mcf_outbox', 'creator_mcf_active_key_ids', 'creator_mcf_alert_summary', 'creator_mcf_cancel_confirmation',
      'creator_mcf_custody_residue', 'creator_mcf_send_confirmation', 'expire_creator_mcf_custody', 'mark_creator_mcf_ladder_exhausted',
      'purge_creator_mcf_masks', 'read_creator_mcf_custody', 'record_creator_mcf_cancel_outcome', 'record_creator_mcf_cancel_preview', 'record_creator_mcf_cancel_unsent',
      'record_creator_mcf_heartbeat', 'record_creator_mcf_outcome', 'record_creator_mcf_preview', 'record_creator_mcf_settlement',
      'refuse_creator_mcf_preview', 'release_creator_mcf_claim', 'reserve_creator_mcf_cancel', 'reserve_creator_mcf_dispatch']);
    const definers = await db.sql<{ proname: string }[]>`select proname from pg_proc where pronamespace = 'app'::regnamespace
      and proname like '%creator_mcf%' and prosecdef and not coalesce(proconfig::text like '%search_path=%', false)`;
    expect(definers).toEqual([]);
    // A client role cannot reach a service-role function, and an authenticated user cannot claim.
    await expect(asUser(db, OWNER, (sql) => sql`select app.claim_creator_mcf_outbox('x', '{}', '{preview}')`)).rejects.toMatchObject({ code: '42501' });
    await expect(asUser(db, OWNER, (sql) => sql`select app.creator_mcf_sweep(null)`)).rejects.toMatchObject({ code: '42501' });
  });

  it('(14) computes the Send wording in SQL exactly as the shared function does, for 1 to 20', async () => {
    const rows = await db.sql<{ n: number; wording: string | null }[]>`select n, app.creator_mcf_send_confirmation(n) as wording
      from generate_series(0, 21) n order by n`;
    expect(rows).toHaveLength(22);
    for (let n = 1; n <= 20; n++) expect(rows[n]!.wording).toBe(creatorMcfSendConfirmation(n));
    expect([rows[0]!.wording, rows[21]!.wording]).toEqual([null, null]);
  });

  it('enforces the shared transition map, custody states and terminal states in SQL', async () => {
    const states = CreatorMcfSendState.options;
    const rows = await db.sql<{ state: string; next: string[]; held: boolean; terminal: boolean }[]>`select s as state,
      app.creator_mcf_next_states(s) as next, app.creator_mcf_custody_held(s) as held, app.creator_mcf_terminal(s) as terminal
      from unnest(${[...states]}::text[]) s`;
    expect(rows).toHaveLength(21);
    let pairs = 0;
    for (const row of rows) {
      const from = CreatorMcfSendState.parse(row.state);
      expect([...row.next].sort()).toEqual([...CREATOR_MCF_SEND_TRANSITIONS[from].next].sort());
      for (const to of states) { expect(row.next.includes(to)).toBe(canTransitionCreatorMcfSend(from, to)); pairs++; }
      expect(row.held).toBe(isCustodyHeldState(from));
      expect(row.terminal).toBe(isTerminalState(from));
    }
    expect(pairs).toBe(441);
  });

  it('(2) seals once per envelope, replays idempotently, supersedes an unapproved send, and refuses every case before storing anything', async () => {
    const lane = await newLane(main);
    const env = envelope();
    const first = await seal(lane, OWNER, env);
    expect(first).toMatchObject({ outcome: 'sealed', state: 'sealed', replay: false });
    const replay = await seal(lane, OWNER, env);
    expect(replay).toMatchObject({ outcome: 'sealed', replay: true, sendId: first.outcome === 'sealed' ? first.sendId : '' });
    const other = await newLane(main);
    expect(await seal(other, OWNER, env)).toEqual({ outcome: 'refused', reason: 'envelope_reused' });
    // A second seal on the same lane supersedes the first while it holds no approval.
    const second = await seal(lane);
    expect(second.outcome).toBe('sealed');
    const firstRow = await sendRow(first.outcome === 'sealed' ? first.sendId : '');
    expect(firstRow).toMatchObject({ state: 'withdrawn', state_reason: 'superseded', custody_destroyed_reason: 'superseded' });

    const before = await ledgerCounts(main.id);
    const refusals: [string, Promise<unknown>][] = [];
    const fresh = await newLane(main);
    const bind = binding(fresh);
    const request = (change: Record<string, unknown> = {}, env2: Record<string, unknown> = envelope()) => ({ binding: { ...bind, ...change }, envelope: env2 });
    refusals.push(['binding_mismatch', sealRaw(fresh, request({ orgId: capOrg.id }))]);
    refusals.push(['binding_mismatch', sealRaw(fresh, request({ creatorRecordId: other.record }))]);
    refusals.push(['binding_mismatch', sealRaw(fresh, request({ asin: other.asin }))]);
    refusals.push(['binding_mismatch', sealRaw(fresh, request({ derivedOrderKey: other.key }))]);
    // Byte for byte: the same reservation in another case is another binding.
    refusals.push(['binding_mismatch', sealRaw(fresh, request({ reservationId: fresh.reservation.toLowerCase().replace('mcfr', 'MCFR') }))]);
    refusals.push(['binding_mismatch', sealRaw(fresh, request({ orgId: fresh.org.id.toUpperCase() }))]);
    refusals.push(['binding_invalid', sealRaw(fresh, { binding: { ...bind, extra: 'x' }, envelope: envelope() })]);
    refusals.push(['envelope_invalid', sealRaw(fresh, { ...request(), recipient: 'plaintext' })]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ suite: 'DHKEM(X25519)' })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ enc: b64(Uint8Array.of(4, ...randomBytes(63))) })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ enc: b64(Uint8Array.of(2, ...randomBytes(64))) })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ ciphertext: b64(randomBytes(16)) })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ ciphertext: b64(randomBytes(4097)) })))]);
    // Non-canonical base64url: an unused trailing bit set.
    const text = b64(randomBytes(47));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789-_';
    const tampered = text.slice(0, -1) + alphabet.charAt(alphabet.indexOf(text.at(-1)!) ^ 1);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ ciphertext: tampered })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ mask: { countryCode: 'US', postalPrefix: '94', lines: 4 } })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ address: 'x' })))]);
    refusals.push(['envelope_invalid', sealRaw(fresh, request({}, envelope({ envelopeId: randomUUID().toUpperCase() })))]);
    refusals.push(['key_unknown', sealRaw(fresh, request({}, envelope({ keyId: OTHER_KEY_ID })))]);
    for (const [reason, pending] of refusals) expect(await pending).toEqual({ outcome: 'refused', reason });
    expect(refusals).toHaveLength(18);
    // The wrapper refuses a body with a plaintext field without calling the database.
    expect(await sealCreatorMcfRecipient(db, actor(main), { creatorRecordId: fresh.record, asin: fresh.asin,
      request: { binding: bind, envelope: { ...envelope(), name: 'x' } } })).toEqual({ outcome: 'refused', reason: 'envelope_invalid' });
    expect(await ledgerCounts(main.id)).toEqual(before);
  });

  it('(2) refuses a lane that is not handed over, a record in Conflict, a failed import, a missing, held or stale pre-flight and a bad grant or connection', async () => {
    const org = await newOrg('mcf-seal-refusals');
    const cases: [string, () => Promise<Lane>][] = [
      ['lane_not_reserved', () => newLane(org, { laneState: 'Verified for Submit' })],
      ['lane_not_reserved', () => newLane(org, { reservation: null })],
      ['lane_not_runner', async () => {
        const lane = await newLane(org);
        await db.sql.begin(async (sql) => {
          await sql`select set_config('app.creator_mcf_ledger', 'on', true)`;
          await sql`update public.creator_sample_shipments set order_owner = 'arcana' where org_id = ${org.id} and creator_record_id = ${lane.record}`;
        });
        return lane;
      }],
      ['record_conflict', () => newLane(org, { lock: 'Conflict' })],
      ['preflight_missing', () => newLane(org, { preflight: false })],
      ['preflight_hold', async () => { const lane = await newLane(org, { preflight: false }); await preflight(org, lane.record, lane.asin, 'HOLD', lane.sku); return lane; }],
      ['preflight_stale', async () => { const lane = await newLane(org, { preflight: false }); await preflight(org, lane.record, lane.asin, 'PASS', lane.sku, '25 hours'); return lane; }],
      // A HOLD recorded after the PASS, even with an earlier completion time.
      ['preflight_hold', async () => { const lane = await newLane(org); await preflight(org, lane.record, lane.asin, 'HOLD', lane.sku, '2 minutes'); return lane; }],
      ['preflight_mismatch', async () => { const lane = await newLane(org, { preflight: false }); await preflight(org, lane.record, lane.asin, 'PASS', 'OTHER-SKU'); return lane; }],
    ];
    const before = await ledgerCounts(org.id);
    for (const [reason, make] of cases) {
      const lane = await make();
      expect(await sealRaw(lane, { binding: binding(lane), envelope: envelope() })).toEqual({ outcome: 'refused', reason });
    }
    expect(cases).toHaveLength(9);

    const lane = await newLane(org);
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, failure, files, counts, source)
      values (${org.id}, now(), clock_timestamp(), 'failed', 'file_unreadable', '{}',
        '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}', 'control-runner')`;
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'import_failed' });
    await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
      values (${org.id}, now(), clock_timestamp() + interval '1 second', 'succeeded', '{}',
        '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}', 'control-runner')`;

    await regrant(org, { actions: ['cancel'] });
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'grant_inactive' });
    await regrant(org, { enabledAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'grant_inactive' });
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org.id} and revoked_at is null`;
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'grant_inactive' });
    await regrant(org, { keys: [OTHER_KEY_ID] });
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'key_unknown' });
    await regrant(org);

    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'pending' where org_id = ${org.id}`);
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'spapi_connection_count' });
    await asServiceRole(db, (sql) => sql`update public.spapi_connections set status = 'active' where org_id = ${org.id}`);
    const [profile] = await db.sql<{ id: string }[]>`insert into public.ad_profiles(org_id, amazon_profile_id, region, country_code, currency_code,
        timezone, sync_enabled) select org_id, ${`synthetic-${hex(4)}`}, region, country_code, currency_code, timezone, true from public.ad_profiles
      where id = (select profile_id from public.spapi_profile_bindings where org_id = ${org.id} limit 1) returning id`;
    const [second] = await asServiceRole(db, (sql) => sql<{ id: string }[]>`insert into public.spapi_connections(org_id, label, selling_partner_id,
        marketplace_ids, status, vault_secret_id)
      values (${org.id}, 'second', 'second-seller', ${[org.marketplace]}::text[], 'active', gen_random_uuid()) returning id`);
    await db.sql`insert into public.spapi_profile_bindings(org_id, profile_id, connection_id, marketplace_id, enabled)
      values (${org.id}, ${profile!.id}, ${second!.id}, ${org.marketplace}, true)`;
    expect(await seal(lane)).toEqual({ outcome: 'refused', reason: 'spapi_connection_count' });
    expect(await ledgerCounts(org.id)).toEqual(before);

    for (const user of [ANALYST, VIEWER]) await expect(seal(lane, user)).rejects.toBeInstanceOf(AgencyAccessDenied);
  });

  it('(3) approves exactly the latest, unexpired, fingerprinted preview with the recomputed wording, once per request', async () => {
    const lane = await newLane(main);
    const ready = await previewReady(lane);
    const base = { sendId: ready.sendId, previewId: ready.preview.previewId, previewFingerprint: ready.fingerprint, totalUnits: 1, confirmation: ONE };
    expect(await approveCreatorMcfSend(db, actor(main), { ...base, totalUnits: 2, confirmation: 'Send 2 units via Amazon', requestId: randomUUID() }))
      .toEqual({ outcome: 'refused', reason: 'confirmation_mismatch' });
    expect(await approveCreatorMcfSend(db, actor(main), { ...base, previewFingerprint: hex(32), requestId: randomUUID() }))
      .toEqual({ outcome: 'refused', reason: 'fingerprint_mismatch' });
    await expect(approveCreatorMcfSend(db, actor(main, ANALYST), { ...base, requestId: randomUUID() })).rejects.toBeInstanceOf(AgencyAccessDenied);
    // A newer preview makes the first one not the latest.
    expect(await refreshCreatorMcfPreview(db, actor(main), ready.sendId)).toMatchObject({ outcome: 'previewing', state: 'previewing' });
    const claim = await claimFor(main, ready.sendId, 'preview');
    const newer = preview(claim, lane);
    const recorded = await recordCreatorMcfPreview(db, claim.sendId, claim.leaseId, newer);
    expect(recorded.decision).toBe('preview_ready');
    expect(recorded['fingerprint']).toBe(await creatorMcfPreviewFingerprint(newer));
    expect(await approveCreatorMcfSend(db, actor(main), { ...base, requestId: randomUUID() })).toEqual({ outcome: 'refused', reason: 'preview_not_latest' });
    // Older than 30 minutes at the press.
    await backdate((sql) => sql`update public.creator_mcf_send_previews set read_at = now() - interval '31 minutes',
      valid_until = now() - interval '1 minute' where id = ${newer.previewId}`);
    const current = { ...base, previewId: newer.previewId, previewFingerprint: String(recorded['fingerprint']) };
    expect(await approveCreatorMcfSend(db, actor(main), { ...current, requestId: randomUUID() })).toEqual({ outcome: 'refused', reason: 'preview_expired' });
    await backdate((sql) => sql`update public.creator_mcf_send_previews set read_at = now(), valid_until = now() + interval '30 minutes'
      where id = ${newer.previewId}`);
    // Revoked, then expired grant.
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${main.id} and revoked_at is null`;
    expect(await approveCreatorMcfSend(db, actor(main), { ...current, requestId: randomUUID() })).toEqual({ outcome: 'refused', reason: 'grant_inactive' });
    await regrant(main, { enabledAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(await approveCreatorMcfSend(db, actor(main), { ...current, requestId: randomUUID() })).toEqual({ outcome: 'refused', reason: 'grant_inactive' });
    await regrant(main);
    const requestId = randomUUID();
    const done = await approveCreatorMcfSend(db, actor(main, ADMIN), { ...current, requestId });
    expect(done).toMatchObject({ outcome: 'approved', state: 'approved', replay: false, units: 1 });
    expect(await approveCreatorMcfSend(db, actor(main, ADMIN), { ...current, requestId })).toMatchObject({ outcome: 'approved', replay: true });
    const [log] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_action_log where org_id = ${main.id}
      and action = 'mcf_send_approved' and evidence_reference = ${`arcana:send:${ready.sendId}`} and actor_user_id = ${ADMIN}`;
    expect(log!.n).toBe(1);
    const other = await newLane(main);
    const otherReady = await previewReady(other);
    expect(await approveCreatorMcfSend(db, actor(main), { sendId: otherReady.sendId, previewId: otherReady.preview.previewId,
      previewFingerprint: otherReady.fingerprint, totalUnits: 1, confirmation: ONE, requestId })).toEqual({ outcome: 'refused', reason: 'request_reused' });
  });

  it('(3) refuses a superseded send, and the database holds one open send per lane', async () => {
    const lane = await newLane(main);
    const first = await previewReady(lane);
    const second = await seal(lane);
    expect(second.outcome).toBe('sealed');
    expect(await approveCreatorMcfSend(db, actor(main), { sendId: first.sendId, previewId: first.preview.previewId,
      previewFingerprint: first.fingerprint, totalUnits: 1, confirmation: ONE, requestId: randomUUID() })).toEqual({ outcome: 'refused', reason: 'send_not_ready' });
    const [open] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_sends where org_id = ${main.id}
      and derived_order_key = ${lane.key} and not app.creator_mcf_terminal(state)`;
    expect(open!.n).toBe(1);
    const [row] = await db.sql<Record<string, unknown>[]>`select * from public.creator_mcf_sends where id = ${first.sendId}`;
    await expect(db.sql`insert into public.creator_mcf_sends(org_id, creator_record_id, asin, sku, reservation_id, preflight_id, spapi_connection_id,
        marketplace_id, key_id, envelope_id, ciphertext_sha256, created_by, membership_created_at, state)
      values (${main.id}, ${lane.record}, ${lane.asin}, ${lane.sku}, ${lane.reservation}, ${String(row!['preflight_id'])}, ${main.connection},
        ${main.marketplace}, ${KEY_ID}, gen_random_uuid(), ${hex(32)}, ${OWNER}, now(), 'sealed')`).rejects.toMatchObject({ code: '23505' });
  });

  it('(3) serializes approvals on the grant: a second press waits for the first and then finds the day\'s unit taken', async () => {
    const lanes = [await newLane(capOrg), await newLane(capOrg)];
    const ready = [await previewReady(lanes[0]!), await previewReady(lanes[1]!)];
    const held = await db.sql.reserve();
    let second: Promise<unknown>;
    try {
      await held`begin`;
      await held`select set_config('request.jwt.claims', ${JSON.stringify({ sub: OWNER, role: 'authenticated' })}, true),
        set_config('request.jwt.claim.sub', ${OWNER}, true), set_config('request.jwt.claim.role', 'authenticated', true)`;
      await held`set local role authenticated`;
      const [first] = await held<{ result: Record<string, unknown> }[]>`select app.approve_creator_mcf_send(${capOrg.id}::uuid, ${ready[0]!.sendId}::uuid,
        ${ready[0]!.preview.previewId}::uuid, ${ready[0]!.fingerprint}, ${ONE}, ${randomUUID()}::uuid) as result`;
      expect(first!.result).toMatchObject({ outcome: 'approved' });
      second = approveCreatorMcfSend(db, actor(capOrg, ADMIN), { sendId: ready[1]!.sendId, previewId: ready[1]!.preview.previewId,
        previewFingerprint: ready[1]!.fingerprint, totalUnits: 1, confirmation: ONE, requestId: randomUUID() });
      let waiting = 0;
      for (let attempt = 0; attempt < 100 && waiting === 0; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const [row] = await db.sql<{ waiting: number }[]>`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and query like '%approve_creator_mcf_send%'`;
        waiting = row?.waiting ?? 0;
      }
      expect(waiting).toBe(1);
      await held`commit`;
    } finally {
      held.release();
    }
    expect(await second).toEqual({ outcome: 'refused', reason: 'daily_cap_reached' });
    for (const r of ready) await withdrawCreatorMcfSend(db, actor(capOrg), r.sendId);
  });

  it('(3) lets exactly one of two concurrent approvals take the last unit of the UTC day', async () => {
    const lanes = [await newLane(capOrg), await newLane(capOrg)];
    const ready = [await previewReady(lanes[0]!), await previewReady(lanes[1]!)];
    const results = await Promise.all(ready.map((r, index) => approveCreatorMcfSend(db, actor(capOrg, index === 0 ? OWNER : ADMIN), {
      sendId: r.sendId, previewId: r.preview.previewId, previewFingerprint: r.fingerprint, totalUnits: 1, confirmation: ONE, requestId: randomUUID() })));
    expect(results.filter((result) => result.outcome === 'approved')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'refused' && result.reason === 'daily_cap_reached')).toHaveLength(1);
    const gate = await readCreatorMcfSendGate(db, actor(capOrg, ANALYST));
    expect([gate.unitsToday, gate.maxUnitsPerDay]).toEqual([1, 1]);
    for (const r of ready) await withdrawCreatorMcfSend(db, actor(capOrg), r.sendId);
    expect((await readCreatorMcfSendGate(db, actor(capOrg))).unitsToday).toBe(0);
  });

  it('(4) counts a unit on the UTC day of its approval; stale, withdrawn and expired sends release it, a rejected posted send keeps it', async () => {
    const org = await newOrg('mcf-cap-days', { units: 1 });
    const units = async () => (await readCreatorMcfSendGate(db, actor(org))).unitsToday;
    const press = (r: { sendId: string; preview: CreatorMcfPreview; fingerprint: string }) => approveCreatorMcfSend(db, actor(org), {
      sendId: r.sendId, previewId: r.preview.previewId, previewFingerprint: r.fingerprint, totalUnits: 1, confirmation: ONE, requestId: randomUUID() });
    // Withdrawn releases.
    const a = await approved(await newLane(org));
    expect(await units()).toBe(1);
    const bLane = await newLane(org);
    const b = await previewReady(bLane);
    expect(await press(b)).toEqual({ outcome: 'refused', reason: 'daily_cap_reached' });
    await withdrawCreatorMcfSend(db, actor(org), a.sendId);
    expect(await units()).toBe(0);
    expect((await press(b)).outcome).toBe('approved');
    // Stale releases: the dispatch re-read differs.
    const bClaim = await claimFor(org, b.sendId, 'dispatch');
    const stale = await reread(bClaim, { fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 610 }], totalMinor: 610, currency: 'USD' } });
    expect(stale).toMatchObject({ decision: 'stale', state: 'stale', fields: ['fees'] });
    expect(await units()).toBe(0);
    // Expired (unclaimed and ttl) release.
    const c = await approved(await newLane(org));
    await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = approved_at - interval '16 minutes',
      claim_deadline = claim_deadline - interval '16 minutes' where id = ${c.sendId}`);
    expect(await expireCreatorMcfCustody(db)).toMatchObject({ expiredUnclaimed: 1 });
    expect(await units()).toBe(0);
    const d = await approved(await newLane(org));
    await backdate((sql) => sql`update app.creator_mcf_recipient_custody set created_at = now() - interval '2 hours',
      expires_at = now() - interval '1 second' where send_id = ${d.sendId}`);
    expect(await expireCreatorMcfCustody(db)).toMatchObject({ expiredTtl: 1 });
    expect((await sendRow(d.sendId)).state).toBe('expired');
    expect(await units()).toBe(0);
    // A rejected posted send keeps its unit.
    const eLane = await newLane(org);
    const e = await dispatching(eLane);
    expect(await recordCreatorMcfOutcome(db, e.sendId, e.claim.leaseId, { outcome: 'rejected', status: 400, codes: ['InvalidInput'], reason: 'validation' },
      notFound())).toMatchObject({ decision: 'recorded', state: 'rejected' });
    expect(await units()).toBe(1);
    const fLane = await newLane(org);
    const f = await previewReady(fLane);
    expect(await press(f)).toEqual({ outcome: 'refused', reason: 'daily_cap_reached' });
    // Approved at 23:59 UTC yesterday: it counts for yesterday, not today.
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const lateYesterday = new Date(midnight.getTime() - 60_000);
    await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = ${lateYesterday.toISOString()}::timestamptz,
      claim_deadline = ${lateYesterday.toISOString()}::timestamptz + interval '15 minutes' where id = ${e.sendId}`);
    const [days] = await db.sql<{ yesterday: number; today: number }[]>`select
      app.creator_mcf_units_on(${org.id}::uuid, ${org.connection}::uuid, ${org.marketplace}, ${new Date(lateYesterday.getTime() + 30_000).toISOString()}::timestamptz) as yesterday,
      app.creator_mcf_units_on(${org.id}::uuid, ${org.connection}::uuid, ${org.marketplace}, ${new Date(midnight.getTime() + 30_000).toISOString()}::timestamptz) as today`;
    expect(days).toEqual({ yesterday: 1, today: 0 });
    expect((await press(f)).outcome).toBe('approved');
    expect(await units()).toBe(1);
  });

  it('(5) reserves once after the clause-9 recheck and resets the lane\'s not-found probes', async () => {
    const lane = await newLane(main);
    await db.sql`update public.creator_sample_shipments set mcf_not_found_probes = 3, mcf_settlement = 'escalated', mcf_probed_at = now()
      where org_id = ${main.id} and creator_record_id = ${lane.record}`;
    const run = await dispatchClaimed(lane);
    expect(await reserveCreatorMcfDispatch(db, run.sendId, run.claim.leaseId, hex(32))).toEqual({ decision: 'refused', reason: 'reread_missing', state: 'approved' });
    expect((await reread(run.claim)).decision).toBe('same');
    expect(await reserveCreatorMcfDispatch(db, run.sendId, randomUUID(), hex(32))).toMatchObject({ decision: 'refused', reason: 'lease' });
    const reserved = await reserveCreatorMcfDispatch(db, run.sendId, run.claim.leaseId, hex(32));
    expect(reserved).toMatchObject({ decision: 'dispatch_once', derivedOrderKey: lane.key, sku: lane.sku, quantity: 1, marketplaceId: main.marketplace });
    expect(await reserveCreatorMcfDispatch(db, run.sendId, run.claim.leaseId, hex(32))).toEqual({ decision: 'already_reserved', state: 'dispatching' });
    expect(await withdrawCreatorMcfSend(db, actor(main), run.sendId)).toEqual({ outcome: 'refused', reason: 'send_not_withdrawable' });
    const [events] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events where send_id = ${run.sendId}
      and event = 'reserved'`;
    expect(events!.n).toBe(1);
    expect(await sendRow(run.sendId)).toMatchObject({ state: 'dispatching', posts: 1 });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Verified for Submit', order_owner: 'arcana', mcf_not_found_probes: 0, mcf_settlement: 'not_found' });
  });

  it('(5) refuses a reservation after a membership change, a revoked grant, a passed claim deadline or a changed reservation', async () => {
    const org = await newOrg('mcf-reserve-refusals');
    // The approving admin became an analyst.
    const a = await dispatchClaimed(await newLane(org), ADMIN);
    expect((await reread(a.claim)).decision).toBe('same');
    await db.sql`update public.org_members set role = 'analyst' where org_id = ${org.id} and user_id = ${ADMIN}`;
    expect(await reserveCreatorMcfDispatch(db, a.sendId, a.claim.leaseId, hex(32))).toEqual({ decision: 'refused', reason: 'authority_changed', state: 'expired' });
    await db.sql`update public.org_members set role = 'admin' where org_id = ${org.id} and user_id = ${ADMIN}`;
    // The membership was removed and re-added: same role, a new membership.
    const b = await dispatchClaimed(await newLane(org), ADMIN);
    expect((await reread(b.claim)).decision).toBe('same');
    await db.sql`delete from public.org_members where org_id = ${org.id} and user_id = ${ADMIN}`;
    await db.sql`insert into public.org_members(org_id, user_id, role) values (${org.id}, ${ADMIN}, 'admin')`;
    expect(await reserveCreatorMcfDispatch(db, b.sendId, b.claim.leaseId, hex(32))).toMatchObject({ reason: 'authority_changed' });
    // The grant was revoked.
    const c = await dispatchClaimed(await newLane(org));
    expect((await reread(c.claim)).decision).toBe('same');
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org.id} and revoked_at is null`;
    expect(await reserveCreatorMcfDispatch(db, c.sendId, c.claim.leaseId, hex(32))).toMatchObject({ decision: 'refused', reason: 'grant_revoked' });
    await regrant(org);
    // The runner changed the reservation.
    const dLane = await newLane(org);
    const d = await dispatchClaimed(dLane);
    expect((await reread(d.claim)).decision).toBe('same');
    const moved: CreatorShipmentWrite = { creatorRecordId: dLane.record, asin: dLane.asin, sku: dLane.sku, campaignId: 'campaign-synthetic-1',
      reservationId: `MCFR-${hex(8).toUpperCase()}`, laneState: 'Reserved', runnerOrderId: null, feeCents: 620, feeCapCents: 800,
      reservedAt: new Date().toISOString(), verifiedAt: null, confirmedAt: null, cancelledAt: null, cancellationReason: null, reconciliationReason: null };
    await persistCreatorImport(db, { orgId: org.id, startedAt: new Date().toISOString(), source: 'control-runner', files: ['mcf_reservations'],
      records: null, actions: null, queue: null, sweeps: null, shipments: { read: 1, invalid: 0, rows: [moved] } });
    expect(await reserveCreatorMcfDispatch(db, d.sendId, d.claim.leaseId, hex(32))).toMatchObject({ decision: 'refused', reason: 'lane_changed' });
    // The claim deadline passed.
    const e = await dispatchClaimed(await newLane(org));
    expect((await reread(e.claim)).decision).toBe('same');
    await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = approved_at - interval '16 minutes',
      claim_deadline = claim_deadline - interval '16 minutes' where id = ${e.sendId}`);
    expect(await reserveCreatorMcfDispatch(db, e.sendId, e.claim.leaseId, hex(32))).toMatchObject({ decision: 'refused', state: 'expired_unclaimed' });
    const states = await Promise.all([a, b, c, d, e].map(async (run) => {
      const row = await sendRow(run.sendId);
      return [row.state, row.state_reason, row.custody_destroyed_reason, row.posts];
    }));
    expect(states).toEqual([['expired', 'authority_changed', 'authority_changed', 0], ['expired', 'authority_changed', 'authority_changed', 0],
      ['expired', 'grant_revoked', 'grant_revoked', 0], ['expired', 'lane_changed', 'lane_changed', 0],
      ['expired_unclaimed', 'claim_deadline', 'expired_unclaimed', 0]]);
    expect(await readCreatorMcfCustodyResidue(db)).toEqual({ expiredLive: 0, custodyFreeLive: 0 });
  });

  it('(5) expires at reservation when the grant was replaced, the record is in Conflict or the day is over its cap; a lowered lane fee cap goes stale', async () => {
    const org = await newOrg('mcf-reserve-more', { units: 1 });
    const proof = async (sendId: string, reason: string) => {
      const p = await custodyProof(sendId);
      expect([p.custody, p.tombstones.length, p.tombstones[0]?.reason, (await sendRow(sendId)).custody_destroyed_reason]).toEqual([0, 1, reason, reason]);
      expect(p.residue).toEqual({ expiredLive: 0, custodyFreeLive: 0 });
    };
    // Replaced with identical settings between the press and the reservation: the press named the old grant.
    const a = await dispatchClaimed(await newLane(org));
    expect((await reread(a.claim)).decision).toBe('same');
    await regrant(org, { units: 1 });
    expect(await reserveCreatorMcfDispatch(db, a.sendId, a.claim.leaseId, hex(32))).toMatchObject({ reason: 'grant_revoked', state: 'expired' });
    await proof(a.sendId, 'grant_revoked');
    // The record went into Conflict.
    const bLane = await newLane(org);
    const b = await dispatchClaimed(bLane);
    expect((await reread(b.claim)).decision).toBe('same');
    await db.sql`update public.creator_records set lock_state = 'Conflict' where org_id = ${org.id} and creator_record_id = ${bLane.record}`;
    expect(await reserveCreatorMcfDispatch(db, b.sendId, b.claim.leaseId, hex(32))).toMatchObject({ reason: 'record_conflict', state: 'expired' });
    await proof(b.sendId, 'record_conflict');
    // Over the day's cap at reservation (another posted unit now counts today).
    const x = await dispatching(await newLane(org));
    await recordCreatorMcfOutcome(db, x.sendId, x.claim.leaseId, { outcome: 'rejected', status: 403, codes: [], reason: 'authorization' });
    await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = approved_at - interval '1 day',
      claim_deadline = claim_deadline - interval '1 day' where id = ${x.sendId}`);
    const c = await dispatchClaimed(await newLane(org));
    expect((await reread(c.claim)).decision).toBe('same');
    await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = approved_at + interval '1 day',
      claim_deadline = claim_deadline + interval '1 day' where id = ${x.sendId}`);
    expect(await reserveCreatorMcfDispatch(db, c.sendId, c.claim.leaseId, hex(32))).toMatchObject({ reason: 'cap_exceeded', state: 'expired' });
    await proof(c.sendId, 'cap_exceeded');
    // The runner lowered the lane's fee cap below the approved fee: stale, custody kept, no POST.
    await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = approved_at - interval '1 day',
      claim_deadline = claim_deadline - interval '1 day' where id = ${x.sendId}`);
    const dLane = await newLane(org);
    const d = await dispatchClaimed(dLane);
    expect((await reread(d.claim)).decision).toBe('same');
    await db.sql`update public.creator_sample_shipments set fee_cap_cents = 500 where org_id = ${org.id} and creator_record_id = ${dLane.record}`;
    expect(await reserveCreatorMcfDispatch(db, d.sendId, d.claim.leaseId, hex(32))).toMatchObject({ decision: 'refused', reason: 'stale', state: 'stale' });
    expect(await sendRow(d.sendId)).toMatchObject({ state: 'stale', state_reason: 'caps_changed', posts: 0, custody_destroyed_reason: null });
    expect((await custodyProof(d.sendId)).custody).toBe(1);
  });

  it('refuses at commit any write that leaves custody behind a custody-free send or a held send without custody', async () => {
    const sealed = await seal(await newLane(main));
    const sendId = sealed.outcome === 'sealed' ? sealed.sendId : '';
    await expect(db.sql.begin((sql) => sql`delete from app.creator_mcf_recipient_custody where send_id = ${sendId}`))
      .rejects.toMatchObject({ code: '23514' });
    await expect(db.sql.begin((sql) => sql`update public.creator_mcf_sends set state = 'withdrawn', custody_destroyed_at = now(),
      custody_destroyed_reason = 'withdrawn' where id = ${sendId}`)).rejects.toMatchObject({ code: '23514' });
    await expect(db.sql`update public.creator_mcf_sends set state = 'dispatching' where id = ${sendId}`).rejects.toMatchObject({ code: '55000' });
    expect((await custodyProof(sendId)).custody).toBe(1);
    expect((await sendRow(sendId)).state).toBe('sealed');
  });

  it('(6) destroys custody on every custody-ending transition, with one tombstone and residue (0, 0)', async () => {
    const org = await newOrg('mcf-custody-table');
    type Case = [string, string, () => Promise<string>];
    const cases: Case[] = [
      ['withdrawn from sealed', 'withdrawn', async () => {
        const sealed = await seal(await newLane(org)); const id = sealed.outcome === 'sealed' ? sealed.sendId : '';
        await withdrawCreatorMcfSend(db, actor(org), id); return id;
      }],
      ['withdrawn from previewing', 'withdrawn', async () => {
        const sealed = await seal(await newLane(org)); const id = sealed.outcome === 'sealed' ? sealed.sendId : '';
        await claimFor(org, id, 'preview'); await withdrawCreatorMcfSend(db, actor(org), id); return id;
      }],
      ['withdrawn from preview_ready', 'withdrawn', async () => { const r = await previewReady(await newLane(org)); await withdrawCreatorMcfSend(db, actor(org), r.sendId); return r.sendId; }],
      ['withdrawn from stale', 'withdrawn', async () => {
        const r = await dispatchClaimed(await newLane(org)); await reread(r.claim, { latestArrivalDate: '2026-10-09' });
        await withdrawCreatorMcfSend(db, actor(org), r.sendId); return r.sendId;
      }],
      ['withdrawn from approved', 'withdrawn', async () => { const r = await approved(await newLane(org)); await withdrawCreatorMcfSend(db, actor(org), r.sendId); return r.sendId; }],
      ['superseded by a new seal', 'superseded', async () => {
        const lane = await newLane(org); const sealed = await seal(lane); await seal(lane); return sealed.outcome === 'sealed' ? sealed.sendId : '';
      }],
      ['preview refused by the worker', 'preview_refused', async () => {
        const sealed = await seal(await newLane(org)); const id = sealed.outcome === 'sealed' ? sealed.sendId : '';
        const claim = await claimFor(org, id, 'preview');
        expect(await refuseCreatorMcfPreview(db, id, claim.leaseId, 'recipient_invalid', ['stateOrRegion.required'])).toMatchObject({ decision: 'preview_refused' });
        return id;
      }],
      ['preview refused: not fulfillable', 'preview_refused', async () => {
        const lane = await newLane(org); const sealed = await seal(lane); const id = sealed.outcome === 'sealed' ? sealed.sendId : '';
        const claim = await claimFor(org, id, 'preview');
        const r = await recordCreatorMcfPreview(db, id, claim.leaseId, preview(claim, lane, { isFulfillable: false, fees: null, unfulfillableReasons: ['InvalidDestinationAddress'] }));
        expect(r).toMatchObject({ decision: 'preview_refused', codes: ['InvalidDestinationAddress', 'fee_missing', 'not_fulfillable'] });
        return id;
      }],
      ['expired by the ttl sweep', 'ttl', async () => {
        const r = await previewReady(await newLane(org));
        await backdate((sql) => sql`update app.creator_mcf_recipient_custody set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
          where send_id = ${r.sendId}`);
        await expireCreatorMcfCustody(db); return r.sendId;
      }],
      ['expired unclaimed by the sweep', 'expired_unclaimed', async () => {
        const r = await approved(await newLane(org));
        await backdate((sql) => sql`update public.creator_mcf_sends set approved_at = approved_at - interval '16 minutes',
          claim_deadline = claim_deadline - interval '16 minutes' where id = ${r.sendId}`);
        await expireCreatorMcfCustody(db); return r.sendId;
      }],
      ['expired at reservation: grant revoked', 'grant_revoked', async () => {
        const r = await dispatchClaimed(await newLane(org)); await reread(r.claim);
        await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org.id} and revoked_at is null`;
        await reserveCreatorMcfDispatch(db, r.sendId, r.claim.leaseId, hex(32)); await regrant(org); return r.sendId;
      }],
      ['expired at dispatch: envelope unopenable', 'unopenable', async () => {
        const r = await dispatchClaimed(await newLane(org));
        expect(await refuseCreatorMcfPreview(db, r.sendId, r.claim.leaseId, 'envelope_unopenable', [])).toMatchObject({ decision: 'expired' });
        return r.sendId;
      }],
      ['found before the POST', 'found_before_post', async () => {
        const lane = await newLane(org); const r = await dispatchClaimed(lane);
        expect(await recordCreatorMcfSettlement(db, r.sendId, found(lane, 'Received'), r.claim.leaseId)).toMatchObject({ before: 'approved', state: 'placed' });
        return r.sendId;
      }],
      ...(['New', 'Planning:mismatch', 'Unfulfillable'] as const).map((variant): Case => [`found before the POST: ${variant}`, 'found_before_post', async () => {
        const lane = await newLane(org); const r = await dispatchClaimed(lane);
        const [status, mismatch] = variant.split(':');
        const read = found(lane, status!, mismatch === undefined ? {} : { items: [{ sellerSku: 'OTHER-SKU', quantity: 1 }] });
        const expected = status === 'New' ? 'accepted' : status === 'Unfulfillable' ? 'failed_by_amazon' : 'conflict';
        expect(await recordCreatorMcfSettlement(db, r.sendId, read, r.claim.leaseId)).toMatchObject({ before: 'approved', state: expected });
        return r.sendId;
      }]),
      ['POST rejected, then found', 'post_outcome', async () => {
        const lane = await newLane(org); const r = await dispatching(lane);
        expect(await recordCreatorMcfOutcome(db, r.sendId, r.claim.leaseId, { outcome: 'rejected', status: 400, codes: ['DuplicateOrder'], reason: 'validation' },
          found(lane, 'Processing'))).toEqual({ decision: 'recorded', state: 'placed' });
        return r.sendId;
      }],
      ['expired at reservation: authority changed', 'authority_changed', async () => {
        const r = await dispatchClaimed(await newLane(org), ADMIN); await reread(r.claim);
        await db.sql`update public.org_members set role = 'viewer' where org_id = ${org.id} and user_id = ${ADMIN}`;
        await reserveCreatorMcfDispatch(db, r.sendId, r.claim.leaseId, hex(32));
        await db.sql`update public.org_members set role = 'admin' where org_id = ${org.id} and user_id = ${ADMIN}`;
        return r.sendId;
      }],
      ['expired at reservation: lane changed', 'lane_changed', async () => {
        const lane = await newLane(org); const r = await dispatchClaimed(lane); await reread(r.claim);
        await db.sql`update public.creator_sample_shipments set sku = 'SYN-CHANGED' where org_id = ${org.id} and creator_record_id = ${lane.record}`;
        await reserveCreatorMcfDispatch(db, r.sendId, r.claim.leaseId, hex(32));
        return r.sendId;
      }],
      ['POST accepted', 'post_outcome', async () => {
        const r = await dispatching(await newLane(org));
        await recordCreatorMcfOutcome(db, r.sendId, r.claim.leaseId, { outcome: 'accepted', status: 200 }); return r.sendId;
      }],
      ['POST rejected', 'post_outcome', async () => {
        const r = await dispatching(await newLane(org));
        await recordCreatorMcfOutcome(db, r.sendId, r.claim.leaseId, { outcome: 'rejected', status: 403, codes: [], reason: 'authorization' }); return r.sendId;
      }],
      ['POST uncertain', 'post_outcome', async () => {
        const r = await dispatching(await newLane(org));
        await recordCreatorMcfOutcome(db, r.sendId, r.claim.leaseId, { outcome: 'uncertain', cause: 'transport', status: null }); return r.sendId;
      }],
      ['lease expired while dispatching', 'lease_expired', async () => {
        const r = await dispatching(await newLane(org));
        await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${r.sendId}`);
        await expireCreatorMcfCustody(db); return r.sendId;
      }],
    ];
    const rows: [string, string, string, number, number, string][] = [];
    for (const [label, reason, run] of cases) {
      const sendId = await run();
      const proof = await custodyProof(sendId);
      const send = await sendRow(sendId);
      rows.push([label, send.custody_destroyed_reason ?? '', proof.tombstones[0]?.reason ?? '', proof.tombstones.length, proof.custody,
        proof.tombstones[0]?.digest === send.ciphertext_sha256 ? 'digest' : 'no digest']);
      expect(proof.residue).toEqual({ expiredLive: 0, custodyFreeLive: 0 });
      expect(isCustodyHeldState(CreatorMcfSendState.parse(send.state))).toBe(false);
      expect(send.custody_destroyed_reason).toBe(reason);
    }
    expect(rows).toHaveLength(23);
    expect(rows.filter(([, destroyed, tombstone, tombstones, custody, digest]) => destroyed !== tombstone || tombstones !== 1 || custody !== 0
      || digest !== 'digest')).toEqual([]);
  }, 120_000);

  it('(7) the sweep, called directly with no scheduler, applies its three rules and never moves dispatching to expired', async () => {
    const org = await newOrg('mcf-sweep');
    const sealedLane = await newLane(org);
    const sealed = await seal(sealedLane);
    const sealedId = sealed.outcome === 'sealed' ? sealed.sendId : '';
    const ready = await previewReady(await newLane(org));
    const staleRun = await dispatchClaimed(await newLane(org));
    await reread(staleRun.claim, { earliestArrivalDate: '2026-10-01' });
    const approvedRun = await approved(await newLane(org));
    const unclaimed = await approved(await newLane(org));
    const heldDispatch = await dispatching(await newLane(org));
    const crashLane = await newLane(org);
    const crash = await dispatching(crashLane);
    // Every held send's custody is past its TTL; one approval also passed its claim deadline.
    await backdate(async (sql) => {
      await sql`update app.creator_mcf_recipient_custody set created_at = now() - interval '2 hours', expires_at = now() - interval '1 second'
        where send_id in ${sql([sealedId, ready.sendId, staleRun.sendId, approvedRun.sendId, heldDispatch.sendId, crash.sendId])}`;
      await sql`update public.creator_mcf_sends set approved_at = approved_at - interval '16 minutes', claim_deadline = claim_deadline - interval '16 minutes'
        where id in ${sql([unclaimed.sendId, heldDispatch.sendId, crash.sendId])}`;
      await sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${crash.sendId}`;
    });
    expect(await expireCreatorMcfCustody(db)).toEqual({ expiredTtl: 4, expiredUnclaimed: 1, uncertainCrash: 1 });
    const states = await Promise.all([sealedId, ready.sendId, staleRun.sendId, approvedRun.sendId, unclaimed.sendId, heldDispatch.sendId, crash.sendId]
      .map(async (id) => { const row = await sendRow(id); return `${row.state}:${row.state_reason}`; }));
    expect(states).toEqual(['expired:ttl', 'expired:ttl', 'expired:ttl', 'expired:ttl', 'expired_unclaimed:claim_deadline', 'dispatching:null', 'uncertain:crash']);
    expect(await laneRow(crashLane)).toMatchObject({ lane_state: 'Reconciliation Required', order_owner: 'arcana', reconciliation_reason: 'outcome_unknown' });
    // A dispatching send past its custody TTL and claim deadline keeps custody until its lease ends; then it becomes uncertain, never expired.
    const [held] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_recipient_custody where send_id = ${heldDispatch.sendId}`;
    expect(held!.n).toBe(1);
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id = ${heldDispatch.sendId}`);
    expect(await expireCreatorMcfCustody(db)).toEqual({ expiredTtl: 0, expiredUnclaimed: 0, uncertainCrash: 1 });
    expect(await sendRow(heldDispatch.sendId)).toMatchObject({ state: 'uncertain', state_reason: 'crash', custody_destroyed_reason: 'lease_expired' });
    const [everExpired] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events where send_id in
      ${db.sql([heldDispatch.sendId, crash.sendId])} and after_state in ('expired', 'expired_unclaimed')`;
    expect(everExpired!.n).toBe(0);
    expect(await readCreatorMcfCustodyResidue(db)).toEqual({ expiredLive: 0, custodyFreeLive: 0 });
  });

  it('(8) the file import and register_record skip an Arcana lane and count it, still update runner lanes, and the trigger refuses other writers', async () => {
    const org = await newOrg('mcf-ownership');
    const arcanaLane = await newLane(org);
    await dispatching(arcanaLane);
    const runnerLane = await newLane(org);
    const before = await laneRow(arcanaLane);
    const reservedAt = new Date().toISOString();
    const row = (lane: Lane, change: Partial<CreatorShipmentWrite>): CreatorShipmentWrite => ({ creatorRecordId: lane.record, asin: lane.asin,
      sku: lane.sku, campaignId: 'campaign-synthetic-1', reservationId: lane.reservation, laneState: 'Reserved', runnerOrderId: null, feeCents: 640,
      feeCapCents: 800, reservedAt, verifiedAt: null, confirmedAt: null, cancelledAt: null, cancellationReason: null,
      reconciliationReason: null, ...change });
    const imported = await persistCreatorImport(db, { orgId: org.id, startedAt: new Date().toISOString(), source: 'control-runner',
      files: ['mcf_reservations'], records: null, actions: null, queue: null, sweeps: null,
      shipments: { read: 2, invalid: 0, rows: [row(arcanaLane, { laneState: 'Cancelled', cancelledAt: new Date().toISOString(),
        cancellationReason: 'operator_aborted_before_submit' }), row(runnerLane, { feeCents: 650 })] } });
    expect(imported.counts.sample_shipments).toEqual({ read: 2, valid: 2, invalid: 0, inserted: 0, updated: 1, unchanged: 0, skipped: 1, removed: 0 });
    const mcp = await withAuthenticatedActor(db, actor(org), (sql) => writeCreatorMcpRows(sql, org.id, { shipments: [
      row(arcanaLane, { laneState: 'Confirmed', runnerOrderId: 'synthetic-order', confirmedAt: new Date().toISOString() }),
      row(runnerLane, { feeCents: 660 })] }));
    expect(mcp.sample_shipments).toEqual({ read: 2, inserted: 0, updated: 1, unchanged: 0, skipped: 1 });
    const replay = await withAuthenticatedActor(db, actor(org), (sql) => writeCreatorMcpRows(sql, org.id, { shipments: [row(runnerLane, { feeCents: 660 })] }));
    expect(replay.sample_shipments).toEqual({ read: 1, inserted: 0, updated: 0, unchanged: 1, skipped: 0 });
    expect(await laneRow(arcanaLane)).toEqual(before);
    const [runner] = await db.sql<{ fee_cents: number }[]>`select fee_cents from public.creator_sample_shipments where org_id = ${org.id}
      and creator_record_id = ${runnerLane.record}`;
    expect(runner!.fee_cents).toBe(660);
    // The samples list reads the owner, so the screens see which lanes Arcana holds.
    const snapshot = await asUser(db, ANALYST, (sql) => readCreatorSampleShipments({ sql }, org.id));
    const owners = Object.fromEntries(snapshot.shipments.map((lane) => [lane.creatorRecordId, lane.orderOwner]));
    expect([owners[arcanaLane.record], owners[runnerLane.record], owners['CCR-FX-26-0001']]).toEqual(['arcana', 'runner', 'runner']);
    // Direct writers.
    await expect(asUser(db, OWNER, (sql) => sql`update public.creator_sample_shipments set lane_state = 'Reserved' where org_id = ${org.id}
      and creator_record_id = ${arcanaLane.record}`)).rejects.toMatchObject({ code: '23514' });
    await expect(asUser(db, OWNER, (sql) => sql`delete from public.creator_sample_shipments where org_id = ${org.id}
      and creator_record_id = ${arcanaLane.record}`)).rejects.toMatchObject({ code: '23514' });
    await expect(asUser(db, OWNER, (sql) => sql`update public.creator_sample_shipments set order_owner = 'arcana' where org_id = ${org.id}
      and creator_record_id = ${runnerLane.record}`)).rejects.toMatchObject({ code: '23514' });
    await expect(asUser(db, OWNER, (sql) => sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, lane_state, order_owner,
      source, source_digest) values (${org.id}, ${runnerLane.record}, ${`B0${hex(4).toUpperCase()}`}, 'Reserved', 'arcana', 'web', ${hex(32)})`))
      .rejects.toMatchObject({ code: '23514' });
    // The ledger marker is not enough for a client role.
    await expect(withAuthenticatedActor(db, actor(org), async (sql) => {
      await sql`select set_config('app.creator_mcf_ledger', 'on', true)`;
      await sql`update public.creator_sample_shipments set lane_state = 'Reserved' where org_id = ${org.id} and creator_record_id = ${arcanaLane.record}`;
    })).rejects.toMatchObject({ code: '23514' });
    await expect(db.sql.begin(async (sql) => {
      await sql`set local role service_role`;
      await sql`select set_config('app.creator_mcf_ledger', 'on', true)`;
      await sql`update public.creator_sample_shipments set runner_order_id = 'x' where org_id = ${org.id} and creator_record_id = ${arcanaLane.record}`;
    })).rejects.toMatchObject({ code: '23514' });
    // WP-334's columns and an unprotected column stay writable.
    const [touched] = await asUser(db, OWNER, (sql) => sql<{ n: number }[]>`with changed as (update public.creator_sample_shipments set fee_cents = 700
      where org_id = ${org.id} and creator_record_id = ${arcanaLane.record} returning 1) select count(*)::int as n from changed`);
    expect(touched!.n).toBe(1);
    expect(await laneRow(arcanaLane)).toEqual(before);
  });

  it('(9) an uncertain send escalates through WP-334\'s trigger after three post-reservation not-found reads; earlier reads never count toward release', async () => {
    const org = await newOrg('mcf-escalation');
    const lane = await newLane(org);
    const base = Date.now();
    const observe = (key: string, minutesAgo: number, list: boolean) => recordCreatorMcfObservation(db, org.id, {
      observationKey: `observe-${hex(4)}:${key}`, derivedOrderKey: lane.key, queriedOrderId: lane.key,
      operation: list ? 'listAllFulfillmentOrders' : 'getFulfillmentOrder', outcome: 'not_found', status: null, shipments: null, packages: null,
      readAt: new Date(base - minutesAgo * 60_000).toISOString(), jobId: null });
    // Two reads before the reservation, one of them a complete list, while the lane is still the runner's.
    await observe('pre-1', 170, true);
    expect((await observe('pre-2', 150, false)).settlement).toMatchObject({ settlement: 'not_found', notFoundProbes: 0 });
    const run = await dispatching(lane);
    expect(await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'uncertain', cause: 'http_5xx', status: 503 }))
      .toEqual({ decision: 'recorded', state: 'uncertain' });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Reconciliation Required', reconciliation_reason: 'outcome_unknown', mcf_not_found_probes: 0 });
    await backdate((sql) => sql`update public.creator_mcf_sends set intent_reserved_at = ${new Date(base - 120 * 60_000).toISOString()}::timestamptz
      where id = ${run.sendId}`);
    expect(await releaseCreatorMcfSend(db, actor(org), run.sendId)).toEqual({ outcome: 'refused', reason: 'release_evidence_insufficient' });
    expect((await observe('post-1', 100, false)).settlement).toMatchObject({ settlement: 'not_found', notFoundProbes: 1 });
    expect((await observe('post-2', 90, false)).settlement).toMatchObject({ settlement: 'not_found', notFoundProbes: 2 });
    // Four not-found reads in all, one a list, over eighty minutes: only two came after the reservation.
    expect(await releaseCreatorMcfSend(db, actor(org), run.sendId)).toEqual({ outcome: 'refused', reason: 'release_evidence_insufficient' });
    expect((await observe('post-3', 60, true)).settlement).toMatchObject({ settlement: 'escalated', notFoundProbes: 3 });
    const summary = await readCreatorMcfAlertSummary(db);
    expect(summary.conditions.find((condition) => condition.code === 'lane_escalated')?.sendIds).toContain(run.sendId);
    expect(await withAuthenticatedActor(db, actor(org), (sql) => readCreatorMcfSendOutcome(sql, org.id, { derivedOrderKey: lane.key })))
      .toMatchObject({ state: 'uncertain', class: 'uncertain', escalated: true });
    await expect(releaseCreatorMcfSend(db, actor(org, ANALYST), run.sendId)).rejects.toBeInstanceOf(AgencyAccessDenied);
    expect(await releaseCreatorMcfSend(db, actor(org), run.sendId)).toEqual({ outcome: 'released', sendId: run.sendId, state: 'not_created', replay: false });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Reserved', order_owner: 'runner', verified_at: null, reconciliation_reason: null });
    const [event] = await db.sql<{ counts: Record<string, number> }[]>`select counts from public.creator_mcf_send_events where send_id = ${run.sendId}
      and event = 'released'`;
    expect(event!.counts).toEqual({ notFoundReads: 3, listReads: 1, spanSeconds: 2400 });
    expect(await releaseCreatorMcfSend(db, actor(org), run.sendId)).toEqual({ outcome: 'refused', reason: 'send_not_uncertain' });
  });

  it('(10) classifies reads: New is accepted, Received with matching items is placed, failed statuses fail, a mismatch is a conflict', async () => {
    const org = await newOrg('mcf-classify');
    const outcome = async (lane: Lane) => {
      const run = await dispatching(lane);
      await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'uncertain', cause: 'decode', status: 200 });
      return run;
    };
    const newLaneA = await newLane(org);
    const a = await outcome(newLaneA);
    expect(await recordCreatorMcfSettlement(db, a.sendId, found(newLaneA, 'New'))).toMatchObject({ before: 'uncertain', state: 'accepted' });
    expect(await laneRow(newLaneA)).toMatchObject({ lane_state: 'Verified for Submit', reconciliation_reason: null });
    expect(await recordCreatorMcfSettlement(db, a.sendId, found(newLaneA, 'New'))).toMatchObject({ before: 'accepted', state: 'accepted' });
    expect(await recordCreatorMcfSettlement(db, a.sendId, found(newLaneA, 'Received'))).toMatchObject({ before: 'accepted', state: 'placed', nextReadAt: null });
    expect(await laneRow(newLaneA)).toMatchObject({ lane_state: 'Confirmed', order_owner: 'arcana', runner_order_id: newLaneA.key });
    expect(await withAuthenticatedActor(db, actor(org), (sql) => readCreatorMcfSendOutcome(sql, org.id, { creatorRecordId: newLaneA.record, asin: newLaneA.asin })))
      .toMatchObject({ derivedOrderKey: newLaneA.key, state: 'placed', class: 'placed', escalated: false, mcfStatus: 'Received' });
    const failed: string[] = [];
    for (const status of ['Invalid', 'Unfulfillable', 'Cancelled']) {
      const lane = await newLane(org);
      const run = await outcome(lane);
      const result = await recordCreatorMcfSettlement(db, run.sendId, found(lane, status));
      const laneState = await laneRow(lane);
      failed.push(`${String(result['state'])}:${laneState.lane_state}:${laneState.cancellation_reason ?? ''}`);
    }
    expect(failed).toEqual(Array(3).fill('failed_by_amazon:Cancelled:amazon_rejected'));
    const [milestones] = await db.sql<{ placed: number; failed: number; uncertain: number }[]>`select
      count(*) filter (where action = 'mcf_send_placed')::int as placed, count(*) filter (where action = 'mcf_send_failed')::int as failed,
      count(*) filter (where action = 'mcf_send_uncertain')::int as uncertain
      from public.creator_action_log where org_id = ${org.id} and source = 'worker'`;
    expect(milestones).toEqual({ placed: 1, failed: 3, uncertain: 4 });
    // An item mismatch is a conflict with escalation; "Record as sent" needs a validated read at most 30 minutes old.
    const cLane = await newLane(org);
    const c = await dispatching(cLane);
    await recordCreatorMcfOutcome(db, c.sendId, c.claim.leaseId, { outcome: 'accepted', status: 200 });
    await backdate((sql) => sql`update public.creator_mcf_sends set intent_reserved_at = intent_reserved_at - interval '2 hours',
      accepted_at = accepted_at - interval '2 hours' where id = ${c.sendId}`);
    // A read from before the reservation says nothing about the POST and is refused.
    await expect(recordCreatorMcfSettlement(db, c.sendId, found(cLane, 'Received', { readAt: new Date(Date.now() - 150 * 60_000).toISOString() })))
      .rejects.toMatchObject({ code: '22023' });
    const old = new Date(Date.now() - 55 * 60_000).toISOString();
    expect(await recordCreatorMcfSettlement(db, c.sendId, found(cLane, 'Received', { readAt: old, items: [{ sellerSku: 'OTHER-SKU', quantity: 1 }] })))
      .toMatchObject({ state: 'conflict' });
    expect(await sendRow(c.sendId)).toMatchObject({ state: 'conflict', escalation_reason: 'conflict' });
    const request = randomUUID();
    expect(await resolveCreatorMcfConflict(db, actor(org), c.sendId, request)).toEqual({ outcome: 'refused', reason: 'settlement_read_required' });
    await recordCreatorMcfSettlement(db, c.sendId, found(cLane, 'New', { items: [{ sellerSku: 'OTHER-SKU', quantity: 1 }] }));
    expect(await resolveCreatorMcfConflict(db, actor(org), c.sendId, request)).toEqual({ outcome: 'refused', reason: 'settlement_read_required' });
    expect(await recordCreatorMcfSettlement(db, c.sendId, found(cLane, 'Planning', { items: [{ sellerSku: 'OTHER-SKU', quantity: 1 }] })))
      .toMatchObject({ before: 'conflict', state: 'conflict' });
    // Even a matching validated read does not place a conflict; only the operator does.
    expect(await recordCreatorMcfSettlement(db, c.sendId, found(cLane, 'Received'))).toMatchObject({ before: 'conflict', state: 'conflict' });
    await expect(resolveCreatorMcfConflict(db, actor(org, ANALYST), c.sendId, request)).rejects.toBeInstanceOf(AgencyAccessDenied);
    expect(await resolveCreatorMcfConflict(db, actor(org), c.sendId, request)).toEqual({ outcome: 'placed', sendId: c.sendId, state: 'placed', replay: false });
    expect(await resolveCreatorMcfConflict(db, actor(org), c.sendId, request)).toMatchObject({ outcome: 'placed', replay: true });
    expect(await laneRow(cLane)).toMatchObject({ lane_state: 'Confirmed', runner_order_id: cLane.key });
    const [resolved] = await db.sql<{ codes: string[] }[]>`select codes from public.creator_mcf_send_events where send_id = ${c.sendId}
      and event = 'conflict_resolved'`;
    expect(resolved!.codes).toEqual(['item_sku_mismatch']);
  });

  it('(10) a rejected create followed by a found read is classified, and a placed order Amazon later cancels fails after placement', async () => {
    const org = await newOrg('mcf-rejected-found');
    const lane = await newLane(org);
    const run = await dispatching(lane);
    await expect(recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'rejected', status: 400, codes: ['DuplicateOrder'], reason: 'validation' }))
      .rejects.toMatchObject({ code: '22023' });
    expect(await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'rejected', status: 400, codes: ['DuplicateOrder'], reason: 'validation' },
      found(lane, 'Received'))).toEqual({ decision: 'recorded', state: 'placed' });
    expect(await sendRow(run.sendId)).toMatchObject({ provider_outcome: 'rejected', posts: 1, amazon_status: 'Received' });
    await recordCreatorMcfObservation(db, org.id, { observationKey: `observe-${hex(4)}:${lane.key}`, derivedOrderKey: lane.key, queriedOrderId: lane.key,
      operation: 'getFulfillmentOrder', outcome: 'found', status: 'Cancelled', shipments: [], packages: [], readAt: new Date(Date.now() + 1000).toISOString(),
      jobId: null });
    expect(await sendRow(run.sendId)).toMatchObject({ state: 'failed_after_placement', amazon_status: 'Cancelled' });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'amazon_cancelled_after_submit', order_owner: 'arcana' });
  });

  it('(11) a late 200 on an uncertain(crash) send moves it to accepted; a late failure leaves it uncertain; a later answer is still recorded', async () => {
    const org = await newOrg('mcf-late');
    const lanes = [await newLane(org), await newLane(org), await newLane(org)];
    const runs = [await dispatching(lanes[0]!), await dispatching(lanes[1]!), await dispatching(lanes[2]!)];
    await backdate((sql) => sql`update public.creator_mcf_sends set lease_until = now() - interval '1 second' where id in ${sql(runs.map((r) => r.sendId))}`);
    expect(await expireCreatorMcfCustody(db)).toMatchObject({ uncertainCrash: 3 });
    // The third send was settled by a read before its POST's answer arrived; the answer is kept as evidence.
    expect(await recordCreatorMcfSettlement(db, runs[2]!.sendId, found(lanes[2]!, 'New'))).toMatchObject({ state: 'accepted' });
    expect(await recordCreatorMcfOutcome(db, runs[2]!.sendId, runs[2]!.claim.leaseId, { outcome: 'rejected', status: 400,
      codes: ['DuplicateOrder'], reason: 'validation' }, found(lanes[2]!, 'Received'))).toEqual({ decision: 'late_recorded', state: 'placed' });
    expect(await sendRow(runs[2]!.sendId)).toMatchObject({ state: 'placed', provider_outcome: 'rejected' });
    expect(await recordCreatorMcfOutcome(db, runs[0]!.sendId, runs[0]!.claim.leaseId, { outcome: 'accepted', status: 200 }))
      .toEqual({ decision: 'late_recorded', state: 'accepted' });
    expect(await recordCreatorMcfOutcome(db, runs[1]!.sendId, runs[1]!.claim.leaseId, { outcome: 'uncertain', cause: 'http_5xx', status: 502 }))
      .toEqual({ decision: 'late_recorded', state: 'uncertain' });
    expect(await recordCreatorMcfOutcome(db, runs[0]!.sendId, randomUUID(), { outcome: 'accepted', status: 200 })).toMatchObject({ decision: 'refused' });
    expect(await sendRow(runs[0]!.sendId)).toMatchObject({ state: 'accepted', posts: 1, provider_outcome: 'accepted' });
    expect(await laneRow(lanes[0]!)).toMatchObject({ lane_state: 'Verified for Submit', reconciliation_reason: null });
    expect(await sendRow(runs[1]!.sendId)).toMatchObject({ state: 'uncertain', state_reason: 'crash' });
    const [late] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events where event = 'late_outcome'
      and send_id in ${db.sql(runs.map((r) => r.sendId))}`;
    expect(late!.n).toBe(3);
  });

  it('(12) deletes an org holding a placed send, events, previews, custody, a grant and an Arcana lane; refuses while a send is uncertain', async () => {
    const org = await newOrg('mcf-purge');
    const lane = await newLane(org);
    const run = await dispatching(lane);
    await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'accepted', status: 200 });
    await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Received'));
    await seal(await newLane(org));
    const [held] = await db.sql<{ placed: number; custody: number; grants: number; arcana: number; events: number; previews: number }[]>`select
      (select count(*)::int from public.creator_mcf_sends where org_id = ${org.id} and state = 'placed') as placed,
      (select count(*)::int from app.creator_mcf_recipient_custody where org_id = ${org.id}) as custody,
      (select count(*)::int from app.creator_mcf_grants where org_id = ${org.id}) as grants,
      (select count(*)::int from public.creator_sample_shipments where org_id = ${org.id} and order_owner = 'arcana') as arcana,
      (select count(*)::int from public.creator_mcf_send_events where org_id = ${org.id}) > 0 as events,
      (select count(*)::int from public.creator_mcf_send_previews where org_id = ${org.id}) > 0 as previews`;
    expect(held).toMatchObject({ placed: 1, custody: 2, grants: 1, arcana: 1, events: true, previews: true });
    await db.sql`delete from public.orgs where id = ${org.id}`;
    const [gone] = await db.sql<Record<string, number>[]>`select
      (select count(*)::int from public.creator_mcf_sends where org_id = ${org.id}) as sends,
      (select count(*)::int from app.creator_mcf_recipient_custody where org_id = ${org.id}) as custody,
      (select count(*)::int from app.creator_mcf_grants where org_id = ${org.id}) as grants,
      (select count(*)::int from public.creator_mcf_send_events where org_id = ${org.id}) as events,
      (select count(*)::int from public.creator_mcf_send_previews where org_id = ${org.id}) as previews,
      (select count(*)::int from public.creator_mcf_outbox where send_id = ${run.sendId}) as outbox,
      (select count(*)::int from public.creator_sample_shipments where org_id = ${org.id}) as lanes`;
    expect(gone).toEqual({ sends: 0, custody: 0, grants: 0, events: 0, previews: 0, outbox: 0, lanes: 0 });

    const blocked = await newOrg('mcf-purge-blocked');
    const blockedRun = await dispatching(await newLane(blocked));
    await recordCreatorMcfOutcome(db, blockedRun.sendId, blockedRun.claim.leaseId, { outcome: 'uncertain', cause: 'transport', status: null });
    await expect(db.sql`delete from public.orgs where id = ${blocked.id}`).rejects.toMatchObject({ code: '55000' });
    const [kept] = await db.sql<{ uncertain: number; orgs: number }[]>`select
      (select count(*)::int from public.creator_mcf_sends where org_id = ${blocked.id} and state = 'uncertain') as uncertain,
      (select count(*)::int from public.orgs where id = ${blocked.id}) as orgs`;
    expect(kept).toEqual({ uncertain: 1, orgs: 1 });
  });

  it('(13) nulls a mask 30 days after its send ended, and 30 days after delivery of a placed send', async () => {
    const org = await newOrg('mcf-masks');
    const ended = await previewReady(await newLane(org));
    await withdrawCreatorMcfSend(db, actor(org), ended.sendId);
    const [after] = await db.sql<{ days: number }[]>`select round(extract(epoch from mask_purge_after - now()) / 86400)::int as days
      from public.creator_mcf_sends where id = ${ended.sendId}`;
    expect(after!.days).toBe(30);
    expect(await purgeCreatorMcfMasks(db)).toMatchObject({ purged: 0 });
    expect((await sendRow(ended.sendId)).mask).not.toBeNull();
    await backdate((sql) => sql`update public.creator_mcf_sends set mask_purge_after = now() - interval '1 second' where id = ${ended.sendId}`);
    expect(await purgeCreatorMcfMasks(db)).toMatchObject({ purged: 1 });
    expect((await sendRow(ended.sendId)).mask).toBeNull();
    const lane = await newLane(org);
    const run = await dispatching(lane);
    await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'accepted', status: 200 });
    await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Received'));
    const deliveredAt = new Date(Date.now() - 5 * 60_000).toISOString();
    await recordCreatorMcfObservation(db, org.id, { observationKey: `observe-${hex(4)}:${lane.key}`, derivedOrderKey: lane.key, queriedOrderId: lane.key,
      operation: 'getFulfillmentOrder', outcome: 'found', status: 'Complete',
      shipments: [{ amazonShipmentId: 'shipment-1', status: 'SHIPPED', shippedAt: deliveredAt, estimatedArrivalAt: null,
        packages: [{ packageNumber: 7, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-7', estimatedArrivalAt: null }] }],
      packages: [{ packageNumber: 7, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-7', estimatedArrivalAt: null, carrierStatus: 'DELIVERED',
        carrierStatusReadAt: deliveredAt }], readAt: new Date(Date.now() + 1000).toISOString(), jobId: null });
    expect(await purgeCreatorMcfMasks(db)).toEqual({ scheduled: 1, backstop: 0, purged: 0 });
    const [placed] = await db.sql<{ scheduled: boolean }[]>`select mask_purge_after = ${deliveredAt}::timestamptz + interval '30 days' as scheduled
      from public.creator_mcf_sends where id = ${run.sendId}`;
    expect(placed!.scheduled).toBe(true);
    await backdate((sql) => sql`update public.creator_mcf_sends set mask_purge_after = now() - interval '1 second' where id = ${run.sendId}`);
    expect(await purgeCreatorMcfMasks(db)).toEqual({ scheduled: 0, backstop: 0, purged: 1 });
    const [events] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events where event = 'mask_purged'
      and send_id in ${db.sql([ended.sendId, run.sendId])}`;
    expect(events!.n).toBe(2);
    const view = await readCreatorMcfLane(db, actor(org, ANALYST), lane.record, lane.asin);
    expect(view?.send).toMatchObject({ state: 'placed', mask: null, custodyExpiresAt: null });
    // Backstop: an accepted send that never settles keeps its mask at most 37 days after sealing.
    const stuckLane = await newLane(org);
    const stuck = await dispatching(stuckLane);
    await recordCreatorMcfOutcome(db, stuck.sendId, stuck.claim.leaseId, { outcome: 'accepted', status: 200 });
    expect(await purgeCreatorMcfMasks(db)).toEqual({ scheduled: 0, backstop: 0, purged: 0 });
    await backdate((sql) => sql`update public.creator_mcf_sends set created_at = created_at - interval '38 days' where id = ${stuck.sendId}`);
    expect(await purgeCreatorMcfMasks(db)).toEqual({ scheduled: 0, backstop: 1, purged: 1 });
    expect(await sendRow(stuck.sendId)).toMatchObject({ state: 'accepted', mask: null });
  });

  it('opens a real sealed envelope from the custody read with the claim\'s binding, and no plaintext token reaches any MCF table', async () => {
    const org = await newOrg('mcf-real-seal');
    const lane = await newLane(org);
    const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as webcrypto.CryptoKeyPair;
    const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
    const keyId = await creatorMcfRecipientKeyId(publicJwk);
    await regrant(org, { keys: [keyId, KEY_ID] });
    const token = () => `tok${hex(6)}`;
    const recipient = { name: token(), addressLine1: token(), addressLine2: token(), city: token(), stateOrRegion: token(), postalCode: `9${hex(2)}`,
      countryCode: 'US' };
    const sealed = await sealEnvelope(publicJwk, keyId, binding(lane), recipient);
    const result = await sealCreatorMcfRecipient(db, actor(org), { creatorRecordId: lane.record, asin: lane.asin, request: { binding: binding(lane), envelope: sealed } });
    expect(result.outcome).toBe('sealed');
    const sendId = result.outcome === 'sealed' ? result.sendId : '';
    const claim = await claimFor(org, sendId, 'preview');
    expect(claim.binding).toEqual(binding(lane));
    const custody = await readCreatorMcfCustody(db, sendId, claim.leaseId);
    expect(custody?.envelope).toEqual(sealed);
    expect(await readCreatorMcfCustody(db, sendId, randomUUID())).toBeNull();
    const key = await importCreatorMcfRecipientKey(new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', pair.privateKey)), publicJwk);
    const opened = await openCreatorMcfRecipient(key, custody!.envelope, claim.binding);
    expect(opened).toMatchObject({ status: 'opened', recipient });
    const [dump] = await db.sql<{ text: string }[]>`select concat_ws('|',
      (select string_agg(to_jsonb(s)::text, '|') from public.creator_mcf_sends s where org_id = ${org.id}),
      (select string_agg(to_jsonb(e)::text, '|') from public.creator_mcf_send_events e where org_id = ${org.id}),
      (select string_agg(to_jsonb(o)::text, '|') from public.creator_mcf_outbox o where send_id = ${sendId}),
      (select string_agg(encode(c.ciphertext, 'escape') || encode(c.enc, 'escape'), '|') from app.creator_mcf_recipient_custody c where org_id = ${org.id}),
      (select string_agg(to_jsonb(a)::text, '|') from public.creator_action_log a where org_id = ${org.id})) as text`;
    const leaks = Object.values(recipient).filter((value) => value.startsWith('tok') && dump!.text.includes(value));
    expect(leaks).toEqual([]);
    expect(dump!.text.length).toBeGreaterThan(100);
  });

  it('reports the gate to owners, admins and analysts with the heartbeat, scope coverage and today\'s units', async () => {
    const org = await newOrg('mcf-gate');
    const before = await readCreatorMcfSendGate(db, actor(org, ANALYST));
    expect(before).toMatchObject({ active: true, sendingOn: false, unitsToday: 0, maxUnitsPerDay: 20, spapiConnectionId: org.connection,
      marketplaceId: org.marketplace, keyIds: [KEY_ID], residue: { expiredLive: 0, custodyFreeLive: 0 } });
    await recordCreatorMcfHeartbeat(db, { workerId: 'mcf-evo-test', scope: [org.scope], previewEnabled: true, dispatchEnabled: true,
      workerRevision: 'rev-1', lastAuthorizationFailureAt: null });
    expect(await readCreatorMcfSendGate(db, actor(org))).toMatchObject({ sendingOn: true, missing: [],
      heartbeat: { previewEnabled: true, dispatchEnabled: true, scopeCovers: true, workerRevision: 'rev-1' } });
    await recordCreatorMcfHeartbeat(db, { workerId: 'mcf-evo-test', scope: [main.scope], previewEnabled: true, dispatchEnabled: false,
      workerRevision: 'rev-2', lastAuthorizationFailureAt: new Date().toISOString() });
    expect(await readCreatorMcfSendGate(db, actor(org))).toMatchObject({ sendingOn: false, missing: ['scope', 'dispatch_disabled'] });
    const summary = await readCreatorMcfAlertSummary(db);
    expect(summary.conditions.map((condition) => condition.code)).toEqual(['uncertain_over_15m', 'lane_escalated', 'ladder_exhausted', 'conflict',
      'heartbeat_stale', 'custody_residue', 'authorization_failure']);
    expect(summary.conditions.find((condition) => condition.code === 'authorization_failure')!.count).toBeGreaterThanOrEqual(1);
    expect(summary.conditions.find((condition) => condition.code === 'heartbeat_stale')!.count).toBeGreaterThanOrEqual(1);
    expect(summary.conditions.find((condition) => condition.code === 'custody_residue')!.count).toBe(0);
    await expect(readCreatorMcfSendGate(db, actor(org, VIEWER))).rejects.toBeInstanceOf(AgencyAccessDenied);
    await expect(asServiceRole(db, (sql) => sql`select app.record_creator_mcf_heartbeat('x', ${[org.scope, org.scope]}::text[], true, true, 'r', null)`))
      .rejects.toMatchObject({ code: '22023' });
  });

  it('schedules settlement reads on the ladder, escalates at seven days, and serves settle reads on request', async () => {
    const [ladder] = await db.sql<Record<string, Date | null>[]>`with s(start) as (select '2026-09-28T00:00:00Z'::timestamptz) select
      app.creator_mcf_next_settle_at(start, start + interval '30 seconds') as a, app.creator_mcf_next_settle_at(start, start + interval '2 minutes') as b,
      app.creator_mcf_next_settle_at(start, start + interval '20 hours') as c, app.creator_mcf_next_settle_at(start, start + interval '30 hours') as d,
      app.creator_mcf_next_settle_at(start, start + interval '8 days') as e from s`;
    expect(['a', 'b', 'c', 'd', 'e'].map((key) => ladder![key] === null ? null : new Date(ladder![key]!).toISOString())).toEqual(['2026-09-28T00:01:00.000Z',
      '2026-09-28T00:05:00.000Z', '2026-09-28T21:00:00.000Z', '2026-09-29T12:00:00.000Z', null]);
    const org = await newOrg('mcf-ladder');
    const lane = await newLane(org);
    const run = await dispatching(lane);
    await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'accepted', status: 200 });
    expect(await markCreatorMcfLadderExhausted(db, run.sendId)).toMatchObject({ decision: 'refused', reason: 'too_early' });
    await backdate((sql) => sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${run.sendId} and action = 'settle'`);
    const claim = await claimFor(org, run.sendId, 'settle');
    expect(claim.settle).toMatchObject({ reads: 0 });
    const read = await recordCreatorMcfSettlement(db, run.sendId, notFound(), claim.leaseId);
    expect(read).toMatchObject({ decision: 'recorded', before: 'accepted', state: 'accepted', ladderDue: false });
    expect(read['nextReadAt']).not.toBeNull();
    await backdate((sql) => sql`update public.creator_mcf_sends set intent_reserved_at = intent_reserved_at - interval '8 days',
      accepted_at = accepted_at - interval '8 days' where id = ${run.sendId}`);
    // WP-338i: the read that finds the ladder over marks it in its own transaction; the worker's own mark is then a no-op.
    expect(await recordCreatorMcfSettlement(db, run.sendId, notFound())).toMatchObject({ nextReadAt: null, ladderDue: true, ladderMarked: true });
    expect(await markCreatorMcfLadderExhausted(db, run.sendId)).toEqual({ decision: 'unchanged', state: 'accepted' });
    expect(await markCreatorMcfLadderExhausted(db, run.sendId)).toEqual({ decision: 'unchanged', state: 'accepted' });
    expect((await readCreatorMcfAlertSummary(db)).conditions.find((condition) => condition.code === 'ladder_exhausted')?.sendIds).toContain(run.sendId);
    expect(await requestCreatorMcfSettleRead(db, actor(org), run.sendId)).toEqual({ outcome: 'requested', sendId: run.sendId, state: 'accepted', replay: false });
    expect((await claimFor(org, run.sendId, 'settle')).action).toBe('settle');
    expect(await withAuthenticatedActor(db, actor(org), (sql) => readCreatorMcfSendOutcome(sql, org.id, { derivedOrderKey: lane.key })))
      .toMatchObject({ state: 'accepted', class: 'pending', escalated: true });
  });

  it('keeps sends, previews and events readable by owners, admins and analysts of the org only, and writable by no client role', async () => {
    const lane = await newLane(main);
    const ready = await previewReady(lane);
    const read = (userId: string) => asUser(db, userId, (sql) => sql<{ sends: number; previews: number; events: number; foreign: number }[]>`select
      (select count(*)::int from public.creator_mcf_sends where id = ${ready.sendId}) as sends,
      (select count(*)::int from public.creator_mcf_send_previews where send_id = ${ready.sendId}) as previews,
      (select count(*)::int from public.creator_mcf_send_events where send_id = ${ready.sendId}) as events,
      (select count(*)::int from public.creator_mcf_sends where org_id <> ${main.id}) as foreign`);
    expect((await read(ANALYST))[0]).toMatchObject({ sends: 1, previews: 1 });
    expect((await read(VIEWER))[0]).toEqual({ sends: 0, previews: 0, events: 0, foreign: 0 });
    await expect(asUser(db, OWNER, (sql) => sql`update public.creator_mcf_sends set state = 'approved' where id = ${ready.sendId}`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asServiceRole(db, (sql) => sql`update public.creator_mcf_sends set state = 'approved' where id = ${ready.sendId}`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(asUser(db, OWNER, (sql) => sql`select count(*) from public.creator_mcf_outbox`)).rejects.toMatchObject({ code: '42501' });
    // The transition trigger holds for the owner too.
    await expect(db.sql`update public.creator_mcf_sends set state = 'placed', placed_at = now() where id = ${ready.sendId}`).rejects.toMatchObject({ code: '55000' });
    await expect(db.sql`update app.creator_mcf_recipient_custody set expires_at = now() where send_id = ${ready.sendId}`).rejects.toMatchObject({ code: '23514' });
    await expect(db.sql`update app.creator_mcf_grants set max_units_per_day = 5 where org_id = ${main.id} and revoked_at is null`).rejects.toMatchObject({ code: '23514' });
    await expect(db.sql`delete from public.creator_mcf_send_events where send_id = ${ready.sendId}`).rejects.toMatchObject({ code: '23514' });
  });

  it('seeds a grant only from a fully rendered template copy, rehearsing without persistence and rotating the prior grant', async () => {
    const org = await newOrg('mcf-template', null);
    const template = await readFile(new URL('../testing/creator-mcf-grant-seed.TEMPLATE.sql', import.meta.url), 'utf8');
    const values: Record<string, string> = { ORG_ID: org.id, SPAPI_CONNECTION_ID: org.connection, MARKETPLACE_ID: org.marketplace,
      ACTION_CLASSES: 'send,cancel', RECIPIENT_KEY_IDS: KEY_ID, MAX_UNITS_PER_DAY: '1', MAX_FEE_MINOR: '1500', CURRENCY_CODE: 'USD',
      OPERATOR_LABEL: 'synthetic operator', GRANT_EXPIRES_AT: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      EXPECTED_PRIOR_GRANT_ID_OR_EMPTY: '', WINDOW_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() };
    const render = (change: Record<string, string> = {}) => template.replace(/__([A-Z_]+)__/g, (_, key: string) => {
      const value = { ...values, ...change }[key];
      if (value === undefined) throw new Error(`missing template value ${key}`);
      return value.replaceAll("'", "''");
    });
    const execute = async (source: string) => {
      const sql = await db.sql.reserve();
      try { await sql.unsafe(source).simple(); } finally { await sql`rollback`; sql.release(); }
    };
    const active = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_grants where org_id = ${org.id}
      and revoked_at is null`)[0]!.n;
    await expect(execute(template)).rejects.toMatchObject({ code: '22P02' });
    await execute(render());
    expect(await active()).toBe(0);
    await execute(render().replace(/rollback;\s*$/, 'commit;'));
    expect(await active()).toBe(1);
    await expect(execute(render().replace(/rollback;\s*$/, 'commit;'))).rejects.toThrow('Grant prior changed');
    const [prior] = await db.sql<{ id: string }[]>`select id from app.creator_mcf_grants where org_id = ${org.id} and revoked_at is null`;
    await execute(render({ EXPECTED_PRIOR_GRANT_ID_OR_EMPTY: prior!.id, RECIPIENT_KEY_IDS: `${KEY_ID},${OTHER_KEY_ID}` }).replace(/rollback;\s*$/, 'commit;'));
    const grants = await db.sql<{ keys: string[]; revoked: boolean }[]>`select recipient_key_ids as keys, revoked_at is not null as revoked
      from app.creator_mcf_grants where org_id = ${org.id} order by created_at, revoked_at nulls last`;
    expect(grants).toEqual([{ keys: [KEY_ID], revoked: true }, { keys: [KEY_ID, OTHER_KEY_ID], revoked: false }]);
  });

  // ===========================================================================
  // WP-338i: the guarded Amazon cancel, and the ledger follow-ups.
  // ===========================================================================

  const CANCEL_ONE = 'Cancel 1 order in Amazon';
  let ahead = 0;
  /** A read time after every earlier one in this run (and within the ledger's one-minute future allowance). */
  const soon = () => new Date(Date.now() + 1000 + (ahead += 20)).toISOString();
  const OTHER_ITEMS = [{ sellerSku: 'OTHER-SKU', quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }];

  /** A send Amazon holds under its key with the right SKU and one unit (Received): placed, lane Confirmed. */
  async function placedSend(lane: Lane) {
    const run = await dispatching(lane);
    expect(await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'accepted', status: 200 })).toMatchObject({ state: 'accepted' });
    expect(await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Received'))).toMatchObject({ state: 'placed' });
    return run;
  }

  /** A send whose key Amazon holds with another SKU (Received): conflict, lane Verified for Submit. */
  async function conflictSend(lane: Lane) {
    const run = await dispatching(lane);
    await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'accepted', status: 200 });
    expect(await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Received', { items: OTHER_ITEMS }))).toMatchObject({ state: 'conflict' });
    return run;
  }

  /** The worker's CreatorMcfCancelPreview for one found read: its status, its items with positional line ids, 5 minutes of validity. */
  function cancelPreviewOf(claim: CreatorMcfClaim, lane: Lane, lookup: CreatorMcfOrderRead, change: Partial<Record<string, unknown>> = {}): CreatorMcfCancelPreview {
    if (lookup.outcome !== 'found') throw new Error('a cancel preview needs a found read');
    return {
      previewId: randomUUID(), sendId: claim.sendId, derivedOrderKey: lane.key, reservationId: lane.reservation, spapiConnectionId: claim.spapiConnectionId,
      marketplaceId: claim.marketplaceId, readAt: lookup.readAt, validUntil: new Date(Date.parse(lookup.readAt) + 5 * 60_000).toISOString(),
      workerRevision: 'wp338i-test', kind: 'cancel_preview', existingOrder: { status: lookup.status },
      items: lookup.items.map((item, index) => ({ sellerSku: item.sellerSku, sellerFulfillmentOrderItemId: `${lane.key}-${index + 1}`, quantity: item.quantity })),
      totalUnits: lookup.items.reduce((sum, item) => sum + item.quantity, 0), ...change,
    } as CreatorMcfCancelPreview;
  }

  /** "Cancel in Amazon", then the worker's preview read recorded as a cancel preview. */
  async function cancelPreviewReady(lane: Lane, sendId: string, status: 'Received' | 'Planning' = 'Received', items?: typeof OTHER_ITEMS) {
    expect(await requestCreatorMcfCancelPreview(db, actor(lane.org), sendId)).toMatchObject({ outcome: 'cancel_preview_requested', sendId, replay: false });
    const claim = await claimFor(lane.org, sendId, 'cancel');
    expect(claim.cancel?.mode).toBe('preview');
    const lookup = found(lane, status, { readAt: soon(), ...(items === undefined ? {} : { items }) });
    const preview = cancelPreviewOf(claim, lane, lookup);
    const recorded = await recordCreatorMcfCancelPreview(db, sendId, claim.leaseId, lookup, preview);
    expect(recorded).toMatchObject({ decision: 'cancel_preview_ready', previewId: preview.previewId });
    return { preview, fingerprint: String(recorded['fingerprint']), claim, lookup };
  }

  const cancelApproval = (sendId: string, ready: { preview: CreatorMcfCancelPreview; fingerprint: string }, change: Record<string, unknown> = {}) =>
    ({ sendId, previewId: ready.preview.previewId, previewFingerprint: ready.fingerprint, confirmation: CANCEL_ONE, requestId: randomUUID(), ...change });

  async function cancelRow(sendId: string) {
    const rows = await db.sql<{ origin_state: string; confirmation_text: string; reserved: boolean; puts: number; provider_outcome: string | null;
      ending: string | null; ending_reason: string | null; window: string }[]>`select origin_state, confirmation_text, reserved_at is not null as reserved,
      puts, provider_outcome, ending, ending_reason, (claim_deadline - approved_at)::text as window from app.creator_mcf_cancels
      where send_id = ${sendId} order by approved_at desc, id desc`;
    return rows;
  }
  async function cancelEvents(sendId: string) {
    return (await db.sql<{ event: string }[]>`select event from public.creator_mcf_send_events where send_id = ${sendId}
      and (event like 'cancel%' or event = 'settlement_read') order by at, id`).map((row) => row.event);
  }
  async function openWork(sendId: string) {
    return (await db.sql<{ action: string }[]>`select action from public.creator_mcf_outbox where send_id = ${sendId} and completed_at is null
      order by action`).map((row) => row.action);
  }
  const observe = (org: Org, lane: Lane, status: string) => recordCreatorMcfObservation(db, org.id, { observationKey: `observe-${hex(4)}:${lane.key}`,
    derivedOrderKey: lane.key, queriedOrderId: lane.key, operation: 'getFulfillmentOrder', outcome: 'found', status: status as 'Received',
    shipments: [], packages: [], readAt: soon(), jobId: null });

  it('WP-338i computes the cancel wording in SQL exactly as the shared function does, for 1 to 20', async () => {
    const rows = await db.sql<{ n: number; wording: string | null }[]>`select n, app.creator_mcf_cancel_confirmation(n) as wording
      from generate_series(0, 21) n order by n`;
    expect(rows).toHaveLength(22);
    for (let n = 1; n <= 20; n++) expect(rows[n]!.wording).toBe(creatorMcfCancelConfirmation(n));
    expect([rows[0]!.wording, rows[21]!.wording]).toEqual([null, null]);
    expect(rows[1]!.wording).toBe(CANCEL_ONE);
  });

  it('WP-338i cancels a placed order: preview read, "Cancel 1 order in Amazon", one reserved request, settled by reads to Cancelled; custody untouched', async () => {
    const org = await newOrg('mcf-cancel');
    const lane = await newLane(org);
    const run = await placedSend(lane);
    const before = await custodyProof(run.sendId);
    expect(before.custody).toBe(0);
    expect(before.tombstones).toHaveLength(1);
    const custodyReads = async () => (await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events
      where send_id = ${run.sendId} and event = 'custody_read'`)[0]!.n;
    const readsBefore = await custodyReads();
    const ready = await cancelPreviewReady(lane, run.sendId);
    expect(ready.fingerprint).toBe(await creatorMcfPreviewFingerprint(ready.preview));
    const shown = await readCreatorMcfLane(db, actor(org, ANALYST), lane.record, lane.asin);
    expect(shown!.send).toMatchObject({ state: 'placed', cancel: null, cancelPreviewPending: false, cancelPreviewRefusal: null,
      latestCancelPreview: { previewId: ready.preview.previewId, fingerprint: ready.fingerprint } });
    expect(shown!.send!.latestCancelPreview!.preview).toMatchObject({ kind: 'cancel_preview', existingOrder: { status: 'Received' }, totalUnits: 1,
      items: [{ sellerSku: lane.sku, sellerFulfillmentOrderItemId: `${lane.key}-1`, quantity: 1 }] });

    const approval = cancelApproval(run.sendId, ready);
    expect(await approveCreatorMcfCancel(db, actor(org, ADMIN), approval)).toMatchObject({ outcome: 'cancel_approved', sendId: run.sendId, state: 'placed',
      replay: false });
    expect(await approveCreatorMcfCancel(db, actor(org, ADMIN), approval)).toMatchObject({ outcome: 'cancel_approved', state: 'placed', replay: true });
    expect(await cancelRow(run.sendId)).toEqual([{ origin_state: 'placed', confirmation_text: CANCEL_ONE, reserved: false, puts: 0, provider_outcome: null,
      ending: null, ending_reason: null, window: '00:15:00' }]);
    expect(await sendRow(run.sendId)).toMatchObject({ state: 'placed' });
    expect(await openWork(run.sendId)).toEqual(['cancel']);

    const claim = await claimFor(org, run.sendId, 'cancel');
    expect(claim.cancel).toMatchObject({ mode: 'execute', originState: 'placed', previewId: ready.preview.previewId, fingerprint: ready.fingerprint });
    expect(claim.mask).toBeNull();
    const reserved = await reserveCreatorMcfCancel(db, run.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon() }), hex(32));
    expect(reserved).toMatchObject({ decision: 'cancel_once', sendId: run.sendId, derivedOrderKey: lane.key, orderStatus: 'Received' });
    expect(await sendRow(run.sendId)).toMatchObject({ state: 'cancel_dispatching', posts: 1 });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Confirmed', runner_order_id: lane.key, cancellation_reason: null });
    // Exactly one permission: the same lease is told it already has it, and no cancel work is left to claim.
    expect(await reserveCreatorMcfCancel(db, run.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon() }), hex(32)))
      .toEqual({ decision: 'already_reserved', state: 'cancel_dispatching' });
    expect(await claimCreatorMcfOutbox(db, { claimant: 'wp338i-test', scope: [org.scope], actions: ['cancel'] })).toBeNull();
    expect(await openWork(run.sendId)).toEqual(['settle']);
    expect(await recordCreatorMcfCancelOutcome(db, run.sendId, claim.leaseId, { outcome: 'accepted', status: 200 }))
      .toEqual({ decision: 'recorded', state: 'cancel_dispatching' });
    expect(await recordCreatorMcfCancelOutcome(db, run.sendId, claim.leaseId, { outcome: 'accepted', status: 200 }))
      .toEqual({ decision: 'unchanged', state: 'cancel_dispatching' });
    expect(await recordCreatorMcfCancelOutcome(db, run.sendId, claim.leaseId, { outcome: 'uncertain', cause: 'http_5xx', status: 503 }))
      .toEqual({ decision: 'refused', reason: 'recorded', state: 'cancel_dispatching' });

    // HTTP 200 is not a cancel: only a read of the key after the reservation settles it.
    await backdate((sql) => sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${run.sendId} and action = 'settle'`);
    const settle = await claimFor(org, run.sendId, 'settle');
    expect(settle.settle).toMatchObject({ intentReservedAt: reserved.decision === 'cancel_once' ? reserved.reservedAt : null,
      ladderStart: reserved.decision === 'cancel_once' ? reserved.reservedAt : null });
    expect(await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Received', { readAt: soon() }), settle.leaseId))
      .toMatchObject({ before: 'cancel_dispatching', state: 'cancel_dispatching', ladderDue: false, ladderMarked: false });
    expect(await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Cancelled', { readAt: soon() })))
      .toMatchObject({ before: 'cancel_dispatching', state: 'cancelled', nextReadAt: null });
    expect(await sendRow(run.sendId)).toMatchObject({ state: 'cancelled', state_reason: 'operator_cancelled_in_amazon', amazon_status: 'Cancelled',
      posts: 1 });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'operator_cancelled_in_amazon', order_owner: 'arcana',
      runner_order_id: lane.key });
    expect(await cancelRow(run.sendId)).toEqual([{ origin_state: 'placed', confirmation_text: CANCEL_ONE, reserved: true, puts: 1,
      provider_outcome: 'accepted', ending: 'cancelled', ending_reason: 'operator_cancelled_in_amazon', window: '00:15:00' }]);
    // The first settlement_read is the one that placed the order.
    expect(await cancelEvents(run.sendId)).toEqual(['settlement_read', 'cancel_preview_requested', 'cancel_claimed', 'cancel_preview_recorded',
      'cancel_approved', 'cancel_claimed', 'cancel_requested', 'cancel_reserved', 'cancel_outcome', 'settlement_read', 'cancelled']);
    const [milestone] = await db.sql<{ n: number; source: string; reason: string }[]>`select count(*)::int as n, min(source) as source,
      min(reason_code) as reason from public.creator_action_log where org_id = ${org.id} and action = 'mcf_send_cancelled'`;
    expect(milestone).toEqual({ n: 1, source: 'worker', reason: 'operator_cancelled_in_amazon' });
    expect(await withAuthenticatedActor(db, actor(org), (sql) => readCreatorMcfSendOutcome(sql, org.id, { derivedOrderKey: lane.key })))
      .toMatchObject({ state: 'cancelled', class: 'cancelled', mcfStatus: 'Cancelled' });
    expect(await openWork(run.sendId)).toEqual([]);
    // Custody was destroyed at the create's outcome; nothing in the cancel read, wrote or recreated it.
    const after = await custodyProof(run.sendId);
    expect(after).toEqual({ custody: 0, tombstones: before.tombstones, residue: { expiredLive: 0, custodyFreeLive: 0 } });
    expect(await custodyReads()).toBe(readsBefore);
  });

  it('WP-338i refuses the cancel press from a non-owner/admin, with the wrong wording, without the grant class, on a stale or newer preview, and once one is open', async () => {
    const org = await newOrg('mcf-cancel-refusals');
    const lane = await newLane(org);
    const run = await placedSend(lane);
    for (const user of [ANALYST, VIEWER]) {
      await expect(requestCreatorMcfCancelPreview(db, actor(org, user), run.sendId)).rejects.toBeInstanceOf(AgencyAccessDenied);
    }
    const ready = await cancelPreviewReady(lane, run.sendId);
    for (const user of [ANALYST, VIEWER]) {
      await expect(approveCreatorMcfCancel(db, actor(org, user), cancelApproval(run.sendId, ready))).rejects.toBeInstanceOf(AgencyAccessDenied);
    }
    // The wording: the wrapper refuses before the database, and the database refuses on its own.
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready, { confirmation: 'Cancel 2 orders in Amazon' })))
      .toEqual({ outcome: 'refused', reason: 'approval_invalid' });
    const raw = async (confirmation: string) => {
      const [row] = await asUser(db, OWNER, (sql) => sql<{ result: Record<string, unknown> }[]>`select app.approve_creator_mcf_cancel(${org.id}::uuid,
        ${run.sendId}::uuid, ${ready.preview.previewId}::uuid, ${ready.fingerprint}, ${confirmation}, ${randomUUID()}::uuid) as result`);
      return row!.result;
    };
    for (const wording of ['Cancel 2 orders in Amazon', 'Cancel 1 orders in Amazon', 'Send 1 unit via Amazon', 'cancel 1 order in amazon']) {
      expect(await raw(wording)).toEqual({ outcome: 'refused', reason: 'confirmation_mismatch' });
    }
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready, { previewFingerprint: hex(32) })))
      .toEqual({ outcome: 'refused', reason: 'fingerprint_mismatch' });
    // The grant class: a send-only grant refuses the request and the press; no cancel work can be claimed under it.
    await regrant(org, { actions: ['send'] });
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready))).toEqual({ outcome: 'refused', reason: 'cancel_grant_inactive' });
    expect(await requestCreatorMcfCancelPreview(db, actor(org), run.sendId)).toEqual({ outcome: 'refused', reason: 'cancel_grant_inactive' });
    await backdate((sql) => sql`insert into public.creator_mcf_outbox(send_id, action) values (${run.sendId}, 'cancel')`);
    expect(await claimCreatorMcfOutbox(db, { claimant: 'wp338i-test', scope: [org.scope], actions: ['cancel'] })).toBeNull();
    await db.sql`update public.creator_mcf_outbox set completed_at = now() where send_id = ${run.sendId} and completed_at is null`;
    await regrant(org, { actions: ['send', 'cancel'] });
    // A newer preview supersedes the one on screen.
    const newer = await cancelPreviewReady(lane, run.sendId);
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready))).toEqual({ outcome: 'refused', reason: 'preview_not_latest' });
    // A preview read more than 5 minutes ago.
    await backdate((sql) => sql`update public.creator_mcf_send_previews set read_at = read_at - interval '6 minutes',
      valid_until = valid_until - interval '6 minutes' where id = ${newer.preview.previewId}`);
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, newer))).toEqual({ outcome: 'refused', reason: 'cancel_preview_expired' });
    // An observation of the key more than 5 minutes old behind a preview that is not.
    const fresh = await cancelPreviewReady(lane, run.sendId);
    await backdate((sql) => sql`update public.creator_mcf_observations set read_at = read_at - interval '7 minutes' where org_id = ${org.id}
      and derived_order_key = ${lane.key}`);
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, fresh))).toEqual({ outcome: 'refused', reason: 'observation_stale' });
    // One open cancel per send, and a request id is bound to its first press.
    const ok = await cancelPreviewReady(lane, run.sendId);
    const first = cancelApproval(run.sendId, ok);
    expect(await approveCreatorMcfCancel(db, actor(org), first)).toMatchObject({ outcome: 'cancel_approved', replay: false });
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ok))).toEqual({ outcome: 'refused', reason: 'cancel_open' });
    expect(await approveCreatorMcfCancel(db, actor(org), { ...first, previewFingerprint: hex(32) })).toEqual({ outcome: 'refused', reason: 'request_reused' });
    expect(await requestCreatorMcfCancelPreview(db, actor(org), run.sendId)).toEqual({ outcome: 'refused', reason: 'cancel_open' });
    expect(await cancelRow(run.sendId)).toHaveLength(1);
    // A newer read by another reader shows Processing: the next press is refused.
    const lane2 = await newLane(org);
    const run2 = await placedSend(lane2);
    const picked = await cancelPreviewReady(lane2, run2.sendId);
    await observe(org, lane2, 'Processing');
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(run2.sendId, picked))).toEqual({ outcome: 'refused', reason: 'order_not_cancellable' });
    expect(await cancelRow(run2.sendId)).toEqual([]);
  });

  it('WP-338i refuses a cancel while the order is New, and in Processing or later, at the preview read; the SQL checks the preview itself', async () => {
    const org = await newOrg('mcf-cancel-status');
    // An accepted send (Amazon holds it New) is neither placed nor in conflict.
    const accepted = await newLane(org);
    const acc = await dispatching(accepted);
    await recordCreatorMcfOutcome(db, acc.sendId, acc.claim.leaseId, { outcome: 'accepted', status: 200 });
    expect(await requestCreatorMcfCancelPreview(db, actor(org), acc.sendId)).toEqual({ outcome: 'refused', reason: 'send_not_cancellable' });
    // A conflict whose order Amazon still holds as New: the read is recorded, no preview.
    const lane = await newLane(org);
    const c = await conflictSend(lane);
    expect(await requestCreatorMcfCancelPreview(db, actor(org), c.sendId)).toMatchObject({ outcome: 'cancel_preview_requested' });
    const claim = await claimFor(org, c.sendId, 'cancel');
    expect(await recordCreatorMcfCancelPreview(db, c.sendId, claim.leaseId, found(lane, 'New', { readAt: soon(), items: OTHER_ITEMS }), null))
      .toEqual({ decision: 'cancel_preview_refused', reason: 'status_new', state: 'conflict' });
    const view = await readCreatorMcfLane(db, actor(org), lane.record, lane.asin);
    expect(view!.send).toMatchObject({ state: 'conflict', latestCancelPreview: null, cancelPreviewPending: false,
      cancelPreviewRefusal: { reason: 'status_new', codes: ['status_new'] } });
    expect(await approveCreatorMcfCancel(db, actor(org), { sendId: c.sendId, previewId: randomUUID(), previewFingerprint: hex(32), confirmation: CANCEL_ONE,
      requestId: randomUUID() })).toEqual({ outcome: 'refused', reason: 'preview_not_latest' });
    // Processing and every later status that is not a failure: refused, the send stays placed.
    for (const status of ['Processing', 'Complete', 'CompletePartialled'] as const) {
      const placedLane = await newLane(org);
      const placed = await placedSend(placedLane);
      await requestCreatorMcfCancelPreview(db, actor(org), placed.sendId);
      const read = await claimFor(org, placed.sendId, 'cancel');
      expect(await recordCreatorMcfCancelPreview(db, placed.sendId, read.leaseId, found(placedLane, status, { readAt: soon() }), null))
        .toEqual({ decision: 'cancel_preview_refused', reason: `status_${status.toLowerCase()}`, state: 'placed' });
      expect(await sendRow(placed.sendId)).toMatchObject({ state: 'placed', amazon_status: status });
      expect(await openWork(placed.sendId)).toEqual([]);
    }
    // The preview must say what the read said, name the read's items and last at most 5 minutes; else nothing is recorded.
    const checked = await newLane(org);
    const target = await placedSend(checked);
    await requestCreatorMcfCancelPreview(db, actor(org), target.sendId);
    const lease = await claimFor(org, target.sendId, 'cancel');
    const lookup = found(checked, 'Received', { readAt: soon() });
    const record = (body: Record<string, unknown>) => asServiceRole(db, (sql) => sql`select app.record_creator_mcf_cancel_preview(${target.sendId}::uuid,
      ${lease.leaseId}::uuid, ${JSON.stringify(lookup)}::text::jsonb, ${JSON.stringify(body)}) as result`);
    const good = cancelPreviewOf(lease, checked, lookup);
    for (const bad of [{ ...good, existingOrder: { status: 'Planning' } }, { ...good, existingOrder: { status: 'New' } },
      { ...good, validUntil: new Date(Date.parse(lookup.readAt) + 6 * 60_000).toISOString() }, { ...good, readAt: new Date().toISOString() },
      { ...good, items: [{ ...good.items[0]!, sellerFulfillmentOrderItemId: `${checked.key}-2` }] }, { ...good, totalUnits: 2 },
      { ...good, items: [{ ...good.items[0]!, sellerSku: 'OTHER-SKU' }] }, { ...good, derivedOrderKey: lane.key }, { ...good, recipient: 'x' }]) {
      await expect(record({ ...bad, previewId: randomUUID() })).rejects.toMatchObject({ code: '22023' });
    }
    expect(await recordCreatorMcfCancelPreview(db, target.sendId, lease.leaseId, lookup, good)).toMatchObject({ decision: 'cancel_preview_ready' });
    expect(await recordCreatorMcfCancelPreview(db, target.sendId, lease.leaseId, lookup, good)).toMatchObject({ decision: 'unchanged' });
    const [count] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_previews where send_id = ${target.sendId}
      and kind = 'cancel_preview'`;
    expect(count!.n).toBe(1);
  });

  it('WP-338i cancels from conflict while Received or Planning; a re-read in Processing refuses before any request and leaves the conflict as it was', async () => {
    const org = await newOrg('mcf-cancel-conflict');
    const lane = await newLane(org);
    const c = await conflictSend(lane);
    const ready = await cancelPreviewReady(lane, c.sendId, 'Planning', OTHER_ITEMS);
    expect(await approveCreatorMcfCancel(db, actor(org), cancelApproval(c.sendId, ready))).toMatchObject({ outcome: 'cancel_approved', state: 'conflict' });
    const claim = await claimFor(org, c.sendId, 'cancel');
    expect(claim.cancel).toMatchObject({ mode: 'execute', originState: 'conflict' });
    expect(await reserveCreatorMcfCancel(db, c.sendId, claim.leaseId, found(lane, 'Planning', { readAt: soon(), items: OTHER_ITEMS }), hex(32)))
      .toMatchObject({ decision: 'cancel_once', orderStatus: 'Planning' });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Verified for Submit', order_owner: 'arcana' });
    expect(await recordCreatorMcfCancelOutcome(db, c.sendId, claim.leaseId, { outcome: 'uncertain', cause: 'http_5xx', status: 503 }))
      .toEqual({ decision: 'recorded', state: 'cancel_dispatching' });
    expect(await recordCreatorMcfSettlement(db, c.sendId, found(lane, 'Cancelled', { readAt: soon(), items: OTHER_ITEMS })))
      .toMatchObject({ before: 'cancel_dispatching', state: 'cancelled' });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'operator_cancelled_in_amazon' });
    expect(await sendRow(c.sendId)).toMatchObject({ state: 'cancelled', escalation_reason: 'conflict' });

    const lane2 = await newLane(org);
    const c2 = await conflictSend(lane2);
    const ready2 = await cancelPreviewReady(lane2, c2.sendId, 'Received', OTHER_ITEMS);
    await approveCreatorMcfCancel(db, actor(org), cancelApproval(c2.sendId, ready2));
    const claim2 = await claimFor(org, c2.sendId, 'cancel');
    expect(await reserveCreatorMcfCancel(db, c2.sendId, claim2.leaseId, found(lane2, 'Processing', { readAt: soon(), items: OTHER_ITEMS }), hex(32)))
      .toEqual({ decision: 'refused', reason: 'cancel_refused', ending: 'status_processing', orderStatus: 'Processing', state: 'conflict' });
    expect(await sendRow(c2.sendId)).toMatchObject({ state: 'conflict', escalation_reason: 'conflict', amazon_status: 'Processing' });
    expect(await laneRow(lane2)).toMatchObject({ lane_state: 'Verified for Submit', cancellation_reason: null });
    expect(await cancelRow(c2.sendId)).toMatchObject([{ reserved: false, puts: 0, ending: 'refused', ending_reason: 'status_processing' }]);
    const [refused] = await db.sql<{ codes: string[] }[]>`select codes from public.creator_mcf_send_events where send_id = ${c2.sendId} and event = 'cancel_refused'`;
    expect(refused!.codes).toEqual(['status_processing']);
    expect(await claimCreatorMcfOutbox(db, { claimant: 'wp338i-test', scope: [org.scope], actions: ['cancel'] })).toBeNull();
  });

  it('WP-338i rechecks the approver, the grant, the send and the claim deadline before the request, and never grants it after a refusal', async () => {
    const org = await newOrg('mcf-cancel-recheck');
    const approvedCancel = async () => {
      const lane = await newLane(org);
      const run = await placedSend(lane);
      const ready = await cancelPreviewReady(lane, run.sendId);
      expect(await approveCreatorMcfCancel(db, actor(org, ADMIN), cancelApproval(run.sendId, ready))).toMatchObject({ outcome: 'cancel_approved' });
      return { lane, run };
    };
    // The approver lost admin after the press.
    const a = await approvedCancel();
    const aClaim = await claimFor(org, a.run.sendId, 'cancel');
    await db.sql`update public.org_members set role = 'analyst' where org_id = ${org.id} and user_id = ${ADMIN}`;
    try {
      expect(await reserveCreatorMcfCancel(db, a.run.sendId, aClaim.leaseId, found(a.lane, 'Received', { readAt: soon() }), hex(32)))
        .toEqual({ decision: 'refused', reason: 'authority_changed', state: 'placed' });
    } finally {
      await db.sql`update public.org_members set role = 'admin' where org_id = ${org.id} and user_id = ${ADMIN}`;
    }
    expect(await cancelRow(a.run.sendId)).toMatchObject([{ ending: 'refused', ending_reason: 'authority_changed', puts: 0 }]);
    expect(await reserveCreatorMcfCancel(db, a.run.sendId, aClaim.leaseId, found(a.lane, 'Received', { readAt: soon() }), hex(32)))
      .toEqual({ decision: 'refused', reason: 'no_cancel', state: 'placed' });
    // The grant was revoked after the claim.
    const b = await approvedCancel();
    const bClaim = await claimFor(org, b.run.sendId, 'cancel');
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org.id} and revoked_at is null`;
    expect(await reserveCreatorMcfCancel(db, b.run.sendId, bClaim.leaseId, found(b.lane, 'Received', { readAt: soon() }), hex(32)))
      .toEqual({ decision: 'refused', reason: 'grant_revoked', state: 'placed' });
    await regrant(org);
    // Amazon (or someone in Seller Central) cancelled it after the press: the send moved.
    const d = await approvedCancel();
    const dClaim = await claimFor(org, d.run.sendId, 'cancel');
    await observe(org, d.lane, 'Cancelled');
    expect(await sendRow(d.run.sendId)).toMatchObject({ state: 'failed_after_placement' });
    expect(await reserveCreatorMcfCancel(db, d.run.sendId, dClaim.leaseId, found(d.lane, 'Received', { readAt: soon() }), hex(32)))
      .toEqual({ decision: 'refused', reason: 'state_changed', state: 'failed_after_placement' });
    // The re-read must come after the press.
    const e = await approvedCancel();
    const eClaim = await claimFor(org, e.run.sendId, 'cancel');
    await expect(reserveCreatorMcfCancel(db, e.run.sendId, eClaim.leaseId, found(e.lane, 'Received', { readAt: new Date(Date.now() - 60_000).toISOString() }),
      hex(32))).rejects.toMatchObject({ code: '22023' });
    expect(await cancelRow(e.run.sendId)).toMatchObject([{ ending: null, puts: 0 }]);
    // Nobody reserved it within 15 minutes: it expires and nothing is sent.
    await backdate((sql) => sql`update app.creator_mcf_cancels set approved_at = approved_at - interval '16 minutes',
      claim_deadline = claim_deadline - interval '16 minutes' where send_id = ${e.run.sendId}`);
    await db.sql`update public.creator_mcf_outbox set lease_until = now() - interval '1 second' where send_id = ${e.run.sendId} and action = 'cancel'
      and completed_at is null`;
    expect(await claimCreatorMcfOutbox(db, { claimant: 'wp338i-test', scope: [org.scope], actions: ['cancel'] })).toBeNull();
    expect(await cancelRow(e.run.sendId)).toMatchObject([{ ending: 'expired', ending_reason: 'claim_deadline', puts: 0 }]);
    expect(await reserveCreatorMcfCancel(db, e.run.sendId, eClaim.leaseId, found(e.lane, 'Received', { readAt: soon() }), hex(32)))
      .toEqual({ decision: 'refused', reason: 'no_cancel', state: 'placed' });
    for (const run of [a.run, b.run, e.run]) expect(await sendRow(run.sendId)).toMatchObject({ state: 'placed', posts: 1 });
    const [puts] = await db.sql<{ n: number }[]>`select count(*)::int as n from app.creator_mcf_cancels where org_id = ${org.id} and puts = 1`;
    expect(puts!.n).toBe(0);
  });

  it('WP-338i settles an ambiguous cancel request by reads and never sends it twice; a late answer is kept; mcf.observe reads settle it too', async () => {
    const org = await newOrg('mcf-cancel-ambiguous');
    const reservedCancel = async () => {
      const lane = await newLane(org);
      const run = await placedSend(lane);
      const ready = await cancelPreviewReady(lane, run.sendId);
      await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready));
      const claim = await claimFor(org, run.sendId, 'cancel');
      expect(await reserveCreatorMcfCancel(db, run.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon() }), hex(32)))
        .toMatchObject({ decision: 'cancel_once' });
      return { lane, run, claim };
    };
    // The worker stops before recording any answer: the read queued behind the request's window settles it.
    const a = await reservedCancel();
    const [confirmed] = await db.sql<{ at: Date }[]>`select confirmed_at as at from public.creator_sample_shipments where org_id = ${org.id}
      and creator_record_id = ${a.lane.record} and asin = ${a.lane.asin}`;
    const [queued] = await db.sql<{ due: boolean }[]>`select available_at between now() + interval '110 seconds' and now() + interval '130 seconds' as due
      from public.creator_mcf_outbox where send_id = ${a.run.sendId} and action = 'settle' and completed_at is null`;
    expect(queued!.due).toBe(true);
    await expect(db.sql`delete from public.orgs where id = ${org.id}`).rejects.toMatchObject({ code: '55000' });
    await backdate((sql) => sql`update public.creator_mcf_outbox set available_at = now() where send_id = ${a.run.sendId} and action = 'settle'`);
    const settle = await claimFor(org, a.run.sendId, 'settle');
    expect(await recordCreatorMcfSettlement(db, a.run.sendId, found(a.lane, 'Planning', { readAt: soon() }), settle.leaseId))
      .toMatchObject({ state: 'cancel_dispatching' });
    expect(await claimCreatorMcfOutbox(db, { claimant: 'wp338i-test', scope: [org.scope], actions: ['cancel'] })).toBeNull();
    expect(await reserveCreatorMcfCancel(db, a.run.sendId, a.claim.leaseId, found(a.lane, 'Received', { readAt: soon() }), hex(32)))
      .toEqual({ decision: 'already_reserved', state: 'cancel_dispatching' });
    expect(await requestCreatorMcfCancelPreview(db, actor(org), a.run.sendId)).toEqual({ outcome: 'refused', reason: 'send_not_cancellable' });
    // Amazon went on to pick it: the cancel was not honoured, the send is placed again and the lane untouched.
    expect(await recordCreatorMcfSettlement(db, a.run.sendId, found(a.lane, 'Processing', { readAt: soon() })))
      .toMatchObject({ before: 'cancel_dispatching', state: 'placed' });
    expect(await cancelRow(a.run.sendId)).toMatchObject([{ puts: 1, provider_outcome: null, ending: 'not_honoured', ending_reason: 'processing' }]);
    const [still] = await db.sql<{ at: Date; state: string }[]>`select confirmed_at as at, lane_state as state from public.creator_sample_shipments
      where org_id = ${org.id} and creator_record_id = ${a.lane.record} and asin = ${a.lane.asin}`;
    expect(still).toEqual({ at: confirmed!.at, state: 'Confirmed' });
    // The request's answer arrives late: kept as evidence, nothing moves.
    expect(await recordCreatorMcfCancelOutcome(db, a.run.sendId, a.claim.leaseId, { outcome: 'accepted', status: 200 }))
      .toEqual({ decision: 'late_recorded', state: 'placed' });
    expect(await cancelEvents(a.run.sendId)).toContain('cancel_late_outcome');
    // An uncertain answer, then the general worker's observe read shows Cancelled.
    const b = await reservedCancel();
    expect(await recordCreatorMcfCancelOutcome(db, b.run.sendId, b.claim.leaseId, { outcome: 'uncertain', cause: 'transport', status: null }))
      .toEqual({ decision: 'recorded', state: 'cancel_dispatching' });
    await observe(org, b.lane, 'Cancelled');
    expect(await sendRow(b.run.sendId)).toMatchObject({ state: 'cancelled', amazon_status: 'Cancelled' });
    expect(await laneRow(b.lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'operator_cancelled_in_amazon' });
    // A rejected answer needs its read; with it, the send waits for a settling read; a failed status ends it after placement.
    const c = await reservedCancel();
    await expect(recordCreatorMcfCancelOutcome(db, c.run.sendId, c.claim.leaseId, { outcome: 'rejected', status: 400, codes: ['InvalidInput'],
      reason: 'validation' })).rejects.toMatchObject({ code: '22023' });
    expect(await recordCreatorMcfCancelOutcome(db, c.run.sendId, c.claim.leaseId, { outcome: 'rejected', status: 400, codes: ['InvalidInput'],
      reason: 'validation' }, found(c.lane, 'Received', { readAt: soon() }))).toEqual({ decision: 'recorded', state: 'cancel_dispatching' });
    expect(await recordCreatorMcfSettlement(db, c.run.sendId, found(c.lane, 'Unfulfillable', { readAt: soon() })))
      .toMatchObject({ state: 'failed_after_placement' });
    expect(await laneRow(c.lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'amazon_cancelled_after_submit' });
    expect(await cancelRow(c.run.sendId)).toMatchObject([{ provider_outcome: 'rejected', ending: 'not_honoured', ending_reason: 'unfulfillable' }]);
    // A read from before the reservation says nothing about the cancel.
    const d = await reservedCancel();
    const [before] = await db.sql<{ at: string }[]>`select to_char((reserved_at - interval '1 millisecond') at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at from app.creator_mcf_cancels where send_id = ${d.run.sendId}`;
    expect(await recordCreatorMcfSettlement(db, d.run.sendId, found(d.lane, 'Cancelled', { readAt: before!.at })))
      .toMatchObject({ state: 'cancel_dispatching' });
    // Every reserved cancel sent at most one request.
    const [puts] = await db.sql<{ reserved: number; single: number }[]>`select count(*)::int as reserved, count(*) filter (where puts = 1)::int as single
      from app.creator_mcf_cancels where org_id = ${org.id} and reserved_at is not null`;
    expect(puts).toEqual({ reserved: 4, single: 4 });
    expect(await readCreatorMcfCustodyResidue(db)).toEqual({ expiredLive: 0, custodyFreeLive: 0 });
  });

  it('WP-338i marks a finished 7-day ladder exhausted in the settlement read itself, once, so a crash before the worker\'s mark cannot leave it unmarked', async () => {
    const org = await newOrg('mcf-ladder-self');
    const lane = await newLane(org);
    const run = await dispatching(lane);
    await recordCreatorMcfOutcome(db, run.sendId, run.claim.leaseId, { outcome: 'uncertain', cause: 'http_5xx', status: 503 });
    expect(await recordCreatorMcfSettlement(db, run.sendId, notFound())).toMatchObject({ state: 'uncertain', ladderDue: false, ladderMarked: false });
    await backdate((sql) => sql`update public.creator_mcf_sends set intent_reserved_at = intent_reserved_at - interval '8 days' where id = ${run.sendId}`);
    // No worker mark follows: the read alone escalates.
    expect(await recordCreatorMcfSettlement(db, run.sendId, notFound())).toMatchObject({ state: 'uncertain', ladderDue: true, ladderMarked: true,
      nextReadAt: null });
    expect(await sendRow(run.sendId)).toMatchObject({ escalation_reason: 'ladder_exhausted' });
    expect(await recordCreatorMcfSettlement(db, run.sendId, notFound())).toMatchObject({ ladderDue: true, ladderMarked: false });
    expect(await markCreatorMcfLadderExhausted(db, run.sendId)).toEqual({ decision: 'unchanged', state: 'uncertain' });
    const [events] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_mcf_send_events where send_id = ${run.sendId}
      and event = 'ladder_exhausted'`;
    expect(events!.n).toBe(1);
    expect(await openWork(run.sendId)).toEqual([]);
  });

  it('WP-338i reads the recipient key ids of the active grants in a scope for the MCF unit\'s start-up check, and nothing else', async () => {
    const third = hex(32);
    const org = await newOrg('mcf-keys', { keys: [KEY_ID, OTHER_KEY_ID] });
    const other = await newOrg('mcf-keys-other', { keys: [third] });
    const sorted = (ids: string[]) => [...ids].sort();
    expect(await readCreatorMcfActiveKeyIds(db, [org.scope])).toEqual(sorted([KEY_ID, OTHER_KEY_ID]));
    expect(await readCreatorMcfActiveKeyIds(db, [org.scope, other.scope])).toEqual(sorted([KEY_ID, OTHER_KEY_ID, third]));
    expect(await readCreatorMcfActiveKeyIds(db, [])).toEqual([]);
    await regrant(other, { keys: [third], enabledAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(await readCreatorMcfActiveKeyIds(db, [other.scope])).toEqual([]);
    await db.sql`update app.creator_mcf_grants set revoked_at = now() where org_id = ${org.id} and revoked_at is null`;
    expect(await readCreatorMcfActiveKeyIds(db, [org.scope])).toEqual([]);
    await expect(readCreatorMcfActiveKeyIds(db, ['not-a-scope'])).rejects.toMatchObject({ code: '22023' });
    await expect(asUser(db, OWNER, (sql) => sql`select app.creator_mcf_active_key_ids('{}')`)).rejects.toMatchObject({ code: '42501' });
  });

  it('WP-338i keeps cancels immutable, out of every client role\'s reach (the lane read shows them), and cascades them in an org purge', async () => {
    const org = await newOrg('mcf-cancel-rows');
    const lane = await newLane(org);
    const run = await placedSend(lane);
    const ready = await cancelPreviewReady(lane, run.sendId);
    await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready));
    await expect(db.sql`update app.creator_mcf_cancels set confirmation_text = ${CANCEL_ONE}, approved_by = ${ADMIN} where send_id = ${run.sendId}`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(db.sql`update app.creator_mcf_cancels set reserved_at = now(), puts = 1, request_digest = ${hex(32)}, lease_id = gen_random_uuid(),
      ended_at = now(), ending = 'refused', ending_reason = 'x' where send_id = ${run.sendId}`).rejects.toMatchObject({ code: '23514' });
    await expect(db.sql`delete from app.creator_mcf_cancels where send_id = ${run.sendId}`).rejects.toMatchObject({ code: '23514' });
    await expect(asUser(db, OWNER, (sql) => sql`update app.creator_mcf_cancels set ending = 'refused' where send_id = ${run.sendId}`))
      .rejects.toMatchObject({ code: '42501' });
    for (const user of [OWNER, ADMIN, ANALYST]) {
      await expect(asUser(db, user, (sql) => sql`select count(*) from app.creator_mcf_cancels`)).rejects.toMatchObject({ code: '42501' });
      expect((await readCreatorMcfLane(db, actor(org, user), lane.record, lane.asin))!.send!.cancel).toMatchObject({ originState: 'placed', ending: null });
    }
    await expect(readCreatorMcfLane(db, actor(org, VIEWER), lane.record, lane.asin)).rejects.toBeInstanceOf(AgencyAccessDenied);
    const claim = await claimFor(org, run.sendId, 'cancel');
    await reserveCreatorMcfCancel(db, run.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon() }), hex(32));
    await recordCreatorMcfSettlement(db, run.sendId, found(lane, 'Cancelled', { readAt: soon() }));
    await db.sql`delete from public.orgs where id = ${org.id}`;
    const [left] = await db.sql<{ cancels: number; sends: number }[]>`select
      (select count(*)::int from app.creator_mcf_cancels where org_id = ${org.id}) as cancels,
      (select count(*)::int from public.creator_mcf_sends where org_id = ${org.id}) as sends`;
    expect(left).toEqual({ cancels: 0, sends: 0 });
  });

  it('WP-338i a request that certainly did not take (429, 401/403, withheld) ends not_sent: from placed the send is placed again, from conflict reads settle it', async () => {
    const org = await newOrg('mcf-cancel-unsent');
    const reserved = async (conflict = false) => {
      const lane = await newLane(org);
      const run = conflict ? await conflictSend(lane) : await placedSend(lane);
      const ready = await cancelPreviewReady(lane, run.sendId, 'Received', conflict ? OTHER_ITEMS : undefined);
      await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready));
      const claim = await claimFor(org, run.sendId, 'cancel');
      expect(await reserveCreatorMcfCancel(db, run.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon(), ...(conflict ? { items: OTHER_ITEMS } : {}) }),
        hex(32))).toMatchObject({ decision: 'cancel_once' });
      return { lane, run, claim };
    };
    // Throttled, with its read still Received: not sent, placed again, cancellable again.
    const a = await reserved();
    expect(await recordCreatorMcfCancelOutcome(db, a.run.sendId, a.claim.leaseId, { outcome: 'rejected', status: 429, codes: ['QuotaExceeded'],
      reason: 'throttled' }, found(a.lane, 'Received', { readAt: soon() }))).toEqual({ decision: 'recorded', state: 'placed' });
    expect(await cancelRow(a.run.sendId)).toMatchObject([{ puts: 1, provider_outcome: 'rejected', ending: 'not_sent', ending_reason: 'rejected_throttled' }]);
    expect(await laneRow(a.lane)).toMatchObject({ lane_state: 'Confirmed', cancellation_reason: null });
    expect(await openWork(a.run.sendId)).toEqual([]);
    expect(await requestCreatorMcfCancelPreview(db, actor(org), a.run.sendId)).toMatchObject({ outcome: 'cancel_preview_requested' });
    // Unauthorized: no read needed.
    const b = await reserved();
    expect(await recordCreatorMcfCancelOutcome(db, b.run.sendId, b.claim.leaseId, { outcome: 'rejected', status: 403, codes: ['Unauthorized'],
      reason: 'authorization' })).toEqual({ decision: 'recorded', state: 'placed' });
    expect(await cancelRow(b.run.sendId)).toMatchObject([{ ending: 'not_sent', ending_reason: 'rejected_authorization' }]);
    // Throttled, but the read after it already shows Cancelled: that read wins.
    const c = await reserved();
    expect(await recordCreatorMcfCancelOutcome(db, c.run.sendId, c.claim.leaseId, { outcome: 'rejected', status: 429, codes: ['QuotaExceeded'],
      reason: 'throttled' }, found(c.lane, 'Cancelled', { readAt: soon() }))).toEqual({ decision: 'recorded', state: 'cancelled' });
    // Withheld by the worker before it left: placed again; a replay is unchanged; anything else is refused.
    const d = await reserved();
    await expect(asServiceRole(db, (sql) => sql`select app.record_creator_mcf_cancel_unsent(${d.run.sendId}::uuid, ${d.claim.leaseId}::uuid, 'lost')`))
      .rejects.toMatchObject({ code: '22023' });
    expect(await recordCreatorMcfCancelUnsent(db, d.run.sendId, randomUUID(), 'policy_off')).toEqual({ decision: 'refused', reason: 'lease', state: 'cancel_dispatching' });
    expect(await recordCreatorMcfCancelUnsent(db, d.run.sendId, d.claim.leaseId, 'policy_off')).toEqual({ decision: 'recorded', state: 'placed' });
    expect(await recordCreatorMcfCancelUnsent(db, d.run.sendId, d.claim.leaseId, 'policy_off')).toEqual({ decision: 'unchanged', state: 'placed' });
    expect(await cancelRow(d.run.sendId)).toMatchObject([{ puts: 1, provider_outcome: null, ending: 'not_sent', ending_reason: 'policy_off' }]);
    expect(await recordCreatorMcfCancelOutcome(db, d.run.sendId, d.claim.leaseId, { outcome: 'accepted', status: 200 }))
      .toEqual({ decision: 'late_recorded', state: 'placed' });
    // From conflict the shared map has no way back: the send stays cancel_dispatching, the event says why, reads go on.
    const e = await reserved(true);
    expect(await recordCreatorMcfCancelUnsent(db, e.run.sendId, e.claim.leaseId, 'stopping')).toEqual({ decision: 'recorded', state: 'cancel_dispatching' });
    expect(await recordCreatorMcfCancelUnsent(db, e.run.sendId, e.claim.leaseId, 'stopping')).toEqual({ decision: 'unchanged', state: 'cancel_dispatching' });
    expect((await cancelEvents(e.run.sendId)).filter((event) => event === 'cancel_not_sent')).toHaveLength(1);
    expect(await cancelRow(e.run.sendId)).toMatchObject([{ puts: 1, ending: null }]);
    expect(await cancelEvents(e.run.sendId)).toContain('cancel_not_sent');
    expect(await openWork(e.run.sendId)).toEqual(['settle']);
    expect(await recordCreatorMcfSettlement(db, e.run.sendId, found(e.lane, 'Cancelled', { readAt: soon(), items: OTHER_ITEMS })))
      .toMatchObject({ state: 'cancelled' });
  });

  it('WP-338i a cancel_dispatching send takes "Ask Amazon for this order id" and, unsettled for 15 minutes, is in the alert summary', async () => {
    const org = await newOrg('mcf-cancel-alert');
    const lane = await newLane(org);
    const run = await placedSend(lane);
    const ready = await cancelPreviewReady(lane, run.sendId);
    await approveCreatorMcfCancel(db, actor(org), cancelApproval(run.sendId, ready));
    const claim = await claimFor(org, run.sendId, 'cancel');
    await reserveCreatorMcfCancel(db, run.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon() }), hex(32));
    const alerted = async () => (await readCreatorMcfAlertSummary(db)).conditions.find((condition) => condition.code === 'uncertain_over_15m')!.sendIds;
    expect(await alerted()).not.toContain(run.sendId);
    await backdate((sql) => sql`update public.creator_mcf_sends set state_changed_at = now() - interval '16 minutes' where id = ${run.sendId}`);
    expect(await alerted()).toContain(run.sendId);
    await expect(requestCreatorMcfSettleRead(db, actor(org, ANALYST), run.sendId)).rejects.toBeInstanceOf(AgencyAccessDenied);
    expect(await requestCreatorMcfSettleRead(db, actor(org), run.sendId)).toEqual({ outcome: 'requested', sendId: run.sendId, state: 'cancel_dispatching',
      replay: false });
    expect((await claimFor(org, run.sendId, 'settle')).action).toBe('settle');
  });

  it('WP-338i a failed order from a conflict origin is never recorded as placed; a queued preview read under a revoked grant is closed', async () => {
    const org = await newOrg('mcf-cancel-conflict-failed');
    const lane = await newLane(org);
    const c = await conflictSend(lane);
    const ready = await cancelPreviewReady(lane, c.sendId, 'Received', OTHER_ITEMS);
    await approveCreatorMcfCancel(db, actor(org), cancelApproval(c.sendId, ready));
    const claim = await claimFor(org, c.sendId, 'cancel');
    await reserveCreatorMcfCancel(db, c.sendId, claim.leaseId, found(lane, 'Received', { readAt: soon(), items: OTHER_ITEMS }), hex(32));
    expect(await recordCreatorMcfSettlement(db, c.sendId, found(lane, 'Invalid', { readAt: soon(), items: OTHER_ITEMS })))
      .toMatchObject({ state: 'failed_after_placement' });
    expect(await laneRow(lane)).toMatchObject({ lane_state: 'Cancelled', cancellation_reason: 'amazon_cancelled_after_submit', runner_order_id: null,
      confirmed_at: null });
    const [placed] = await db.sql<{ n: number }[]>`select count(*)::int as n from public.creator_action_log where org_id = ${org.id}
      and creator_record_id = ${lane.record} and action = 'mcf_send_placed'`;
    expect(placed!.n).toBe(0);
    expect(await cancelRow(c.sendId)).toMatchObject([{ ending: 'not_honoured', ending_reason: 'invalid' }]);

    const lane2 = await newLane(org);
    const run2 = await placedSend(lane2);
    expect(await requestCreatorMcfCancelPreview(db, actor(org), run2.sendId)).toMatchObject({ outcome: 'cancel_preview_requested' });
    expect((await readCreatorMcfLane(db, actor(org), lane2.record, lane2.asin))!.send).toMatchObject({ cancelPreviewPending: true });
    await regrant(org, { actions: ['send'] });
    expect(await claimCreatorMcfOutbox(db, { claimant: 'wp338i-test', scope: [org.scope], actions: ['cancel'] })).toBeNull();
    expect((await readCreatorMcfLane(db, actor(org), lane2.record, lane2.asin))!.send).toMatchObject({ cancelPreviewPending: false,
      cancelPreviewRefusal: { reason: 'grant_inactive' } });
    expect(await openWork(run2.sendId)).toEqual([]);
  });
});
