/**
 * Feedback items, votes, and the roadmap read model (WP-15).
 *
 * Web mutations use the complete actor command below: current member authority,
 * authenticated RLS, explicit organization predicates and readback share one
 * transaction. Low-level helpers remain available to explicit service callers;
 * their privileged handles do not gain RLS protection from an org predicate.
 */
import {
  FEEDBACK_TYPES, FEEDBACK_SEVERITIES, FEEDBACK_STATUSES, FeedbackBody, FeedbackTitle,
  FeedbackCommand, FeedbackCommandResult, FeedbackSeverity as FeedbackSeveritySchema,
  OrgActor, OrgRole, ORG_CAPABILITY_ROLES,
} from '@wizard-ads/shared';
import type { FeedbackType, FeedbackSeverity, FeedbackStatus, FeedbackItemRecord } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';
import type { JsonValue } from './goto.js';
import { toDate } from './pg-time.js';
import { withAuthenticatedIdentity } from './authenticated-actor.js';

export type FeedbackQueryHandle = QueryHandle;

export { FEEDBACK_TYPES, FEEDBACK_SEVERITIES, FEEDBACK_STATUSES };
export type { FeedbackType, FeedbackSeverity, FeedbackStatus, FeedbackItemRecord };

/** The three roadmap columns, in the order they are shown. */
export const ROADMAP_STATUSES = ['planned', 'in_progress', 'shipped'] as const;

/** Open means "still on somebody's plate": not shipped, not declined. */
export const OPEN_FEEDBACK_STATUSES = ['new', 'triaged', 'planned', 'in_progress'] as const;

export type FeedbackSort = 'votes' | 'newest';

export interface FeedbackCounts {
  openBugs: number;
  openFeatures: number;
  shipped: number;
  declined: number;
  total: number;
}

export interface CreateFeedbackInput {
  orgId: string;
  authorId?: string | null;
  type: FeedbackType;
  title: string;
  body?: string;
  severity?: FeedbackSeverity | null;
  pageContext?: JsonValue;
}

export interface ListFeedbackInput {
  orgId: string;
  viewerId?: string | null;
  type?: FeedbackType | null;
  status?: FeedbackStatus | null;
  statuses?: readonly FeedbackStatus[] | null;
  sort?: FeedbackSort;
  limit?: number;
}

export interface RoadmapBoard {
  planned: FeedbackItemRecord[];
  inProgress: FeedbackItemRecord[];
  shipped: FeedbackItemRecord[];
  /** Shown collapsed, with the admin note: honesty beats silence. */
  declined: FeedbackItemRecord[];
}

export interface BugBoard {
  open: FeedbackItemRecord[];
  inProgress: FeedbackItemRecord[];
  fixed: FeedbackItemRecord[];
  /** Ordinary declines. Duplicate rows are nested beneath their target instead. */
  declined: FeedbackItemRecord[];
  duplicates: FeedbackItemRecord[];
}

interface FeedbackRow {
  id: string;
  org_id: string;
  author_id: string | null;
  type: FeedbackType;
  title: string;
  body: string;
  severity: FeedbackSeverity | null;
  status: FeedbackStatus;
  admin_note: string | null;
  duplicate_of: string | null;
  dedup_checked_at: Date | string | null;
  page_context: JsonValue;
  votes: string | number;
  viewer_has_voted: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  status_changed_at: Date | string;
}

const toItem = (row: FeedbackRow): FeedbackItemRecord => ({
  id: row.id,
  orgId: row.org_id,
  authorId: row.author_id,
  type: row.type,
  title: row.title,
  body: row.body,
  severity: row.severity,
  status: row.status,
  adminNote: row.admin_note,
  duplicateOf: row.duplicate_of,
  dedupCheckedAt: row.dedup_checked_at === null ? null : toDate(row.dedup_checked_at),
  pageContext: row.page_context,
  votes: Number(row.votes),
  viewerHasVoted: row.viewer_has_voted,
  createdAt: toDate(row.created_at),
  updatedAt: toDate(row.updated_at),
  statusChangedAt: toDate(row.status_changed_at),
});

export class FeedbackNotFound extends Error {
  constructor(message = 'Feedback item not found') {
    super(message);
    this.name = 'FeedbackNotFound';
  }
}

