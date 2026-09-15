/**
 * Time Machine (WP-30): the account's change history, read-only.
 *
 * AdLabs ships a per-account change log; this is ours, built over data we
 * already record and adding no history table. Three sources feed one reverse-chronological
 * timeline:
 *
 *  - `entity_changes` — every bid / budget / state diff the entity sync noticed.
 *    Its `source` says whether *we* caused it (`apply`) or somebody changed it
 *    outside wizard-ads (`sync`); the latter is the point of recording it at all.
 *  - `apply_batches` / `apply_rows` — the operator's exported changes, one row
 *    per field per opt-group batch, carrying lifecycle evidence, note and lever.
 *  - Native write plans, approvals and execution evidence — each approved
 *    keyword-bid action and its independently recorded inverse.
 *
 * Legacy export history owns its linked sync changes. Native history replaces
 * only its exact source rows and write-attributed mirror diffs. Ordinary sync
 * events and native conflict observations remain visible even after the legacy
 * linker attaches them to a batch; that link is not native attribution evidence.
 *
 * Every statement carries an explicit `org_id` and `profile_id` predicate. The
 * web tier supplies its authenticated read snapshot; explicit tenant predicates
 * also keep multi-agency memberships scoped to the requested agency.
 */
import { createHash } from 'node:crypto';
import {
  ChangeQueueRestoreBatchPreview,
  COORDINATED_RESTORE_UNAVAILABLE,
  ChangeQueueEntry,
  serializeApplyRows,
} from '@wizard-ads/shared';
import type {
  ApplyEntityType,
  ChangeQueueSource,
  ChangeQueueState,
  ApplyRow,
  ApplyValue,
  ChangeQueueRestoreBatchPreview as ReversionBatchPreviewType,
  ReversionRowPreview,
} from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction } from './authenticated-actor.js';
import type { QueryHandle, QuerySql } from '../client.js';
import type { JsonValue } from './goto.js';
import { lockCurrentApplyStates } from './apply-state.js';
import { toDate, toDateOrNull } from './pg-time.js';
import { TimeMachineReadCursor, TimeMachineInstant, compareTimeMachineCursors, type TimeMachineNativeWrite } from '@wizard-ads/shared/time-machine-writes';
import { SpWriteOperationId } from '@wizard-ads/shared/sp-write-application';
import { listNativeTimeline, nativeTimelineRoots } from './time-machine-writes.js';

export type TimeMachineQueryHandle = QueryHandle;
interface TimeMachineReadHandle {
  sql: QuerySql;
}

/** How the change was recorded — the filter the timeline groups by source. */
export type ChangeSource = 'sync' | 'apply';

export interface TimelineEntry {
  /** Stable across all sources — the React key and dedupe handle. */
  id: string;
  source: ChangeSource;
  entityType: string;
  amazonId: string;
  entityName: string | null;
  field: string;
  oldValue: JsonValue;
  newValue: JsonValue;
  observedAt: Date;
  /** Exact keyset time; Date alone discards PostgreSQL microseconds. */
  observedAtExact: string;
  write: TimeMachineNativeWrite | null;
  /** Present only for an operator apply-batch entry. */
  batch: {
    id: string;
    tag: string;
    optGroup: string;
    lever: string;
    note: string;
    status: string;
    sourceBatchId: string | null;
    exportedAt: Date;
  } | null;
}

export interface TimelineFilter {
  orgId: string;
  profileId: string;
  /** Entity types to include (e.g. `keyword`, `campaign`). Empty / omitted = all. */
  entityTypes?: readonly string[] | null;
  /** A single field name (e.g. `bid`, `budget`, `state`). Omitted = all. */
  field?: string | null;
  /** Restrict to one source. Omitted = both. */
  source?: ChangeSource | null;
  /** Inclusive ISO date-or-timestamp bounds on `observed_at`. */
  from?: string | null;
  to?: string | null;
  limit?: number;
  /** Return entries strictly older than this stable `(observed_at, id)` key. */
  before?: { observedAt: string; id: string } | null;
  /** Optional focus on one native operation, including its exact plan identity. */
  operation?: SpWriteOperationId | null;
}

interface TimelineRow {
  id: string;
  source: ChangeSource;
  entity_type: string;
  amazon_id: string;
  entity_name: string | null;
  field: string;
  old_value: JsonValue;
  new_value: JsonValue;
  observed_at: Date | string;
  observed_at_exact: string;
  batch_id: string | null;
  batch_tag: string | null;
  batch_opt_group: string | null;
  batch_lever: string | null;
  batch_note: string | null;
  batch_status: string | null;
  batch_source_batch_id: string | null;
  batch_exported_at: Date | string | null;
}

const toEntry = (row: TimelineRow): TimelineEntry => ({
  id: row.id,
  source: row.source,
  entityType: row.entity_type,
  amazonId: row.amazon_id,
  entityName: row.entity_name,
  field: row.field,
  oldValue: row.old_value,
  newValue: row.new_value,
  observedAt: toDate(row.observed_at),
  observedAtExact: TimeMachineInstant.parse(row.observed_at_exact),
  write: null,
  batch:
    row.batch_id === null
      ? null
      : {
          id: row.batch_id,
          tag: row.batch_tag ?? '',
          optGroup: row.batch_opt_group ?? '',
          lever: row.batch_lever ?? '',
          note: row.batch_note ?? '',
          status: row.batch_status ?? 'staged',
          sourceBatchId: row.batch_source_batch_id,
          exportedAt: toDate(row.batch_exported_at ?? row.observed_at),
        },
});

/**
 * The timeline for one profile, newest first.
 *
 * Native and legacy candidates use the same filters and one read snapshot.
 * Approval time orders native actions; later execution evidence does not move
 * those entries across page boundaries.
 */
