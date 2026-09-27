import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCreatorImport, legacyReservationId, parseCreatorsImportArgs, readCreatorRunnerDirectory } from './creators-import.js';
import { syntheticRunnerFiles, writeRunnerFiles } from './creators-import.fixture.js';
import { CreatorRunnerQueueItem, CreatorRunnerQueueResult, CreatorRunnerRegistry, CreatorRunnerRegistryRecord } from '@wizard-ads/shared';
import { creatorQueueRows, creatorRegistryRows } from '@wizard-ads/db/worker';

const ORG = '33200000-0000-4000-8000-000000000011';
const scratch = () => mkdtemp(join(tmpdir(), 'wp332-import-'));

describe('creators:import arguments', () => {
  it('requires a directory and an organisation, and keeps --once and the interval exclusive', () => {
    expect(parseCreatorsImportArgs(['--', '--dir', 'runs', '--org-id', ORG, '--once'])).toEqual({ dir: 'runs', orgId: ORG, once: true, intervalSeconds: 300 });
    expect(parseCreatorsImportArgs(['--dir', 'runs', '--org-id', ORG, '--interval-seconds', '60']).intervalSeconds).toBe(60);
    for (const args of [['--org-id', ORG], ['--dir', 'runs'], ['--dir', 'runs', '--org-id', 'not-a-uuid'], ['--dir', 'runs', '--org-id', ORG, '--sheet', 'x'],
      ['--dir', 'runs', '--org-id', ORG, '--once', '--interval-seconds', '60'], ['--dir', 'runs', '--org-id', ORG, '--interval-seconds', '5']]) {
      expect(() => parseCreatorsImportArgs(args), args.join(' ')).toThrow();
    }
  });
});

describe('reading the runner directory', () => {
  it('fails closed on a missing directory, an empty one, unreadable JSON and a wrong envelope', async () => {
    expect(await readCreatorRunnerDirectory(join(await scratch(), 'absent'))).toMatchObject({ ok: false, failure: 'directory_unreadable' });
    expect(await readCreatorRunnerDirectory(await scratch())).toMatchObject({ ok: false, failure: 'no_runner_files' });
    const broken = await scratch();
    await writeRunnerFiles(broken, { registry: syntheticRunnerFiles().registry });
    await writeFile(join(broken, 'daily-queue.json'), '{ not json');
    expect(await readCreatorRunnerDirectory(broken)).toMatchObject({ ok: false, failure: 'file_unreadable', failedFile: 'queue', files: ['registry', 'queue'] });
    const drifted = await scratch();
    await writeRunnerFiles(drifted, { queue: { ...syntheticRunnerFiles().queue, counts: { queued: 1, escalated: 1 } } });
    expect(await readCreatorRunnerDirectory(drifted)).toMatchObject({ ok: false, failure: 'file_shape_invalid', failedFile: 'queue' });
  });

  it('counts a sweep file in another shape as not produced and still reads the runner files', async () => {
    const dir = await scratch();
    const files = syntheticRunnerFiles();
    await writeRunnerFiles(dir, { registry: files.registry, queue: files.queue });
    await writeFile(join(dir, 'sweep-checkpoint.json'), JSON.stringify({ watermarks: { 'synthetic-thread': 'synthetic-signature' } }));
    const read = await readCreatorRunnerDirectory(dir);
    expect(read).toMatchObject({ ok: true, sweepNotProduced: true, files: ['registry', 'queue', 'sweep_checkpoint'] });
    if (!read.ok) throw new Error('runner files must read');
    const { batch, invalid } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', read.files, read.content, read.sweepNotProduced);
    expect(batch.sweeps).toEqual({ read: 1, invalid: 1, rows: [] });
    expect(invalid).toContainEqual({ kind: 'sweep_runs', index: 0, issues: [{ path: '', code: 'sweep_file_not_produced' }] });
    expect(batch.records).toMatchObject({ read: 7, invalid: 1 });
  });
});

