/**
 * Creator Connections persistence (WP-332).
 *
 * The import writes what the control runner produced; the screens read it under
 * tenant RLS. Every write is keyed so a replay of the same files changes
 * nothing: registry, queue, sweep and shipment rows carry a digest of their
 * content and update only when it changes, and action-log events collide on
 * their event key. Counts are asserted, not assumed.
 *
 * Nothing here calls Amazon. The MCF status and package columns are left to a
 * later SP-API read and are never written by an import.
 */
import { createHash } from 'node:crypto';
import {
  CreatorImportRun, CreatorSampleShipment, CreatorSweepRun, CreatorDailyQueueItem, isRecognisedCreatorStatus,
  type CreatorActionLogEntry, type CreatorIdleGroup, type CreatorTrackerScore, type CreatorWriteCounts, type CreatorImportCounts, type CreatorImportFailure, type CreatorImportFile,
  type CreatorImportKind, type CreatorQueueSnapshot, type CreatorRecord, type CreatorSampleSnapshot,
  type CreatorSource, type CreatorSweepSnapshot,
} from '@wizard-ads/shared';
import type { DbHandle, QueryHandle, QuerySql } from '../client.js';
import { partitionCreatorPreflights, writeCreatorPreflights, type CreatorPreflightWrite } from './creators-samples.js';

export type CreatorRecordWrite = Omit<CreatorRecord, 'importedAt' | 'source' | 'status' | 'qualification' | 'qualifiedOn'>;
export type CreatorActionWrite = Omit<CreatorActionLogEntry, 'recordedAt' | 'source'>;
/** An action-log row with what a `creator:write` key or the web adds: the records it named and who asked. */
export type CreatorEventWrite = CreatorActionWrite & { relatedRecordIds?: readonly string[]; actorUserId?: string | null };
export type CreatorQueueWrite = Omit<CreatorDailyQueueItem, 'lockState' | 'source'>;
export type CreatorSweepWrite = Omit<CreatorSweepRun, 'reconciled' | 'importedAt' | 'source'>;
export type CreatorShipmentWrite = Omit<CreatorSampleShipment, 'derivedOrderKey' | 'mcf' | 'packages' | 'importedAt' | 'source'>;

/** One kind of row from one file: how many were read, how many failed validation, and the valid rows. */
export interface CreatorImportSection<Row> {
  read: number;
  invalid: number;
  rows: Row[];
}
export interface CreatorImportBatch {
  orgId: string;
  startedAt: string;
  source: CreatorSource;
  files: CreatorImportFile[];
  /** Null for a kind whose file was absent from the directory. */
  records: CreatorImportSection<CreatorRecordWrite> | null;
  actions: CreatorImportSection<CreatorActionWrite> | null;
  queue: (CreatorImportSection<CreatorQueueWrite> & { runDate: string }) | null;
  sweeps: CreatorImportSection<CreatorSweepWrite> | null;
  shipments: CreatorImportSection<CreatorShipmentWrite> | null;
  /** `preflight-results.json` (WP-334); optional, so a batch built before it existed stays valid. */
  preflights?: CreatorImportSection<CreatorPreflightWrite> | null;
}
export interface CreatorImportFailureInput {
  orgId: string;
  startedAt: string;
  source: CreatorSource;
  files: CreatorImportFile[];
  failure: CreatorImportFailure;
  failedFile: CreatorImportFile | null;
}

export class CreatorImportCountError extends Error {}

/** Stable content identity: key order cannot change a digest. */
export function creatorContentDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
      : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** The database's derivation, repeated here so tests can prove the two agree. */
export function creatorSampleOrderKey(orgId: string, creatorRecordId: string, asin: string): string {
  return `CCS-${createHash('sha256').update(`${orgId}|${creatorRecordId}|${asin}`).digest('hex').slice(0, 32)}`;
}

const KINDS = ['records', 'action_log', 'queue_items', 'sweep_runs', 'sample_shipments', 'preflights'] as const satisfies readonly CreatorImportKind[];
const nullCounts = (): Record<CreatorImportKind, CreatorImportCounts | null> =>
  Object.fromEntries(KINDS.map((kind) => [kind, null])) as Record<CreatorImportKind, CreatorImportCounts | null>;
const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();

