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
 *
 * Every record is validated; an invalid one is counted and skipped, and only its
 * position and the failing field paths are logged, never a value. A file that
 * cannot be read or whose envelope is wrong fails the whole run: nothing is
 * written and the failure is recorded, so the screens refuse rather than show an
 * older day as today's. Replays are idempotent. This command reads files only:
 * it never reads the tracker sheet, never needs the runner's HMAC key, and makes
 * no Amazon call.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CreatorRunnerActiveReservation, CreatorRunnerQueueItem, CreatorRunnerQueueResult, CreatorRunnerRegistry,
  CreatorRunnerRegistryRecord, CreatorRunnerReservationList, CreatorSweepCheckpoint, CreatorSweepThread, CreatorThreadOutcome, Uuid,
  type CreatorImportFailure, type CreatorImportFile, type CreatorImportKind, type CreatorImportRun, type CreatorRunnerSampleHistoryEntry,
  type CreatorRunnerReservationHistoryEntry,
} from '@wizard-ads/shared';
import { connectionStringFromEnv, createDb, type DbHandle } from '@wizard-ads/db';
import {
  persistCreatorImport, recordFailedCreatorImport, type CreatorActionWrite, type CreatorImportBatch, type CreatorImportSection,
  type CreatorQueueWrite, type CreatorRecordWrite, type CreatorShipmentWrite, type CreatorSweepWrite,
} from '@wizard-ads/db/worker';
import { installStopSignalHandlers } from './stop-signals.js';

const USAGE = 'usage: creators:import --dir <dir> --org-id <uuid> [--once] [--interval-seconds <n>]';
export const CREATOR_IMPORT_FILES = {
  registry: 'registry.json',
  queue: 'daily-queue.json',
  sweep_checkpoint: 'sweep-checkpoint.json',
  mcf_reservations: 'mcf-reservations.json',
} as const satisfies Record<CreatorImportFile, string>;
const FILE_ORDER = Object.keys(CREATOR_IMPORT_FILES) as CreatorImportFile[];
/** Unresolved thread detail kept per sweep; the counts keep the full number. */
const UNRESOLVED_LIMIT = 200;

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
  | { ok: true; files: CreatorImportFile[]; content: Partial<Record<CreatorImportFile, unknown>>; sweepNotProduced: boolean }
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
  const envelopes = {
    registry: CreatorRunnerRegistry, queue: CreatorRunnerQueueResult, sweep_checkpoint: CreatorSweepCheckpoint,
    mcf_reservations: CreatorRunnerReservationList,
  } as const;
  for (const file of files) {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(join(dir, CREATOR_IMPORT_FILES[file]), 'utf8')); }
    catch {
      if (file === 'sweep_checkpoint') { sweepNotProduced = true; continue; }
      return { ok: false, files, failure: 'file_unreadable', failedFile: file };
    }
    const parsed = envelopes[file].safeParse(raw);
    if (!parsed.success) {
      if (file === 'sweep_checkpoint') { sweepNotProduced = true; continue; }
      return { ok: false, files, failure: 'file_shape_invalid', failedFile: file };
    }
    content[file] = parsed.data;
  }
  return { ok: true, files, content, sweepNotProduced };
}

const nullable = (value: string) => value === '' ? null : value;
const upper = (value: string) => value.trim().toUpperCase();
/** `active_reservation_id` in creator_control.py, for a reservation written before ids existed. */
export function legacyReservationId(creatorRecordId: string, asin: string, reservedAt: string | undefined): string {
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const seed = [upper(normalized(creatorRecordId)), upper(normalized(asin)), normalized(reservedAt ?? '')].join('|');
  return `MCFR-LEGACY-${createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase()}`;
}
const newest = <T>(items: readonly T[], at: (item: T) => string) =>
  [...items].sort((left, right) => Date.parse(at(right)) - Date.parse(at(left)))[0];

interface Built { batch: CreatorImportBatch; invalid: CreatorInvalidRecord[] }

