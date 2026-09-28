/**
 * `creators:import`: read the Creator Connections control runner's JSON outputs
 * from one directory and upsert them for one organisation.
 *
 *   pnpm --filter @wizard-ads/worker run creators:import -- --dir <dir> --org-id <uuid> [--once] [--interval-seconds <n>]
 *
 * Files, each optional, all under `--dir`:
 *   registry.json          `creator_control.py` registry cache (`new_registry` / `issue_record_id` shape)
 *   daily-queue.json       the `queue` command's output file
 *   sweep-checkpoint.json  the skill's per-client message-watermark checkpoint
 *   mcf-reservations.json  `list-mcf` output
 *   preflight-results.json the skill's `preflight` / `preflight-switch` results (proposed, WP-334)
 *
 * Every record is validated; an invalid one is counted and skipped, and only its
 * position and the failing field paths are logged, never a value. A file that
 * cannot be read or whose envelope is wrong fails the whole run: nothing is
 * written and the failure is recorded, so the screens refuse rather than show an
 * older day as today's. Replays are idempotent. This command reads files only:
 * it never reads the tracker sheet, never needs the runner's HMAC key, and makes
 * no Amazon call.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CreatorRunnerActiveReservation, CreatorRunnerQueueItem, CreatorRunnerQueueResult, CreatorRunnerRegistry,
  CreatorRunnerRegistryRecord, CreatorRunnerReservationList, CreatorSweepCheckpoint, CreatorSweepThread, Uuid,
  CreatorPreflightResultInput, CreatorPreflightResultsFile, findCreatorContactData,
  type CreatorImportFailure, type CreatorImportFile, type CreatorImportKind, type CreatorImportRun,
} from '@wizard-ads/shared';
import { connectionStringFromEnv, createDb, type DbHandle } from '@wizard-ads/db';
import {
  creatorPreflightRow, creatorQueueRows, creatorRegistryRows, creatorSweepRow, persistCreatorImport, recordFailedCreatorImport,
  type CreatorActionWrite, type CreatorPreflightWrite,
  type CreatorImportBatch, type CreatorImportSection, type CreatorRecordWrite, type CreatorRegistryRows, type CreatorShipmentWrite, type CreatorSweepWrite,
} from '@wizard-ads/db/worker';
/** The runner's legacy reservation id, shared with the creator:write MCP tools. */
export { legacyReservationId } from '@wizard-ads/db/worker';
import { installStopSignalHandlers } from './stop-signals.js';

const USAGE = 'usage: creators:import --dir <dir> --org-id <uuid> [--once] [--interval-seconds <n>]';
export const CREATOR_IMPORT_FILES = {
  registry: 'registry.json',
  queue: 'daily-queue.json',
  sweep_checkpoint: 'sweep-checkpoint.json',
  mcf_reservations: 'mcf-reservations.json',
  preflight_results: 'preflight-results.json',
} as const satisfies Record<CreatorImportFile, string>;
const FILE_ORDER = Object.keys(CREATOR_IMPORT_FILES) as CreatorImportFile[];

export interface CreatorsImportArgs { dir: string; orgId: string; once: boolean; intervalSeconds: number }

export function parseCreatorsImportArgs(args: readonly string[]): CreatorsImportArgs {
  const values = new Map<string, string>();
  let once = false;
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (key === '--') continue;
    if (key === '--once' && !once) { once = true; continue; }
    const value = args[index + 1];
    if (!['--dir', '--org-id', '--interval-seconds'].includes(key) || values.has(key) || value === undefined || value.startsWith('--')) {
      throw new Error(USAGE);
    }
    values.set(key, value);
    index++;
  }
  const dir = values.get('--dir')?.trim();
  if (!dir) throw new Error(USAGE);
  const orgId = Uuid.parse(values.get('--org-id'));
  const interval = values.get('--interval-seconds');
  if (interval !== undefined && once) throw new Error('--interval-seconds applies only without --once');
  const intervalSeconds = interval === undefined ? 300 : Number(interval);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30) throw new Error('--interval-seconds must be an integer of at least 30');
  return { dir, orgId, once, intervalSeconds };
}

/** Where a record failed, never what it held. */
export interface CreatorInvalidRecord { kind: CreatorImportKind; index: number; issues: { path: string; code: string }[] }
type Issues = { issues: readonly { path: readonly PropertyKey[]; code: string }[] };
const issuesOf = (error: Issues) => error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), code: issue.code }));