function tally(kind: CreatorImportKind, section: CreatorImportSection<unknown>, written: { inserted: number; updated: number }, removed = 0): CreatorImportCounts {
  const valid = section.rows.length;
  const unchanged = valid - written.inserted - written.updated;
  if (section.read !== valid + section.invalid || unchanged < 0) {
    throw new CreatorImportCountError(`${kind}: read ${section.read}, valid ${valid}, invalid ${section.invalid}, written ${written.inserted + written.updated}`);
  }
  return { read: section.read, valid, invalid: section.invalid, inserted: written.inserted, updated: written.updated, unchanged, removed };
}

async function upsertRecords(sql: QuerySql, orgId: string, source: CreatorSource, rows: readonly CreatorRecordWrite[]) {
  let inserted = 0, updated = 0;
  for (const row of rows) {
    const f = row.fingerprints;
    const result = await sql<{ inserted: boolean }[]>`
      insert into public.creator_records(org_id, creator_record_id, brand, campaign_id, storefront_fp, thread_fp, full_name_fp,
        email_fp, phone_fp, address_fp, record_state, lock_state, escalation_reason, runner_version, created_on, last_verified_on,
        source, source_digest)
      values (${orgId}, ${row.creatorRecordId}, ${row.brand}, ${row.campaignId}, ${f.storefront}, ${f.thread}, ${f.fullName},
        ${f.email}, ${f.phone}, ${f.address}, ${row.recordState}, ${row.lockState}, ${row.escalationReason}, ${row.runnerVersion},
        ${row.createdOn}, ${row.lastVerifiedOn}, ${source}, ${creatorContentDigest(row)})
      on conflict (org_id, creator_record_id) do update set brand = excluded.brand, campaign_id = excluded.campaign_id,
        storefront_fp = excluded.storefront_fp, thread_fp = excluded.thread_fp, full_name_fp = excluded.full_name_fp,
        email_fp = excluded.email_fp, phone_fp = excluded.phone_fp, address_fp = excluded.address_fp,
        record_state = excluded.record_state, lock_state = excluded.lock_state, escalation_reason = excluded.escalation_reason,
        runner_version = excluded.runner_version, created_on = excluded.created_on, last_verified_on = excluded.last_verified_on,
        source = excluded.source, source_digest = excluded.source_digest, imported_at = now(), updated_at = now()
      where creator_records.source_digest is distinct from excluded.source_digest
        -- The runner bumps a record's version on every change; an older row never overwrites a newer one.
        and excluded.runner_version >= creator_records.runner_version
      returning (xmax = 0) as inserted`;
    if (result.length === 1) { if (result[0]!.inserted) inserted++; else updated++; }
  }
  return { inserted, updated };
}

/** The newest queue run's view of each registered record: status and the computed gate. */
async function applyQualifications(sql: QuerySql, orgId: string, runDate: string, rows: readonly CreatorQueueWrite[]) {
  for (const row of rows) {
    if (row.creatorRecordId === null) continue;
    await sql`update public.creator_records set status = ${row.currentStatus}, computed_score = ${row.computedScore},
        missing_checks = ${row.missing}::text[], qualified_on = ${runDate}, updated_at = now()
      where org_id = ${orgId} and creator_record_id = ${row.creatorRecordId}
        and (qualified_on is null or qualified_on <= ${runDate}::date)
        and (status, computed_score, missing_checks, qualified_on) is distinct from
          (${row.currentStatus}::text, ${row.computedScore}::smallint, ${row.missing}::text[], ${runDate}::date)`;
  }
}

async function insertActions(sql: QuerySql, orgId: string, source: CreatorSource, rows: readonly CreatorEventWrite[]) {
  let inserted = 0;
  for (const row of rows) {
    const result = await sql`
      insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reservation_id, asin,
        reason_code, evidence_reference, record_version, source, related_record_ids, actor_user_id)
      values (${orgId}, ${row.eventKey}, ${row.creatorRecordId}, ${row.action}, ${row.occurredAt}, ${row.reservationId}, ${row.asin},
        ${row.reasonCode}, ${row.evidenceReference}, ${row.recordVersion}, ${source}, ${[...(row.relatedRecordIds ?? [])]}::text[],
        ${row.actorUserId ?? null})
      on conflict (org_id, event_key) do nothing returning id`;
    inserted += result.length;
  }
  return { inserted, updated: 0 };
}

