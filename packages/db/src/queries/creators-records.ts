/**
 * Creator Connections round 2 (WP-333): one record, one conflict, reply drafts,
 * and the score a `creator:write` key reports.
 *
 * A draft is text an operator sends by hand. Approving one changes its status
 * and appends an action-log entry (a trigger does both in one statement); it
 * enqueues nothing and sends nothing. Nothing here calls Amazon.
 */
import {
  CreatorDraft, CreatorRecord, CreatorRecordEvent, CreatorDailyQueueItem, OrgActor, type McpKeyMetadata,
  type CreatorConflictDetail, type CreatorDraftRow, type CreatorDraftsSnapshot, type CreatorDraftStatus, type CreatorFingerprintClass,
  type CreatorIdentityDecision, type CreatorRecordDetail, type CreatorRecordScoreInput, type CreatorRefusedCandidate,
  type CreatorSubmitDraftInput, type CreatorWriteCounts,
} from '@wizard-ads/shared';
import type { DbHandle, QueryHandle, QuerySql } from '../client.js';
import { AgencyAccessDenied, withAuthenticatedActor } from './authenticated-actor.js';
import { creatorContentDigest, creatorShipmentFromRow, readLatestCreatorImport, type ShipmentRow } from './creators.js';
import { McpKeyCommandError } from './mcp-key-commands.js';
import { listMcpKeyMetadata } from './mcp-key-metadata.js';

/** A write the rules refuse. The code is safe to show a caller; no value is echoed. */
export type CreatorWriteRefusalCode =
  | 'record_not_found' | 'record_conflict_locked' | 'thread_mismatch' | 'approved_draft_open' | 'event_key_reused'
  | 'draft_not_found' | 'transition_refused' | 'older_than_held' | 'run_id_reused' | 'lane_not_found';
export class CreatorWriteRefusal extends Error {
  constructor(readonly code: CreatorWriteRefusalCode, message: string) {
    super(message);
    this.name = 'CreatorWriteRefusal';
  }
}

const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();

interface RecordRow {
  creator_record_id: string; brand: string; campaign_id: string; storefront_fp: string | null; thread_fp: string | null;
  full_name_fp: string | null; email_fp: string | null; phone_fp: string | null; address_fp: string | null; record_state: string;
  lock_state: string; escalation_reason: string | null; runner_version: number; created_on: string; last_verified_on: string | null;
  status: string | null; computed_score: number | null; missing_checks: string[] | null; qualified_on: string | null;
  tracker_score: number | null; tracker_scored_on: string | null; source: string; imported_at: Date;
}
const RECORD_COLUMNS = `creator_record_id, brand, campaign_id, storefront_fp, thread_fp, full_name_fp, email_fp, phone_fp, address_fp,
  record_state, lock_state, escalation_reason, runner_version, created_on::text as created_on, last_verified_on::text as last_verified_on,
  status, computed_score, missing_checks, qualified_on::text as qualified_on, tracker_score, tracker_scored_on::text as tracker_scored_on,
  source, imported_at`;

function recordFromRow(row: RecordRow): CreatorRecord {
  const missing = row.missing_checks;
  return CreatorRecord.parse({
    creatorRecordId: row.creator_record_id, brand: row.brand, campaignId: row.campaign_id,
    fingerprints: { storefront: row.storefront_fp, thread: row.thread_fp, fullName: row.full_name_fp, email: row.email_fp,
      phone: row.phone_fp, address: row.address_fp },
    recordState: row.record_state, lockState: row.lock_state, escalationReason: row.escalation_reason, runnerVersion: row.runner_version,
    createdOn: row.created_on, lastVerifiedOn: row.last_verified_on, status: row.status,
    qualification: row.computed_score === null || missing === null ? null : {
      score: row.computed_score,
      checks: Object.fromEntries(['complete_fulfillment_details', 'requested_asin', 'exact_product_match', 'storefront_visible',
        'recent_post_verified', 'content_quality', 'category_fit', 'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk']
        .map((check) => [check, !missing.includes(check)])),
      missing,
    },
    qualifiedOn: row.qualified_on, source: row.source, importedAt: iso(row.imported_at),
  });
}