export type CreatorDirectoryRead =
  | { ok: true; files: CreatorImportFile[]; content: Partial<Record<CreatorImportFile, unknown>>; sweepNotProduced: boolean;
      preflightsNotProduced?: boolean }
  | { ok: false; files: CreatorImportFile[]; failure: CreatorImportFailure; failedFile: CreatorImportFile | null };

/**
 * Read and envelope-check the files present. An unreadable or malformed runner
 * file fails the whole read. The sweep checkpoint is a proposed contract nothing
 * produces yet, so a sweep file in another shape is counted as not produced and
 * skipped instead of refusing the runner's own files.
 */
export async function readCreatorRunnerDirectory(dir: string): Promise<CreatorDirectoryRead> {
  let entries: string[];
  try { entries = await readdir(dir); } catch { return { ok: false, files: [], failure: 'directory_unreadable', failedFile: null }; }
  const files = FILE_ORDER.filter((file) => entries.includes(CREATOR_IMPORT_FILES[file]));
  if (files.length === 0) return { ok: false, files, failure: 'no_runner_files', failedFile: null };
  const content: Partial<Record<CreatorImportFile, unknown>> = {};
  let sweepNotProduced = false;
  let preflightsNotProduced = false;
  const envelopes = {
    registry: CreatorRunnerRegistry, queue: CreatorRunnerQueueResult, sweep_checkpoint: CreatorSweepCheckpoint,
    mcf_reservations: CreatorRunnerReservationList, preflight_results: CreatorPreflightResultsFile,
  } as const;
  for (const file of files) {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(dir, CREATOR_IMPORT_FILES[file]), 'utf8')); }
    catch {
      if (file === 'sweep_checkpoint') { sweepNotProduced = true; continue; }
      if (file === 'preflight_results') { preflightsNotProduced = true; continue; }
      return { ok: false, files, failure: 'file_unreadable', failedFile: file };
    }
    const parsed = envelopes[file].safeParse(raw);
    if (!parsed.success) {
      if (file === 'sweep_checkpoint') { sweepNotProduced = true; continue; }
      if (file === 'preflight_results') { preflightsNotProduced = true; continue; }
      return { ok: false, files, failure: 'file_shape_invalid', failedFile: file };
    }
    content[file] = parsed.data;
  }
  return { ok: true, files, content, sweepNotProduced, preflightsNotProduced };
}

const nullable = (value: string) => value === '' ? null : value;
const upper = (value: string) => value.trim().toUpperCase();

interface Built { batch: CreatorImportBatch; invalid: CreatorInvalidRecord[] }