async function replaceQueueDay(sql: QuerySql, orgId: string, source: CreatorSource, runDate: string, rows: readonly CreatorQueueWrite[]) {
  let inserted = 0, updated = 0;
  for (const row of rows) {
    if (row.runDate !== runDate) throw new CreatorImportCountError(`queue item ${row.queueId} is not from ${runDate}`);
    const result = await sql<{ inserted: boolean }[]>`
      insert into public.creator_daily_queue(org_id, run_date, queue_id, occurrence, creator_record_id, brand, campaign_tab,
        current_status, computed_score, missing_checks, due_date, action_type, gate_result, queue_state, reason, source, source_digest)
      values (${orgId}, ${row.runDate}, ${row.queueId}, ${row.occurrence}, ${row.creatorRecordId}, ${row.brand}, ${row.campaignTab},
        ${row.currentStatus}, ${row.computedScore}, ${row.missing}::text[], ${row.dueDate}, ${row.actionType}, ${row.gateResult},
        ${row.queueState}, ${row.reason}, ${source}, ${creatorContentDigest(row)})
      on conflict (org_id, run_date, queue_id, occurrence) do update set creator_record_id = excluded.creator_record_id,
        brand = excluded.brand, campaign_tab = excluded.campaign_tab, current_status = excluded.current_status,
        computed_score = excluded.computed_score, missing_checks = excluded.missing_checks, due_date = excluded.due_date,
        action_type = excluded.action_type, gate_result = excluded.gate_result, queue_state = excluded.queue_state,
        reason = excluded.reason, source = excluded.source, source_digest = excluded.source_digest, imported_at = now(), updated_at = now()
      where creator_daily_queue.source_digest is distinct from excluded.source_digest
      returning (xmax = 0) as inserted`;
    if (result.length === 1) { if (result[0]!.inserted) inserted++; else updated++; }
  }
  const keep = rows.map((row) => `${row.queueId}#${row.occurrence}`);
  const removed = await sql`delete from public.creator_daily_queue where org_id = ${orgId} and run_date = ${runDate}
    and not (queue_id || '#' || occurrence::text = any(${keep}::text[])) returning queue_id`;
  return { inserted, updated, removed: removed.length };
}

async function upsertSweeps(sql: QuerySql, orgId: string, source: CreatorSource, rows: readonly CreatorSweepWrite[]) {
  let inserted = 0, updated = 0;
  for (const row of rows) {
    const c = row.counts;
    const result = await sql<{ inserted: boolean }[]>`
      insert into public.creator_sweep_runs(org_id, run_id, run_date, brand, started_at, completed_at, mounted, opened, changed,
        messages_examined, messages_sent, no_action_acknowledgements, held_or_escalated, archived_spam, unmatched, outcomes,
        unresolved_threads, evidence_reference, source, source_digest)
      values (${orgId}, ${row.runId}, ${row.runDate}, ${row.brand}, ${row.startedAt}, ${row.completedAt}, ${c.mounted}, ${c.opened},
        ${c.changed}, ${c.messagesExamined}, ${c.messagesSent}, ${c.noActionAcknowledgements}, ${c.heldOrEscalated}, ${c.archivedSpam},
        ${c.unmatched}, ${row.outcomes === null ? null : JSON.stringify(row.outcomes)}::jsonb, ${JSON.stringify(row.unresolved)}::jsonb, ${row.evidenceReference},
        ${source}, ${creatorContentDigest(row)})
      on conflict (org_id, run_id) do update set run_date = excluded.run_date, brand = excluded.brand, started_at = excluded.started_at,
        completed_at = excluded.completed_at, mounted = excluded.mounted, opened = excluded.opened, changed = excluded.changed,
        messages_examined = excluded.messages_examined, messages_sent = excluded.messages_sent,
        no_action_acknowledgements = excluded.no_action_acknowledgements, held_or_escalated = excluded.held_or_escalated,
        archived_spam = excluded.archived_spam, unmatched = excluded.unmatched, outcomes = excluded.outcomes,
        unresolved_threads = excluded.unresolved_threads, evidence_reference = excluded.evidence_reference,
        source = excluded.source, source_digest = excluded.source_digest, imported_at = now(), updated_at = now()
      where creator_sweep_runs.source_digest is distinct from excluded.source_digest
      returning (xmax = 0) as inserted`;
    if (result.length === 1) { if (result[0]!.inserted) inserted++; else updated++; }
  }
  return { inserted, updated };
}

