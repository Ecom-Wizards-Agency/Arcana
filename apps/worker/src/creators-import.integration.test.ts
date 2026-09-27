/**
 * `creators:import` against a migrated database: every kind upserted, a replay
 * writes nothing, a changed file updates only what changed, and a broken file
 * is recorded as the latest read without touching the stored rows.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCreatorQueue, readCreatorSampleShipments, readCreatorSweeps, readLatestCreatorImport } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCreatorsImport } from './creators-import.js';
import { syntheticRunnerFiles, writeRunnerFiles } from './creators-import.fixture.js';

const available = await databaseAvailable();
const OWNER = '33200000-0000-4000-8000-000000000021';
const TABLES = ['creator_records', 'creator_action_log', 'creator_daily_queue', 'creator_sweep_runs', 'creator_sample_shipments'] as const;

describe.skipIf(!available)('creators:import', () => {
  let db: TestDatabase;
  let orgId: string;
  let dir: string;
  const lines: string[] = [];
  const run = (...extra: string[]) => runCreatorsImport(['--dir', dir, '--org-id', orgId, '--once', ...extra], { DATABASE_URL: db.connectionString }, (line) => lines.push(line));
  const rowCounts = async () => Object.fromEntries(await Promise.all(TABLES.map(async (table) =>
    [table, (await db.sql<{ n: number }[]>`select count(*)::int as n from ${db.sql(table)} where org_id = ${orgId}`)[0]!.n])));

  beforeAll(async () => {
    db = await createTestDatabase('wp332_import');
    const [org] = await db.sql`select app.seed_tenant_fixture('creators-import', ${OWNER}, 'owner') as id`;
    orgId = String(org!['id']);
    dir = await mkdtemp(join(tmpdir(), 'wp332-runner-'));
    await writeRunnerFiles(dir);
  }, 180_000);
  afterAll(async () => { await db?.drop(); });

  it('upserts every kind from the four runner files and logs counts without values', async () => {
    const before = await rowCounts();
    expect(await run()).toBe(0);
    const summary = JSON.parse(lines.at(-1)!);
    expect(summary).toMatchObject({ event: 'creators_import', status: 'succeeded', files: ['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations'], queueRunDate: '2026-09-09' });
    expect(summary.counts).toEqual({
      records: { read: 7, valid: 6, invalid: 1, inserted: 6, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      action_log: { read: 8, valid: 8, invalid: 0, inserted: 8, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      queue_items: { read: 5, valid: 4, invalid: 1, inserted: 4, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      sweep_runs: { read: 1, valid: 1, invalid: 0, inserted: 1, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      sample_shipments: { read: 4, valid: 4, invalid: 0, inserted: 4, updated: 0, unchanged: 0, skipped: 0, removed: 0 },
      // No preflight-results.json among the four runner files: not read, so null rather than zero.
      preflights: null,
    });
    expect(summary.invalid.map((entry: { kind: string }) => entry.kind)).toEqual(['records', 'queue_items']);
    const after = await rowCounts();
    expect(after).toEqual({ creator_records: before['creator_records']! + 6, creator_action_log: before['creator_action_log']! + 8,
      creator_daily_queue: before['creator_daily_queue']! + 4, creator_sweep_runs: before['creator_sweep_runs']! + 1,
      creator_sample_shipments: before['creator_sample_shipments']! + 4 });
    const queue = await readCreatorQueue(db, orgId);
    expect(queue.runDate).toBe('2026-09-09');
    expect(queue.items).toHaveLength(4);
    expect(queue.items.find((item) => item.creatorRecordId === 'CCR-SW-26-0072')?.lockState).toBe('Locked for MCF');
    expect((await readCreatorSweeps(db, orgId)).latest).toMatchObject({ runId: 'sweep-20260909-0612', reconciled: false });
    expect((await readCreatorSampleShipments(db, orgId)).shipments.filter((item) => item.creatorRecordId !== 'CCR-FX-26-0001')).toHaveLength(4);
  });

  it('replays idempotently: a second run writes no row and reports everything unchanged', async () => {
    const before = await rowCounts();
    expect(await run()).toBe(0);
    const summary = JSON.parse(lines.at(-1)!);
    expect(summary.counts.preflights).toBeNull();
    const replayed = Object.values(summary.counts).filter((counts) => counts !== null);
    expect(replayed).toHaveLength(5);
    for (const counts of replayed as { inserted: number; updated: number; removed: number; unchanged: number; valid: number }[]) {
      expect(counts).toMatchObject({ inserted: 0, updated: 0, removed: 0 });
      expect(counts.unchanged).toBe(counts.valid);
    }
    expect(await rowCounts()).toEqual(before);
  });

  it('updates only what changed when the runner moves a record on', async () => {
    const files = syntheticRunnerFiles();
    const record = files.registry.records[0] as Record<string, unknown>;
    record['version'] = 4;
    record['last_verified_at'] = '2026-09-09';
    await writeRunnerFiles(dir, files);
    expect(await run()).toBe(0);
    const summary = JSON.parse(lines.at(-1)!);
    expect(summary.counts.records).toMatchObject({ inserted: 0, updated: 1, unchanged: 5 });
    expect(summary.counts.queue_items).toMatchObject({ inserted: 0, updated: 0, unchanged: 4 });
  });

  it('skips a sweep file nothing produced, counts it, and keeps importing the runner files', async () => {
    const files = syntheticRunnerFiles();
    await writeRunnerFiles(dir, files);
    await writeFile(join(dir, 'sweep-checkpoint.json'), JSON.stringify({ watermarks: {} }));
    expect(await run()).toBe(0);
    const summary = JSON.parse(lines.at(-1)!);
    expect(summary).toMatchObject({ status: 'succeeded', files: ['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations'] });
    expect(summary.counts.sweep_runs).toEqual({ read: 1, valid: 0, invalid: 1, inserted: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 });
    expect(summary.invalid).toContainEqual({ kind: 'sweep_runs', index: 0, issues: [{ path: '', code: 'sweep_file_not_produced' }] });
    expect(summary.counts.records).toMatchObject({ read: 7, valid: 6, invalid: 1 });
  });

  it('records a broken file as the latest read, exits 2, and leaves every stored row as it was', async () => {
    const before = await rowCounts();
    await writeFile(join(dir, 'daily-queue.json'), '{ "run_date": "2026-09-10", "items": [], "counts": { "queued": 1, "escalated": 0 } }');
    expect(await run()).toBe(2);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: 'failed', failure: 'file_shape_invalid', failedFile: 'queue' });
    expect(await rowCounts()).toEqual(before);
    expect(await readLatestCreatorImport(db, orgId)).toMatchObject({ status: 'failed', failure: 'file_shape_invalid' });
    expect((await readCreatorQueue(db, orgId)).runDate).toBe('2026-09-09');
  });
});
