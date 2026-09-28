/**
 * WP-338q: the runner's handover fields (creator_control.py on wp-338l) through
 * the one registry mapping the file import and `creators.register_record` share.
 * A CCS key must be this organisation's own for the record and ASIN; the
 * runner's `order_owner` never sets a lane's owner; an Arcana-recorded order
 * confirms its lane with nothing about the recipient. Synthetic values only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreatorRunnerRegistryRecord } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { creatorSampleOrderKey, persistCreatorImport, type CreatorImportBatch } from './creators.js';
import { creatorRegistryRows } from './creators-runner.js';

const available = await databaseAvailable();
const OWNER = '33800000-0000-4000-8000-000000000001';
const ASIN = 'B0EXAMPLE1';
const NOTE = 'recipient: operator-entered in Arcana, binding unverified';
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');

/** A registry row in the shape creator_control.py writes (its ArcanaHandoverTests fixtures), with synthetic fingerprints. */
const record = (id: string, change: Record<string, unknown> = {}) => ({
  creator_record_id: id, brand: 'Example', campaign_id: 'campaign-1', thread_key: fp(`${id}:thread`), storefront_key: fp(`${id}:storefront`),
  full_name_fp: fp(`${id}:name`), email_fp: fp(`${id}:email`), phone_fp: fp(`${id}:phone`), address_fp: fp(`${id}:address`),
  record_state: 'Active', lock_state: 'Locked for MCF', version: 2, created_at: '2026-08-05', ...change,
});
/** `reserve_mcf` for a lane handed to Arcana: the stored key, order_owner, the cap and no visible fee. */
const handed = (id: string, key: string, change: Record<string, unknown> = {}) => ({
  reservation_id: `MCFR-${createHash('sha256').update(id).digest('hex').slice(0, 16).toUpperCase()}`, state: 'Reserved', creator_record_id: id,
  campaign_id: 'campaign-1', tracker_source_ref: 'tracker/campaign-1/row-2', asin: ASIN, sku: 'SKU-1', product_title: 'Example Product',
  quantity: 1, recipient_binding: fp(`${id}:recipient`), approved_fee_cap_cents: 800, thread_evidence_reference: 'private-evidence/thread-1.json',
  preflight_evidence_reference: 'private-evidence/preflight-1.json', inventory_evidence_reference: 'private-evidence/mcf-search.json',
  reserved_at: '2026-09-27T23:47:35.437142+00:00', derived_order_key: key, order_owner: 'arcana', ...change,
});
/** `record_api_order`: the note, the key as order id and the arcana:send evidence; no binding. */
const recorded = (id: string, key: string, reservationId: string) => ({
  reservation_id: reservationId, creator_record_id: id, campaign_id: 'campaign-1', tracker_source_ref: 'tracker/campaign-1/row-2', asin: ASIN,
  sku: 'SKU-1', product_title: 'Example Product', quantity: 1, order_id: key, status: 'Confirmed',
  evidence_reference: `arcana:send:${key}:${fp(`${id}:send`)}`, recipient_note: NOTE, confirmed_at: '2026-09-28T10:03:00.000000+00:00',
});

function rows(orgId: string, raw: unknown) {
  return creatorRegistryRows(orgId, CreatorRunnerRegistryRecord.parse(raw));
}

