/**
 * The creator:write key class, over Streamable HTTP against a real database:
 * who may issue one, which tools each key class can reach, raw contact data
 * refused by shape, replays through the import's keys and digests, and one
 * audit row per call that never holds the arguments. Synthetic values only;
 * contact-shaped strings are assembled from fragments at run time.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { persistCreatorImport } from '@wizard-ads/db/worker';
import { creatorQueueRows, creatorRegistryRows, legacyReservationId } from '@wizard-ads/db/mcp-writes';
import { creatorSampleOrderKey } from '@wizard-ads/db';
import { CreatorMcfSendState } from '@wizard-ads/shared';
import { readAuditEntries } from './audit.js';
import { DEFAULT_MAX_DOWNLOAD_BYTES, DEFAULT_MAX_ROWS, type McpConfig } from './config.js';
import { CREATOR_WRITE_TOOLS, creatorIdentityEvent } from './creators.js';
import { startHttpServer, type RunningServer } from './http.js';
import { issueApiKey, verifyApiKey } from './keys.js';
import { withCreatorWriteOperation, withMcpOperation } from './operation.js';

const available = await databaseAvailable();
const OWNER = '33310000-0000-4000-8000-000000000001';
const ADMIN = '33310000-0000-4000-8000-000000000002';
const ANALYST = '33310000-0000-4000-8000-000000000003';
const VIEWER = '33310000-0000-4000-8000-000000000004';
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');
const email = ['creator.synthetic', '@', 'example', '.test'].join('');
const phone = ['+49', '151', '2345', '6789'].join(' ');
const street = ['12', 'Synthetic Street'].join(' ');
const link = ['https', '://', 'example.test/shop/synthetic'].join('');
/** Every analytics tool a read key reaches; a creator:write key must reach none of them. */
const READ_TOOLS = ['download_data', 'get_amazon_change_history', 'get_entity_data', 'get_experiment', 'get_flags', 'get_pacing',
  'get_product_evidence', 'get_provider_evidence', 'get_recommendations', 'get_report_family_facts', 'get_sync_status', 'group_by',
  'list_experiments', 'list_profiles', 'query'];

const registry = (id: string, change: Record<string, unknown> = {}) => ({
  creator_record_id: id, brand: 'Synthetic brand', campaign_id: 'campaign-synthetic-1', thread_key: fp(`${id}:thread`),
  storefront_key: fp(`${id}:storefront`), full_name_fp: '', email_fp: '', phone_fp: '', address_fp: '', record_state: 'Active',
  lock_state: 'Unlocked', version: 1, created_at: '2026-09-01', ...change,
});
const reservation = {
  reservation_id: 'MCFR-9f2c41ab77e0d3b5', state: 'Reconciliation Required', creator_record_id: 'CCR-SW-26-0072', campaign_id: 'campaign-synthetic-1',
  asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', quantity: 1, visible_fee_cents: 620, approved_fee_cap_cents: 800,
  reserved_at: '2026-09-08T06:40:00+00:00', verified_at: '2026-09-08T06:43:00+00:00', reconciliation_reason: 'outcome_unknown',
  preflight_evidence_reference: 'ev:mcf-inv-16',
};
/** The mapping for one org, narrowed: these rows carry no CCS key, so none can mismatch. */
function mapped(orgId: string, record: unknown) {
  const rows = creatorRegistryRows(orgId, record as never);
  if (!rows.ok) throw new Error(`unexpected refusal at ${rows.paths.map((path) => path.join('.')).join(', ')}`);
  return rows;
}
const queueItem = (id: string, change: Record<string, unknown> = {}) => ({
  queue_id: `20260909-${id}`, run_date: '2026-09-09', creator_record_id: id, brand: 'Synthetic brand', campaign_tab: 'Synthetic tab',
  current_status: 'Verification Confirmed', computed_score: 8, missing: ['recent_post_verified', 'performance_or_revenue'], due_date: '2026-09-09',
  action_type: 'RECONCILE_QUALIFICATION', gate_result: 'BLOCKED', queue_state: 'Escalated', reason: 'status_score_drift', ...change,
});