export class FeedbackNotEditable extends Error {
  constructor(message = 'A feedback item can only be edited by its author while it is new') {
    super(message);
    this.name = 'FeedbackNotEditable';
  }
}

export class FeedbackInputError extends Error {}

/** Fixed errors never retain SQL text, parameters, request data or driver causes. */
export class FeedbackCommandError extends Error {
  constructor(readonly code: 'invalid' | 'not_found' | 'forbidden' | 'unconfirmed') {
    super({ invalid: 'Check the feedback fields and try again.', not_found: 'Feedback item or context not found',
      forbidden: 'This feedback change is not permitted.',
      unconfirmed: 'The save could not be confirmed. Reload before trying again.' }[code]);
    this.name = 'FeedbackCommandError';
  }
}

export function normalizeFeedbackTitle(title: string): string {
  const parsed = FeedbackTitle.safeParse(title);
  if (!parsed.success) throw new FeedbackInputError(parsed.error.issues[0]!.message);
  return parsed.data;
}

export function normalizeFeedbackBody(body: string | undefined): string {
  const parsed = FeedbackBody.safeParse(body ?? '');
  if (!parsed.success) throw new FeedbackInputError(parsed.error.issues[0]!.message);
  return parsed.data;
}

/**
 * Severity belongs to bugs. Rejected here as well as by the check constraint,
 * because a caller deserves the reason rather than a constraint name.
 */
export function normalizeFeedbackSeverity(
  type: FeedbackType,
  severity: FeedbackSeverity | null | undefined,
): FeedbackSeverity | null {
  if (severity === null || severity === undefined) return null;
  if (type !== 'bug') throw new FeedbackInputError('Only a bug report carries a severity');
  const parsed = FeedbackSeveritySchema.safeParse(severity);
  if (!parsed.success) throw new FeedbackInputError('Unknown feedback severity');
  return parsed.data;
}

function serializeContext(context: JsonValue | undefined): string {
  const serialized = JSON.stringify(context ?? {});
  if (serialized === undefined) throw new Error('Feedback page context must be JSON-serializable');
  return serialized;
}

export async function createFeedbackItem(
  handle: FeedbackQueryHandle,
  input: CreateFeedbackInput,
): Promise<FeedbackItemRecord> {
  if (!FEEDBACK_TYPES.includes(input.type)) throw new Error(`Unknown feedback type: ${input.type}`);
  const title = normalizeFeedbackTitle(input.title);
  const body = normalizeFeedbackBody(input.body);
  const severity = normalizeFeedbackSeverity(input.type, input.severity);

  // Operator rule (2026-08-27): a feature request lands straight on the
  // roadmap as Planned — there is no separate "requested" waiting room. Bugs
  // keep the triage default.
  const initialStatus = input.type === 'feature' ? 'planned' : 'new';
  const rows = await handle.sql<{ id: string }[]>`
    insert into public.feedback_items
      (org_id, author_id, type, title, body, severity, status, page_context)
    values (
      ${input.orgId}, ${input.authorId ?? null}, ${input.type}::public.feedback_type,
      ${title}, ${body}, ${severity}::public.feedback_severity,
      ${initialStatus}::public.feedback_status,
      ${serializeContext(input.pageContext)}::text::jsonb
    )
    returning id
  `;
  const id = rows[0]?.id;
  if (rows.length !== 1 || !id) throw new Error('Creating a feedback item returned an unexpected row count');
  const created = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: id,
    viewerId: input.authorId ?? null,
  });
  if (!created) throw new Error('A feedback item was created but could not be read back');
  return created;
}

export async function getFeedbackItem(
  handle: FeedbackQueryHandle,
  input: { orgId: string; itemId: string; viewerId?: string | null },
): Promise<FeedbackItemRecord | null> {
  const viewerId = input.viewerId ?? null;
  const rows = await handle.sql<FeedbackRow[]>`
    select i.id, i.org_id, i.author_id, i.type::text as type, i.title, i.body,
           i.severity::text as severity, i.status::text as status, i.admin_note,
           i.duplicate_of, i.dedup_checked_at, i.page_context,
           (select count(*) from public.feedback_votes v where v.org_id = i.org_id and v.item_id = i.id) as votes,
           exists(
             select 1 from public.feedback_votes v
              where v.org_id = i.org_id and v.item_id = i.id and v.user_id = ${viewerId}::uuid
           ) as viewer_has_voted,
           i.created_at, i.updated_at, i.status_changed_at
      from public.feedback_items i
     where i.org_id = ${input.orgId} and i.id = ${input.itemId}
  `;
  return rows[0] ? toItem(rows[0]) : null;
}