export async function listTimeline(
  handle: TimeMachineQueryHandle,
  filter: TimelineFilter,
): Promise<TimelineEntry[]> {
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  const normalized = { ...filter, limit, field: filter.field?.trim() || null,
    before: filter.before == null ? null : TimeMachineReadCursor.parse(filter.before),
    operation: filter.operation == null ? null : SpWriteOperationId.parse(filter.operation) };
  const read = async (sql: QuerySql) => {
    const native = await listNativeTimeline(sql, normalized);
    const legacy = normalized.operation === null ? await listLegacyTimeline({ sql }, normalized) : [];
    const entries = [...legacy, ...native].sort((left, right) => compareTimeMachineCursors(
      { observedAt: right.observedAtExact, id: right.id }, { observedAt: left.observedAtExact, id: left.id },
    )).slice(0, limit);
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('timeline entry identities do not close');
    return { entries };
  };
  const result = 'begin' in handle.sql
    ? await handle.sql.begin('isolation level repeatable read read only', read)
    : await read(handle.sql);
  return result.entries;
}

async function listLegacyTimeline(
  handle: TimeMachineReadHandle, filter: TimelineFilter,
): Promise<TimelineEntry[]> {
  const entityTypes = filter.entityTypes?.length ? [...filter.entityTypes] : null;
  const field = filter.field ?? null;
  const source = filter.source ?? null;
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const limit = Math.min(Math.max(filter.limit ?? 500, 1), 2000);
  const beforeObservedAt = filter.before?.observedAt ?? null;
  const beforeId = filter.before?.id ?? null;

  const rows = await handle.sql<TimelineRow[]>`
    with native_roots as (${nativeTimelineRoots(handle.sql, filter)}), native_roots_in_window as (
      -- A native entry can replace an older export or later mirror event only
      -- inside this date window. Do not use the page cursor here: otherwise a
      -- duplicate would reappear on a later page after its native entry was seen.
      select * from native_roots n
      where (${from}::timestamptz is null or n.approved_at >= ${from}::timestamptz)
        and (${to}::timestamptz is null or n.approved_at <= ${to}::timestamptz)
    ), timeline as (
      select
        'change:' || ec.id::text                      as id,
        ec.source::text                               as source,
        ec.entity_type::text                          as entity_type,
        ec.amazon_id                                  as amazon_id,
        ec.entity_name                                as entity_name,
        ec.field                                      as field,
        ec.old_value                                  as old_value,
        ec.new_value                                  as new_value,
        ec.observed_at                                as observed_at,
        null::uuid                                    as batch_id,
        null::text                                    as batch_tag,
        null::text                                    as batch_opt_group,
        null::text                                    as batch_lever,
        null::text                                    as batch_note
        ,null::text                                   as batch_status
        ,null::uuid                                   as batch_source_batch_id
        ,null::timestamptz                            as batch_exported_at
      from public.entity_changes ec
      where ec.org_id = ${filter.orgId}
        and ec.profile_id = ${filter.profileId}
        -- A legacy batch link does not establish native-write attribution.
        and (ec.apply_batch_id is null
          or exists(select 1 from public.apply_batches b where b.org_id = ec.org_id
            and b.profile_id = ec.profile_id and b.id = ec.apply_batch_id
            and b.source_kind = 'mcp_keyword_proposals')
          or exists(select 1 from native_roots n where n.direction = 'forward'
            and n.org_id = ec.org_id and n.profile_id = ec.profile_id
            and n.preview_artifact #>> '{provenance,applyBatchId}' = ec.apply_batch_id::text)
          or exists(select 1 from public.sp_write_mirror_observations m
          where m.org_id = ec.org_id and m.profile_id = ec.profile_id and m.entity_change_id = ec.id
            and m.change_attribution = 'observation'))
        and not exists(select 1 from public.sp_write_mirror_observations m
          join native_roots_in_window n on n.org_id = m.org_id and n.profile_id = m.profile_id
            and n.execution_id = m.execution_id and n.plan_id = m.plan_id
          join public.sp_write_plan_actions a on a.org_id = n.org_id and a.profile_id = n.profile_id
            and a.plan_id = n.plan_id and a.action_id = m.action_id
          where m.entity_change_id = ec.id and m.change_attribution = 'write'
            and a.route_key = 'sp.v3.keywords.update' and a.artifact -> 'changes' ? 'bid')
        and (${entityTypes}::text[] is null or ec.entity_type::text = any(${entityTypes}::text[]))
        and (${field}::text is null or ec.field = ${field}::text)
        and (${source}::text is null or ec.source::text = ${source}::text)
        and (${from}::timestamptz is null or ec.observed_at >= ${from}::timestamptz)
        and (${to}::timestamptz is null or ec.observed_at <= ${to}::timestamptz)
      union all
      select
        'apply:' || ar.id::text                       as id,
        'apply'                                       as source,
        ar.entity_type::text                          as entity_type,
        ar.entity_id                                  as amazon_id,
        ar.entity_name                                as entity_name,
        ar.field                                      as field,
        ar.old_value                                  as old_value,
        ar.new_value                                  as new_value,
        coalesce(ab.applied_at, ab.exported_at, ab.created_at) as observed_at,
        ab.id                                         as batch_id,
        ab.tag                                        as batch_tag,
        ab.opt_group                                  as batch_opt_group,
        ar.lever                                      as batch_lever,
        ab.note                                       as batch_note
        ,ab.status::text                              as batch_status
        ,ab.source_batch_id                           as batch_source_batch_id
        ,ab.exported_at                               as batch_exported_at
      from public.apply_rows ar
      join public.apply_batches ab on ab.id = ar.batch_id
      where ar.org_id = ${filter.orgId}
        and ab.org_id = ${filter.orgId}
        and ab.profile_id = ${filter.profileId}
        and ab.source_kind = 'legacy_export'
        and not exists(select 1 from native_roots_in_window n join public.sp_write_plan_actions a
          on a.org_id = n.org_id and a.profile_id = n.profile_id and a.plan_id = n.plan_id
          where n.direction = 'forward' and a.route_key = 'sp.v3.keywords.update'
            and a.artifact -> 'changes' ? 'bid' and a.artifact -> 'sources' @> jsonb_build_array(
              jsonb_build_object('kind', 'apply_row', 'applyRowId', ar.id::text, 'changeKey', 'keyword.bid')))
        and (${entityTypes}::text[] is null or ar.entity_type::text = any(${entityTypes}::text[]))
        and (${field}::text is null or ar.field = ${field}::text)
        and (${source}::text is null or ${source}::text = 'apply')
        and (${from}::timestamptz is null
             or coalesce(ab.applied_at, ab.exported_at, ab.created_at) >= ${from}::timestamptz)
        and (${to}::timestamptz is null
             or coalesce(ab.applied_at, ab.exported_at, ab.created_at) <= ${to}::timestamptz)
    )
    select *, to_char(observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as observed_at_exact
      from timeline
     where (${beforeObservedAt}::timestamptz is null
            or (observed_at, id collate "C") < (${beforeObservedAt}::timestamptz, ${beforeId}::text collate "C"))
    order by observed_at desc, id collate "C" desc
    limit ${limit}
  `;
  return rows.map(toEntry);
}