describe('building the import from synthetic runner outputs', () => {
  it('counts every record read, skips the invalid ones and logs where they failed without their values', async () => {
    const dir = await scratch();
    await writeRunnerFiles(dir);
    const read = await readCreatorRunnerDirectory(dir);
    if (!read.ok) throw new Error('synthetic files must read');
    expect(read.files).toEqual(['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations']);
    const { batch, invalid } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', read.files, read.content);
    expect(batch.records).toMatchObject({ read: 7, invalid: 1 });
    expect(batch.records!.rows).toHaveLength(6);
    expect(batch.queue).toMatchObject({ runDate: '2026-09-09', read: 5, invalid: 1 });
    expect(batch.queue!.rows.map((row) => [row.queueId, row.occurrence])).toEqual([
      ['20260909-CCR-SW-26-0134', 1], ['20260909-UNRESOLVED', 1], ['20260909-UNRESOLVED', 2], ['20260909-CCR-SW-26-0072', 1]]);
    expect(batch.queue!.rows.filter((row) => row.creatorRecordId === null)).toHaveLength(2);
    expect(invalid.map((entry) => [entry.kind, entry.index])).toEqual([['records', 6], ['queue_items', 4]]);
    expect(JSON.stringify(invalid)).not.toContain('synthetic"');
    expect(invalid[0]!.issues).toEqual([{ path: '', code: 'unrecognized_keys' }]);
  });

  it('derives lanes, actions and legacy ids from the registry, and keeps list-mcf as a cross-check', async () => {
    const files = syntheticRunnerFiles();
    const { batch, invalid } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', ['registry', 'mcf_reservations'],
      { registry: files.registry, mcf_reservations: files.reservations });
    const lanes = Object.fromEntries(batch.shipments!.rows.map((row) => [`${row.creatorRecordId}|${row.asin}`, row]));
    expect(Object.keys(lanes).sort()).toEqual(['CCR-SW-26-0031|B0D9K3M2QP', 'CCR-SW-26-0045|B0D7Q1V8LM', 'CCR-SW-26-0045|B0D9K3M2QP', 'CCR-SW-26-0072|B0D9K3M2QP']);
    expect(lanes['CCR-SW-26-0072|B0D9K3M2QP']).toMatchObject({ laneState: 'Reconciliation Required', reservationId: 'MCFR-9F2C41AB77E0D3B5', feeCents: 620,
      reconciliationReason: 'outcome_unknown', runnerOrderId: null });
    expect(lanes['CCR-SW-26-0045|B0D9K3M2QP']).toMatchObject({ laneState: 'Confirmed', runnerOrderId: 'synthetic-order-45' });
    expect(lanes['CCR-SW-26-0045|B0D7Q1V8LM']).toMatchObject({ laneState: 'Cancelled', cancellationReason: 'inventory_unavailable_before_submit' });
    expect(lanes['CCR-SW-26-0031|B0D9K3M2QP']).toMatchObject({ laneState: 'Reserved', reservationId: 'MCFR-LEGACY-85794FBD4E17' });
    expect(batch.shipments).toMatchObject({ read: 4, invalid: 0 });
    expect(invalid).toHaveLength(1);
    expect(batch.actions!.rows.map((row) => row.eventKey).sort()).toEqual([
      'cancelled:MCFR-00000000000000A0', 'confirmed:MCFR-00000000000000A1', 'conflict:CCR-SW-26-0117:2', 'conflict:CCR-SW-26-0203:2',
      'reconciliation:MCFR-9F2C41AB77E0D3B5', 'reserved:MCFR-9F2C41AB77E0D3B5', 'reserved:MCFR-LEGACY-85794FBD4E17',
      'verified:MCFR-9F2C41AB77E0D3B5:2026-09-08T06:43:00+00:00']);
    expect(batch.actions).toMatchObject({ read: 8, invalid: 0 });
  });

  it('takes invalid counts from the logged positions, so a lost row cannot reconcile', () => {
    const files = syntheticRunnerFiles();
    // Without a registry, two listed entries for the same lane collapse to one row: read 2, valid 1, invalid 0.
    const twice = { ...files.reservations, active_reservations: [files.reservations.active_reservations[0]!, files.reservations.active_reservations[0]!] };
    const { batch } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', ['mcf_reservations'], { mcf_reservations: twice });
    expect(batch.shipments).toMatchObject({ read: 2, invalid: 0 });
    expect(batch.shipments!.rows).toHaveLength(1);
    expect(batch.shipments!.read).not.toBe(batch.shipments!.rows.length + batch.shipments!.invalid);
  });

  it('refuses a listed reservation the registry does not hold', () => {
    const files = syntheticRunnerFiles();
    const listed = { ...files.reservations, count: 3, active_reservations: [...files.reservations.active_reservations,
      { ...files.reservations.active_reservations[0]!, creator_record_id: 'CCR-SW-26-0134', reservation_id: 'MCFR-00000000000000C3' }] };
    const { batch, invalid } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', ['registry', 'mcf_reservations'], { registry: files.registry, mcf_reservations: listed });
    expect(batch.shipments).toMatchObject({ read: 5, invalid: 1 });
    expect(invalid).toContainEqual({ kind: 'sample_shipments', index: 2, issues: [{ path: 'reservation_id', code: 'not_in_registry' }] });
  });

  it('matches the runner\'s legacy reservation id derivation (creator_control.py active_reservation_id)', () => {
    // Vectors computed once by the runner's own function on synthetic input.
    expect(legacyReservationId('ccr-sw-26-0072', 'b0d9k3m2qp', ' 2026-09-08T06:40:00+00:00 ')).toBe('MCFR-LEGACY-B54A4492C3FD');
    expect(legacyReservationId('CCR-SW-26-0072', 'B0D9K3M2QP', undefined)).toBe('MCFR-LEGACY-10960F986124');
  });

  it('summarises thread outcomes and keeps unmatched threads by fingerprint, refusing a sweep with a bad thread', () => {
    const files = syntheticRunnerFiles();
    const { batch } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', ['sweep_checkpoint'], { sweep_checkpoint: files.sweep });
    const [sweep] = batch.sweeps!.rows;
    expect(sweep!.outcomes).toEqual({ unchanged: 1, actioned: 1, held: 0, escalated: 0, unmatched: 2, unopened: 0, unclassified: 0 });
    expect(sweep!.unresolved).toHaveLength(2);
    expect(sweep!.counts.unmatched).toBe(7);
    const bad = { ...files.sweep, threads: [...files.sweep.threads, { thread_key: 'raw thread title' }] };
    const refused = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', ['sweep_checkpoint'], { sweep_checkpoint: bad });
    expect(refused.batch.sweeps).toEqual({ read: 1, invalid: 1, rows: [] });
    expect(refused.invalid[0]!.issues[0]!.path).toMatch(/^threads\.4\./);
  });
});