async function readRecordRows(sql: QuerySql, orgId: string, ids: readonly string[]): Promise<RecordRow[]> {
  if (ids.length === 0) return [];
  return sql<RecordRow[]>`select ${sql.unsafe(RECORD_COLUMNS)} from public.creator_records
    where org_id = ${orgId} and creator_record_id = any(${[...ids]}::text[]) order by creator_record_id`;
}

interface EventRow {
  event_key: string; creator_record_id: string; action: string; occurred_at: Date | null; recorded_at: Date; reservation_id: string | null;
  asin: string | null; reason_code: string | null; evidence_reference: string | null; record_version: number | null;
  related_record_ids: string[]; draft_id: string | null; actor_user_id: string | null; source: string;
}
const eventFromRow = (row: EventRow): CreatorRecordEvent => CreatorRecordEvent.parse({
  eventKey: row.event_key, action: row.action, occurredAt: iso(row.occurred_at), recordedAt: iso(row.recorded_at),
  reservationId: row.reservation_id, asin: row.asin, reasonCode: row.reason_code, evidenceReference: row.evidence_reference,
  recordVersion: row.record_version, relatedRecordIds: row.related_record_ids, draftId: row.draft_id, actorUserId: row.actor_user_id,
  source: row.source,
});
async function readEvents(sql: QuerySql, orgId: string, ids: readonly string[], actions: readonly string[] | null, limit: number) {
  return sql<EventRow[]>`select event_key, creator_record_id, action, occurred_at, recorded_at, reservation_id, asin, reason_code,
      evidence_reference, record_version, related_record_ids, draft_id, actor_user_id, source
    from public.creator_action_log
    where org_id = ${orgId} and creator_record_id = any(${[...ids]}::text[])
      and (${actions === null}::boolean or action = any(${[...(actions ?? [])]}::text[]))
    order by coalesce(occurred_at, recorded_at) desc, recorded_at desc, event_key limit ${limit}`;
}

interface DraftRowDb {
  id: string; creator_record_id: string; thread_fp: string; template_key: string; body: string; draft_date: string; status: string;
  created_by: string | null; created_at: Date; approved_by: string | null; approved_at: Date | null; closed_by: string | null;
  closed_at: Date | null; source: string;
}
const DRAFT_COLUMNS = `id, creator_record_id, thread_fp, template_key, body, draft_date::text as draft_date, status, created_by, created_at,
  approved_by, approved_at, closed_by, closed_at, source`;
const draftFromRow = (row: DraftRowDb): CreatorDraft => CreatorDraft.parse({
  id: row.id, creatorRecordId: row.creator_record_id, threadKey: row.thread_fp, templateKey: row.template_key, body: row.body,
  draftDate: row.draft_date, status: row.status, createdBy: row.created_by, createdAt: iso(row.created_at), approvedBy: row.approved_by,
  approvedAt: iso(row.approved_at), closedBy: row.closed_by, closedAt: iso(row.closed_at), source: row.source,
});

// ---------------------------------------------------------------------------
// Identity: which records the runner's rules would match, and which it would refuse
// ---------------------------------------------------------------------------

const CONTACTS = ['fullName', 'email', 'phone', 'address'] as const;
const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * `resolve_record`'s rungs applied between two registry records: a shared
 * storefront, a shared thread on the same campaign, or two shared contact
 * fingerprints is a match. Sharing less is a refused candidate.
 */
export function creatorIdentityOverlap(self: CreatorRecord, other: CreatorRecord):
  { kind: 'match'; shared: CreatorFingerprintClass[] } | { kind: 'refused'; shared: CreatorFingerprintClass[]; rule: CreatorRefusedCandidate['rule'] } | null {
  const a = self.fingerprints, b = other.fingerprints;
  const same = (key: keyof typeof a) => a[key] !== null && a[key] === b[key];
  const shared = (['storefront', 'thread', ...CONTACTS] as const).filter((key) => same(key));
  if (shared.length === 0) return null;
  const contacts = CONTACTS.filter((key) => same(key)).length;
  const sameCampaign = normalized(self.campaignId) !== '' && normalized(self.campaignId) === normalized(other.campaignId);
  if (same('storefront') || (same('thread') && sameCampaign) || contacts >= 2) return { kind: 'match', shared: [...shared] };
  return { kind: 'refused', shared: [...shared], rule: same('thread') ? 'thread_on_other_campaign' : 'one_contact_fingerprint' };
}