export interface TimelineFacets {
  entityTypes: string[];
  fields: string[];
}

/**
 * The distinct entity types and fields present across both sources for a
 * profile, so the filter controls offer only values that would return something.
 * Independent of the current filter on purpose: a filter control that hides the
 * option that would widen the view is a trap.
 */
export async function listTimelineFacets(
  handle: TimeMachineQueryHandle,
  input: { orgId: string; profileId: string },
): Promise<TimelineFacets> {
  const rows = await handle.sql<{ entity_type: string; field: string }[]>`
    with native_roots as (${nativeTimelineRoots(handle.sql, input)})
    select ec.entity_type::text as entity_type, ec.field as field
      from public.entity_changes ec
     where ec.org_id = ${input.orgId}
       and ec.profile_id = ${input.profileId}
       and (ec.apply_batch_id is null
         or exists(select 1 from public.apply_batches b where b.org_id = ec.org_id
           and b.profile_id = ec.profile_id and b.id = ec.apply_batch_id
           and b.source_kind = 'mcp_keyword_proposals')
         or exists(select 1 from native_roots n where n.direction = 'forward'
           and n.org_id = ec.org_id and n.profile_id = ec.profile_id
           and n.preview_artifact #>> '{provenance,applyBatchId}' = ec.apply_batch_id::text)
         or exists(select 1 from public.sp_write_mirror_observations m
           where m.org_id = ec.org_id and m.profile_id = ec.profile_id
             and m.entity_change_id = ec.id and m.change_attribution = 'observation'))
    union
    select ar.entity_type::text as entity_type, ar.field as field
      from public.apply_rows ar
      join public.apply_batches ab on ab.id = ar.batch_id
     where ar.org_id = ${input.orgId}
       and ab.org_id = ${input.orgId}
       and ab.profile_id = ${input.profileId}
       and ab.source_kind = 'legacy_export'
    union
    select 'keyword' as entity_type, 'bid' as field from native_roots n
      join public.sp_write_plan_actions a on a.org_id = n.org_id and a.profile_id = n.profile_id and a.plan_id = n.plan_id
      where a.route_key = 'sp.v3.keywords.update' and a.artifact -> 'changes' ? 'bid'
  `;
  const entityTypes = [...new Set(rows.map((row) => row.entity_type))].sort();
  const fields = [...new Set(rows.map((row) => row.field))].sort();
  return { entityTypes, fields };
}

// ---------------------------------------------------------------------------
// Time Machine v2: immutable export batches and evidence-backed reversions.
// ---------------------------------------------------------------------------

export interface ReversionBatchSummary {
  batchId: string;
  sourceBatchId: string | null;
  profileId: string;
  tag: string;
  optGroup: string;
  lever: string;
  lifecycleStatus: ReversionBatchPreviewType['lifecycleStatus'];
  exportedAt: Date;
  appliedAt: Date | null;
  exportedProposals: number;
  reversibleRows: number;
  unsupportedRows: number;
}

interface ReversionBatchHeaderRow {
  dependency_sets_count: number | null;
  id: string;
  source_batch_id: string | null;
  active_reversion_batch_id: string | null;
  profile_id: string;
  tag: string;
  opt_group: string;
  lever: string;
  note: string;
  status: string;
  exported_at: Date | string;
  applied_at: Date | string | null;
  artifact_sha256: string | null;
  exported_proposals: number;
  reversible_rows: number;
  unsupported_rows: number;
}

interface ReversionEvidenceRow {
  coordinated: boolean;
  row_id: string;
  recommendation_id: string | null;
  entity_type: ApplyEntityType;
  entity_id: string;
  entity_name: string | null;
  field: string;
  old_value: unknown;
  new_value: unknown;
  supported: boolean;
  present: boolean;
  current_value: unknown;
  current_synced_at: Date | string | null;
  synchronized_value: unknown;
  synchronized_at: Date | string | null;
  has_unlinked_exact_change: boolean;
}

function lifecycleStatus(row: Pick<ReversionBatchHeaderRow, 'source_batch_id' | 'status'>): ReversionBatchPreviewType['lifecycleStatus'] {
  if (row.status === 'abandoned') return 'abandoned';
  if (row.status === 'reverted') return 'verified_reverted';
  if (row.source_batch_id !== null) return 'reversion_exported';
  if (row.status === 'applied') return 'applied_externally';
  return 'exported';
}

function scalar(value: unknown): { valid: true; value: ApplyValue } | { valid: false; value: null } {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return { valid: true, value };
  }
  return { valid: false, value: null };
}

function sameScalar(left: ApplyValue, right: ApplyValue): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