describe('the registry mapping with the WP-338l handover fields', () => {
  const org = randomUUID();
  const id = 'CCR-EX-26-0001';
  const own = creatorSampleOrderKey(org, id, ASIN);
  const foreign = creatorSampleOrderKey(randomUUID(), id, ASIN);

  it('maps a lane handed to Arcana like any reservation, with no owner and no fee', () => {
    const mapped = rows(org, record(id, { mcf_reservation: handed(id, own) }));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.lanes).toHaveLength(1);
    expect(mapped.lanes[0]).toMatchObject({ laneState: 'Reserved', feeCents: null, feeCapCents: 800, runnerOrderId: null });
    expect(mapped.lanes[0]).not.toHaveProperty('orderOwner');
    expect(Object.keys(mapped.lanes[0]!).some((key) => /owner/i.test(key))).toBe(false);
  });

  it('maps a runner lane carrying its key, and a reservation from before keys existed', () => {
    const { order_owner: _owner, ...runnerLane } = handed(id, own, { visible_fee_cents: 799 });
    expect(rows(org, record(id, { mcf_reservation: runnerLane })).ok).toBe(true);
    const { derived_order_key: _key, ...legacy } = runnerLane;
    expect(rows(org, record(id, { mcf_reservation: legacy })).ok).toBe(true);
  });

  it('refuses a reservation whose key is another organisation\'s or another lane\'s, with a fixed reason and the field\'s path only', () => {
    for (const key of [foreign, creatorSampleOrderKey(org, 'CCR-EX-26-0002', ASIN), creatorSampleOrderKey(org, id, 'B0OTHER001')]) {
      expect(rows(org, record(id, { mcf_reservation: handed(id, key) }))).toEqual({ ok: false, reason: 'derived_order_key_mismatch',
        paths: [['mcf_reservation', 'derived_order_key']] });
      const { order_owner: _owner, ...runnerLane } = handed(id, key, { visible_fee_cents: 799 });
      expect(rows(org, record(id, { mcf_reservation: runnerLane })).ok).toBe(false);
    }
  });

  it('confirms the lane of an Arcana-recorded order under its key, and stores nothing of the recipient', () => {
    const reservationId = handed(id, own).reservation_id;
    const mapped = rows(org, record(id, { lock_state: 'Unlocked', version: 3, sample_history: [recorded(id, own, reservationId)] }));
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.lanes).toEqual([expect.objectContaining({ laneState: 'Confirmed', runnerOrderId: own, reservationId,
      confirmedAt: '2026-09-28T10:03:00.000000+00:00' })]);
    expect(mapped.actions).toEqual([expect.objectContaining({ action: 'sample_confirmed', evidenceReference: `arcana:send:${own}:${fp(`${id}:send`)}` })]);
    const text = JSON.stringify(mapped);
    for (const value of [NOTE, 'recipient', fp(`${id}:recipient`)]) expect(text).not.toContain(value);
  });

  it('refuses an Arcana-recorded order under another key, by its history position', () => {
    const reservationId = handed(id, own).reservation_id;
    const runnerEntry = { ...recorded(id, own, reservationId), reservation_id: 'MCFR-00000000000000A1', order_id: '111-2222222-3333333',
      evidence_reference: 'private-evidence/order.png', recipient_note: undefined };
    const mapped = rows(org, record(id, { lock_state: 'Unlocked', version: 3, sample_history: [runnerEntry, recorded(id, foreign, reservationId)] }));
    expect(mapped).toEqual({ ok: false, reason: 'derived_order_key_mismatch', paths: [['sample_history', 1, 'order_id']] });
    // A runner-recorded entry names its order however the runner got it; only the recipient_note entries are keyed.
    expect(rows(org, record(id, { lock_state: 'Unlocked', version: 3, sample_history: [runnerEntry] })).ok).toBe(true);
  });
});