async function upsertShipments(sql: QuerySql, orgId: string, source: CreatorSource, rows: readonly CreatorShipmentWrite[]) {
  let inserted = 0, updated = 0;
  for (const row of rows) {
    const result = await sql<{ inserted: boolean }[]>`
      insert into public.creator_sample_shipments(org_id, creator_record_id, asin, sku, campaign_id, reservation_id, lane_state,
        runner_order_id, fee_cents, fee_cap_cents, reserved_at, verified_at, confirmed_at, cancelled_at, cancellation_reason,
        reconciliation_reason, source, source_digest)
      values (${orgId}, ${row.creatorRecordId}, ${row.asin}, ${row.sku}, ${row.campaignId}, ${row.reservationId}, ${row.laneState},
        ${row.runnerOrderId}, ${row.feeCents}, ${row.feeCapCents}, ${row.reservedAt}, ${row.verifiedAt}, ${row.confirmedAt},
        ${row.cancelledAt}, ${row.cancellationReason}, ${row.reconciliationReason}, ${source}, ${creatorContentDigest(row)})
      on conflict (org_id, creator_record_id, asin) do update set sku = excluded.sku, campaign_id = excluded.campaign_id,
        reservation_id = excluded.reservation_id, lane_state = excluded.lane_state, runner_order_id = excluded.runner_order_id,
        -- A confirmed or cancelled history entry carries no fee or reservation times; keep what the reservation recorded.
        fee_cents = coalesce(excluded.fee_cents, creator_sample_shipments.fee_cents),
        fee_cap_cents = coalesce(excluded.fee_cap_cents, creator_sample_shipments.fee_cap_cents),
        reserved_at = coalesce(excluded.reserved_at, creator_sample_shipments.reserved_at),
        verified_at = coalesce(excluded.verified_at, creator_sample_shipments.verified_at),
        confirmed_at = excluded.confirmed_at, cancelled_at = excluded.cancelled_at,
        cancellation_reason = excluded.cancellation_reason, reconciliation_reason = excluded.reconciliation_reason,
        source = excluded.source, source_digest = excluded.source_digest, imported_at = now(), updated_at = now()
      where creator_sample_shipments.source_digest is distinct from excluded.source_digest
      returning (xmax = 0) as inserted`;
    if (result.length === 1) { if (result[0]!.inserted) inserted++; else updated++; }
  }
  return { inserted, updated };
}

interface ImportRunRow {
  id: string; started_at: Date; finished_at: Date; status: string; failure: string | null; failed_file: string | null;
  files: string[]; queue_run_date: string | null; counts: unknown; source: string;
}
function importRun(row: ImportRunRow): CreatorImportRun {
  return CreatorImportRun.parse({
    id: row.id, startedAt: iso(row.started_at), finishedAt: iso(row.finished_at), status: row.status, failure: row.failure,
    failedFile: row.failed_file, files: row.files, queueRunDate: row.queue_run_date, counts: row.counts, source: row.source,
  });
}

/**
 * Write one import atomically and record its counters. Either every section and
 * the run row commit, or nothing does.
 */