function classifyReversionRow(
  batchId: string,
  exportedAt: Date,
  row: ReversionEvidenceRow,
): ReversionRowPreview {
  const original = scalar(row.old_value);
  const exported = scalar(row.new_value);
  const current = scalar(row.current_value);
  const synchronized = scalar(row.synchronized_value);
  const synchronizedAt = row.synchronized_at === null ? null : TimeMachineInstant.parse(typeof row.synchronized_at === 'string' ? row.synchronized_at : row.synchronized_at.toISOString());
  const currentSyncedAt = row.current_synced_at === null ? null : TimeMachineInstant.parse(typeof row.current_synced_at === 'string' ? row.current_synced_at : row.current_synced_at.toISOString());

  let state: ReversionRowPreview['state'];
  let reason: string;

  if (row.coordinated) {
    state = 'unsupported';
    reason = COORDINATED_RESTORE_UNAVAILABLE;
  } else if (!original.valid || !exported.valid) {
    state = 'unsupported';
    reason = 'The exported row contains a structured value that the staged-apply bridge cannot invert.';
  } else if (!row.supported) {
    state = 'unsupported';
    reason = 'This entity field does not have a verified current-state adapter.';
  } else if (!row.present) {
    state = 'conflict';
    reason = 'The entity is missing or deleted in the current synchronized mirror.';
  } else if (synchronizedAt === null) {
    state = row.has_unlinked_exact_change ? 'ambiguous' : 'awaiting_sync';
    reason = row.has_unlinked_exact_change
      ? 'An exact change was observed, but it cannot be attributed uniquely to this export.'
      : 'The exported value has not appeared in a uniquely linked synchronization event.';
  } else if (
    currentSyncedAt === null ||
    currentSyncedAt < TimeMachineInstant.parse(exportedAt.toISOString()) || currentSyncedAt < synchronizedAt
  ) {
    state = 'awaiting_sync';
    reason = 'restore_mirror_stale: The current mirror predates the applied observation.';
  } else if (!current.valid) {
    state = 'unsupported';
    reason = 'The current synchronized value is not a scalar value.';
  } else if (sameScalar(current.value, exported.value)) {
    state = 'ready';
    reason = 'The exported value was uniquely observed and still matches the current synchronized value.';
  } else if (sameScalar(current.value, original.value)) {
    state = 'already_reverted';
    reason = 'The current synchronized value already equals the original value.';
  } else {
    state = 'conflict';
    reason = 'The current synchronized value differs from the value this export expected to apply.';
  }

  const originalValue = original.value;
  const exportedValue = exported.value;
  return {
    batchId,
    rowId: row.row_id,
    recommendationId: row.recommendation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    entityName: row.entity_name,
    field: row.field,
    originalValue,
    proposedValue: exportedValue,
    exportedValue,
    synchronizedValue: synchronizedAt === null || !synchronized.valid ? null : synchronized.value,
    synchronizedAt,
    currentValue: current.valid ? current.value : null,
    currentSyncedAt,
    inverseValue: originalValue,
    state,
    conflict: state === 'conflict' || state === 'ambiguous',
    exportAllowed: state === 'ready',
    reason,
  };
}

export async function listReversionBatches(
  handle: TimeMachineQueryHandle,
  input: { orgId: string; profileId: string; limit?: number },
): Promise<ReversionBatchSummary[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const rows = await handle.sql<ReversionBatchHeaderRow[]>`
    with native_roots as (${nativeTimelineRoots(handle.sql, input)})
    select id, source_batch_id,
           coalesce((select child.id from public.apply_batches child
             where child.org_id = apply_batches.org_id
               and child.profile_id = apply_batches.profile_id
               and child.source_batch_id = apply_batches.id
               and child.status <> 'abandoned'
             order by child.exported_at desc limit 1),
             (select proposal.plan_id from public.sp_write_restore_proposals proposal
               join public.sp_write_cycle_plans cycle on cycle.org_id=proposal.org_id and cycle.profile_id=proposal.profile_id and cycle.plan_id=proposal.plan_id
               join public.sp_write_plans restore_plan on restore_plan.org_id=proposal.org_id and restore_plan.profile_id=proposal.profile_id and restore_plan.plan_id=proposal.plan_id
                 and restore_plan.artifact#>>'{source,restoreProposal,kind}'='restore_proposal'
               where proposal.org_id=apply_batches.org_id and proposal.profile_id=apply_batches.profile_id and proposal.source_batch_id=apply_batches.id
               order by proposal.created_at desc,proposal.plan_id desc limit 1)) as active_reversion_batch_id,
           profile_id, tag, opt_group, lever, note,
           status::text as status, exported_at, applied_at, artifact_sha256,
           exported_proposals, reversible_rows, unsupported_rows, dependency_sets_count
      from public.apply_batches
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and source_kind = 'legacy_export'
       and not exists(select 1 from native_roots n where n.direction = 'forward'
         and not exists(select 1 from public.sp_write_restore_proposals restore where restore.org_id=n.org_id and restore.profile_id=n.profile_id and restore.plan_id=n.plan_id)
         and n.preview_artifact #>> '{provenance,applyBatchId}' = apply_batches.id::text)
     order by exported_at desc, id desc
     limit ${limit}
  `;
  return rows.map((row) => ({
    batchId: row.id,
    sourceBatchId: row.source_batch_id,
    profileId: row.profile_id,
    tag: row.tag,
    optGroup: row.opt_group,
    lever: row.lever,
    lifecycleStatus: lifecycleStatus(row),
    exportedAt: toDate(row.exported_at),
    appliedAt: toDateOrNull(row.applied_at),
    exportedProposals: row.exported_proposals,
    reversibleRows: row.reversible_rows,
    unsupportedRows: row.unsupported_rows,
  }));
}