async function overlapping(sql: QuerySql, orgId: string, record: CreatorRecord): Promise<CreatorRecord[]> {
  const f = record.fingerprints;
  const rows = await sql<RecordRow[]>`select ${sql.unsafe(RECORD_COLUMNS)} from public.creator_records
    where org_id = ${orgId} and creator_record_id <> ${record.creatorRecordId} and record_state = 'Active'
      and (storefront_fp = ${f.storefront} or thread_fp = ${f.thread} or full_name_fp = ${f.fullName} or email_fp = ${f.email}
        or phone_fp = ${f.phone} or address_fp = ${f.address})
    order by creator_record_id limit 50`;
  return rows.map(recordFromRow);
}

async function latestQueueItem(sql: QuerySql, orgId: string, id: string): Promise<CreatorDailyQueueItem | null> {
  const [row] = await sql<Record<string, unknown>[]>`
    select q.run_date::text as "runDate", q.queue_id as "queueId", q.occurrence, q.creator_record_id as "creatorRecordId",
      q.brand, q.campaign_tab as "campaignTab", q.current_status as "currentStatus", q.computed_score as "computedScore",
      q.missing_checks as missing, q.due_date::text as "dueDate", q.action_type as "actionType", q.gate_result as "gateResult",
      q.queue_state as "queueState", q.reason, r.lock_state as "lockState", q.source
    from public.creator_daily_queue q
    join public.creator_records r on r.org_id = q.org_id and r.creator_record_id = q.creator_record_id
    where q.org_id = ${orgId} and q.creator_record_id = ${id}
      and q.run_date = (select max(run_date) from public.creator_daily_queue where org_id = ${orgId})
    order by q.occurrence limit 1`;
  return row === undefined ? null : CreatorDailyQueueItem.parse(row);
}

/** `/creators/records/[id]`: null when the organisation holds no such record. */
export async function readCreatorRecord(handle: QueryHandle, orgId: string, id: string): Promise<CreatorRecordDetail | null> {
  const sql = handle.sql;
  const [row] = await readRecordRows(sql, orgId, [id]);
  if (row === undefined) return null;
  const record = recordFromRow(row);
  const others = await overlapping(sql, orgId, record);
  const matching: CreatorRecordDetail['matching'] = [];
  const refusedCandidates: CreatorRefusedCandidate[] = [];
  for (const other of others) {
    const overlap = creatorIdentityOverlap(record, other);
    if (overlap?.kind === 'match') matching.push({ creatorRecordId: other.creatorRecordId, lockState: other.lockState, shared: overlap.shared });
    else if (overlap?.kind === 'refused') {
      refusedCandidates.push({ creatorRecordId: other.creatorRecordId, lockState: other.lockState, shared: overlap.shared, rule: overlap.rule });
    }
  }
  const eventRows = await readEvents(sql, orgId, [id], null, 500);
  const events = eventRows.map(eventFromRow);
  if (events.length !== eventRows.length) throw new Error('Creator event read count mismatch');
  // A registered conflict is an identity decision too, but it has no rung.
  const decided = events.find((event) => event.action === 'identity_resolved' && event.reasonCode !== null
    && ['storefront', 'thread', 'contacts', 'new'].includes(event.reasonCode));
  const identity: CreatorIdentityDecision | null = decided === undefined ? null
    : { rung: decided.reasonCode as CreatorIdentityDecision['rung'], recordedAt: decided.recordedAt, source: decided.source };
  const shipmentRows = await sql<ShipmentRow[]>`select creator_record_id, asin, derived_order_key, sku, campaign_id, reservation_id,
      lane_state, runner_order_id, fee_cents, fee_cap_cents, reserved_at, verified_at, confirmed_at, cancelled_at, cancellation_reason,
      reconciliation_reason, mcf_status, mcf_operation, mcf_read_at, packages, source, imported_at
    from public.creator_sample_shipments where org_id = ${orgId} and creator_record_id = ${id} order by asin`;
  const draftRows = await sql<DraftRowDb[]>`select ${sql.unsafe(DRAFT_COLUMNS)} from public.creator_drafts
    where org_id = ${orgId} and creator_record_id = ${id} order by created_at desc, id`;
  return {
    lastImport: await readLatestCreatorImport(handle, orgId),
    record,
    trackerScore: row.tracker_score === null || row.tracker_scored_on === null ? null : { score: row.tracker_score, scoredOn: row.tracker_scored_on },
    identity,
    refusedCandidates,
    matching,
    queueItem: await latestQueueItem(sql, orgId, id),
    events,
    shipments: shipmentRows.map(creatorShipmentFromRow),
    drafts: draftRows.map(draftFromRow),
  };
}