describe('runner shapes map to the import\'s rows and keys', () => {
  it('derives the same event keys and lanes as creators:import for one registry row', () => {
    const rows = mapped(randomUUID(), registry('CCR-SW-26-0072', { lock_state: 'Locked for MCF', version: 7, mcf_reservation: reservation }));
    expect(rows.actions.map((action) => action.eventKey)).toEqual([
      'reserved:MCFR-9F2C41AB77E0D3B5', 'verified:MCFR-9F2C41AB77E0D3B5:2026-09-08T06:43:00+00:00', 'reconciliation:MCFR-9F2C41AB77E0D3B5']);
    expect(rows.lanes).toHaveLength(1);
    expect(rows.lanes[0]).toMatchObject({ laneState: 'Reconciliation Required', feeCents: 620, feeCapCents: 800, reservationId: 'MCFR-9F2C41AB77E0D3B5' });
    expect(rows.record.fingerprints).toEqual({ storefront: fp('CCR-SW-26-0072:storefront'), thread: fp('CCR-SW-26-0072:thread'), fullName: null,
      email: null, phone: null, address: null });
    expect(legacyReservationId('CCR-SW-26-0072', 'B0D9K3M2QP', undefined)).toMatch(/^MCFR-LEGACY-[0-9A-F]{12}$/);
  });

  it('records the rung, or the records a conflict named, under the import\'s conflict key', () => {
    const conflict = creatorIdentityEvent(registry('CCR-SW-26-0117', { lock_state: 'Conflict', version: 2 }) as never,
      { result: 'CONFLICT', reason: 'multiple_active_records_match', matches: ['CCR-SW-26-0117', 'CCR-SW-26-0203'] }, OWNER);
    expect(conflict).toMatchObject({ eventKey: 'identity:CCR-SW-26-0117:2', relatedRecordIds: ['CCR-SW-26-0203'], action: 'identity_resolved',
      reasonCode: 'conflict' });
    const resolved = creatorIdentityEvent(registry('CCR-SW-26-0134') as never, { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0134', match_method: 'storefront' }, OWNER);
    expect(resolved).toMatchObject({ eventKey: 'identity:CCR-SW-26-0134:1', action: 'identity_resolved', reasonCode: 'storefront' });
  });

  it('numbers repeated queue ids as the import does', () => {
    const rows = creatorQueueRows([queueItem('CCR-SW-26-0134'), queueItem('CCR-SW-26-0134'), queueItem('CCR-SW-26-0072')] as never);
    expect(rows.map((row) => row.occurrence)).toEqual([1, 2, 1]);
  });
});

describe.skipIf(!available)('the creator:write key class', () => {
  let database: TestDatabase;
  let server: RunningServer;
  let orgId: string;
  let profileId: string;
  let creatorToken: string;
  let creatorKeyId: string;
  let readToken: string;
  let readKeyId: string;

  const issue = (userId: string, change: Record<string, unknown> = {}) => issueApiKey(database, {
    orgId, createdBy: userId, label: 'synthetic creator key', scope: 'creator:write', profileIds: [],
    expiresAt: new Date(Date.now() + 86_400_000), ...change,
  });

  beforeAll(async () => {
    database = await createTestDatabase('mcp_creators');
    const [seed] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('creator-keys', ${OWNER}, 'owner') as id`;
    orgId = seed!.id;
    for (const [user, role] of [[ADMIN, 'admin'], [ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await database.sql`select public.auth_user_stub(${user})`;
      await database.sql`insert into public.org_members(org_id, user_id, role) values (${orgId}, ${user}, ${role})`;
    }
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId} limit 1`;
    profileId = profile!.id;
    const creator = await issue(ADMIN);
    creatorToken = creator.token;
    creatorKeyId = creator.record.id;
    const read = await issueApiKey(database, { orgId, createdBy: OWNER, label: 'synthetic read key', profileIds: [profileId],
      expiresAt: new Date(Date.now() + 86_400_000) });
    readToken = read.token;
    readKeyId = read.record.id;
    server = await startHttpServer({ config: testConfig(database.connectionString), handle: database });
  }, 180_000);
  afterAll(async () => {
    await server?.close();
    await database?.drop();
  });

  it('is issued by owners and admins only, with no profiles, and the bid-write refusal stays', async () => {
    expect((await issue(OWNER)).record).toMatchObject({ scope: 'creator:write', profileIds: [] });
    expect((await issue(ADMIN)).record.scope).toBe('creator:write');
    for (const user of [ANALYST, VIEWER]) await expect(issue(user)).rejects.toMatchObject({ status: 403 });
    await expect(issue(OWNER, { profileIds: [profileId] })).rejects.toThrow('reaches no profile');
    await expect(issue(OWNER, { scope: 'write' })).rejects.toThrow('read keys and creator:write keys only');
    await expect(issueApiKey(database, { orgId, createdBy: OWNER, label: 'no profiles', profileIds: [], expiresAt: new Date(Date.now() + 86_400_000) }))
      .rejects.toThrow('at least one profile');
    expect((await verifyApiKey(database, creatorToken)).scope).toBe('creator:write');
    expect((await verifyApiKey(database, readToken)).scope).toBe('read');
  });

  it('lists exactly the eight creator tools for a creator:write key and none of them for a read key', async () => {
    // Pinned by name, so dropping a tool from the constant under test fails here.
    expect([...CREATOR_WRITE_TOOLS].sort()).toEqual(['creators.append_action', 'creators.preflight_result', 'creators.queue_snapshot',
      'creators.record_score', 'creators.register_record', 'creators.sample_send_outcome', 'creators.submit_draft', 'creators.sweep_checkpoint']);
    const creator = await connect(server, creatorToken);
    const read = await connect(server, readToken);
    try {
      expect((await creator.listTools()).tools.map((tool) => tool.name).sort()).toEqual([...CREATOR_WRITE_TOOLS].sort());
      expect((await creator.listResources()).resources.map((resource) => resource.uri)).toEqual(['wizardads://instructions']);
      const readNames = (await read.listTools()).tools.map((tool) => tool.name);
      expect(readNames.filter((name) => name.startsWith('creators.'))).toEqual([]);
      expect([...readNames].sort()).toEqual(READ_TOOLS);
    } finally {
      await creator.close();
      await read.close();
    }
  });

  it('refuses a read key on every creators tool and a creator:write key on every other tool', async () => {
    const creator = await connect(server, creatorToken);
    const read = await connect(server, readToken);
    const before = await tableCounts();
    try {
      for (const tool of CREATOR_WRITE_TOOLS) {
        const result = await call(read, tool, { creator_record_id: 'CCR-SW-26-0134' });
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toMatch(/not found/);
      }
      for (const tool of READ_TOOLS) {
        const result = await call(creator, tool, { profile_id: profileId });
        expect(result.isError, tool).toBe(true);
        expect(result.text, tool).toMatch(/not found/);
      }
      await expect(creator.readResource({ uri: `wizardads://profiles/${profileId}` })).rejects.toThrow();
    } finally {
      await creator.close();
      await read.close();
    }
    expect(await tableCounts()).toEqual(before);
    // The database refuses each class on the other's authorization as well, whatever a server registered.
    const context = (keyId: string) => ({ handle: database, config: testConfig(database.connectionString), actor: { orgId, userId: keyId === creatorKeyId ? ADMIN : OWNER }, keyId });
    await expect(withMcpOperation(context(creatorKeyId), async () => 'read')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(withCreatorWriteOperation(context(readKeyId), async () => 'write')).rejects.toMatchObject({ code: 'forbidden' });
    expect(await withCreatorWriteOperation(context(creatorKeyId), async (operation) => operation.orgSlug)).toBe('creator-keys');
  });

  it('writes a registered record, replays it unchanged, and agrees with the import on every digest', async () => {
    const client = await connect(server, creatorToken);
    try {
      const input = { record: registry('CCR-SW-26-0072', { lock_state: 'Locked for MCF', version: 7, mcf_reservation: reservation }),
        resolution: { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0072', match_method: 'thread' } };
      const first = await call(client, 'creators.register_record', input);
      expect(first.isError).toBe(false);
      expect(first.payload['counts']).toEqual({
        records: { read: 1, inserted: 1, updated: 0, unchanged: 0, skipped: 0 },
        action_log: { read: 4, inserted: 4, updated: 0, unchanged: 0, skipped: 0 },
        sample_shipments: { read: 1, inserted: 1, updated: 0, unchanged: 0, skipped: 0 },
      });
      const replay = await call(client, 'creators.register_record', input);
      expect(replay.payload['counts']).toEqual({
        records: { read: 1, inserted: 0, updated: 0, unchanged: 1, skipped: 0 },
        action_log: { read: 4, inserted: 0, updated: 0, unchanged: 4, skipped: 0 },
        sample_shipments: { read: 1, inserted: 0, updated: 0, unchanged: 1, skipped: 0 },
      });
      // The file import of the same registry row, mapped the same way, changes nothing either.
      const rows = mapped(orgId, input.record);
      const run = await persistCreatorImport(database, { orgId, startedAt: new Date().toISOString(), source: 'control-runner', files: ['registry'],
        records: { read: 1, invalid: 0, rows: [rows.record] }, actions: { read: rows.actions.length, invalid: 0, rows: rows.actions }, queue: null,
        sweeps: null, shipments: { read: rows.lanes.length, invalid: 0, rows: rows.lanes } });
      expect(run.counts.records).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
      expect(run.counts.action_log).toMatchObject({ inserted: 0, unchanged: 3 });
      expect(run.counts.sample_shipments).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
      const [identity] = await database.sql`select action, reason_code, source, actor_user_id from public.creator_action_log
        where org_id = ${orgId} and event_key = 'identity:CCR-SW-26-0072:7'`;
      expect(identity).toEqual({ action: 'identity_resolved', reason_code: 'thread', source: 'mcp', actor_user_id: ADMIN });
      // A stale row (an older runner version) writes nothing and says so.
      const stale = await call(client, 'creators.register_record', { record: registry('CCR-SW-26-0072', { version: 6 }),
        resolution: { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0072', match_method: 'thread' } });
      expect(stale.payload).toEqual({ creator_record_id: 'CCR-SW-26-0072', record: 'older_than_held', held_version: 7 });
      const [held] = await database.sql`select lock_state, runner_version from public.creator_records where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0072'`;
      expect(held).toEqual({ lock_state: 'Locked for MCF', runner_version: 7 });
      // A conflict keeps the records it named even when the import wrote the conflict entry first.
      const locked = registry('CCR-SW-26-0117', { lock_state: 'Conflict', escalation_reason: 'multiple_active_records_match', version: 2 });
      const importedFirst = mapped(orgId, locked);
      await persistCreatorImport(database, { orgId, startedAt: new Date().toISOString(), source: 'control-runner', files: ['registry'],
        records: { read: 1, invalid: 0, rows: [importedFirst.record] }, actions: { read: 1, invalid: 0, rows: importedFirst.actions }, queue: null, sweeps: null,
        shipments: null });
      const conflict = await call(client, 'creators.register_record', { record: locked,
        resolution: { result: 'CONFLICT', reason: 'multiple_active_records_match', matches: ['CCR-SW-26-0117', 'CCR-SW-26-0203'] } });
      expect(conflict.payload['counts']).toMatchObject({ records: { unchanged: 1 }, action_log: { read: 2, inserted: 1, unchanged: 1 } });
      const [named] = await database.sql`select related_record_ids from public.creator_action_log where org_id = ${orgId} and event_key = 'identity:CCR-SW-26-0117:2'`;
      expect(named).toEqual({ related_record_ids: ['CCR-SW-26-0203'] });
    } finally { await client.close(); }
  });

  it('registers the WP-338l handover fields: a lane handed to Arcana stays runner-owned, its recorded order confirms it, another key is refused', async () => {
    const client = await connect(server, creatorToken);
    const id = 'CCR-SW-26-0338';
    const asin = 'B0D9K3M2QP';
    const key = creatorSampleOrderKey(orgId, id, asin);
    const resolution = { result: 'RESOLVED', creator_record_id: id, match_method: 'storefront' };
    // reserve-mcf for a lane handed to Arcana (creator_control.py on wp-338l): the key, order_owner, no visible fee.
    const handed = { reservation_id: 'MCFR-00000000000338A1', state: 'Reserved', creator_record_id: id, campaign_id: 'campaign-synthetic-1',
      tracker_source_ref: 'tracker/campaign-synthetic-1/row-338', asin, sku: 'SW-DERMA-05-FBA', product_title: 'Synthetic product', quantity: 1,
      recipient_binding: fp('recipient-0338'), approved_fee_cap_cents: 800, thread_evidence_reference: 'private-evidence/thread-338.json',
      preflight_evidence_reference: 'private-evidence/preflight-338.json', inventory_evidence_reference: 'private-evidence/mcf-search-338.json',
      reserved_at: '2026-09-27T23:47:35.437142+00:00', derived_order_key: key, order_owner: 'arcana' };
    const lane = async () => (await database.sql`select lane_state, order_owner, runner_order_id, fee_cents, fee_cap_cents, reservation_id
      from public.creator_sample_shipments where org_id = ${orgId} and creator_record_id = ${id} and asin = ${asin}`)[0];
    try {
      const reserved = await call(client, 'creators.register_record', { record: registry(id, { lock_state: 'Locked for MCF', version: 2,
        mcf_reservation: handed }), resolution });
      expect(reserved.isError, reserved.text).toBe(false);
      expect(await lane()).toEqual({ lane_state: 'Reserved', order_owner: 'runner', runner_order_id: null, fee_cents: null, fee_cap_cents: 800,
        reservation_id: 'MCFR-00000000000338A1' });

      // Another organisation's key (or another lane's) for this record and ASIN is refused whole, named by field only.
      const before = await tableCounts();
      const foreign = creatorSampleOrderKey(randomUUID(), id, asin);
      const refused = await call(client, 'creators.register_record', { record: registry(id, { lock_state: 'Locked for MCF', version: 9,
        mcf_reservation: { ...handed, derived_order_key: foreign } }), resolution });
      expect(refused.isError).toBe(true);
      expect(refused.payload['error']).toBe('invalid_argument');
      expect(refused.text).toContain('record.mcf_reservation.derived_order_key (derived_order_key is not this organisation');
      expect(refused.text).not.toContain(foreign);
      expect(await tableCounts()).toEqual(before);

      // record-api-order: the reservation moves to history with the note, the key as order id and the arcana:send evidence.
      const evidence = `arcana:send:${key}:${fp('send-event-338')}`;
      const recorded = { reservation_id: handed.reservation_id, creator_record_id: id, campaign_id: handed.campaign_id,
        tracker_source_ref: handed.tracker_source_ref, asin, sku: handed.sku, product_title: handed.product_title, quantity: 1, order_id: key,
        status: 'Confirmed', evidence_reference: evidence, recipient_note: 'recipient: operator-entered in Arcana, binding unverified',
        confirmed_at: '2026-09-28T10:03:00.000000+00:00' };
      const confirmed = await call(client, 'creators.register_record', { record: registry(id, { version: 3, sample_history: [recorded] }), resolution });
      expect(confirmed.isError, confirmed.text).toBe(false);
      expect(await lane()).toEqual({ lane_state: 'Confirmed', order_owner: 'runner', runner_order_id: key, fee_cents: null, fee_cap_cents: 800,
        reservation_id: 'MCFR-00000000000338A1' });
      const [logged] = await database.sql`select action, evidence_reference from public.creator_action_log
        where org_id = ${orgId} and event_key = ${`confirmed:${handed.reservation_id}`}`;
      expect(logged).toEqual({ action: 'sample_confirmed', evidence_reference: evidence });
      const wrongOrder = await call(client, 'creators.register_record', { record: registry(id, { version: 4, sample_history: [{ ...recorded,
        order_id: foreign, evidence_reference: `arcana:send:${foreign}:${fp('send-event-338')}` }] }), resolution });
      expect(wrongOrder.isError).toBe(true);
      expect(wrongOrder.text).toContain('record.sample_history.0.order_id (order_id is not this organisation\'s derived order key');
      expect(wrongOrder.text).not.toContain(foreign);
      // Nothing about the recipient is stored beyond the lane and the action log's evidence reference.
      const stored = JSON.stringify(await database.sql`select * from public.creator_sample_shipments where org_id = ${orgId} and creator_record_id = ${id}`);
      expect(stored).not.toContain('binding unverified');
    } finally { await client.close(); }
  });

  it('writes the score, the skill\'s entries, a draft, the queue and a sweep, each idempotent', async () => {
    const client = await connect(server, creatorToken);
    try {
      expect((await call(client, 'creators.register_record', { record: registry('CCR-SW-26-0134'),
        resolution: { result: 'NEW', fingerprints: { thread_key: fp('CCR-SW-26-0134:thread'), storefront_key: fp('CCR-SW-26-0134:storefront'),
          full_name_fp: '', email_fp: '', phone_fp: '', address_fp: '' } } })).isError).toBe(false);
      const checks = ['complete_fulfillment_details', 'requested_asin', 'exact_product_match', 'storefront_visible', 'recent_post_verified', 'content_quality',
        'category_fit', 'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk'];
      const missing = ['recent_post_verified', 'performance_or_revenue'];
      const score = { creator_record_id: 'CCR-SW-26-0134', scored_on: '2026-09-09', current_status: 'Verification Confirmed', tracker_score: 10,
        result: { score: 8, checks: Object.fromEntries(checks.map((check) => [check, !missing.includes(check)])), missing } };
      expect((await call(client, 'creators.record_score', score)).payload).toMatchObject({ record: 'updated' });
      expect((await call(client, 'creators.record_score', score)).payload).toMatchObject({ record: 'unchanged' });

      const entries = { entries: [{ event_key: 'sent-0134-1', creator_record_id: 'CCR-SW-26-0134', action: 'message_sent_by_hand',
        occurred_at: '2026-09-09T06:38:00Z', evidence_reference: 'ev:thread-synthetic-1' }] };
      expect((await call(client, 'creators.append_action', entries)).payload['counts']).toEqual({ read: 1, inserted: 1, updated: 0, unchanged: 0, skipped: 0 });
      expect((await call(client, 'creators.append_action', entries)).payload['counts']).toEqual({ read: 1, inserted: 0, updated: 0, unchanged: 1, skipped: 0 });

      const draft = { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('CCR-SW-26-0134:thread'), template_key: 'first_base_verification',
        draft_date: '2026-09-09', body: 'Hi {first name}, thanks for reaching out. Could you confirm the remaining details for sample review?' };
      const submitted = await call(client, 'creators.submit_draft', draft);
      expect(submitted.payload).toMatchObject({ status: 'draft', outcome: 'inserted', withdrew: null });
      const again = await call(client, 'creators.submit_draft', draft);
      expect(again.payload).toMatchObject({ draft_id: submitted.payload['draft_id'], outcome: 'unchanged' });

      const queue = { run_date: '2026-09-09', items: [queueItem('CCR-SW-26-0134'), queueItem('CCR-SW-26-0072', { action_type: 'MCF_PREFLIGHT',
        gate_result: 'HOLD', queue_state: 'Queued', computed_score: 10, missing: [], current_status: 'Approved for Sample',
        reason: 'paid_order_requires_preflight_and_authorized_executor' })], counts: { queued: 1, escalated: 1 } };
      expect((await call(client, 'creators.queue_snapshot', queue)).payload['counts']).toEqual({ queue_items: { read: 2, inserted: 2, updated: 0, unchanged: 0, skipped: 0, removed: 0 } });
      expect((await call(client, 'creators.queue_snapshot', queue)).payload['counts']).toEqual({ queue_items: { read: 2, inserted: 0, updated: 0, unchanged: 2, skipped: 0, removed: 0 } });
      const earlier = await call(client, 'creators.queue_snapshot', { run_date: '2026-09-08', items: [queueItem('CCR-SW-26-0134', {
        queue_id: '20260908-CCR-SW-26-0134', run_date: '2026-09-08' })], counts: { queued: 0, escalated: 1 } });
      expect(earlier.isError).toBe(true);
      expect(earlier.text).toContain('earlier day is refused');
      const badQueue = await call(client, 'creators.queue_snapshot', { ...queue, items: [queue.items[0], { ...queue.items[1], computed_score: 11 }] });
      expect(badQueue.isError).toBe(true);
      expect(badQueue.text).toContain('items.1.computed_score');

      const sweep = { schema_version: 1, run_id: 'sweep-20260909-0612', run_date: '2026-09-09', brand: 'Synthetic brand', started_at: null,
        completed_at: '2026-09-09T06:12:00Z', evidence_reference: 'ev:sweep-0909', counts: { mounted: 412, opened: 412, changed: 37, messages_examined: 96,
          messages_sent: 0, no_action_acknowledgements: 359, held_or_escalated: 9, archived_spam: 5, unmatched: 7 },
        threads: [{ thread_key: fp('thread-unmatched-1'), creator_record_id: null, sender_role: 'creator', amazon_timestamp: '2026-09-09T05:10:00Z',
          body_hash: fp('body-1'), outcome: 'unmatched', reason: 'multiple_active_records_match' }] };
      expect((await call(client, 'creators.sweep_checkpoint', sweep)).payload['counts']).toEqual({ sweep_runs: { read: 1, inserted: 1, updated: 0, unchanged: 0, skipped: 0 } });
      expect((await call(client, 'creators.sweep_checkpoint', sweep)).payload['counts']).toEqual({ sweep_runs: { read: 1, inserted: 0, updated: 0, unchanged: 1, skipped: 0 } });
      const [stored] = await database.sql`select reconciled, source from public.creator_sweep_runs where org_id = ${orgId} and run_id = 'sweep-20260909-0612'`;
      expect(stored).toEqual({ reconciled: false, source: 'mcp' });
    } finally { await client.close(); }
  });

  it('refuses raw contact data by shape anywhere in the arguments, writes nothing, and keeps it out of the audit log', async () => {
    const client = await connect(server, creatorToken);
    const before = await tableCounts();
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['creators.register_record', { record: registry('CCR-SW-26-0300', { brand: `Brand ${email}` }),
        resolution: { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0300', match_method: 'storefront' } }, /record\.brand \(email\)/],
      ['creators.register_record', { record: { ...registry('CCR-SW-26-0301'), email: 'x' },
        resolution: { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0301', match_method: 'storefront' } }, /record\.email \(contact_key\)/],
      ['creators.submit_draft', { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('CCR-SW-26-0134:thread'), template_key: 'proof_request',
        draft_date: '2026-09-10', body: `Hi {first name}, please call ${phone}.` }, /body \(phone\)/],
      ['creators.submit_draft', { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('CCR-SW-26-0134:thread'), template_key: 'proof_request',
        draft_date: '2026-09-10', body: `Hi {first name}, shipping to ${street}.` }, /body \(address\)/],
      ['creators.append_action', { entries: [{ event_key: 'sent-0134-9', creator_record_id: 'CCR-SW-26-0134', action: 'message_sent_by_hand',
        occurred_at: '2026-09-09T06:38:00Z', evidence_reference: link }] }, /evidence_reference \(link\)/],
      ['creators.record_score', { creator_record_id: 'CCR-SW-26-0134', scored_on: '2026-09-10', current_status: `Verified ${email}`, tracker_score: null,
        result: {} }, /current_status \(email\)/],
      ...['email_address', 'phone_number', 'shipping_address'].map((key): [string, Record<string, unknown>, RegExp] => ['creators.submit_draft',
        { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('CCR-SW-26-0134:thread'), template_key: 'proof_request', draft_date: '2026-09-10',
          body: 'Hi {first name}, synthetic.', [key]: 'x' }, new RegExp(`${key} \\(contact_key\\)`)]),
      ['creators.submit_draft', { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('CCR-SW-26-0134:thread'), template_key: 'proof_request',
        draft_date: '2026-09-10', body: 'Hi {first name}, synthetic.', [email]: 1 }, /\[key 5\] \(email\)/],
    ];
    try {
      for (const [tool, args, where] of cases) {
        const result = await call(client, tool, args);
        expect(result.isError, tool).toBe(true);
        expect(result.payload['error'], tool).toBe('invalid_argument');
        expect(result.text, tool).toMatch(where);
        for (const value of [email, phone, street, link]) expect(result.text, tool).not.toContain(value);
      }
    } finally { await client.close(); }
    expect(await tableCounts()).toEqual(before);
    const audit = (await readAuditEntries(database, orgId, 500)).filter((entry) => entry.actorId === creatorKeyId && entry.payload['outcome'] === 'error');
    expect(audit.length).toBeGreaterThanOrEqual(cases.length);
    const text = JSON.stringify(audit);
    for (const value of [email, phone, street, link]) expect(text).not.toContain(value);
    const keyed = audit.filter((entry) => (entry.payload['params'] as { otherKeys: number }).otherKeys > 0);
    expect(keyed).toHaveLength(4);
    for (const entry of keyed) expect((entry.payload['params'] as { keys: string[] }).keys).not.toContain('email_address');
  });

  it('records a pre-flight and a product-switch pre-flight per lane, replays them unchanged, and refuses a reused run id', async () => {
    const client = await connect(server, creatorToken);
    const preflight = (change: Record<string, unknown> = {}) => ({
      command: 'preflight', run_id: 'preflight-0088-20260909-063304', started_at: '2026-09-09T06:33:04Z', completed_at: '2026-09-09T06:33:19Z',
      result: { result: 'PASS', creator_record_id: 'CCR-SW-26-0088', computed_score: 10, errors: [], required_next_state: 'Locked for MCF',
        quantity: 1, visible_fee_cents: 620, approved_fee_cap_cents: 800, selected_asin: 'B0D9K3M2QP', selected_sku: 'SW-DERMA-05-FBA',
        product_title: 'Synthetic roller, 0.5mm', campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker:synthetic:row-87',
        recipient_binding: fp('recipient-0088'), ...change },
      inventory: { asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', fulfillment_channel: 'AFN', mcf_fulfillable: true, fulfillable_quantity: 37,
        inventory_checked_at: '2026-09-09T06:33:17Z', fulfillment_evidence_reference: 'ev:mcf-inv-16' },
      preview: { operation: 'getFulfillmentPreview', read_at: '2026-09-09T06:33:17Z', valid_until: null, is_fulfillable: true, fee_cents: 620,
        currency: 'EUR', constraints: [] },
      reads: [{ check: 'identity', read_at: '2026-09-09T06:33:04Z', evidence_reference: 'ev:idn-0088' },
        { check: 'fulfillable_stock', read_at: '2026-09-09T06:33:17Z', evidence_reference: 'ev:mcf-inv-16' }],
    });
    const count = async () => (await database.sql<{ n: number }[]>`select count(*)::int as n from public.creator_sample_preflights
      where org_id = ${orgId}`)[0]!.n;
    try {
      expect((await call(client, 'creators.register_record', { record: registry('CCR-SW-26-0088'),
        resolution: { result: 'RESOLVED', creator_record_id: 'CCR-SW-26-0088', match_method: 'storefront' } })).isError).toBe(false);
      const before = await count();
      const first = await call(client, 'creators.preflight_result', preflight());
      expect(first.isError).toBe(false);
      expect(first.payload).toEqual({ run_id: 'preflight-0088-20260909-063304', command: 'preflight', result: 'PASS',
        derived_order_key: creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', 'B0D9K3M2QP'), counts: { read: 1, inserted: 1, updated: 0, unchanged: 0, skipped: 0 } });
      expect((await call(client, 'creators.preflight_result', preflight())).payload['counts']).toEqual({ read: 1, inserted: 0, updated: 0, unchanged: 1, skipped: 0 });
      const reused = await call(client, 'creators.preflight_result', preflight({ visible_fee_cents: 790 }));
      expect(reused.isError).toBe(true);
      expect(reused.payload['error']).toBe('invalid_argument');
      expect(reused.text).toContain('already recorded with a different result');
      expect(await count()).toBe(before + 1);
      const [stored] = await database.sql`select command, result, errors, recipient_binding_fp,
          preview_read_at = '2026-09-09T06:33:17Z'::timestamptz as preview_read, source, actor_user_id,
          detail->'checks'->6->>'readAt' as stock_read
        from public.creator_sample_preflights where org_id = ${orgId} and run_id = 'preflight-0088-20260909-063304'`;
      expect(stored).toEqual({ command: 'preflight', result: 'PASS', errors: [], recipient_binding_fp: fp('recipient-0088'),
        preview_read: true, source: 'mcp', actor_user_id: ADMIN, stock_read: '2026-09-09T06:33:17Z' });
      const [logged] = await database.sql`select action, reason_code, asin from public.creator_action_log
        where org_id = ${orgId} and event_key = 'preflight:preflight-0088-20260909-063304'`;
      expect(logged).toEqual({ action: 'preflight_recorded', reason_code: 'preflight_pass', asin: 'B0D9K3M2QP' });

      const switched = await call(client, 'creators.preflight_result', { command: 'preflight-switch', run_id: 'switch-0088-20260909-063600',
        started_at: '2026-09-09T06:36:00Z', completed_at: '2026-09-09T06:36:09Z',
        result: { result: 'HOLD', phase: 'offer', creator_record_id: 'CCR-SW-26-0088', errors: ['selected_sku_not_mcf_fulfillable',
          'insufficient_mcf_fulfillable_quantity'], required_next_state: 'Conflict or Held', original_asin: 'B0D9K3M2QP', alternate_asin: 'B0D6H9YY41',
          alternate_sku: 'SW-DERMA-01-FBM' },
        inventory: { asin: 'B0D6H9YY41', sku: 'SW-DERMA-01-FBM', fulfillment_channel: 'MFN', mcf_fulfillable: false, fulfillable_quantity: 0,
          inventory_checked_at: '2026-09-09T06:36:05Z', fulfillment_evidence_reference: 'ev:mcf-inv-17' },
        original_unavailable_reason: 'not_mcf_fulfillable', original_blocker_evidence_reference: 'ev:mcf-inv-17' });
      expect(switched.payload).toMatchObject({ command: 'preflight-switch', result: 'HOLD',
        derived_order_key: creatorSampleOrderKey(orgId, 'CCR-SW-26-0088', 'B0D6H9YY41'), counts: { inserted: 1 } });

      // Runner drift, an unregistered record and contact data are refused before anything is written.
      const drift = await call(client, 'creators.preflight_result', { ...preflight({ result: 'HOLD', errors: ['moon_phase_wrong'],
        required_next_state: 'Conflict or Held' }), run_id: 'preflight-drift' });
      expect(drift.isError).toBe(true);
      expect(drift.text).toContain('result.errors.0');
      const unknown = await call(client, 'creators.preflight_result', { ...preflight({ creator_record_id: 'CCR-SW-26-9998' }), run_id: 'preflight-unknown' });
      expect(unknown.payload['error']).toBe('not_found');
      const titled = await call(client, 'creators.preflight_result', { ...preflight({ product_title: `Roller for ${email}` }), run_id: 'preflight-email' });
      expect(titled.text).toMatch(/result\.product_title \(email\)/);
      const block = await call(client, 'creators.preflight_result', { ...preflight(), run_id: 'preflight-block',
        recipient: { full_name: 'x', address_line1: 'x' } });
      expect(block.text).toMatch(/recipient\.full_name \(contact_key\)/);
      for (const refused of [titled, block]) {
        expect(refused.isError).toBe(true);
        for (const value of [email, street]) expect(refused.text).not.toContain(value);
      }
      expect(await count()).toBe(before + 2);
    } finally { await client.close(); }
  });

  it('refuses a draft whose name placeholder was rendered, and says why without the name', async () => {
    const client = await connect(server, creatorToken);
    try {
      const rendered = await call(client, 'creators.submit_draft', { creator_record_id: 'CCR-SW-26-0134', thread_key: fp('CCR-SW-26-0134:thread'),
        template_key: 'awaiting_content_follow_up', draft_date: '2026-09-10', body: 'Hi Synthetic, just checking in on the sample.' });
      expect(rendered.isError).toBe(true);
      expect(rendered.text).toContain('leave {first name} unrendered');
      expect(rendered.text).not.toContain('Hi Synthetic');
    } finally { await client.close(); }
  });

  it('writes one audit row per call, holding a digest and a size, never the arguments', async () => {
    const before = (await readAuditEntries(database, orgId, 1_000)).filter((entry) => entry.actorId === creatorKeyId).length;
    const client = await connect(server, creatorToken);
    const body = 'Hi {first name}, thanks again. Your sample is now on the way.';
    try {
      const refused = await call(client, 'creators.submit_draft', { creator_record_id: 'CCR-SW-26-9999', thread_key: fp('x'),
        template_key: 'sample_confirmation', draft_date: '2026-09-10', body });
      expect(refused.payload['error']).toBe('not_found');
      const resource = await client.readResource({ uri: 'wizardads://instructions' });
      const text = (resource.contents[0] as { text?: string }).text ?? '';
      for (const tool of CREATOR_WRITE_TOOLS) expect(text).toContain(tool);
      expect(text).toContain('Fingerprints only');
    } finally { await client.close(); }
    const entries = (await readAuditEntries(database, orgId, 1_000)).filter((entry) => entry.actorId === creatorKeyId);
    expect(entries.length - before).toBe(2);
    const [resourceRead, draftCall] = entries;
    expect(resourceRead).toMatchObject({ action: 'mcp.resource.instructions.read', actorType: 'mcp' });
    expect(draftCall).toMatchObject({ action: 'mcp.creators.submit_draft', actorType: 'mcp' });
    expect(draftCall!.payload).toMatchObject({ outcome: 'error', summary: { code: 'record_not_found' } });
    expect((draftCall!.payload['params'] as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(draftCall!.payload)).not.toContain(body);
  });

  it('stops working when its issuer stops being an owner or admin, or it is revoked', async () => {
    const demoted = await issue(ADMIN);
    const client = await connect(server, demoted.token);
    try {
      await database.sql`update public.org_members set role = 'analyst' where org_id = ${orgId} and user_id = ${ADMIN}`;
      const result = await call(client, 'creators.append_action', { entries: [{ event_key: 'demoted-1', creator_record_id: 'CCR-SW-26-0134',
        action: 'status_moved', occurred_at: '2026-09-09T07:00:00Z' }] });
      expect(result.isError).toBe(true);
      expect(result.payload['error']).toBe('forbidden');
    } finally {
      await database.sql`update public.org_members set role = 'admin' where org_id = ${orgId} and user_id = ${ADMIN}`;
      await client.close();
    }
    await database.sql`update mcp.api_keys set revoked_at = now() where id = ${demoted.record.id}`;
    await expect(connect(server, demoted.token)).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // creators.sample_send_outcome (WP-338h): read-only, on this key class only.
  // -------------------------------------------------------------------------

  /** Every send state with the class a skill must see for it: an oracle written out, not derived from the code under test. */
  const SEND_STATES: readonly [state: string, outcomeClass: string][] = [
    ['sealed', 'pending'], ['previewing', 'pending'], ['preview_ready', 'pending'], ['stale', 'pending'], ['approved', 'pending'],
    ['dispatching', 'pending'], ['accepted', 'pending'], ['placed', 'placed'], ['uncertain', 'uncertain'], ['conflict', 'uncertain'],
    ['cancel_requested', 'uncertain'], ['cancel_dispatching', 'uncertain'], ['preview_refused', 'failed'], ['withdrawn', 'failed'],
    ['expired', 'failed'], ['expired_unclaimed', 'failed'], ['rejected', 'failed'], ['not_created', 'failed'], ['failed_by_amazon', 'failed'],
    ['failed_after_placement', 'failed'], ['cancelled', 'cancelled'],
  ];
  const BEFORE_APPROVAL = ['sealed', 'previewing', 'preview_ready', 'stale', 'preview_refused', 'withdrawn', 'expired'];
  const AFTER_ACCEPT = ['accepted', 'placed', 'conflict', 'cancel_requested', 'cancel_dispatching', 'failed_after_placement', 'cancelled'];
  const AFTER_PLACE = ['placed', 'cancel_requested', 'cancel_dispatching', 'failed_after_placement', 'cancelled'];
  const AMAZON_STATUS: Record<string, string> = { placed: 'Received', cancelled: 'Cancelled', failed_by_amazon: 'Invalid', conflict: 'Planning' };
  /** A mask whose postal prefix appears nowhere else in a response, so a leak is visible. */
  const MASK = { countryCode: 'GB', postalPrefix: 'Z7', lines: 2 };
  let laneNumber = 5000;

  interface SeededLane { record: string; asin: string; key: string; reservation: string; keyId: string; ciphertext: string }

  /** A runner-owned lane with a passing pre-flight, as the import and creators.preflight_result leave it. */
  async function seedLane(): Promise<SeededLane> {
    const record = `CCR-SW-26-${laneNumber++}`;
    const asin = `B0${randomBytes(4).toString('hex').toUpperCase()}`;
    const reservation = `MCFR-${randomBytes(8).toString('hex').toUpperCase()}`;
    await database.sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, thread_fp, record_state, lock_state,
        runner_version, created_on, source, source_digest)
      values (${orgId}, ${record}, 'Synthetic brand', 'campaign-synthetic-1', ${fp(`${record}:thread`)}, 'Active', 'Locked for MCF', 1,
        '2026-09-01', 'control-runner', ${fp(`${record}:digest`)})`;
    await database.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state,
        fee_cents, fee_cap_cents, reserved_at, source, source_digest)
      values (${orgId}, ${record}, ${asin}, 'SYN-SAMPLE-1', 'campaign-synthetic-1', ${reservation}, 'Reserved', 620, 800,
        now() - interval '10 minutes', 'control-runner', ${fp(`${record}:lane`)})`;
    return { record, asin, key: creatorSampleOrderKey(orgId, record, asin), reservation, keyId: randomBytes(32).toString('hex'),
      ciphertext: randomBytes(32).toString('hex') };
  }

  /**
   * One send in `state`, written directly with triggers off (the ledger's functions need a grant, a sealed envelope and a
   * worker lease; WP-338d's own suite drives those). Every CHECK constraint of the table still applies, so the row is a
   * shape the ledger can hold. Foreign keys and the lane guard are triggers and are off: the approval and grant ids point
   * at nothing, and the lane stays runner-owned and Reserved whatever the send's state. That is enough for a read.
   */
  async function seedSend(lane: SeededLane, state: string, change: { escalation?: 'ladder_exhausted' | 'conflict'; createdAgo?: string } = {}) {
    const [binding] = await database.sql<{ connection_id: string; marketplace_id: string }[]>`select connection_id, marketplace_id
      from public.spapi_profile_bindings where org_id = ${orgId} limit 1`;
    const approved = !BEFORE_APPROVAL.includes(state);
    await database.sql.begin(async (sql) => {
      await sql`set local session_replication_role = replica`;
      const [preflight] = await sql<{ id: string }[]>`insert into public.creator_sample_preflights(org_id, run_id, command, creator_record_id, asin,
          result, errors, required_next_state, detail, started_at, completed_at, source, source_digest)
        values (${orgId}, ${`preflight-${randomBytes(6).toString('hex')}`}, 'preflight', ${lane.record}, ${lane.asin}, 'PASS', '{}'::text[],
          'Locked for MCF', ${JSON.stringify({ sku: 'SYN-SAMPLE-1', quantity: 1 })}::jsonb, now() - interval '6 minutes', now() - interval '5 minutes',
          'mcp', ${randomBytes(32).toString('hex')}) returning id`;
      await sql`insert into public.creator_mcf_sends(org_id, creator_record_id, asin, sku, reservation_id, preflight_id, spapi_connection_id,
          marketplace_id, key_id, envelope_id, ciphertext_sha256, created_by, membership_created_at, state, mask, escalated_at, escalation_reason,
          approved_preview_id, approved_by, approved_membership_created_at, approved_at, confirmation_text, approval_request_id, approved_grant_id,
          approved_units, claim_deadline, lease_id, lease_until, intent_reserved_at, request_digest, posts, amazon_status, accepted_at, placed_at,
          custody_destroyed_at, custody_destroyed_reason, created_at)
        select ${orgId}, ${lane.record}, ${lane.asin}, 'SYN-SAMPLE-1', ${lane.reservation}, ${preflight!.id}, ${binding!.connection_id},
          ${binding!.marketplace_id}, ${lane.keyId}, ${randomUUID()}, ${lane.ciphertext}, ${OWNER}, now() - interval '30 days', ${state},
          ${JSON.stringify(MASK)}::jsonb, ${change.escalation === undefined ? null : new Date().toISOString()}::timestamptz, ${change.escalation ?? null},
          ${approved ? randomUUID() : null}::uuid, ${approved ? OWNER : null}::uuid,
          ${approved ? new Date(Date.now() - 30 * 86_400_000).toISOString() : null}::timestamptz, a.at,
          case when a.at is null then null else app.creator_mcf_send_confirmation(1) end, ${approved ? randomUUID() : null}::uuid,
          ${approved ? randomUUID() : null}::uuid, case when a.at is null then null else 1 end, a.at + interval '15 minutes',
          ${randomUUID()}::uuid, now() + interval '1 minute', case when a.at is null then null else a.at + interval '1 minute' end,
          case when a.at is null then null else ${randomBytes(32).toString('hex')} end, case when a.at is null then 0 else 1 end,
          ${AMAZON_STATUS[state] ?? null}, case when ${AFTER_ACCEPT.includes(state)} then a.at + interval '2 minutes' end,
          case when ${AFTER_PLACE.includes(state)} then a.at + interval '5 minutes' end,
          case when app.creator_mcf_custody_held(${state}) then null else now() end,
          case when app.creator_mcf_custody_held(${state}) then null else 'post_outcome' end,
          now() - ${change.createdAgo ?? '0 seconds'}::interval
        from (select case when ${approved} then date_trunc('milliseconds', now()) - interval '20 minutes' end as at) a`;
    });
  }

  it('reads the outcome of every send state by key and by lane, with the class the skill acts on and nothing about the recipient', async () => {
    const client = await connect(server, creatorToken);
    const before = await tableCounts();
    const seeded: [string, string, SeededLane][] = [];
    for (const [state, outcomeClass] of SEND_STATES) {
      const lane = await seedLane();
      await seedSend(lane, state);
      seeded.push([state, outcomeClass, lane]);
    }
    // The oracle names every state the contract has, so a new state fails here until it is given a class.
    expect(SEND_STATES.map(([state]) => state).sort()).toEqual([...CreatorMcfSendState.options].sort());
    const afterSeed = await tableCounts();
    let read = 0;
    try {
      for (const [state, outcomeClass, lane] of seeded) {
        const byKey = await call(client, 'creators.sample_send_outcome', { derivedOrderKey: lane.key });
        const byLane = await call(client, 'creators.sample_send_outcome', { creatorRecordId: lane.record, asin: lane.asin });
        for (const answer of [byKey, byLane]) {
          expect(answer.isError, state).toBe(false);
          expect(Object.keys(answer.payload).sort(), state).toEqual(['acceptedAt', 'class', 'derivedOrderKey', 'escalated', 'mcfStatus', 'placedAt',
            'reservationId', 'state']);
          expect(answer.payload, state).toMatchObject({ derivedOrderKey: lane.key, state, class: outcomeClass, escalated: false,
            mcfStatus: AMAZON_STATUS[state] ?? null, reservationId: lane.reservation });
          expect(answer.payload['acceptedAt'] === null, state).toBe(!AFTER_ACCEPT.includes(state));
          expect(answer.payload['placedAt'] === null, state).toBe(!AFTER_PLACE.includes(state));
          // No mask, fingerprint, key id, digest, fee or address field, by name (as a JSON key) or by value.
          for (const absent of ['"mask', '"countryCode', '"postalPrefix', '"fingerprint', '"recipient', '"address', '"keyId', '"sku', '"fee',
            MASK.postalPrefix, lane.keyId, lane.ciphertext]) {
            expect(answer.text, `${state}: ${absent}`).not.toContain(absent);
          }
          read++;
        }
      }
    } finally { await client.close(); }
    expect(read).toBe(SEND_STATES.length * 2);
    expect(new Set(seeded.map(([, outcomeClass]) => outcomeClass))).toEqual(new Set(['pending', 'placed', 'failed', 'uncertain', 'cancelled']));
    // Reading wrote nothing but audit rows.
    expect(await tableCounts()).toEqual(afterSeed);
    expect(afterSeed['creator_sample_shipments']).toBe(before['creator_sample_shipments']! + SEND_STATES.length);
  });

  it('flags a send escalated by the ledger in any state, and WP-334\'s not-found escalation only while the send is uncertain', async () => {
    const client = await connect(server, creatorToken);
    const cases: [label: string, state: string, change: { escalation?: 'ladder_exhausted' | 'conflict' }, laneEscalated: boolean, expected: boolean][] = [
      ['ladder exhausted while uncertain', 'uncertain', { escalation: 'ladder_exhausted' }, false, true],
      ['conflict escalation', 'conflict', { escalation: 'conflict' }, false, true],
      ['lane not-found escalation while uncertain', 'uncertain', {}, true, true],
      ['lane not-found escalation after placement', 'placed', {}, true, false],
      ['lane not-found escalation after a failure', 'rejected', {}, true, false],
      ['nothing escalated while uncertain', 'uncertain', {}, false, false],
    ];
    let checked = 0;
    try {
      for (const [label, state, change, laneEscalated, expected] of cases) {
        const lane = await seedLane();
        await seedSend(lane, state, change);
        if (laneEscalated) {
          await database.sql`update public.creator_sample_shipments set mcf_settlement = 'escalated', mcf_probed_at = now()
            where org_id = ${orgId} and creator_record_id = ${lane.record} and asin = ${lane.asin}`;
        }
        const answer = await call(client, 'creators.sample_send_outcome', { derivedOrderKey: lane.key });
        expect(answer.isError, label).toBe(false);
        expect(answer.payload, label).toMatchObject({ state, escalated: expected });
        checked++;
      }
    } finally { await client.close(); }
    expect(checked).toBe(cases.length);
  });

  it('answers with the lane\'s newest send, and not_found for a lane without one', async () => {
    const client = await connect(server, creatorToken);
    try {
      const lane = await seedLane();
      await seedSend(lane, 'rejected', { createdAgo: '1 hour' });
      await seedSend(lane, 'placed');
      expect((await call(client, 'creators.sample_send_outcome', { creatorRecordId: lane.record, asin: lane.asin })).payload)
        .toMatchObject({ state: 'placed', class: 'placed' });
      const empty = await seedLane();
      for (const args of [{ derivedOrderKey: empty.key }, { creatorRecordId: empty.record, asin: empty.asin },
        { derivedOrderKey: creatorSampleOrderKey(orgId, 'CCR-SW-26-9997', 'B0AAAAAAAA') }]) {
        const missing = await call(client, 'creators.sample_send_outcome', args);
        expect(missing.isError).toBe(true);
        expect(missing.payload['error']).toBe('not_found');
        expect(missing.text).toContain('no Arcana send');
      }
    } finally { await client.close(); }
  });

  it('refuses a malformed, mixed or contact-bearing lane before reading, naming the path and never the value', async () => {
    const client = await connect(server, creatorToken);
    const cases: [Record<string, unknown>, RegExp][] = [
      [{}, /creatorRecordId \(invalid_type\)/],
      [{ derivedOrderKey: 'CCS-NOTHEX' }, /derivedOrderKey \(invalid_format\)/],
      [{ creatorRecordId: 'CCR-SW-26-0072' }, /asin \(invalid_type\)/],
      [{ derivedOrderKey: creatorSampleOrderKey(orgId, 'CCR-SW-26-0072', 'B0D9K3M2QP'), creatorRecordId: 'CCR-SW-26-0072', asin: 'B0D9K3M2QP' },
        /not both/],
      [{ derivedOrderKey: creatorSampleOrderKey(orgId, 'CCR-SW-26-0072', 'B0D9K3M2QP'), note: 'x' }, /unrecognized_keys/],
      [{ creatorRecordId: 'CCR-SW-26-0072', asin: 'B0D9K3M2QP', shipping_address: street }, /shipping_address \(contact_key\)/],
    ];
    try {
      for (const [args, where] of cases) {
        const refused = await call(client, 'creators.sample_send_outcome', args);
        expect(refused.isError, JSON.stringify(Object.keys(args))).toBe(true);
        expect(refused.payload['error']).toBe('invalid_argument');
        expect(refused.text).toMatch(where);
        expect(refused.text).not.toContain(street);
      }
    } finally { await client.close(); }
  });

  it('refuses the outcome read to a read key, and to a creator:write key once it is expired or revoked', async () => {
    const lane = await seedLane();
    await seedSend(lane, 'placed');
    const read = await connect(server, readToken);
    try {
      const refused = await call(read, 'creators.sample_send_outcome', { derivedOrderKey: lane.key });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/not found/);
      expect(refused.text).not.toContain(lane.key);
    } finally { await read.close(); }
    // The database refuses a read key on this tool's authorization too, whatever a server registered.
    await expect(withCreatorWriteOperation({ handle: database, config: testConfig(database.connectionString), actor: { orgId, userId: OWNER },
      keyId: readKeyId }, async () => 'outcome')).rejects.toMatchObject({ code: 'forbidden' });

    for (const ending of ['expired', 'revoked'] as const) {
      const key = await issue(ADMIN);
      const client = await connect(server, key.token);
      try {
        expect((await call(client, 'creators.sample_send_outcome', { derivedOrderKey: lane.key })).payload).toMatchObject({ class: 'placed' });
        if (ending === 'expired') await database.sql`update mcp.api_keys set expires_at = now() - interval '1 second' where id = ${key.record.id}`;
        else await database.sql`update mcp.api_keys set revoked_at = now() where id = ${key.record.id}`;
        const answer = await call(client, 'creators.sample_send_outcome', { derivedOrderKey: lane.key }).catch((error: unknown) => ({
          payload: {} as Record<string, unknown>, text: String(error), isError: true }));
        // The HTTP token check refuses it first; the database re-authorization would refuse it as well.
        expect(answer.isError, ending).toBe(true);
        expect(answer.text, ending).toContain('invalid or revoked API key');
        expect(answer.text, ending).not.toContain(lane.reservation);
        await expect(withCreatorWriteOperation({ handle: database, config: testConfig(database.connectionString), actor: { orgId, userId: ADMIN },
          keyId: key.record.id }, async () => 'outcome'), ending).rejects.toMatchObject({ code: 'forbidden' });
      } finally { await client.close(); }
      await expect(connect(server, key.token), ending).rejects.toThrow();
    }
  });

  it('audits every outcome read with a digest, a size and the outcome class, never the arguments or the answer', async () => {
    const lane = await seedLane();
    await seedSend(lane, 'uncertain', { escalation: 'ladder_exhausted' });
    const before = (await readAuditEntries(database, orgId, 5_000)).filter((entry) => entry.actorId === creatorKeyId).length;
    const client = await connect(server, creatorToken);
    try {
      expect((await call(client, 'creators.sample_send_outcome', { derivedOrderKey: lane.key })).isError).toBe(false);
      expect((await call(client, 'creators.sample_send_outcome', { creatorRecordId: lane.record, asin: 'B0NOTALANE' })).isError).toBe(true);
    } finally { await client.close(); }
    const entries = (await readAuditEntries(database, orgId, 5_000)).filter((entry) => entry.actorId === creatorKeyId);
    expect(entries.length - before).toBe(2);
    const [missed, found] = entries;
    expect(found).toMatchObject({ action: 'mcp.creators.sample_send_outcome', actorType: 'mcp' });
    expect(found!.payload).toMatchObject({ outcome: 'ok', summary: { state: 'uncertain', class: 'uncertain', escalated: true } });
    expect(Object.keys(found!.payload['params'] as object).sort()).toEqual(['bytes', 'digest', 'keys', 'otherKeys']);
    expect((found!.payload['params'] as { digest: string }).digest).toMatch(/^[0-9a-f]{64}$/);
    expect(missed!.payload).toMatchObject({ outcome: 'error', summary: { code: 'not_found' } });
    const text = JSON.stringify([found, missed]);
    for (const value of [lane.key, lane.record, lane.reservation, lane.keyId, lane.ciphertext, MASK.postalPrefix, 'B0NOTALANE']) {
      expect(text).not.toContain(value);
    }
  });

  async function tableCounts(): Promise<Record<string, number>> {
    const tables = ['creator_records', 'creator_action_log', 'creator_daily_queue', 'creator_sweep_runs', 'creator_sample_shipments', 'creator_drafts',
      'creator_import_runs', 'creator_mcf_sends', 'creator_mcf_send_events', 'creator_sample_preflights'];
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from ${database.sql(table)} where org_id = ${orgId}`;
      counts[table] = row!.n;
    }
    return counts;
  }
});

function testConfig(connectionString: string): McpConfig {
  return {
    connectionString, port: 0, host: '127.0.0.1', webBaseUrl: 'http://localhost:3000', revision: 'abcdef123456', poolSize: 4,
    statementTimeoutSeconds: 30, maxRows: DEFAULT_MAX_ROWS, maxDownloadBytes: DEFAULT_MAX_DOWNLOAD_BYTES,
  };
}

async function connect(server: RunningServer, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'creator-write-test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = result.content.find((entry) => entry.type === 'text')?.text ?? '';
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(text) as Record<string, unknown>; } catch { /* a protocol refusal is plain text */ }
  return { payload, text, isError: result.isError === true };
}