describe('one mapping for the import and the creator:write MCP tools', () => {
  it('builds exactly the rows the MCP tools write from the same registry, queue and sweep', async () => {
    const files = syntheticRunnerFiles();
    const dir = await scratch();
    await writeRunnerFiles(dir, files);
    const read = await readCreatorRunnerDirectory(dir);
    if (!read.ok) throw new Error('synthetic runner files did not read');
    const { batch, invalid } = buildCreatorImport(ORG, '2026-09-09T06:14:00.000Z', read.files, read.content, read.sweepNotProduced);
    const registry = CreatorRunnerRegistry.parse(files.registry);
    const valid = registry.records.flatMap((raw) => { const parsed = CreatorRunnerRegistryRecord.safeParse(raw); return parsed.success ? [parsed.data] : []; });
    const seen = new Set<string>();
    const records = valid.filter((record) => !seen.has(record.creator_record_id) && seen.add(record.creator_record_id));
    const mapped = records.map(creatorRegistryRows);
    expect(mapped.map((rows) => rows.record)).toEqual(batch.records!.rows);
    expect(mapped.flatMap((rows) => rows.actions)).toEqual(batch.actions!.rows);
    // Registry lanes first, as the MCP tool writes them; list-mcf only confirms these.
    expect(mapped.flatMap((rows) => rows.lanes)).toEqual(batch.shipments!.rows.slice(0, mapped.flatMap((rows) => rows.lanes).length));
    const queue = CreatorRunnerQueueResult.parse(files.queue);
    const items = queue.items.flatMap((raw) => { const parsed = CreatorRunnerQueueItem.safeParse(raw); return parsed.success && parsed.data.run_date === queue.run_date ? [parsed.data] : []; });
    expect(creatorQueueRows(items)).toEqual(batch.queue!.rows);
    expect(batch.actions!.rows.length).toBeGreaterThan(0);
    expect(invalid.filter((entry) => entry.kind === 'action_log')).toEqual([]);
  });
});