/** Map validated runner content to rows. Pure: no clock, no I/O. */
export function buildCreatorImport(orgId: string, startedAt: string, files: CreatorImportFile[],
  content: Partial<Record<CreatorImportFile, unknown>>, sweepNotProduced = false, preflightsNotProduced = false): Built {
  const invalid: CreatorInvalidRecord[] = [];
  /** Invalid counts come from the positions logged, independent of the rows kept. */
  const invalidOf = (kind: CreatorImportKind) => invalid.filter((entry) => entry.kind === kind).length;
  const registry = content.registry as CreatorRunnerRegistry | undefined;
  const queue = content.queue as CreatorRunnerQueueResult | undefined;
  const sweep = content.sweep_checkpoint as CreatorSweepCheckpoint | undefined;
  const listed = content.mcf_reservations as CreatorRunnerReservationList | undefined;

  let records: CreatorImportSection<CreatorRecordWrite> | null = null;
  let actions: CreatorImportSection<CreatorActionWrite> | null = null;
  let shipments: CreatorImportSection<CreatorShipmentWrite> | null = null;
  const valid: Extract<CreatorRegistryRows, { ok: true }>[] = [];
  if (registry) {
    const rows: CreatorRecordWrite[] = [];
    const seen = new Set<string>();
    registry.records.forEach((raw, index) => {
      const parsed = CreatorRunnerRegistryRecord.safeParse(raw);
      if (!parsed.success) { invalid.push({ kind: 'records', index, issues: issuesOf(parsed.error) }); return; }
      if (seen.has(parsed.data.creator_record_id)) {
        invalid.push({ kind: 'records', index, issues: [{ path: 'creator_record_id', code: 'duplicate' }] });
        return;
      }
      seen.add(parsed.data.creator_record_id);
      // A CCS key that is not this organisation's for the record and ASIN refuses the whole record.
      const derived = creatorRegistryRows(orgId, parsed.data);
      if (!derived.ok) { invalid.push({ kind: 'records', index, issues: derived.paths.map((path) => ({ path: path.join('.'), code: derived.reason })) }); return; }
      valid.push(derived);
      rows.push(derived.record);
    });
    records = { read: registry.records.length, invalid: invalidOf('records'), rows };
  }

  // Active reservations as `list-mcf` names them, including legacy ids.
  const listedRows: CreatorRunnerActiveReservation[] = [];
  const listedIndex = new Map<CreatorRunnerActiveReservation, number>();
  listed?.active_reservations.forEach((raw, index) => {
    const parsed = CreatorRunnerActiveReservation.safeParse(raw);
    if (parsed.success) { listedRows.push(parsed.data); listedIndex.set(parsed.data, index); }
    else invalid.push({ kind: 'sample_shipments', index, issues: issuesOf(parsed.error) });
  });

  if (registry || listed) {
    const derivedActions: CreatorActionWrite[] = [];
    const lanes = new Map<string, CreatorShipmentWrite>();
    // One mapping per record, shared with the creator:write MCP tools (packages/db creators-runner).
    for (const derived of valid) {
      derivedActions.push(...derived.actions);
      for (const lane of derived.lanes) lanes.set(`${derived.record.creatorRecordId}|${lane.asin}`, lane);
    }
    // Lanes formed from the registry, counted before `list-mcf` is folded in.
    const registryLanes = lanes.size;
    let agreed = 0;
    // `list-mcf` agrees with the registry or, without one, stands in for it.
    for (const entry of listedRows) {
      const index = listedIndex.get(entry)!;
      const key = `${entry.creator_record_id}|${entry.asin}`;
      const lane = lanes.get(key);
      if (registry) {
        const agrees = lane !== undefined && lane.reservationId === upper(entry.reservation_id)
          && ['Reserved', 'Verified for Submit', 'Reconciliation Required'].includes(lane.laneState);
        if (agrees) agreed++;
        else invalid.push({ kind: 'sample_shipments', index, issues: [{ path: 'reservation_id', code: 'not_in_registry' }] });
        continue;
      }
      lanes.set(key, {
        creatorRecordId: entry.creator_record_id, asin: entry.asin, sku: nullable(entry.sku), campaignId: entry.campaign_id,
        reservationId: upper(entry.reservation_id), laneState: entry.state === 'Legacy Reserved' ? 'Reserved' : entry.state, runnerOrderId: null,
        feeCents: null, feeCapCents: null, reservedAt: nullable(entry.reserved_at), verifiedAt: null, confirmedAt: null, cancelledAt: null,
        cancellationReason: null, reconciliationReason: null,
      });
    }
    const rows = [...lanes.values()];
    // Read = registry lanes plus every listed entry, less the listed entries that are the same lane as a registry one.
    const listedTotal = listed?.active_reservations.length ?? 0;
    shipments = { read: registryLanes + listedTotal - agreed, invalid: invalidOf('sample_shipments'), rows };
    if (registry) actions = { read: derivedActions.length, invalid: invalidOf('action_log'), rows: derivedActions };
  }

  let queueSection: CreatorImportBatch['queue'] = null;
  if (queue) {
    const items: CreatorRunnerQueueItem[] = [];
    queue.items.forEach((raw, index) => {
      const parsed = CreatorRunnerQueueItem.safeParse(raw);
      if (!parsed.success || parsed.data.run_date !== queue.run_date) {
        invalid.push({ kind: 'queue_items', index, issues: parsed.success ? [{ path: 'run_date', code: 'other_run' }] : issuesOf(parsed.error) });
        return;
      }
      items.push(parsed.data);
    });
    const rows = creatorQueueRows(items);
    queueSection = { runDate: queue.run_date, read: queue.items.length, invalid: invalidOf('queue_items'), rows };
  }

  let sweeps: CreatorImportSection<CreatorSweepWrite> | null = null;
  if (sweepNotProduced) {
    invalid.push({ kind: 'sweep_runs', index: 0, issues: [{ path: '', code: 'sweep_file_not_produced' }] });
    sweeps = { read: 1, invalid: invalidOf('sweep_runs'), rows: [] };
  } else if (sweep) {
    const threads = sweep.threads.map((raw) => CreatorSweepThread.safeParse(raw));
    const failed = threads.findIndex((result) => !result.success);
    if (failed >= 0) {
      invalid.push({ kind: 'sweep_runs', index: 0, issues: issuesOf(threads[failed]!.error!).map((issue) => ({ ...issue, path: `threads.${failed}.${issue.path}` })) });
      sweeps = { read: 1, invalid: invalidOf('sweep_runs'), rows: [] };
    } else {
      const parsedThreads = threads.map((result) => result.data!);
      sweeps = { read: 1, invalid: invalidOf('sweep_runs'), rows: [creatorSweepRow(sweep, parsedThreads)] };
    }
  }

  // Pre-flight results (proposed file): the same validation, contact-data refusal and mapping as `creators.preflight_result`.
  let preflights: CreatorImportSection<CreatorPreflightWrite> | null = null;
  const preflightFile = content.preflight_results as CreatorPreflightResultsFile | undefined;
  if (preflightsNotProduced) {
    invalid.push({ kind: 'preflights', index: 0, issues: [{ path: '', code: 'preflight_file_not_produced' }] });
    preflights = { read: 1, invalid: invalidOf('preflights'), rows: [] };
  } else if (preflightFile) {
    const rows: CreatorPreflightWrite[] = [];
    const runs = new Set<string>();
    preflightFile.results.forEach((raw, index) => {
      const contact = findCreatorContactData(raw);
      if (contact.length > 0) {
        invalid.push({ kind: 'preflights', index, issues: contact.map((hit) => ({ path: hit.path, code: `contact_data_${hit.shape}` })) });
        return;
      }
      const parsed = CreatorPreflightResultInput.safeParse(raw);
      if (!parsed.success) { invalid.push({ kind: 'preflights', index, issues: issuesOf(parsed.error) }); return; }
      if (runs.has(parsed.data.run_id)) { invalid.push({ kind: 'preflights', index, issues: [{ path: 'run_id', code: 'duplicate' }] }); return; }
      runs.add(parsed.data.run_id);
      rows.push(creatorPreflightRow(parsed.data));
    });
    preflights = { read: preflightFile.results.length, invalid: invalidOf('preflights'), rows };
  }

  return {
    batch: { orgId, startedAt, source: 'control-runner', files, records, actions, queue: queueSection, sweeps, shipments, preflights },
    invalid,
  };
}