export async function persistCreatorImport(handle: DbHandle, batch: CreatorImportBatch): Promise<CreatorImportRun> {
  return handle.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`creators-import:${batch.orgId}`}, 0))`;
    const counts = nullCounts();
    if (batch.records) counts.records = tally('records', batch.records, await upsertRecords(sql, batch.orgId, batch.source, batch.records.rows));
    if (batch.actions) counts.action_log = tally('action_log', batch.actions, await insertActions(sql, batch.orgId, batch.source, batch.actions.rows));
    if (batch.queue) {
      const written = await replaceQueueDay(sql, batch.orgId, batch.source, batch.queue.runDate, batch.queue.rows);
      counts.queue_items = tally('queue_items', batch.queue, written, written.removed);
      await applyQualifications(sql, batch.orgId, batch.queue.runDate, batch.queue.rows);
    }
    if (batch.sweeps) counts.sweep_runs = tally('sweep_runs', batch.sweeps, await upsertSweeps(sql, batch.orgId, batch.source, batch.sweeps.rows));
    if (batch.shipments) counts.sample_shipments = tally('sample_shipments', batch.shipments, await upsertShipments(sql, batch.orgId, batch.source, batch.shipments.rows));
    if (batch.preflights) {
      // A pre-flight for an unregistered record, or a run id held with another result, is counted invalid, not fatal.
      const { writable, refused } = await partitionCreatorPreflights(sql, batch.orgId, batch.preflights.rows);
      const { inserted, updated } = await writeCreatorPreflights(sql, batch.orgId, batch.source, writable, null);
      counts.preflights = tally('preflights', { read: batch.preflights.read, invalid: batch.preflights.invalid + refused.length, rows: writable },
        { inserted, updated });
    }
    const [row] = await sql<ImportRunRow[]>`
      insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, queue_run_date, counts, source)
      values (${batch.orgId}, ${batch.startedAt}, clock_timestamp(), 'succeeded', ${batch.files}::text[], ${batch.queue?.runDate ?? null},
        ${JSON.stringify(counts)}::jsonb, ${batch.source})
      returning id, started_at, finished_at, status, failure, failed_file, files, queue_run_date::text as queue_run_date, counts, source`;
    return importRun(row!);
  });
}

/** What a `creator:write` MCP call writes: any of the import's row kinds, validated and mapped by the caller. */
export interface CreatorMcpRows {
  records?: readonly CreatorRecordWrite[];
  actions?: readonly CreatorEventWrite[];
  queue?: { runDate: string; rows: readonly CreatorQueueWrite[] };
  sweeps?: readonly CreatorSweepWrite[];
  shipments?: readonly CreatorShipmentWrite[];
}
export type CreatorMcpWriteCounts = Partial<Record<'records' | 'action_log' | 'queue_items' | 'sweep_runs' | 'sample_shipments', CreatorWriteCounts & { removed?: number }>>;

const writeCounts = (read: number, written: { inserted: number; updated: number }): CreatorWriteCounts => {
  const unchanged = read - written.inserted - written.updated;
  if (unchanged < 0) throw new CreatorImportCountError(`wrote ${written.inserted + written.updated} of ${read} rows`);
  return { read, inserted: written.inserted, updated: written.updated, unchanged };
};

/**
 * Write rows a `creator:write` key submitted, inside the caller's authenticated
 * transaction, through the same upserts, keys and content digests as the file
 * import: a row the import already wrote is unchanged, and so is a replay.
 * It records no import run. The MCP audit row is the record of the call, and the
 * screens' "last read" stays the control runner's.
 */
export async function writeCreatorMcpRows(sql: QuerySql, orgId: string, rows: CreatorMcpRows): Promise<CreatorMcpWriteCounts> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`creators-import:${orgId}`}, 0))`;
  const counts: CreatorMcpWriteCounts = {};
  if (rows.records) counts.records = writeCounts(rows.records.length, await upsertRecords(sql, orgId, 'mcp', rows.records));
  if (rows.actions) counts.action_log = writeCounts(rows.actions.length, await insertActions(sql, orgId, 'mcp', rows.actions));
  if (rows.queue) {
    const written = await replaceQueueDay(sql, orgId, 'mcp', rows.queue.runDate, rows.queue.rows);
    counts.queue_items = { ...writeCounts(rows.queue.rows.length, written), removed: written.removed };
    await applyQualifications(sql, orgId, rows.queue.runDate, rows.queue.rows);
  }
  if (rows.sweeps) counts.sweep_runs = writeCounts(rows.sweeps.length, await upsertSweeps(sql, orgId, 'mcp', rows.sweeps));
  if (rows.shipments) counts.sample_shipments = writeCounts(rows.shipments.length, await upsertShipments(sql, orgId, 'mcp', rows.shipments));
  return counts;
}

/** Record that nothing was read. The previous rows stay; the screens refuse to present them as today's. */
export async function recordFailedCreatorImport(handle: DbHandle, input: CreatorImportFailureInput): Promise<CreatorImportRun> {
  const [row] = await handle.sql<ImportRunRow[]>`
    insert into public.creator_import_runs(org_id, started_at, finished_at, status, failure, failed_file, files, counts, source)
    values (${input.orgId}, ${input.startedAt}, clock_timestamp(), 'failed', ${input.failure}, ${input.failedFile}, ${input.files}::text[],
      ${JSON.stringify(nullCounts())}::jsonb, ${input.source})
    returning id, started_at, finished_at, status, failure, failed_file, files, queue_run_date::text as queue_run_date, counts, source`;
  return importRun(row!);
}