describe('pre-flight results (WP-334, proposed preflight-results.json)', () => {
  const email = ['creator.synthetic', '@', 'example', '.test'].join('');
  const result = (runId: string, change: Record<string, unknown> = {}) => ({
    command: 'preflight', run_id: runId, started_at: '2026-09-09T06:31:02Z', completed_at: '2026-09-09T06:31:11Z',
    result: { result: 'HOLD', creator_record_id: 'CCR-SW-26-0151', computed_score: 10, errors: ['selected_sku_not_mcf_fulfillable'],
      required_next_state: 'Conflict or Held', quantity: 1, visible_fee_cents: null, approved_fee_cap_cents: 800, selected_asin: 'B0D7Q1V8LM',
      selected_sku: 'SW-DERMA-03-FBM', product_title: 'Synthetic roller', campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker:synthetic:row-118',
      recipient_binding: '', ...change },
    inventory: null, preview: null, reads: [],
  });

  it('maps valid entries like creators.preflight_result, and counts a drifted entry, contact data and a repeated run id as invalid by position', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'preflight-results.json'), JSON.stringify({ schema_version: 1, results: [result('preflight-0151-1'),
      result('preflight-0151-2', { errors: ['moon_phase_wrong'] }), result('preflight-0151-3', { product_title: `Roller ${email}` }), result('preflight-0151-1')] }));
    const read = await readCreatorRunnerDirectory(dir);
    expect(read).toMatchObject({ ok: true, files: ['preflight_results'], preflightsNotProduced: false });
    if (!read.ok) throw new Error('unreachable');
    const built = buildCreatorImport(ORG, '2026-09-09T06:40:00.000Z', read.files, read.content, read.sweepNotProduced, read.preflightsNotProduced);
    expect(built.batch.preflights).toMatchObject({ read: 4, invalid: 3 });
    expect(built.batch.preflights?.rows.map((row) => [row.runId, row.command, row.asin, row.result])).toEqual([['preflight-0151-1', 'preflight', 'B0D7Q1V8LM', 'HOLD']]);
    expect(built.invalid.map((entry) => [entry.kind, entry.index, entry.issues[0]?.code])).toEqual([
      ['preflights', 1, 'invalid_value'], ['preflights', 2, 'contact_data_email'], ['preflights', 3, 'duplicate']]);
    expect(JSON.stringify(built.invalid)).not.toContain(email);
    expect(built.batch.records).toBeNull();
  });

  it('counts a pre-flight file in another shape as not produced and still reads the runner files', async () => {
    const dir = await scratch();
    await writeRunnerFiles(dir, { registry: syntheticRunnerFiles().registry });
    await writeFile(join(dir, 'preflight-results.json'), JSON.stringify({ schema_version: 2, results: [] }));
    const read = await readCreatorRunnerDirectory(dir);
    expect(read).toMatchObject({ ok: true, files: ['registry', 'preflight_results'], preflightsNotProduced: true });
    if (!read.ok) throw new Error('unreachable');
    const built = buildCreatorImport(ORG, '2026-09-09T06:40:00.000Z', read.files, read.content, read.sweepNotProduced, read.preflightsNotProduced);
    expect(built.batch.preflights).toEqual({ read: 1, invalid: 1, rows: [] });
    expect(built.batch.records?.rows.length).toBeGreaterThan(0);
  });
});
