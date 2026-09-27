/**
 * Creator Connections persistence against a migrated database: tenant RLS by
 * role, append-only logs, idempotent replays, the derived sample order key and
 * the computed sweep reconciliation. Synthetic values only.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asAnon, asServiceRole, asUser } from '../testing/rls.js';
import {
  creatorSampleOrderKey, persistCreatorImport, readCreatorQueue, readCreatorSampleShipments, readCreatorSweeps,
  readLatestCreatorImport, recordFailedCreatorImport, type CreatorImportBatch, type CreatorQueueWrite, type CreatorRecordWrite,
} from './creators.js';

const available = await databaseAvailable();
const OWNER = '33200000-0000-4000-8000-000000000001';
const ADMIN = '33200000-0000-4000-8000-000000000002';
const ANALYST = '33200000-0000-4000-8000-000000000003';
const VIEWER = '33200000-0000-4000-8000-000000000004';
const FOREIGN = '33200000-0000-4000-8000-000000000005';
const TABLES = ['creator_records', 'creator_action_log', 'creator_daily_queue', 'creator_sweep_runs', 'creator_sample_shipments', 'creator_import_runs'] as const;
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');

const record = (id: string, change: Partial<CreatorRecordWrite> = {}): CreatorRecordWrite => ({
  creatorRecordId: id, brand: 'Synthetic brand', campaignId: 'campaign-synthetic-1',
  fingerprints: { storefront: fp(`${id}:storefront`), thread: fp(`${id}:thread`), fullName: null, email: null, phone: null, address: null },
  recordState: 'Active', lockState: 'Unlocked', escalationReason: null, runnerVersion: 1, createdOn: '2026-09-01', lastVerifiedOn: null, ...change,
});
const queueItem = (id: string, change: Partial<CreatorQueueWrite> = {}): CreatorQueueWrite => ({
  runDate: '2026-09-09', queueId: `20260909-${id}`, occurrence: 1, creatorRecordId: id, brand: 'Synthetic brand', campaignTab: 'Synthetic tab',
  currentStatus: 'Verification Confirmed', computedScore: 8, missing: ['recent_post_verified', 'performance_or_revenue'], dueDate: '2026-09-09',
  actionType: 'RECONCILE_QUALIFICATION', gateResult: 'BLOCKED', queueState: 'Escalated', reason: 'status_score_drift', ...change,
});
function batch(orgId: string, change: Partial<CreatorImportBatch> = {}): CreatorImportBatch {
  const records = [record('CCR-SW-26-0134'), record('CCR-SW-26-0117', { lockState: 'Conflict', escalationReason: 'multiple_active_records_match', runnerVersion: 2 }),
    record('CCR-SW-26-0072', { lockState: 'Locked for MCF', runnerVersion: 7 })];
  return {
    orgId, startedAt: '2026-09-09T06:14:00.000Z', source: 'control-runner', files: ['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations'],
    records: { read: 4, invalid: 1, rows: records },
    actions: { read: 2, invalid: 0, rows: [
      { eventKey: 'conflict:CCR-SW-26-0117:2', creatorRecordId: 'CCR-SW-26-0117', action: 'identity_conflict_locked', occurredAt: null, reservationId: null,
        asin: null, reasonCode: 'multiple_active_records_match', evidenceReference: null, recordVersion: 2 },
      { eventKey: 'reserved:MCFR-9F2C41AB77E0D3B5', creatorRecordId: 'CCR-SW-26-0072', action: 'mcf_reserved', occurredAt: '2026-09-08T06:40:00.000Z',
        reservationId: 'MCFR-9F2C41AB77E0D3B5', asin: 'B0D9K3M2QP', reasonCode: null, evidenceReference: 'evidence/synthetic/preflight', recordVersion: 7 }] },
    queue: { runDate: '2026-09-09', read: 3, invalid: 0, rows: [queueItem('CCR-SW-26-0134'),
      queueItem('CCR-SW-26-0117', { actionType: 'IDENTITY_RESOLUTION', currentStatus: 'New Inquiry', computedScore: 10, missing: [], reason: 'record_is_locked' }),
      queueItem('CCR-SW-26-0072', { actionType: 'MCF_PREFLIGHT', gateResult: 'HOLD', queueState: 'Queued', computedScore: 10, missing: [],
        currentStatus: 'Approved for Sample', reason: 'paid_order_requires_preflight_and_authorized_executor' })] },
    sweeps: { read: 1, invalid: 0, rows: [{ runId: 'sweep-20260909-0612', runDate: '2026-09-09', brand: 'Synthetic brand', startedAt: null,
      completedAt: '2026-09-09T06:12:00.000Z', counts: { mounted: 412, opened: 412, changed: 37, messagesExamined: 96, messagesSent: 0,
        noActionAcknowledgements: 359, heldOrEscalated: 9, archivedSpam: 5, unmatched: 7 },
      outcomes: { unchanged: 359, actioned: 37, held: 6, escalated: 3, unmatched: 7, unopened: 0, unclassified: 0 },
      unresolved: [{ threadKey: fp('thread-unmatched-1'), amazonTimestamp: '2026-09-09T05:10:00.000Z', outcome: 'unmatched', reason: 'multiple_active_records_match' }],
      evidenceReference: 'ev:sweep-0909' }] },
    shipments: { read: 1, invalid: 0, rows: [{ creatorRecordId: 'CCR-SW-26-0072', asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', campaignId: 'campaign-synthetic-1',
      reservationId: 'MCFR-9F2C41AB77E0D3B5', laneState: 'Reconciliation Required', runnerOrderId: null, feeCents: 620, feeCapCents: 800,
      reservedAt: '2026-09-08T06:40:00.000Z', verifiedAt: '2026-09-08T06:43:00.000Z', confirmedAt: null, cancelledAt: null, cancellationReason: null,
      reconciliationReason: 'outcome_unknown' }] },
    ...change,
  };
}

describe.skipIf(!available)('Creator Connections persistence', () => {
  let db: TestDatabase;
  let orgId: string;
  let foreignOrg: string;
  beforeAll(async () => {
    db = await createTestDatabase('wp332_creators');
    const [a] = await db.sql`select app.seed_tenant_fixture('creators-synthetic', ${OWNER}, 'owner') as id`;
    orgId = String(a!['id']);
    const [b] = await db.sql`select app.seed_tenant_fixture('creators-foreign', ${FOREIGN}, 'owner') as id`;
    foreignOrg = String(b!['id']);
    for (const [user, role] of [[ADMIN, 'admin'], [ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await db.sql`select public.auth_user_stub(${user})`;
      await db.sql`insert into public.org_members(org_id, user_id, role) values (${orgId}, ${user}, ${role})`;
    }
  }, 180_000);
  afterAll(async () => { await db?.drop(); });

  it('upserts every kind, counts it, and derives qualification from the queue', async () => {
    const run = await persistCreatorImport(db, batch(orgId));
    expect(run.status).toBe('succeeded');
    expect(run.queueRunDate).toBe('2026-09-09');
    expect(run.counts).toEqual({
      records: { read: 4, valid: 3, invalid: 1, inserted: 3, updated: 0, unchanged: 0, removed: 0 },
      action_log: { read: 2, valid: 2, invalid: 0, inserted: 2, updated: 0, unchanged: 0, removed: 0 },
      queue_items: { read: 3, valid: 3, invalid: 0, inserted: 3, updated: 0, unchanged: 0, removed: 0 },
      sweep_runs: { read: 1, valid: 1, invalid: 0, inserted: 1, updated: 0, unchanged: 0, removed: 0 },
      sample_shipments: { read: 1, valid: 1, invalid: 0, inserted: 1, updated: 0, unchanged: 0, removed: 0 },
    });
    const [scored] = await db.sql`select status, computed_score, missing_checks, qualified_on::text as qualified_on from public.creator_records
      where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0134'`;
    expect(scored).toEqual({ status: 'Verification Confirmed', computed_score: 8, missing_checks: ['recent_post_verified', 'performance_or_revenue'], qualified_on: '2026-09-09' });
  });

  it('replays the same files without writing a row, and updates only what changed', async () => {
    const before = await Promise.all(TABLES.map(async (table) => (await db.sql`select count(*)::int as n from ${db.sql(table)} where org_id = ${orgId}`)[0]!['n']));
    const replay = await persistCreatorImport(db, batch(orgId));
    for (const counts of Object.values(replay.counts)) expect(counts).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
    expect(replay.counts.records?.unchanged).toBe(3);
    const after = await Promise.all(TABLES.map(async (table) => (await db.sql`select count(*)::int as n from ${db.sql(table)} where org_id = ${orgId}`)[0]!['n']));
    expect(after).toEqual(before.map((count, index) => TABLES[index] === 'creator_import_runs' ? Number(count) + 1 : count));

    const next = batch(orgId);
    next.records!.rows[0] = { ...next.records!.rows[0]!, lastVerifiedOn: '2026-09-09', runnerVersion: 4 };
    next.queue = { runDate: '2026-09-09', read: 1, invalid: 0, rows: [next.queue!.rows[2]!] };
    const changed = await persistCreatorImport(db, next);
    expect(changed.counts.records).toMatchObject({ inserted: 0, updated: 1, unchanged: 2 });
    expect(changed.counts.queue_items).toMatchObject({ read: 1, inserted: 0, updated: 0, unchanged: 1, removed: 2 });
  });

  it('keeps a day worked to zero as that day', async () => {
    const zero = await persistCreatorImport(db, batch(orgId, { queue: { runDate: '2026-09-10', read: 0, invalid: 0, rows: [] } }));
    expect(zero.counts.queue_items).toEqual({ read: 0, valid: 0, invalid: 0, inserted: 0, updated: 0, unchanged: 0, removed: 0 });
    const snapshot = await asUser(db, ANALYST, (sql) => readCreatorQueue({ sql }, orgId));
    expect(snapshot.runDate).toBe('2026-09-10');
    expect(snapshot.items).toHaveLength(0);
    expect(snapshot.registryRecords).toBe(4);
  });

  it('refuses counts that do not reconcile and writes nothing', async () => {
    const [{ n: runs }] = await db.sql<[{ n: number }]>`select count(*)::int as n from public.creator_import_runs where org_id = ${orgId}`;
    await expect(persistCreatorImport(db, batch(orgId, { sweeps: { read: 3, invalid: 1, rows: batch(orgId).sweeps!.rows } }))).rejects.toThrow(/sweep_runs/);
    const [{ n: after }] = await db.sql<[{ n: number }]>`select count(*)::int as n from public.creator_import_runs where org_id = ${orgId}`;
    expect(after).toBe(runs);
  });

  it('derives the sample order key with no clock, matching the documented derivation, and collides on a repeat', async () => {
    const [row] = await db.sql<{ derived_order_key: string }[]>`select derived_order_key from public.creator_sample_shipments
      where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0072' and asin = 'B0D9K3M2QP'`;
    expect(row!.derived_order_key).toBe(creatorSampleOrderKey(orgId, 'CCR-SW-26-0072', 'B0D9K3M2QP'));
    expect(row!.derived_order_key).toHaveLength(36);
    await expect(db.sql`insert into public.creator_sample_shipments(org_id, creator_record_id, asin, lane_state, reservation_id, source, source_digest)
      values (${orgId}, 'CCR-SW-26-0072', 'B0D9K3M2QP', 'Reserved', 'MCFR-00000000000000B2', 'web', ${'0'.repeat(64)})`).rejects.toThrow(/duplicate key/);
    const foreignKey = creatorSampleOrderKey(foreignOrg, 'CCR-SW-26-0072', 'B0D9K3M2QP');
    expect(foreignKey).not.toBe(row!.derived_order_key);
  });

  it('keeps the reservation fee and times when a lane moves to Confirmed', async () => {
    const reserved = batch(orgId).shipments!.rows[0]!;
    await persistCreatorImport(db, batch(orgId, { shipments: { read: 1, invalid: 0, rows: [{ ...reserved, creatorRecordId: 'CCR-SW-26-0134', asin: 'B0D7Q1V8LM',
      reservationId: 'MCFR-00000000000000C1', laneState: 'Reserved', reconciliationReason: null }] } }));
    const confirmed = await persistCreatorImport(db, batch(orgId, { shipments: { read: 1, invalid: 0, rows: [{ ...reserved, creatorRecordId: 'CCR-SW-26-0134',
      asin: 'B0D7Q1V8LM', reservationId: 'MCFR-00000000000000C1', laneState: 'Confirmed', runnerOrderId: 'synthetic-order-c1', feeCents: null, feeCapCents: null,
      reservedAt: null, verifiedAt: null, confirmedAt: '2026-09-09T07:00:00.000Z', reconciliationReason: null }] } }));
    expect(confirmed.counts.sample_shipments).toMatchObject({ updated: 1 });
    const lane = (await readCreatorSampleShipments(db, orgId)).shipments.find((item) => item.asin === 'B0D7Q1V8LM' && item.creatorRecordId === 'CCR-SW-26-0134');
    expect(lane).toMatchObject({ laneState: 'Confirmed', runnerOrderId: 'synthetic-order-c1', feeCents: 620, feeCapCents: 800,
      reservedAt: '2026-09-08T06:40:00.000Z', verifiedAt: '2026-09-08T06:43:00.000Z', confirmedAt: '2026-09-09T07:00:00.000Z' });
  });

  it('computes reconciliation in the database from the nine counts', async () => {
    const sweeps = await readCreatorSweeps(db, orgId);
    expect(sweeps.latest?.reconciled).toBe(false);
    expect(sweeps.latest?.counts.unmatched).toBe(7);
    const clean = batch(orgId).sweeps!.rows[0]!;
    await persistCreatorImport(db, batch(orgId, { sweeps: { read: 1, invalid: 0, rows: [{ ...clean, runId: 'sweep-20260910-0612', runDate: '2026-09-10',
      completedAt: '2026-09-10T06:12:00.000Z', counts: { ...clean.counts, unmatched: 0, noActionAcknowledgements: 366 }, unresolved: [] }] } }));
    const next = await readCreatorSweeps(db, orgId);
    expect(next.latest?.runId).toBe('sweep-20260910-0612');
    expect(next.latest?.reconciled).toBe(true);
    expect(next.previous?.runId).toBe('sweep-20260909-0612');
    await expect(db.sql`update public.creator_sweep_runs set reconciled = true where org_id = ${orgId}`).rejects.toThrow(/can only be updated to DEFAULT/);
  });

  it('records a failed read as the latest import without touching earlier rows', async () => {
    const failed = await recordFailedCreatorImport(db, { orgId, startedAt: new Date().toISOString(), source: 'control-runner', files: ['queue'],
      failure: 'file_shape_invalid', failedFile: 'queue' });
    expect(failed).toMatchObject({ status: 'failed', failure: 'file_shape_invalid', failedFile: 'queue', queueRunDate: null });
    expect(Object.values(failed.counts).every((counts) => counts === null)).toBe(true);
    expect((await readLatestCreatorImport(db, orgId))?.id).toBe(failed.id);
    expect((await readCreatorQueue(db, orgId)).runDate).toBe('2026-09-10');
    const samples = await readCreatorSampleShipments(db, orgId);
    expect(samples.shipments.find((item) => item.creatorRecordId === 'CCR-SW-26-0072')).toMatchObject({ laneState: 'Reconciliation Required', mcf: null, packages: null });
  });

  describe('tenant RLS', () => {
    it('lets owners, admins and analysts read their own organisation only; viewers and anonymous callers read nothing', async () => {
      for (const user of [OWNER, ADMIN, ANALYST]) {
        await asUser(db, user, async (sql) => {
          for (const table of TABLES) {
            const [counts] = await sql<{ own: number; foreign: number }[]>`select count(*) filter (where org_id = ${orgId})::int as own,
              count(*) filter (where org_id <> ${orgId})::int as foreign from ${sql(table)}`;
            expect(counts!.own, `${user} ${table}`).toBeGreaterThan(0);
            expect(counts!.foreign, `${user} ${table}`).toBe(0);
          }
        });
      }
      await asUser(db, VIEWER, async (sql) => {
        for (const table of TABLES) expect((await sql`select 1 from ${sql(table)}`).length, table).toBe(0);
      });
      await asAnon(db, async (sql) => {
        for (const table of TABLES) await expect(sql`select 1 from ${sql(table)}`, table).rejects.toThrow(/permission denied/);
      });
      const [{ n: visible }] = await asUser(db, ANALYST, (sql) => sql<[{ n: number }]>`select count(*)::int as n from public.creator_records`);
      const [{ n: stored }] = await db.sql<[{ n: number }]>`select count(*)::int as n from public.creator_records where org_id = ${orgId}`;
      expect(visible).toBe(stored);
    });

    it('lets owners and admins write, and refuses analysts, viewers and other organisations', async () => {
      const insert = (sql: typeof db.sql, org: string, id: string) => sql`insert into public.creator_records(org_id, creator_record_id, brand, campaign_id,
        record_state, lock_state, runner_version, created_on, source, source_digest)
        values (${org}, ${id}, 'Synthetic brand', 'campaign-synthetic-1', 'Active', 'Unlocked', 1, '2026-09-09', 'web', ${'0'.repeat(64)}) returning creator_record_id`;
      expect(await asUser(db, OWNER, (sql) => insert(sql, orgId, 'CCR-SW-26-0901'))).toHaveLength(1);
      expect(await asUser(db, ADMIN, (sql) => insert(sql, orgId, 'CCR-SW-26-0902'))).toHaveLength(1);
      for (const user of [ANALYST, VIEWER]) await expect(asUser(db, user, (sql) => insert(sql, orgId, 'CCR-SW-26-0903'))).rejects.toThrow(/row-level security/);
      await expect(asUser(db, ADMIN, (sql) => insert(sql, foreignOrg, 'CCR-SW-26-0904'))).rejects.toThrow(/row-level security/);
      const analystUpdate = await asUser(db, ANALYST, (sql) => sql`update public.creator_records set lock_state = 'Conflict' where org_id = ${orgId} returning 1`);
      expect(analystUpdate).toHaveLength(0);
      const adminUpdate = await asUser(db, ADMIN, (sql) => sql`update public.creator_records set lock_state = 'Conflict'
        where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0902' returning 1`);
      expect(adminUpdate).toHaveLength(1);
      const foreignUpdate = await asUser(db, ADMIN, (sql) => sql`update public.creator_records set lock_state = 'Conflict' where org_id = ${foreignOrg} returning 1`);
      expect(foreignUpdate).toHaveLength(0);
    });

    it('keeps the action log and import runs append-only for every role, and purges them with the organisation', async () => {
      for (const table of ['creator_action_log', 'creator_import_runs'] as const) {
        await expect(asServiceRole(db, (sql) => sql`update ${sql(table)} set source = 'web' where org_id = ${orgId}`)).rejects.toThrow(/append-only/);
        await expect(asServiceRole(db, (sql) => sql`delete from ${sql(table)} where org_id = ${orgId}`)).rejects.toThrow(/append-only/);
        await expect(asUser(db, OWNER, (sql) => sql`delete from ${sql(table)} where org_id = ${orgId}`)).rejects.toThrow(/permission denied/);
      }
      const [purge] = await db.sql`select app.seed_tenant_fixture('creators-purge', ${'33200000-0000-4000-8000-000000000006'}, 'owner') as id`;
      const purged = String(purge!['id']);
      await persistCreatorImport(db, batch(purged));
      await db.sql`delete from public.orgs where id = ${purged}`;
      for (const table of TABLES) expect((await db.sql`select 1 from ${db.sql(table)} where org_id = ${purged}`).length, table).toBe(0);
    });

    it('stores fingerprints only: no creator table has a column for raw contact data', async () => {
      const columns = await db.sql<{ column_name: string }[]>`select column_name from information_schema.columns
        where table_schema = 'public' and table_name = any(${[...TABLES]}::text[])`;
      const forbidden = columns.map((row) => row.column_name).filter((name) => /(^|_)(email|phone|address|full_name|name|storefront|url|link)$/.test(name));
      expect(forbidden).toEqual([]);
      expect(columns.length).toBeGreaterThan(80);
    });
  });
});