/** One source batch, reconstructed from immutable rows and exact sync links. */
export async function getReversionBatchPreview(
  handle: TimeMachineReadHandle,
  input: { orgId: string; batchId: string },
): Promise<ReversionBatchPreviewType | null> {
  const [header] = await handle.sql<ReversionBatchHeaderRow[]>`
    select id, source_batch_id,
           coalesce((select child.id from public.apply_batches child
             where child.org_id = apply_batches.org_id
               and child.profile_id = apply_batches.profile_id
               and child.source_batch_id = apply_batches.id
               and child.status <> 'abandoned'
             order by child.exported_at desc limit 1),
             (select proposal.plan_id from public.sp_write_restore_proposals proposal
               join public.sp_write_cycle_plans cycle on cycle.org_id=proposal.org_id and cycle.profile_id=proposal.profile_id and cycle.plan_id=proposal.plan_id
               join public.sp_write_plans restore_plan on restore_plan.org_id=proposal.org_id and restore_plan.profile_id=proposal.profile_id and restore_plan.plan_id=proposal.plan_id
                 and restore_plan.artifact#>>'{source,restoreProposal,kind}'='restore_proposal'
               where proposal.org_id=apply_batches.org_id and proposal.profile_id=apply_batches.profile_id and proposal.source_batch_id=apply_batches.id
               order by proposal.created_at desc,proposal.plan_id desc limit 1)) as active_reversion_batch_id,
           profile_id, tag, opt_group, lever, note,
           status::text as status, exported_at, applied_at, artifact_sha256,
           exported_proposals, reversible_rows, unsupported_rows, dependency_sets_count
      from public.apply_batches
     where org_id = ${input.orgId} and id = ${input.batchId}
       and source_kind = 'legacy_export'
       and not exists(select 1 from public.sp_write_plans p
         join public.sp_write_authorization_receipts r on r.org_id = p.org_id
           and r.profile_id = p.profile_id and r.plan_id = p.plan_id
         where p.org_id = apply_batches.org_id and p.profile_id = apply_batches.profile_id
           and p.direction = 'forward' and p.artifact #> '{source,restoreProposal}' is null
           and p.artifact #>> '{source,applyBatchId}' = apply_batches.id::text)
  `;
  if (header === undefined) return null;

  const evidence = await handle.sql<ReversionEvidenceRow[]>`
    select ar.id as row_id, ar.recommendation_id,
           (b.dependency_sets_count is not null or ar.dependency_set_id is not null or ar.dependency_step_index is not null) as coordinated,
           ar.entity_type::text as entity_type, ar.entity_id, ar.entity_name,
           ar.field, ar.old_value, ar.new_value,
           current_state.supported, current_state.present,
           current_state.current_value,
           to_char(current_state.current_synced_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as current_synced_at,
           linked.new_value as synchronized_value,
           to_char(linked.observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as synchronized_at,
           exists (
             select 1
               from public.entity_changes possible
              where possible.org_id = b.org_id
                and possible.profile_id = b.profile_id
                and possible.apply_batch_id is null
                and possible.source = 'sync'
                and possible.entity_type::text =
                    (case when ar.entity_type = 'placement' then 'campaign' else ar.entity_type::text end)
                and possible.amazon_id = ar.entity_id
                and app.canonical_apply_field(possible.entity_type::text, possible.field)
                    = app.canonical_apply_field(ar.entity_type::text, ar.field)
                and possible.old_value = ar.old_value
                and possible.new_value = ar.new_value
                and possible.observed_at >= b.exported_at
           ) as has_unlinked_exact_change
      from public.apply_batches b
      join public.apply_rows ar
        on ar.org_id = b.org_id
       and ar.profile_id = b.profile_id
       and ar.batch_id = b.id
      left join lateral app.resolve_apply_current_value(
        b.org_id, b.profile_id, ar.entity_type, ar.entity_id, ar.field
      ) current_state on true
      left join lateral (
        select ec.new_value, ec.observed_at
          from public.entity_changes ec
         where ec.org_id = b.org_id
           and ec.profile_id = b.profile_id
           and ec.apply_row_id = ar.id and ec.apply_batch_id=b.id and ec.source='sync'
           and ec.entity_type::text=(case when ar.entity_type='placement' then 'campaign' else ar.entity_type::text end)
           and ec.amazon_id=ar.entity_id
           and app.canonical_apply_field(ec.entity_type::text,ec.field)=app.canonical_apply_field(ar.entity_type::text,ar.field)
           and ec.old_value=ar.old_value and ec.new_value=ar.new_value and ec.observed_at>=b.exported_at
         order by ec.observed_at desc, ec.id desc
         limit 1
      ) linked on true
     where b.org_id = ${input.orgId}
       and b.id = ${input.batchId}
     order by ar.created_at, ar.id
  `;

  const exportedAt = toDate(header.exported_at);
  const rows = evidence.map((row) => classifyReversionRow(header.id, exportedAt, row));
  const readyRows = rows.filter((row) => row.exportAllowed).length;
  const blockedRows = header.reversible_rows + header.unsupported_rows - readyRows;
  let exportAllowed = true;
  let reason = `${readyRows} synchronized changes are ready for an exact inverse export.`;

  if (header.dependency_sets_count !== null) {
    exportAllowed = false;
    reason = COORDINATED_RESTORE_UNAVAILABLE;
  } else if (header.source_batch_id !== null) {
    exportAllowed = false;
    reason = 'A reversion export is an immutable audit record and cannot itself be inverted here.';
  } else if (header.active_reversion_batch_id !== null) {
    exportAllowed = false;
    reason = 'This batch already has an active reversion export.';
  } else if (header.status === 'abandoned') {
    exportAllowed = false;
    reason = 'This export was abandoned.';
  } else if (header.status === 'reverted') {
    exportAllowed = false;
    reason = 'This batch is already verified as reverted.';
  } else if (header.artifact_sha256 === null) {
    exportAllowed = false;
    reason = 'This legacy export has no immutable artifact fingerprint.';
  } else if (header.unsupported_rows > 0) {
    exportAllowed = false;
    reason = `${header.unsupported_rows} exported create rows do not have an invertible old value.`;
  } else if (rows.length !== header.reversible_rows) {
    exportAllowed = false;
    reason = `The ledger expected ${header.reversible_rows} reversible rows but reconstructed ${rows.length}.`;
  } else if (rows.length === 0) {
    exportAllowed = false;
    reason = 'This export contains no reversible update rows.';
  } else if (readyRows !== rows.length) {
    exportAllowed = false;
    reason = `${rows.length - readyRows} of ${rows.length} rows are waiting, ambiguous, unsupported, or conflicted.`;
  }

  return ChangeQueueRestoreBatchPreview.parse({
    dependencySetCount: header.dependency_sets_count,
    batchId: header.id,
    sourceBatchId: header.source_batch_id,
    activeReversionBatchId: header.active_reversion_batch_id,
    profileId: header.profile_id,
    tag: header.tag,
    optGroup: header.opt_group,
    lever: header.lever,
    note: header.note,
    lifecycleStatus: lifecycleStatus(header),
    exportedAt: exportedAt.toISOString(),
    appliedAt: toDateOrNull(header.applied_at)?.toISOString() ?? null,
    artifactSha256: header.artifact_sha256,
    exportedProposals: header.exported_proposals,
    reversibleRows: header.reversible_rows,
    unsupportedRows: header.unsupported_rows,
    rows,
    readyRows,
    blockedRows,
    exportAllowed,
    reason,
  });
}

export interface ReversionExportResult {
  batchId: string;
  sourceBatchId: string;
  tag: string;
  rows: ApplyRow[];
  artifactSha256: string;
}

/**
 * Create a new immutable staged batch containing the exact inverse rows. The
 * source is re-read under a transaction lock, so a stale browser preview can
 * never authorize a conflicting export. Nothing is sent to Amazon.
 */