export async function listFeedbackItems(
  handle: FeedbackQueryHandle,
  input: ListFeedbackInput,
): Promise<FeedbackItemRecord[]> {
  const viewerId = input.viewerId ?? null;
  const statuses = input.statuses?.length ? [...input.statuses] : null;
  const sort: FeedbackSort = input.sort ?? 'newest';
  const limit = input.limit ?? 500;

  const rows = await handle.sql<FeedbackRow[]>`
    select i.id, i.org_id, i.author_id, i.type::text as type, i.title, i.body,
           i.severity::text as severity, i.status::text as status, i.admin_note,
           i.duplicate_of, i.dedup_checked_at, i.page_context,
           (select count(*) from public.feedback_votes v where v.org_id = i.org_id and v.item_id = i.id) as votes,
           exists(
             select 1 from public.feedback_votes v
              where v.org_id = i.org_id and v.item_id = i.id and v.user_id = ${viewerId}::uuid
           ) as viewer_has_voted,
           i.created_at, i.updated_at, i.status_changed_at
      from public.feedback_items i
     where i.org_id = ${input.orgId}
       and (${input.type ?? null}::text is null or i.type::text = ${input.type ?? null})
       and (${input.status ?? null}::text is null or i.status::text = ${input.status ?? null})
       and (${statuses}::text[] is null or i.status::text = any(${statuses}::text[]))
     -- One statement rather than two, so the projection cannot drift between
     -- the two orderings. The CASE collapses to a constant per query.
     order by (case when ${sort} = 'votes'
                    then (select count(*) from public.feedback_votes v where v.org_id = i.org_id and v.item_id = i.id)
                    else 0 end) desc,
              i.created_at desc, i.id
     limit ${limit}
  `;
  return rows.map(toItem);
}

export async function countFeedback(
  handle: FeedbackQueryHandle,
  orgId: string,
): Promise<FeedbackCounts> {
  const rows = await handle.sql<
    { open_bugs: string; open_features: string; shipped: string; declined: string; total: string }[]
  >`
    -- The open statuses are spelled out rather than bound: they are constants
    -- of this module, and an enum array parameter is the one shape the driver
    -- and the server disagree about.
    select
      count(*) filter (
        where type = 'bug' and status in ('new', 'triaged', 'planned', 'in_progress')
      ) as open_bugs,
      count(*) filter (
        where type = 'feature' and status in ('new', 'triaged', 'planned', 'in_progress')
      ) as open_features,
      count(*) filter (where status = 'shipped') as shipped,
      count(*) filter (where status = 'declined') as declined,
      count(*) as total
    from public.feedback_items
   where org_id = ${orgId}
  `;
  const row = rows[0];
  return {
    openBugs: Number(row?.open_bugs ?? 0),
    openFeatures: Number(row?.open_features ?? 0),
    shipped: Number(row?.shipped ?? 0),
    declined: Number(row?.declined ?? 0),
    total: Number(row?.total ?? 0),
  };
}

/**
 * The board. One query, split in memory, so the three columns are guaranteed to
 * come from the same snapshot and the same vote counts.
 */
export async function listRoadmap(
  handle: FeedbackQueryHandle,
  input: { orgId: string; viewerId?: string | null },
): Promise<RoadmapBoard> {
  const items = await listFeedbackItems(handle, {
    orgId: input.orgId,
    viewerId: input.viewerId ?? null,
    statuses: [...ROADMAP_STATUSES, 'declined'],
    sort: 'votes',
  });
  return {
    planned: items.filter((item) => item.status === 'planned'),
    inProgress: items.filter((item) => item.status === 'in_progress'),
    shipped: items.filter((item) => item.status === 'shipped'),
    declined: items.filter((item) => item.status === 'declined'),
  };
}

/**
 * The bug board's complete read model. Planned bugs share the in-progress
 * column so every non-terminal status has a visible home.
 */