export async function readLatestCreatorImport(handle: QueryHandle, orgId: string): Promise<CreatorImportRun | null> {
  const [row] = await handle.sql<ImportRunRow[]>`select id, started_at, finished_at, status, failure, failed_file, files, queue_run_date::text as queue_run_date, counts, source from public.creator_import_runs
    where org_id = ${orgId} order by finished_at desc, started_at desc limit 1`;
  return row === undefined ? null : importRun(row);
}

interface SweepRow {
  run_id: string; run_date: string; brand: string | null; started_at: Date | null; completed_at: Date; mounted: number; opened: number;
  changed: number; messages_examined: number; messages_sent: number; no_action_acknowledgements: number; held_or_escalated: number;
  archived_spam: number; unmatched: number; reconciled: boolean; outcomes: unknown; unresolved_threads: unknown;
  evidence_reference: string | null; source: string; imported_at: Date;
}
function sweepRun(row: SweepRow): CreatorSweepRun {
  return CreatorSweepRun.parse({
    runId: row.run_id, runDate: row.run_date, brand: row.brand, startedAt: iso(row.started_at), completedAt: iso(row.completed_at),
    counts: { mounted: row.mounted, opened: row.opened, changed: row.changed, messagesExamined: row.messages_examined,
      messagesSent: row.messages_sent, noActionAcknowledgements: row.no_action_acknowledgements, heldOrEscalated: row.held_or_escalated,
      archivedSpam: row.archived_spam, unmatched: row.unmatched },
    reconciled: row.reconciled, outcomes: row.outcomes, unresolved: row.unresolved_threads, evidenceReference: row.evidence_reference,
    source: row.source, importedAt: iso(row.imported_at),
  });
}
async function readSweeps(handle: QueryHandle, orgId: string, limit: number): Promise<CreatorSweepRun[]> {
  const rows = await handle.sql<SweepRow[]>`select run_id, run_date::text as run_date, brand, started_at, completed_at, mounted, opened,
      changed, messages_examined, messages_sent, no_action_acknowledgements, held_or_escalated, archived_spam, unmatched, reconciled,
      outcomes, unresolved_threads, evidence_reference, source, imported_at
    from public.creator_sweep_runs where org_id = ${orgId} order by completed_at desc, run_id desc limit ${limit}`;
  return rows.map(sweepRun);
}

/** `/creators`: the newest queue day, every item on it with its record's lock, and the newest sweep. */
export async function readCreatorQueue(handle: QueryHandle, orgId: string): Promise<CreatorQueueSnapshot> {
  const lastImport = await readLatestCreatorImport(handle, orgId);
  const [day] = await handle.sql<{ run_date: string | null }[]>`select greatest(
      (select max(queue_run_date) from public.creator_import_runs where org_id = ${orgId} and status = 'succeeded'),
      (select max(run_date) from public.creator_daily_queue where org_id = ${orgId}))::text as run_date`;
  const runDate = day?.run_date ?? null;
  const rows = runDate === null ? [] : await handle.sql<Record<string, unknown>[]>`
    select q.run_date::text as "runDate", q.queue_id as "queueId", q.occurrence, q.creator_record_id as "creatorRecordId",
      q.brand, q.campaign_tab as "campaignTab", q.current_status as "currentStatus", q.computed_score as "computedScore",
      q.missing_checks as missing, q.due_date::text as "dueDate", q.action_type as "actionType", q.gate_result as "gateResult",
      q.queue_state as "queueState", q.reason, r.lock_state as "lockState", q.source
    from public.creator_daily_queue q
    left join public.creator_records r on r.org_id = q.org_id and r.creator_record_id = q.creator_record_id
    where q.org_id = ${orgId} and q.run_date = ${runDate}::date
    order by q.queue_id, q.occurrence`;
  const items = rows.map((row) => CreatorDailyQueueItem.parse(row));
  if (items.length !== rows.length) throw new CreatorImportCountError('Creator queue read count mismatch');
  const [registry] = await handle.sql<{ count: number }[]>`select count(*)::int as count from public.creator_records where org_id = ${orgId}`;
  const [sweep] = await readSweeps(handle, orgId, 1);
  const named = [...new Set(items.flatMap((item) => item.creatorRecordId === null ? [] : [item.creatorRecordId]))];
  const trackerScores: CreatorTrackerScore[] = named.length === 0 ? [] : (await handle.sql<{ id: string; score: number; on: string }[]>`
    select creator_record_id as id, tracker_score as score, tracker_scored_on::text as on from public.creator_records
    where org_id = ${orgId} and creator_record_id = any(${named}::text[]) and tracker_score is not null order by creator_record_id`)
    .map((row) => ({ creatorRecordId: row.id, trackerScore: row.score, scoredOn: row.on }));
  // Records the run did not name, by the status last reported for them. Without a run nothing is "idle".
  const idle: CreatorIdleGroup[] = runDate === null ? [] : (await handle.sql<{ status: string | null; records: number }[]>`
    select status, count(*)::int as records from public.creator_records
    where org_id = ${orgId} and not (creator_record_id = any(${named}::text[]))
    group by status order by count(*) desc, status nulls last`)
    .map((row) => ({ status: row.status, recognised: row.status === null ? null : isRecognisedCreatorStatus(row.status), records: row.records }));
  return { lastImport, runDate, items, registryRecords: registry?.count ?? 0, sweep: sweep ?? null, trackerScores, idle };
}