/** One pass: read, build, write; a read failure is recorded as the latest import. */
export async function importCreatorDirectory(handle: DbHandle, args: Pick<CreatorsImportArgs, 'dir' | 'orgId'>,
  now: () => Date = () => new Date()): Promise<{ run: CreatorImportRun; invalid: CreatorInvalidRecord[] }> {
  const startedAt = now().toISOString();
  const read = await readCreatorRunnerDirectory(args.dir);
  if (!read.ok) {
    const run = await recordFailedCreatorImport(handle, { orgId: args.orgId, startedAt, source: 'control-runner', files: read.files,
      failure: read.failure, failedFile: read.failedFile });
    return { run, invalid: [] };
  }
  const built = buildCreatorImport(args.orgId, startedAt, read.files, read.content, read.sweepNotProduced, read.preflightsNotProduced === true);
  try {
    return { run: await persistCreatorImport(handle, built.batch), invalid: built.invalid };
  } catch (error) {
    await recordFailedCreatorImport(handle, { orgId: args.orgId, startedAt, source: 'control-runner', files: read.files,
      failure: 'database_write_failed', failedFile: null }).catch(() => undefined);
    throw error;
  }
}

export async function runCreatorsImport(argv: readonly string[], env = process.env, write = console.log,
  wait: (ms: number, stop: Promise<void>) => Promise<void> = (ms, stop) => Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms).unref()), stop])): Promise<number> {
  const args = parseCreatorsImportArgs(argv);
  const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1, statementTimeoutSeconds: 60 });
  let stopping = false;
  let signalStop: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { signalStop = resolve; });
  if (!args.once) installStopSignalHandlers(() => { stopping = true; signalStop(); }, { stopping: () => stopping });
  let lastStatus: CreatorImportRun['status'] | undefined;
  try {
    do {
      const { run, invalid } = await importCreatorDirectory(handle, args);
      write(JSON.stringify({ event: 'creators_import', status: run.status, failure: run.failure, failedFile: run.failedFile, files: run.files,
        queueRunDate: run.queueRunDate, counts: run.counts, invalid }));
      lastStatus = run.status;
      if (!args.once && !stopping) await wait(args.intervalSeconds * 1000, stopped);
    } while (!args.once && !stopping);
  } finally { await handle.close(); }
  // 0 when the last pass read and wrote; 2 when it recorded a refused read, as the runner holds with 2.
  return lastStatus === 'succeeded' ? 0 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCreatorsImport(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(error instanceof Error && error.message.startsWith('usage:') ? error.message
      : 'Creator Connections import failed. Check the directory, the organisation id and database access.');
    process.exitCode = 1;
  });
}