describe.skipIf(!available)('importing the handover fields', () => {
  let db: TestDatabase;
  let orgId: string;
  beforeAll(async () => {
    db = await createTestDatabase('wp338q_runner');
    const [seed] = await db.sql`select app.seed_tenant_fixture('creators-handover', ${OWNER}, 'owner') as id`;
    orgId = String(seed!['id']);
  }, 180_000);
  afterAll(async () => { await db?.drop(); });

  /** What creators:import builds from a registry file: refused rows are counted invalid, never partly written. */
  function batch(raws: unknown[]): CreatorImportBatch {
    const mapped = raws.map((raw) => rows(orgId, raw));
    const ok = mapped.filter((item) => item.ok);
    const actions = ok.flatMap((item) => item.actions);
    const lanes = ok.flatMap((item) => item.lanes);
    return { orgId, startedAt: new Date().toISOString(), source: 'control-runner', files: ['registry'], queue: null, sweeps: null,
      records: { read: raws.length, invalid: raws.length - ok.length, rows: ok.map((item) => item.record) },
      actions: { read: actions.length, invalid: 0, rows: actions }, shipments: { read: lanes.length, invalid: 0, rows: lanes } };
  }
  const lane = async (id: string) => (await db.sql`select lane_state, order_owner, runner_order_id, fee_cents, fee_cap_cents, derived_order_key
    from public.creator_sample_shipments where org_id = ${orgId} and creator_record_id = ${id} and asin = ${ASIN}`)[0];

  it('counts the handover records valid, a key mismatch invalid, and leaves every lane it inserts runner-owned', async () => {
    const key = (id: string) => creatorSampleOrderKey(orgId, id, ASIN);
    const { order_owner: _owner, ...runnerLane } = handed('CCR-EX-26-0402', key('CCR-EX-26-0402'), { visible_fee_cents: 799 });
    const run = await persistCreatorImport(db, batch([
      record('CCR-EX-26-0401', { mcf_reservation: handed('CCR-EX-26-0401', key('CCR-EX-26-0401')) }),
      record('CCR-EX-26-0402', { mcf_reservation: runnerLane }),
      record('CCR-EX-26-0403', { lock_state: 'Unlocked', version: 3,
        sample_history: [recorded('CCR-EX-26-0403', key('CCR-EX-26-0403'), handed('CCR-EX-26-0403', '').reservation_id)] }),
      record('CCR-EX-26-0404', { mcf_reservation: handed('CCR-EX-26-0404', creatorSampleOrderKey(randomUUID(), 'CCR-EX-26-0404', ASIN)) }),
    ]));
    expect(run.status).toBe('succeeded');
    expect(run.counts.records).toMatchObject({ read: 4, valid: 3, invalid: 1, inserted: 3 });
    expect(run.counts.sample_shipments).toMatchObject({ read: 3, valid: 3, inserted: 3, skipped: 0 });
    expect(await lane('CCR-EX-26-0401')).toEqual({ lane_state: 'Reserved', order_owner: 'runner', runner_order_id: null, fee_cents: null,
      fee_cap_cents: 800, derived_order_key: key('CCR-EX-26-0401') });
    expect(await lane('CCR-EX-26-0402')).toMatchObject({ lane_state: 'Reserved', order_owner: 'runner', fee_cents: 799, derived_order_key: key('CCR-EX-26-0402') });
    expect(await lane('CCR-EX-26-0403')).toMatchObject({ lane_state: 'Confirmed', order_owner: 'runner', runner_order_id: key('CCR-EX-26-0403') });
    expect(await lane('CCR-EX-26-0404')).toBeUndefined();
    const [refused] = await db.sql`select count(*)::int as n from public.creator_records where org_id = ${orgId} and creator_record_id = 'CCR-EX-26-0404'`;
    expect(refused!['n']).toBe(0);
  });

  it('never moves a lane\'s owner either way: a runner lane stays runner, an Arcana lane stays Arcana and untouched', async () => {
    const id = 'CCR-EX-26-0401';
    const key = creatorSampleOrderKey(orgId, id, ASIN);
    // The send ledger, not the import, hands the lane to Arcana.
    await db.sql.begin(async (sql) => {
      await sql`select set_config('app.creator_mcf_ledger', 'on', true)`;
      await sql`update public.creator_sample_shipments set order_owner = 'arcana' where org_id = ${orgId} and creator_record_id = ${id}`;
    });
    const before = await lane(id);
    const replay = await persistCreatorImport(db, batch([
      record(id, { version: 5, mcf_reservation: handed(id, key, { approved_fee_cap_cents: 900, visible_fee_cents: 850 }) }),
      record('CCR-EX-26-0402', { version: 5, mcf_reservation: handed('CCR-EX-26-0402', creatorSampleOrderKey(orgId, 'CCR-EX-26-0402', ASIN),
        { visible_fee_cents: 810 }) }),
    ]));
    expect(replay.counts.sample_shipments).toMatchObject({ read: 2, skipped: 1, updated: 1 });
    expect(await lane(id)).toEqual(before);
    expect(await lane('CCR-EX-26-0402')).toMatchObject({ order_owner: 'runner', fee_cents: 810 });
  });
});