const IDENTITY_ACTIONS = ['identity_conflict_locked', 'identity_resolved'] as const;

/** `/creators/conflicts/[id]`: the record, every record it collides with, and their identity events. */
export async function readCreatorConflict(handle: QueryHandle, orgId: string, id: string): Promise<CreatorConflictDetail | null> {
  const sql = handle.sql;
  const [row] = await readRecordRows(sql, orgId, [id]);
  if (row === undefined) return null;
  const record = recordFromRow(row);
  const own = (await readEvents(sql, orgId, [id], IDENTITY_ACTIONS, 100)).map(eventFromRow);
  const named = new Set(own.flatMap((event) => event.relatedRecordIds));
  named.delete(id);
  const matched = new Map<string, CreatorFingerprintClass[]>();
  for (const other of await overlapping(sql, orgId, record)) {
    const overlap = creatorIdentityOverlap(record, other);
    if (overlap?.kind === 'match') matched.set(other.creatorRecordId, overlap.shared);
  }
  const ids = [...new Set([...matched.keys(), ...named])].sort();
  const counterparts = (await readRecordRows(sql, orgId, ids)).map(recordFromRow).map((other) => ({
    record: other, shared: matched.get(other.creatorRecordId) ?? [], namedByResolution: named.has(other.creatorRecordId),
  }));
  const eventRows = await readEvents(sql, orgId, [id, ...ids], IDENTITY_ACTIONS, 200);
  return {
    lastImport: await readLatestCreatorImport(handle, orgId),
    record,
    lockedSince: record.lockState === 'Conflict' ? record.lastVerifiedOn : null,
    counterparts,
    events: eventRows.map((event) => ({ ...eventFromRow(event), creatorRecordId: event.creator_record_id })),
  };
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * `creators.record_score`: the runner's score for one record, the status beside
 * it and the tracker's typed score. A score dated before the one already held
 * changes nothing. One `score_recorded` entry per distinct result and day.
 */
export async function recordCreatorScore(sql: QuerySql, orgId: string, actorUserId: string, input: CreatorRecordScoreInput):
  Promise<{ record: 'updated' | 'unchanged' | 'older_than_held'; actionLog: CreatorWriteCounts }> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`creators-import:${orgId}`}, 0))`;
  const id = input.creator_record_id;
  const [held] = await sql<{ qualified_on: string | null }[]>`select qualified_on::text as qualified_on from public.creator_records
    where org_id = ${orgId} and creator_record_id = ${id} for update`;
  if (held === undefined) throw new CreatorWriteRefusal('record_not_found', 'No creator record with this id is registered for the organisation.');
  const missing = input.result.missing;
  const updated = await sql`update public.creator_records set status = ${input.current_status}, computed_score = ${input.result.score},
      missing_checks = ${missing}::text[], qualified_on = ${input.scored_on}, tracker_score = ${input.tracker_score},
      tracker_scored_on = ${input.tracker_score === null ? null : input.scored_on}, updated_at = now()
    where org_id = ${orgId} and creator_record_id = ${id} and (qualified_on is null or qualified_on <= ${input.scored_on}::date)
      and (status, computed_score, missing_checks, qualified_on, tracker_score, tracker_scored_on) is distinct from
        (${input.current_status}::text, ${input.result.score}::smallint, ${missing}::text[], ${input.scored_on}::date,
         ${input.tracker_score}::smallint, ${input.tracker_score === null ? null : input.scored_on}::date)
    returning creator_record_id`;
  const older = held.qualified_on !== null && held.qualified_on > input.scored_on;
  if (older) return { record: 'older_than_held', actionLog: { read: 0, inserted: 0, updated: 0, unchanged: 0 } };
  const digest = creatorContentDigest({ result: input.result, status: input.current_status, tracker: input.tracker_score });
  const logged = await sql`insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reason_code,
      source, actor_user_id)
    values (${orgId}, ${`score:${id}:${input.scored_on}:${digest.slice(0, 16)}`}, ${id}, 'score_recorded', ${`${input.scored_on}T00:00:00Z`},
      ${input.tracker_score !== null && input.tracker_score !== input.result.score ? 'tracker_score_disagrees' : null}, 'mcp', ${actorUserId})
    on conflict (org_id, event_key) do nothing returning id`;
  return {
    record: updated.length === 1 ? 'updated' : 'unchanged',
    actionLog: { read: 1, inserted: logged.length, updated: 0, unchanged: 1 - logged.length },
  };
}

// ---------------------------------------------------------------------------
// Action-log entries a skill appends
// ---------------------------------------------------------------------------

export interface CreatorAppendEntry {
  eventKey: string; creatorRecordId: string; action: string; occurredAt: string; reservationId: string | null; asin: string | null;
  reasonCode: string | null; evidenceReference: string | null;
}
/**
 * Append-only and idempotent: the same key with the same content is unchanged;
 * the same key with other content is refused rather than silently kept.
 */
export async function appendCreatorActions(sql: QuerySql, orgId: string, actorUserId: string, entries: readonly CreatorAppendEntry[]):
  Promise<CreatorWriteCounts> {
  const ids = [...new Set(entries.map((entry) => entry.creatorRecordId))];
  const known = await sql<{ id: string }[]>`select creator_record_id as id from public.creator_records
    where org_id = ${orgId} and creator_record_id = any(${ids}::text[])`;
  if (known.length !== ids.length) throw new CreatorWriteRefusal('record_not_found', 'An entry names a creator record the organisation has not registered.');
  let inserted = 0;
  for (const entry of entries) {
    const key = `skill:${entry.eventKey}`;
    const result = await sql`insert into public.creator_action_log(org_id, event_key, creator_record_id, action, occurred_at, reservation_id,
        asin, reason_code, evidence_reference, source, actor_user_id)
      values (${orgId}, ${key}, ${entry.creatorRecordId}, ${entry.action}, ${entry.occurredAt}, ${entry.reservationId}, ${entry.asin},
        ${entry.reasonCode}, ${entry.evidenceReference}, 'mcp', ${actorUserId})
      on conflict (org_id, event_key) do nothing returning id`;
    if (result.length === 1) { inserted++; continue; }
    const [held] = await sql<{ same: boolean }[]>`select (creator_record_id, action, occurred_at, reservation_id, asin, reason_code,
        evidence_reference) is not distinct from (${entry.creatorRecordId}::text, ${entry.action}::text, ${entry.occurredAt}::timestamptz,
        ${entry.reservationId}::text, ${entry.asin}::text, ${entry.reasonCode}::text, ${entry.evidenceReference}::text) as same
      from public.creator_action_log where org_id = ${orgId} and event_key = ${key}`;
    if (held?.same !== true) throw new CreatorWriteRefusal('event_key_reused', `Event key ${entry.eventKey} already names a different entry.`);
  }
  return { read: entries.length, inserted, updated: 0, unchanged: entries.length - inserted };
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/**
 * `creators.submit_draft`. The same record, thread, template, day and text is
 * the same draft: a replay returns its id unchanged. A different text for a
 * thread with an open draft withdraws that draft first; an approved one is
 * never replaced, because an operator may already be sending it.
 */
export async function submitCreatorDraft(sql: QuerySql, orgId: string, actorUserId: string, input: CreatorSubmitDraftInput):
  Promise<{ draftId: string; status: CreatorDraftStatus; outcome: 'inserted' | 'unchanged'; withdrew: string | null }> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`creator-draft:${orgId}:${input.thread_key}`}, 0))`;
  const [record] = await sql<{ lock_state: string; thread_fp: string | null }[]>`select lock_state, thread_fp from public.creator_records
    where org_id = ${orgId} and creator_record_id = ${input.creator_record_id}`;
  if (record === undefined) throw new CreatorWriteRefusal('record_not_found', 'No creator record with this id is registered for the organisation.');
  if (record.lock_state === 'Conflict') {
    throw new CreatorWriteRefusal('record_conflict_locked', 'The record is locked in Conflict. Nothing may act on it, so no draft is kept.');
  }
  if (record.thread_fp !== null && record.thread_fp !== input.thread_key) {
    throw new CreatorWriteRefusal('thread_mismatch', 'The thread fingerprint is not the one registered for this record.');
  }
  const digest = creatorContentDigest({ creatorRecordId: input.creator_record_id, threadKey: input.thread_key, templateKey: input.template_key,
    draftDate: input.draft_date, body: input.body });
  const [same] = await sql<{ id: string; status: CreatorDraftStatus }[]>`select id, status from public.creator_drafts
    where org_id = ${orgId} and submission_digest = ${digest}`;
  if (same !== undefined) return { draftId: same.id, status: same.status, outcome: 'unchanged', withdrew: null };
  const [open] = await sql<{ id: string; status: CreatorDraftStatus }[]>`select id, status from public.creator_drafts
    where org_id = ${orgId} and thread_fp = ${input.thread_key} and status in ('draft', 'approved') for update`;
  if (open?.status === 'approved') {
    throw new CreatorWriteRefusal('approved_draft_open', 'This thread has an approved draft. An owner or admin marks it sent by hand or withdraws it first.');
  }
  if (open !== undefined) {
    await sql`update public.creator_drafts set status = 'withdrawn', status_source = 'mcp' where org_id = ${orgId} and id = ${open.id}`;
  }
  const [row] = await sql<{ id: string }[]>`insert into public.creator_drafts(org_id, creator_record_id, thread_fp, template_key, body,
      draft_date, submission_digest, created_by, source, status_source)
    values (${orgId}, ${input.creator_record_id}, ${input.thread_key}, ${input.template_key}, ${input.body}, ${input.draft_date}, ${digest},
      ${actorUserId}, 'mcp', 'mcp')
    returning id`;
  return { draftId: row!.id, status: 'draft', outcome: 'inserted', withdrew: open?.id ?? null };
}