export async function createReversionExport(
  handle: TimeMachineQueryHandle,
  input: {
    orgId: string;
    batchId: string;
    tag: string;
    note: string;
    actorId?: string | null;
  },
): Promise<ReversionExportResult> {
  const note = input.note.trim();
  if (note.length === 0) throw new Error('A reversion export requires a note.');
  const tag = input.tag.trim();
  if (tag.length === 0) throw new Error('A reversion export requires a batch tag.');

  return await inTransaction(handle, async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`time-machine:${input.orgId}:${input.batchId}`}, 0))`;
    await sql`
      select id from public.apply_batches
       where org_id = ${input.orgId} and id = ${input.batchId}
       for update
    `;
    const initialPreview = await getReversionBatchPreview({ sql }, {
      orgId: input.orgId,
      batchId: input.batchId,
    });
    if (initialPreview === null) throw new Error('Not found');
    if ('actor' in handle) await sql`select app.lock_review_export_rows(
      ${input.orgId}::uuid,${initialPreview.profileId}::uuid,null,
      ${JSON.stringify(initialPreview.rows.map((row) => ({ entityType: row.entityType, entityId: row.entityId })))}::text::jsonb)`;
    else await lockCurrentApplyStates({ sql }, {
      orgId: input.orgId,
      profileId: initialPreview.profileId,
      targets: initialPreview.rows.map((row) => ({
        key: row.rowId,
        entityType: row.entityType,
        entityId: row.entityId,
        field: row.field,
      })),
    });
    const preview = await getReversionBatchPreview({ sql }, {
      orgId: input.orgId,
      batchId: input.batchId,
    });
    if (preview === null) throw new Error('Not found');
    if (!preview.exportAllowed) throw new Error(`Reversion blocked: ${preview.reason}`);

    const rows: ApplyRow[] = preview.rows.map((row) => ({
      entityType: row.entityType,
      entityId: row.entityId,
      field: row.field,
      old: row.exportedValue,
      new: row.inverseValue,
      ...(row.entityName === null ? {} : { name: row.entityName }),
    }));
    if (rows.length !== preview.readyRows || rows.length !== preview.reversibleRows) {
      throw new Error(
        `Reversion preview offered ${preview.reversibleRows} rows, prepared ${rows.length}`,
      );
    }
    const artifactSha256 = createHash('sha256')
      .update(serializeApplyRows(rows))
      .digest('hex');
    const [batch] = await sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, source_batch_id,
         exported_at, artifact_sha256, exported_proposals, reversible_rows,
         unsupported_rows, created_by)
      values (${input.orgId}, ${preview.profileId}, ${tag}, ${preview.optGroup},
              'revert', ${note}, 'staged', ${preview.batchId}, now(), ${artifactSha256},
              ${rows.length}, ${rows.length}, 0, ${input.actorId ?? null}::uuid)
      returning id
    `;
    const batchId = batch?.id;
    if (batchId === undefined) throw new Error('Failed to create the reversion export.');

    const inserted = await sql<{ id: string }[]>`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, entity_name,
         field, old_value, new_value, lever)
      select ${batchId}, ${input.orgId}, ${preview.profileId},
             offered.entity_type::public.apply_entity_type, offered.entity_id,
             offered.entity_name, offered.field, offered.old_value::jsonb,
             offered.new_value::jsonb, 'revert'
        from unnest(
               ${rows.map((row) => row.entityType)}::text[],
               ${rows.map((row) => row.entityId)}::text[],
               ${rows.map((row) => row.name ?? null)}::text[],
               ${rows.map((row) => row.field)}::text[],
               ${rows.map((row) => JSON.stringify(row.old))}::text[],
               ${rows.map((row) => JSON.stringify(row.new))}::text[]
             ) offered(entity_type, entity_id, entity_name, field, old_value, new_value)
      returning id
    `;
    if (inserted.length !== rows.length) {
      throw new Error(`Reversion offered ${rows.length} rows, wrote ${inserted.length}`);
    }

    if ('actor' in handle) {
      const [audit] = await sql<{ count: number }[]>`select app.record_recommendation_review_audit(
        ${input.orgId}::uuid,'reversion.exported','apply_batch',${[batchId]}::text[],
        ${JSON.stringify({ sourceBatchId: preview.batchId, rows: rows.length, artifactSha256 })}::text::jsonb) as count`;
      if (audit?.count !== 1) throw new Error('Reversion audit count mismatch');
    } else {
      await sql`
        insert into public.audit_log
          (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
        values (${input.orgId}, 'user', ${input.actorId ?? null}, 'reversion.exported',
                'apply_batch', ${batchId},
                ${JSON.stringify({ sourceBatchId: preview.batchId, rows: rows.length, artifactSha256 })}::text::jsonb,
                'web')
      `;
    }

    return { batchId, sourceBatchId: preview.batchId, tag, rows, artifactSha256 };
  });
}

/** Reuse an admitted transaction; legacy worker callers still own one commit. */
async function inTransaction<T>(handle: QueryHandle, operation: (sql: QuerySql) => Promise<T>): Promise<T> {
  if (!('begin' in handle.sql)) return operation(handle.sql);
  const result = await handle.sql.begin(async (sql) => ({ value: await operation(sql) }));
  return result.value;
}