export async function listBugBoard(
  handle: FeedbackQueryHandle,
  input: { orgId: string; viewerId?: string | null },
): Promise<BugBoard> {
  const items = await listFeedbackItems(handle, {
    orgId: input.orgId,
    viewerId: input.viewerId ?? null,
    type: 'bug',
    sort: 'votes',
  });
  const ordinary = items.filter((item) => item.duplicateOf === null);
  return {
    open: ordinary.filter((item) => item.status === 'new' || item.status === 'triaged'),
    inProgress: ordinary.filter(
      (item) => item.status === 'planned' || item.status === 'in_progress',
    ),
    fixed: ordinary.filter((item) => item.status === 'shipped'),
    declined: ordinary.filter((item) => item.status === 'declined'),
    duplicates: items.filter((item) => item.duplicateOf !== null),
  };
}

/** Escape wildcard characters so a title fragment remains a literal fragment. */
function feedbackTitlePattern(query: string): string | null {
  const normalized = query.trim().replace(/\s+/g, ' ').slice(0, 200);
  if (normalized.length < 3) return null;
  return `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
}

/** Deterministic pre-submit candidates; semantic matching belongs to the 24/7 job. */
export async function findSimilarOpenBugs(
  handle: FeedbackQueryHandle,
  input: { orgId: string; viewerId?: string | null; query: string; limit?: number },
): Promise<FeedbackItemRecord[]> {
  const pattern = feedbackTitlePattern(input.query);
  if (pattern === null) return [];
  const viewerId = input.viewerId ?? null;
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const rows = await handle.sql<FeedbackRow[]>`
    select i.id, i.org_id, i.author_id, i.type::text as type, i.title, i.body,
           i.severity::text as severity, i.status::text as status, i.admin_note,
           i.duplicate_of, i.dedup_checked_at, i.page_context,
           (select count(*) from public.feedback_votes v where v.org_id = i.org_id and v.item_id = i.id) as votes,
           exists(
             select 1 from public.feedback_votes v
              where v.org_id = i.org_id and v.item_id = i.id and v.user_id = ${viewerId}::uuid
           ) as viewer_has_voted,
           i.created_at, i.updated_at, i.status_changed_at
      from public.feedback_items i
     where i.org_id = ${input.orgId}
       and i.type = 'bug'
       and i.status in ('new', 'triaged', 'planned', 'in_progress')
       and i.duplicate_of is null
       and i.title ilike ${pattern} escape '\\'
     order by (select count(*) from public.feedback_votes v where v.org_id = i.org_id and v.item_id = i.id) desc,
              i.created_at desc, i.id
     limit ${limit}
  `;
  return rows.map(toItem);
}

/**
 * Cast or withdraw one person's vote, and report the resulting count.
 *
 * A delete that removed a row means the vote was on; otherwise it is inserted.
 * A conflict is not a confirmed toggle. Actor commands serialize through their
 * held authority lock; callers outside that boundary may receive a refusal.
 */
export async function toggleFeedbackVote(
  handle: FeedbackQueryHandle,
  input: { orgId: string; itemId: string; userId: string },
): Promise<{ itemId: string; voted: boolean; votes: number }> {
  const exists = await handle.sql<{ id: string }[]>`
    select id from public.feedback_items
     where org_id = ${input.orgId} and id = ${input.itemId}
  `;
  if (!exists[0]) throw new FeedbackNotFound();

  const removed = await handle.sql<{ item_id: string }[]>`
    delete from public.feedback_votes
     where org_id = ${input.orgId} and item_id = ${input.itemId} and user_id = ${input.userId}
    returning item_id
  `;
  if (removed.length > 1) throw new Error('Unexpected feedback vote removal count');
  if (removed.length === 0) {
    const inserted = await handle.sql<{ item_id: string }[]>`
      insert into public.feedback_votes (item_id, org_id, user_id)
      values (${input.itemId}, ${input.orgId}, ${input.userId})
      on conflict (item_id, user_id) do nothing
      returning item_id
    `;
    if (inserted.length !== 1) throw new Error('Feedback vote transition could not be confirmed');
  }

  const counted = await handle.sql<{ votes: string; voted: boolean }[]>`
    select
      (select count(*) from public.feedback_votes v where v.org_id = ${input.orgId} and v.item_id = ${input.itemId}) as votes,
      exists(
        select 1 from public.feedback_votes v
         where v.org_id = ${input.orgId} and v.item_id = ${input.itemId} and v.user_id = ${input.userId}
      ) as voted
  `;
  const votes = Number(counted[0]?.votes);
  if (counted.length !== 1 || !Number.isSafeInteger(votes) || votes < 0
    || counted[0]?.voted !== (removed.length === 0)) throw new Error('Feedback vote readback differs');
  return {
    itemId: input.itemId,
    voted: counted[0].voted,
    votes,
  };
}

/**
 * Mark one item as another's duplicate in a single tenant-scoped transition.
 * The type predicate prevents a bug from being hidden under a feature request.
 */
export async function markFeedbackDuplicate(
  handle: FeedbackQueryHandle,
  input: {
    orgId: string;
    itemId: string;
    duplicateOf: string;
    viewerId?: string | null;
  },
): Promise<FeedbackItemRecord> {
  const rows = await handle.sql<{ id: string }[]>`
    update public.feedback_items source
       set status = 'declined',
           admin_note = 'duplicate of #' || target.id::text,
           duplicate_of = target.id
      from public.feedback_items target
     where source.org_id = ${input.orgId}
       and source.id = ${input.itemId}
       and target.org_id = ${input.orgId}
       and target.id = ${input.duplicateOf}
       and target.type = source.type
       and target.id <> source.id
    returning source.id
  `;
  const id = rows[0]?.id;
  if (rows.length !== 1 || !id) throw new FeedbackNotFound('Feedback item or duplicate target not found');
  const item = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: id,
    viewerId: input.viewerId ?? null,
  });
  if (!item) throw new FeedbackNotFound();
  return item;
}

/** Triage. Owner/admin only; the caller checks the role, the database checks it again. */
export async function setFeedbackStatus(
  handle: FeedbackQueryHandle,
  input: {
    orgId: string;
    itemId: string;
    status?: FeedbackStatus;
    adminNote?: string | null;
    viewerId?: string | null;
  },
): Promise<FeedbackItemRecord> {
  if (input.status === undefined && input.adminNote === undefined) {
    throw new Error('A triage update must change the status or the note');
  }
  if (input.status !== undefined && !FEEDBACK_STATUSES.includes(input.status)) {
    throw new Error(`Unknown feedback status: ${input.status}`);
  }
  // "Clear the note" and "leave the note alone" are different requests, and a
  // plain coalesce cannot tell them apart: the flag is what keeps an empty
  // string from being read as "no opinion".
  const noteProvided = input.adminNote !== undefined;
  const note = noteProvided ? (input.adminNote?.trim() || null) : null;

  const rows = await handle.sql<{ id: string }[]>`
    update public.feedback_items
       set status = coalesce(${input.status ?? null}::public.feedback_status, status),
           admin_note = case when ${noteProvided} then ${note}::text else admin_note end,
           duplicate_of = case
             when ${input.status ?? null}::text is not null
              and ${input.status ?? null}::text <> 'declined' then null
             else duplicate_of
           end
     where org_id = ${input.orgId} and id = ${input.itemId}
    returning id
  `;
  const id = rows[0]?.id;
  if (rows.length !== 1 || !id) throw new FeedbackNotFound();
  const item = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: id,
    viewerId: input.viewerId ?? null,
  });
  if (!item) throw new FeedbackNotFound();
  return item;
}

/** The author's own correction, allowed only while the item is untriaged. */
export async function updateFeedbackContent(
  handle: FeedbackQueryHandle,
  input: {
    orgId: string;
    itemId: string;
    authorId: string;
    title?: string;
    body?: string;
    severity?: FeedbackSeverity | null;
  },
): Promise<FeedbackItemRecord> {
  if (input.title === undefined && input.body === undefined && input.severity === undefined) {
    throw new Error('An edit must change the title, the description or the severity');
  }
  const current = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: input.itemId,
    viewerId: input.authorId,
  });
  if (!current) throw new FeedbackNotFound();
  if (current.authorId !== input.authorId || current.status !== 'new') {
    throw new FeedbackNotEditable();
  }

  const title = input.title === undefined ? null : normalizeFeedbackTitle(input.title);
  const body = input.body === undefined ? null : normalizeFeedbackBody(input.body);
  const severity =
    input.severity === undefined
      ? null
      : normalizeFeedbackSeverity(current.type, input.severity);

  const rows = await handle.sql<{ id: string }[]>`
    update public.feedback_items
       set title = case when ${input.title !== undefined} then ${title}::text else title end,
           body = case when ${input.body !== undefined} then ${body}::text else body end,
           severity = case when ${input.severity !== undefined} then ${severity}::public.feedback_severity else severity end
     where org_id = ${input.orgId}
       and id = ${input.itemId}
       and author_id = ${input.authorId}
       and status = 'new'
    returning id
  `;
  if (rows.length !== 1) throw new FeedbackNotEditable();
  const item = await getFeedbackItem(handle, {
    orgId: input.orgId,
    itemId: input.itemId,
    viewerId: input.authorId,
  });
  if (!item) throw new FeedbackNotFound();
  return item;
}

/** One complete authenticated command. An exception never authorizes replay. */
export async function mutateFeedbackForActor(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  rawCommand: FeedbackCommand,
): Promise<FeedbackCommandResult> {
  try {
    const actorParse = OrgActor.safeParse(rawActor);
    if (!actorParse.success) throw new FeedbackCommandError('forbidden');
    const actor = Object.freeze(actorParse.data);
    const commandParse = FeedbackCommand.safeParse(rawCommand);
    if (!commandParse.success) throw new FeedbackCommandError('invalid');
    const command = commandParse.data;
    return await withAuthenticatedIdentity(handle, { userId: actor.userId }, async (sql) => {
      const [locked] = await sql<{ role: string }[]>`select app.lock_feedback_member(${actor.orgId}::uuid) as role`;
      const role = OrgRole.parse(locked?.role);
      if ((command.kind === 'triage' || command.kind === 'duplicate')
        && !(ORG_CAPABILITY_ROLES.triageFeedback as readonly OrgRole[]).includes(role)) {
        throw new FeedbackCommandError('forbidden');
      }
      const query = { sql };
      let result: FeedbackCommandResult;
      switch (command.kind) {
        case 'create': {
          const context = command.pageContext ?? { route: null, profileId: null, appVersion: null };
          if (context.profileId !== null) {
            const profiles = await sql`select id from public.ad_profiles
              where org_id=${actor.orgId} and id=${context.profileId}`;
            if (profiles.length !== 1) throw new FeedbackCommandError('not_found');
          }
          const item = await createFeedbackItem(query, { ...command, orgId: actor.orgId, authorId: actor.userId,
            pageContext: { ...context, actorType: 'user' } });
          result = { kind: 'created', item };
          break;
        }
        case 'edit':
          result = { kind: 'updated', item: await updateFeedbackContent(query, { ...command, orgId: actor.orgId, authorId: actor.userId }) };
          break;
        case 'triage':
          result = { kind: 'updated', item: await setFeedbackStatus(query, { ...command, orgId: actor.orgId, viewerId: actor.userId }) };
          break;
        case 'duplicate':
          result = { kind: 'updated', item: await markFeedbackDuplicate(query, { ...command, orgId: actor.orgId, viewerId: actor.userId }) };
          break;
        case 'toggleVote':
          result = { kind: 'vote', ...await toggleFeedbackVote(query, { orgId: actor.orgId, itemId: command.itemId, userId: actor.userId }) };
          break;
      }
      // Validate readback before COMMIT; malformed counts/rows roll back the DML.
      return FeedbackCommandResult.parse(result);
    });
  } catch (error) {
    if (error instanceof FeedbackCommandError) throw error;
    if (error instanceof FeedbackNotFound) throw new FeedbackCommandError('not_found');
    if (error instanceof FeedbackNotEditable) throw new FeedbackCommandError('forbidden');
    if (error instanceof FeedbackInputError) throw new FeedbackCommandError('invalid');
    const sqlError = error as { code?: unknown; message?: unknown } | null;
    if (sqlError?.code === '42501' && sqlError.message === 'Resource not found') throw new FeedbackCommandError('forbidden');
    throw new FeedbackCommandError('unconfirmed');
  }
}