/** `/creators/drafts`: the newest draft day, one row per draft, with the record's lock and that day's queue action. */
export async function readCreatorDrafts(handle: QueryHandle, orgId: string): Promise<CreatorDraftsSnapshot> {
  const sql = handle.sql;
  const [day] = await sql<{ draft_date: string | null; submitted: number }[]>`select max(draft_date)::text as draft_date,
      count(*)::int as submitted from public.creator_drafts where org_id = ${orgId}`;
  const draftDate = day?.draft_date ?? null;
  const rows = draftDate === null ? [] : await sql<(DraftRowDb & { lock_state: string; action_type: string | null })[]>`
    select ${sql.unsafe(DRAFT_COLUMNS.split(',').map((column) => `d.${column.trim()}`).join(', '))}, r.lock_state,
      (select q.action_type from public.creator_daily_queue q where q.org_id = d.org_id and q.run_date = d.draft_date
        and q.creator_record_id = d.creator_record_id order by q.occurrence limit 1) as action_type
    from public.creator_drafts d
    join public.creator_records r on r.org_id = d.org_id and r.creator_record_id = d.creator_record_id
    where d.org_id = ${orgId} and d.draft_date = ${draftDate}::date
    order by d.thread_fp, d.created_at, d.id`;
  const drafts: CreatorDraftRow[] = rows.map((row) => ({
    draft: draftFromRow(row), lockState: row.lock_state as CreatorDraftRow['lockState'],
    queueAction: row.action_type as CreatorDraftRow['queueAction'],
  }));
  if (drafts.length !== rows.length) throw new Error('Creator draft read count mismatch');
  return { lastImport: await readLatestCreatorImport(handle, orgId), draftDate, rows: drafts, submittedEver: day?.submitted ?? 0 };
}