/** `/creators/sweep`: the newest sweep and the one before it, for comparison. */
export async function readCreatorSweeps(handle: QueryHandle, orgId: string): Promise<CreatorSweepSnapshot> {
  const [latest, previous] = await readSweeps(handle, orgId, 2);
  return { lastImport: await readLatestCreatorImport(handle, orgId), latest: latest ?? null, previous: previous ?? null };
}

export interface ShipmentRow {
  creator_record_id: string; asin: string; derived_order_key: string; sku: string | null; campaign_id: string | null;
  reservation_id: string | null; lane_state: string; runner_order_id: string | null; fee_cents: number | null; fee_cap_cents: number | null;
  reserved_at: Date | null; verified_at: Date | null; confirmed_at: Date | null; cancelled_at: Date | null;
  cancellation_reason: string | null; reconciliation_reason: string | null; mcf_status: string | null; mcf_operation: string | null;
  mcf_read_at: Date | null; packages: unknown; source: string; imported_at: Date;
}
/** `/creators/samples`: every lane, newest activity first. */
export async function readCreatorSampleShipments(handle: QueryHandle, orgId: string): Promise<CreatorSampleSnapshot> {
  const rows = await handle.sql<ShipmentRow[]>`select creator_record_id, asin, derived_order_key, sku, campaign_id, reservation_id,
      lane_state, runner_order_id, fee_cents, fee_cap_cents, reserved_at, verified_at, confirmed_at, cancelled_at, cancellation_reason,
      reconciliation_reason, mcf_status, mcf_operation, mcf_read_at, packages, source, imported_at
    from public.creator_sample_shipments where org_id = ${orgId}
    order by greatest(mcf_read_at, confirmed_at, cancelled_at, verified_at, reserved_at, imported_at) desc, creator_record_id, asin`;
  const shipments = rows.map(creatorShipmentFromRow);
  if (shipments.length !== rows.length) throw new CreatorImportCountError('Creator shipment read count mismatch');
  return { lastImport: await readLatestCreatorImport(handle, orgId), shipments };
}

/** One `creator_sample_shipments` row as the screens read it. */
export function creatorShipmentFromRow(row: ShipmentRow): CreatorSampleShipment {
  return CreatorSampleShipment.parse({
    creatorRecordId: row.creator_record_id, asin: row.asin, derivedOrderKey: row.derived_order_key, sku: row.sku,
    campaignId: row.campaign_id, reservationId: row.reservation_id, laneState: row.lane_state, runnerOrderId: row.runner_order_id,
    feeCents: row.fee_cents, feeCapCents: row.fee_cap_cents, reservedAt: iso(row.reserved_at), verifiedAt: iso(row.verified_at),
    confirmedAt: iso(row.confirmed_at), cancelledAt: iso(row.cancelled_at), cancellationReason: row.cancellation_reason,
    reconciliationReason: row.reconciliation_reason,
    mcf: row.mcf_status === null ? null : { status: row.mcf_status, operation: row.mcf_operation, readAt: iso(row.mcf_read_at) },
    packages: row.packages, source: row.source, importedAt: iso(row.imported_at),
  });
}