/** Map validated runner content to rows. Pure: no clock, no I/O. */
export function buildCreatorImport(orgId: string, startedAt: string, files: CreatorImportFile[],
  content: Partial<Record<CreatorImportFile, unknown>>, sweepNotProduced = false): Built {
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
  const valid: CreatorRunnerRegistryRecord[] = [];
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
      const record = parsed.data;
      valid.push(record);
      rows.push({
        creatorRecordId: record.creator_record_id, brand: record.brand, campaignId: record.campaign_id,
        fingerprints: { storefront: nullable(record.storefront_key), thread: nullable(record.thread_key), fullName: nullable(record.full_name_fp),
          email: nullable(record.email_fp), phone: nullable(record.phone_fp), address: nullable(record.address_fp) },
        recordState: record.record_state, lockState: record.lock_state, escalationReason: record.escalation_reason ?? null,
        runnerVersion: record.version, createdOn: record.created_at, lastVerifiedOn: record.last_verified_at ?? null,
      });
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
    for (const record of valid) {
      const id = record.creator_record_id;
      if (record.lock_state === 'Conflict') {
        derivedActions.push({ eventKey: `conflict:${id}:${record.version}`, creatorRecordId: id, action: 'identity_conflict_locked', occurredAt: null,
          reservationId: null, asin: null, reasonCode: record.escalation_reason ?? null, evidenceReference: null, recordVersion: record.version });
      }
      const byAsin = new Map<string, { history: CreatorRunnerSampleHistoryEntry[]; cancelled: CreatorRunnerReservationHistoryEntry[] }>();
      const bucket = (asin: string) => byAsin.get(asin) ?? byAsin.set(asin, { history: [], cancelled: [] }).get(asin)!;
      for (const entry of record.sample_history ?? []) {
        bucket(entry.asin).history.push(entry);
        derivedActions.push({ eventKey: `confirmed:${upper(entry.reservation_id)}`, creatorRecordId: id, action: 'sample_confirmed',
          occurredAt: entry.confirmed_at, reservationId: upper(entry.reservation_id), asin: entry.asin, reasonCode: null,
          evidenceReference: entry.evidence_reference, recordVersion: null });
      }
      for (const entry of record.mcf_reservation_history ?? []) {
        bucket(entry.asin).cancelled.push(entry);
        derivedActions.push({ eventKey: `cancelled:${upper(entry.reservation_id)}`, creatorRecordId: id, action: 'mcf_reservation_cancelled',
          occurredAt: entry.cancelled_at, reservationId: upper(entry.reservation_id), asin: entry.asin, reasonCode: entry.reason_code,
          evidenceReference: entry.evidence_reference, recordVersion: null });
      }
      const reservation = record.mcf_reservation;
      for (const [asin, { history, cancelled }] of byAsin) {
        if (reservation?.asin === asin) continue;
        const confirmed = newest(history, (entry) => entry.confirmed_at);
        const released = newest(cancelled, (entry) => entry.cancelled_at);
        const lane = confirmed ?? released!;
        lanes.set(`${id}|${asin}`, {
          creatorRecordId: id, asin, sku: lane.sku ?? null, campaignId: lane.campaign_id ?? null, reservationId: upper(lane.reservation_id),
          laneState: confirmed ? 'Confirmed' : 'Cancelled', runnerOrderId: confirmed?.order_id ?? null, feeCents: null, feeCapCents: null,
          reservedAt: null, verifiedAt: null, confirmedAt: confirmed?.confirmed_at ?? null, cancelledAt: confirmed ? null : released!.cancelled_at,
          cancellationReason: confirmed ? null : released!.reason_code, reconciliationReason: null,
        });
      }
      if (reservation) {
        const reservationId = reservation.reservation_id === undefined
          ? legacyReservationId(id, reservation.asin, reservation.reserved_at) : upper(reservation.reservation_id);
        if (reservation.reserved_at) {
          derivedActions.push({ eventKey: `reserved:${reservationId}`, creatorRecordId: id, action: 'mcf_reserved', occurredAt: reservation.reserved_at,
            reservationId, asin: reservation.asin, reasonCode: null, evidenceReference: reservation.preflight_evidence_reference ?? null, recordVersion: null });
        }
        if (reservation.verified_at) {
          derivedActions.push({ eventKey: `verified:${reservationId}:${reservation.verified_at}`, creatorRecordId: id, action: 'mcf_screen_verified',
            occurredAt: reservation.verified_at, reservationId, asin: reservation.asin, reasonCode: null,
            evidenceReference: reservation.verification_evidence_reference ?? null, recordVersion: null });
        }
        if (reservation.state === 'Reconciliation Required') {
          derivedActions.push({ eventKey: `reconciliation:${reservationId}`, creatorRecordId: id, action: 'mcf_reconciliation_required', occurredAt: null,
            reservationId, asin: reservation.asin, reasonCode: reservation.reconciliation_reason ?? null,
            evidenceReference: reservation.reconciliation_evidence_reference ?? null, recordVersion: record.version });
        }
        lanes.set(`${id}|${reservation.asin}`, {
          creatorRecordId: id, asin: reservation.asin, sku: reservation.sku ?? null, campaignId: reservation.campaign_id ?? null, reservationId,
          laneState: reservation.state ?? 'Reserved', runnerOrderId: null, feeCents: reservation.visible_fee_cents ?? null,
          feeCapCents: reservation.approved_fee_cap_cents ?? null, reservedAt: reservation.reserved_at ?? null, verifiedAt: reservation.verified_at ?? null,
          confirmedAt: null, cancelledAt: null, cancellationReason: null, reconciliationReason: reservation.reconciliation_reason ?? null,
        });
      }
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
    const rows: CreatorQueueWrite[] = [];
    const occurrences = new Map<string, number>();
    queue.items.forEach((raw, index) => {
      const parsed = CreatorRunnerQueueItem.safeParse(raw);
      if (!parsed.success || parsed.data.run_date !== queue.run_date) {
        invalid.push({ kind: 'queue_items', index, issues: parsed.success ? [{ path: 'run_date', code: 'other_run' }] : issuesOf(parsed.error) });
        return;
      }
      const item = parsed.data;
      const occurrence = (occurrences.get(item.queue_id) ?? 0) + 1;
      occurrences.set(item.queue_id, occurrence);
      rows.push({
        runDate: item.run_date, queueId: item.queue_id, occurrence, creatorRecordId: item.creator_record_id === 'UNRESOLVED' ? null : item.creator_record_id,
        brand: item.brand, campaignTab: item.campaign_tab, currentStatus: item.current_status, computedScore: item.computed_score, missing: item.missing,
        dueDate: item.due_date, actionType: item.action_type, gateResult: item.gate_result, queueState: item.queue_state, reason: item.reason,
      });
    });
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
      const outcomes = parsedThreads.length === 0 ? null : Object.fromEntries(CreatorThreadOutcome.options.map((outcome) =>
        [outcome, parsedThreads.filter((thread) => thread.outcome === outcome).length])) as Record<CreatorThreadOutcome, number>;
      const c = sweep.counts;
      sweeps = { read: 1, invalid: invalidOf('sweep_runs'), rows: [{
        runId: sweep.run_id, runDate: sweep.run_date, brand: sweep.brand, startedAt: sweep.started_at, completedAt: sweep.completed_at,
        counts: { mounted: c.mounted, opened: c.opened, changed: c.changed, messagesExamined: c.messages_examined, messagesSent: c.messages_sent,
          noActionAcknowledgements: c.no_action_acknowledgements, heldOrEscalated: c.held_or_escalated, archivedSpam: c.archived_spam, unmatched: c.unmatched },
        outcomes,
        unresolved: parsedThreads.filter((thread) => ['unmatched', 'unopened', 'unclassified'].includes(thread.outcome)).slice(0, UNRESOLVED_LIMIT)
          .map((thread) => ({ threadKey: thread.thread_key, amazonTimestamp: thread.amazon_timestamp, outcome: thread.outcome, reason: thread.reason })),
        evidenceReference: sweep.evidence_reference,
      }] };
    }
  }

  return {
    batch: { orgId, startedAt, source: 'control-runner', files, records, actions, queue: queueSection, sweeps, shipments },
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
  const built = buildCreatorImport(args.orgId, startedAt, read.files, read.content, read.sweepNotProduced);
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