/**
 * An owner or admin moves one draft: approve it, mark it sent by hand, or
 * withdraw it. The database trigger enforces the transition, the role and the
 * Conflict lock, stamps who and when from the session, and appends the entry.
 * Nothing is sent and nothing is enqueued.
 */
export async function transitionCreatorDraft(handle: Pick<DbHandle, 'sql'>, rawActor: OrgActor, draftId: string,
  to: Exclude<CreatorDraftStatus, 'draft'>): Promise<CreatorDraft> {
  const actor = OrgActor.parse(rawActor);
  try {
    return await withAuthenticatedActor(handle, actor, async (sql) => {
      const [role] = await sql<{ manager: boolean }[]>`select app.has_org_role(${actor.orgId}::uuid, array['owner', 'admin']) as manager`;
      if (role?.manager !== true) throw new AgencyAccessDenied();
      if (to === 'approved') {
        // The queue a draft answers is read by the import; a failed last read means approval waits.
        const [last] = await sql<{ status: string }[]>`select status from public.creator_import_runs where org_id = ${actor.orgId}
          order by finished_at desc, started_at desc limit 1`;
        if (last?.status === 'failed') {
          throw new CreatorWriteRefusal('transition_refused', 'The last import failed, so the queue this draft answers is not current. Approval waits for a good read.');
        }
      }
      const rows = await sql<DraftRowDb[]>`update public.creator_drafts set status = ${to}, status_source = 'web'
        where org_id = ${actor.orgId} and id = ${draftId}::uuid returning ${sql.unsafe(DRAFT_COLUMNS)}`;
      if (rows.length !== 1) throw new CreatorWriteRefusal('draft_not_found', 'No draft with this id is open to you in this organisation.');
      return draftFromRow(rows[0]!);
    });
  } catch (error) {
    if (error instanceof CreatorWriteRefusal || error instanceof AgencyAccessDenied) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
    if (code === '42501') throw new AgencyAccessDenied();
    if (code === '23514' || code === '55000') {
      throw new CreatorWriteRefusal('transition_refused', 'That change is not allowed for this draft, or its record is locked in Conflict.');
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Issuing a creator:write key from the web
// ---------------------------------------------------------------------------

export interface CreatorWriteKeyIssue { label: string; expiresInDays: 7 | 30 | 90; keyPrefix: string; tokenHash: string }

/**
 * A current owner or admin issues one `creator:write` key: no profiles, an
 * offered expiry, one audit row, all in the SQL command's transaction. The
 * token's digest arrives here; the plaintext never does.
 */
export async function issueManagedMcpCreatorWriteKey(handle: Pick<DbHandle, 'sql'>, actor: OrgActor, command: CreatorWriteKeyIssue):
  Promise<McpKeyMetadata> {
  const label = command.label.trim();
  if (label.length === 0 || label.length > 200 || ![7, 30, 90].includes(command.expiresInDays)
    || !/^wza_[A-Za-z0-9_-]{8}$/.test(command.keyPrefix) || !/^[a-f0-9]{64}$/.test(command.tokenHash)) {
    throw new McpKeyCommandError('invalid');
  }
  try {
    return await withAuthenticatedActor(handle, actor, async (sql) => {
      const rows = await sql<{ id: string }[]>`select app.issue_mcp_creator_write_key(${actor.orgId}::uuid, ${label},
        ${command.expiresInDays}::integer, ${command.keyPrefix}, ${command.tokenHash}) as id`;
      const id = rows[0]?.id;
      const records = id === undefined ? [] : (await listMcpKeyMetadata({ sql }, actor.orgId)).filter((record) => record.id === id);
      if (records.length !== 1) throw new McpKeyCommandError('unavailable');
      return records[0]!;
    });
  } catch (error) {
    if (error instanceof AgencyAccessDenied || error instanceof McpKeyCommandError) throw error;
    const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
    if (code === '42501') throw new AgencyAccessDenied();
    throw new McpKeyCommandError(code === '22023' ? 'invalid' : 'unavailable');
  }
}

/** The runner version held for a record and the newest queue day held; null when there is none. */
export async function readCreatorWriteBaseline(sql: QuerySql, orgId: string, creatorRecordId: string | null):
  Promise<{ runnerVersion: number | null; newestQueueDay: string | null }> {
  const [row] = await sql<{ version: number | null; day: string | null }[]>`select
      (select runner_version from public.creator_records where org_id = ${orgId} and creator_record_id = ${creatorRecordId}) as version,
      (select max(run_date)::text from public.creator_daily_queue where org_id = ${orgId}) as day`;
  return { runnerVersion: row?.version ?? null, newestQueueDay: row?.day ?? null };
}