/** The ACT queue keeps observation receipts separate from immutable exports. */
export async function listChangeQueue(
  handle: TimeMachineReadHandle,
  input: { orgId: string; profileId: string; from?: string | null; to?: string | null;
    source?: ChangeQueueSource | null; state?: string | null;
    entityType?: string | null; field?: string | null; limit?: number;
    before?: { observedAt: string; id: string } | null },
): Promise<ChangeQueueEntry[]> {
  const limit = Math.min(2000, Math.max(1, input.limit ?? 51));
  const result = await handle.sql<{ artifact: unknown }[]>`
    with native_roots as (${nativeTimelineRoots(handle.sql, input)}), visible_native_roots as (
      select * from native_roots n where (${input.from ?? null}::timestamptz is null or n.approved_at>=${input.from ?? null}::timestamptz)
        and (${input.to ?? null}::timestamptz is null or n.approved_at<=${input.to ?? null}::timestamptz)
    ), entries as (
      select 'change:'||ec.id::text as id, ec.observed_at as at, ec.entity_type::text as entity_type,
        ec.amazon_id as entity_id, coalesce(ec.entity_name,ec.amazon_id) as entity, ec.field,
        ec.old_value,ec.new_value,'sync'::text as source,
        case when ec.acknowledged_at is not null then 'acknowledged'
          when candidates.count>1 then 'unattributed'
          when ec.apply_row_id is not null then 'confirmed' else 'observed' end as state,
        case when candidates.count>1 then null else b.id end as batch_id,
        case when candidates.count>1 then candidates.label else b.tag end as batch_label,
        case when candidates.count>1 then null else b.reversible_rows+b.unsupported_rows end as batch_count,
        (candidates.count<=1 and b.experiment_id is not null) as experiment_start, candidates.count as candidate_count,
        ec.acknowledged_at,ec.acknowledged_by,null::text as review_href
      from public.entity_changes ec
      left join public.apply_batches b on b.org_id=ec.org_id and b.profile_id=ec.profile_id and b.id=ec.apply_batch_id
      cross join lateral (
        select count(*)::int as count, case when count(distinct cb.id)=1 then min(cb.tag) else null end as label
        from public.apply_rows ar join public.apply_batches cb on cb.org_id=ar.org_id and cb.profile_id=ar.profile_id and cb.id=ar.batch_id
        where ar.org_id=ec.org_id and ar.profile_id=ec.profile_id and cb.source_kind='legacy_export'
          and (case when ar.entity_type='placement' then 'campaign' else ar.entity_type::text end)=ec.entity_type::text
          and ar.entity_id=ec.amazon_id and app.canonical_apply_field(ar.entity_type::text,ar.field)=app.canonical_apply_field(ec.entity_type::text,ec.field)
          and ar.old_value=ec.old_value and ar.new_value=ec.new_value and cb.exported_at<=ec.observed_at
          and cb.status in ('staged','applied') and cb.artifact_sha256 is not null
          and not exists(select 1 from public.entity_changes prior where prior.org_id=ec.org_id and prior.profile_id=ec.profile_id and prior.apply_row_id=ar.id and prior.id<>ec.id)
      ) candidates
      where ec.org_id=${input.orgId}::uuid and ec.profile_id=${input.profileId}::uuid and ec.source='sync'
        and not exists(select 1 from public.sp_write_mirror_observations m join visible_native_roots n
          on n.org_id=m.org_id and n.profile_id=m.profile_id and n.execution_id=m.execution_id and n.plan_id=m.plan_id
          where m.entity_change_id=ec.id and m.change_attribution='write')
      union all
      select 'apply:'||ar.id::text,b.exported_at,ar.entity_type::text,ar.entity_id,coalesce(ar.entity_name,ar.entity_id),ar.field,
        ar.old_value,ar.new_value,'apply',case when exists(select 1 from public.entity_changes ec
          where ec.org_id=ar.org_id and ec.profile_id=ar.profile_id and ec.apply_row_id=ar.id) then 'confirmed' else 'exported' end,
        b.id,b.tag,b.reversible_rows+b.unsupported_rows,b.experiment_id is not null,0,null::timestamptz,null::uuid,null::text
      from public.apply_rows ar join public.apply_batches b on b.org_id=ar.org_id and b.profile_id=ar.profile_id and b.id=ar.batch_id
      where ar.org_id=${input.orgId}::uuid and ar.profile_id=${input.profileId}::uuid and b.source_kind='legacy_export'
        and not exists(select 1 from visible_native_roots n where n.direction='forward'
          and not exists(select 1 from public.sp_write_restore_proposals restore where restore.org_id=n.org_id and restore.profile_id=n.profile_id and restore.plan_id=n.plan_id)
          and n.preview_artifact #>> '{provenance,applyBatchId}'=b.id::text)
      union all
      select 'queued:'||q.id::text,q.created_at,'target',q.target_id,coalesce(q.context->>'targetLabel',q.target_id),'bid',
        q.request#>'{expectedBid,amount}',q.request#>'{newBid,amount}','queued',
        case when a.change_id is null then 'awaiting review' else 'approved' end,null::uuid,null::text,null::integer,false,0,
        null::timestamptz,null::uuid,q.id::text
      from public.queued_changes q left join public.queued_change_approvals a on a.org_id=q.org_id and a.profile_id=q.profile_id and a.change_id=q.id
      where q.org_id=${input.orgId}::uuid and q.profile_id=${input.profileId}::uuid
      union all
      select 'restore:'||p.plan_id::text,p.created_at,'keyword',p.plan_id::text,
        'Restore proposal · '||plan.provider_rows::text||' changes','bid',null::jsonb,null::jsonb,'restore',
        case when accounting.observed_requested=plan.provider_rows then 'observed'
          when accounting.provider_rejected+accounting.refused_before_dispatch+accounting.observation_conflict+accounting.observation_missing>0 then 'failed'
          when accounting.provider_accepted=plan.provider_rows then 'succeeded'
          when accounting.intent_committed>0 then 'attempted'
          when accounting.execution_id is not null then 'admitted'
          when review.plan_id is null then 'awaiting review' else 'approved' end,
        p.source_batch_id,b.tag,plan.provider_rows,false,0,null::timestamptz,null::uuid,
        case when cycle.execution_id is null then '/optimizer/confirm/' else '/optimizer/run/' end||p.source_batch_id::text||'?profile='||p.profile_id::text||'&plan='||p.plan_id::text
          ||case when cycle.execution_id is null then '' else '&execution='||cycle.execution_id::text end
      from public.sp_write_restore_proposals p
      join public.sp_write_plans plan on plan.org_id=p.org_id and plan.profile_id=p.profile_id and plan.plan_id=p.plan_id
      left join public.apply_batches b on b.org_id=p.org_id and b.profile_id=p.profile_id and b.id=p.source_batch_id
      left join public.sp_write_cycle_plans cycle on cycle.org_id=p.org_id and cycle.profile_id=p.profile_id and cycle.plan_id=p.plan_id
      left join public.sp_write_execution_accounting accounting on accounting.org_id=cycle.org_id and accounting.profile_id=cycle.profile_id
        and accounting.execution_id=cycle.execution_id and accounting.plan_id=cycle.plan_id
      left join public.sp_write_restore_reviews review on review.org_id=p.org_id and review.profile_id=p.profile_id and review.plan_id=p.plan_id
      where p.org_id=${input.orgId}::uuid and p.profile_id=${input.profileId}::uuid
        and plan.artifact #>> '{source,restoreProposal,kind}'='restore_proposal'
    ) select jsonb_build_object('id',id,'when',to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'entity',entity,'entityType',entity_type,'entityId',entity_id,'field',field,'oldValue',old_value,'newValue',new_value,
      'source',source,'state',state,'batchId',batch_id,'batchLabel',batch_label,'batchCount',batch_count,
      'experimentStart',experiment_start,'candidateCount',candidate_count,'acknowledgedAt',acknowledged_at,
      'acknowledgedBy',acknowledged_by,'reviewHref',review_href) as artifact
    from entries where (${input.source ?? null}::text is null or source=${input.source ?? null})
      and (${input.state ?? null}::text is null or state=${input.state ?? null})
      and (${input.field ?? null}::text is null or field=${input.field ?? null})
      and (${input.entityType ?? null}::text is null or entity_type=${input.entityType ?? null})
      and (${input.from ?? null}::timestamptz is null or at>=${input.from ?? null}::timestamptz)
      and (${input.to ?? null}::timestamptz is null or at<=${input.to ?? null}::timestamptz)
      and (${input.before?.observedAt ?? null}::timestamptz is null or (at,id collate "C")<(${input.before?.observedAt ?? null}::timestamptz,${input.before?.id ?? null}::text collate "C"))
    order by at desc,id collate "C" desc limit ${limit}
  `;
  const entries = result.map(({ artifact }) => ChangeQueueEntry.parse(artifact));
  for (const row of entries) {
    if (row.source === 'queued') row.reviewHref = `/targets/${encodeURIComponent(row.entityId)}/queue/${row.reviewHref}?${new URLSearchParams({profile:input.profileId})}`;
  }
  if (entries.length !== result.length || new Set(entries.map((row) => row.id)).size !== entries.length) throw new Error('Change queue count mismatch');
  // Native rows retain their independent provider and observation state. Fetch
  // another bounded window when a state filter removes candidates from this one.
  const native: ChangeQueueEntry[] = [];
  if (input.source == null || input.source === 'apply') {
    let before = input.before ?? null;
    for (;;) {
      const window = await listNativeTimeline(handle.sql, { orgId: input.orgId, profileId: input.profileId,
        from: input.from, to: input.to, field: input.field, entityTypes: input.entityType ? [input.entityType] : null,
        before, limit });
      const restorePlans = window.length === 0 ? [] : await handle.sql<{ plan_id: string }[]>`select plan_id::text
        from public.sp_write_restore_proposals where org_id=${input.orgId}::uuid and profile_id=${input.profileId}::uuid
          and plan_id=any(${window.flatMap((entry) => entry.write ? [entry.write.execution.operation.planId] : [])}::uuid[])`;
      const restoreIds = new Set(restorePlans.map((row) => row.plan_id));
      for (const entry of window) {
        const write = entry.write;
        if (write === null) throw new Error('Native history evidence missing');
        if (restoreIds.has(write.execution.operation.planId)) continue;
        const state: ChangeQueueState = write.phase === 'observed_requested' ? 'observed'
          : write.phase === 'awaiting_observation' ? 'succeeded'
          : write.phase === 'awaiting_result' || write.phase === 'ambiguous' ? 'attempted'
          : write.phase === 'queued' ? (write.execution.admission === 'queued' ? 'admitted' : 'approved') : 'failed';
        if (input.state && input.state !== state) continue;
        native.push(ChangeQueueEntry.parse({ id: entry.id, when: entry.observedAtExact, entity: entry.entityName ?? entry.amazonId,
          entityId: entry.amazonId, entityType: entry.entityType, field: entry.field, oldValue: entry.oldValue, newValue: entry.newValue,
          source: 'apply', state, batchId: null, batchLabel: entry.batch?.tag ?? null,
          batchCount: write.execution.receipt.plan.counts.providerRows, experimentStart: false, candidateCount: 0,
          acknowledgedAt: null, acknowledgedBy: null, reviewHref: null }));
      }
      const last = window.at(-1);
      if (native.length >= limit || window.length < limit || !last) break;
      before = { observedAt: last.observedAtExact, id: last.id };
    }
  }
  return [...entries,...native].sort((a,b) => a.when < b.when ? 1 : a.when > b.when ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0).slice(0,limit);
}

export async function countChangeQueue(handle: TimeMachineReadHandle, scope: { orgId: string; profileId: string }): Promise<number> {
  const [row] = await handle.sql<{ count: number }[]>`select (
    (select count(*) from public.queued_changes q where q.org_id=${scope.orgId}::uuid and q.profile_id=${scope.profileId}::uuid
      and not exists(select 1 from public.queued_change_approvals a where a.org_id=q.org_id and a.profile_id=q.profile_id and a.change_id=q.id))
    +(select count(*) from public.sp_write_restore_proposals p where p.org_id=${scope.orgId}::uuid and p.profile_id=${scope.profileId}::uuid
      and not exists(select 1 from public.sp_write_restore_reviews r where r.org_id=p.org_id and r.profile_id=p.profile_id and r.plan_id=p.plan_id)
      and not exists(select 1 from public.sp_write_cycle_plans c where c.org_id=p.org_id and c.profile_id=p.profile_id and c.plan_id=p.plan_id))
    +(select count(*) from public.entity_changes ec where ec.org_id=${scope.orgId}::uuid and ec.profile_id=${scope.profileId}::uuid
      and ec.source='sync' and ec.acknowledged_at is null))::int as count`;
  if (row === undefined) throw new Error('Change queue count unavailable');
  return row.count;
}

export async function acknowledgeObservedChange(context: AuthenticatedEditorTransaction,
  input: { profileId: string; changeId: string }): Promise<void> {
  if (!/^[1-9][0-9]*$/.test(input.changeId)) throw new Error('Invalid observed change identity');
  const rows = await context.sql<{ id: string }[]>`select app.acknowledge_observed_change(${context.actor.orgId}::uuid,
    ${input.profileId}::uuid,${input.changeId}::bigint)::text as id`;
  if (rows.length !== 1 || rows[0]?.id !== input.changeId) throw new Error('Acknowledgement count mismatch');
}
