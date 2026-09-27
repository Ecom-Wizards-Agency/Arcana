/**
 * Creator Connections round 2 against a migrated database: reply drafts under
 * tenant RLS, approvals that append to the action log and send nothing,
 * idempotent submissions, the score a creator:write key reports, the skill's
 * own action-log entries, the record and conflict reads, and the creator:write
 * key class's database rules. Synthetic values only.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asServiceRole, asUser } from '../testing/rls.js';
import { AgencyAccessDenied, withAuthenticatedActor } from './authenticated-actor.js';
import { persistCreatorImport, readCreatorQueue, writeCreatorMcpRows, type CreatorRecordWrite } from './creators.js';
import {
  CreatorWriteRefusal, appendCreatorActions, creatorIdentityOverlap, readCreatorConflict, readCreatorDrafts, readCreatorRecord,
  recordCreatorScore, submitCreatorDraft, transitionCreatorDraft,
} from './creators-records.js';

const available = await databaseAvailable();
const OWNER = '33300000-0000-4000-8000-000000000001';
const ADMIN = '33300000-0000-4000-8000-000000000002';
const ANALYST = '33300000-0000-4000-8000-000000000003';
const VIEWER = '33300000-0000-4000-8000-000000000004';
const FOREIGN = '33300000-0000-4000-8000-000000000005';
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');

const record = (id: string, change: Partial<CreatorRecordWrite> = {}): CreatorRecordWrite => ({
  creatorRecordId: id, brand: 'Synthetic brand', campaignId: 'campaign-synthetic-1',
  fingerprints: { storefront: fp(`${id}:storefront`), thread: fp(`${id}:thread`), fullName: null, email: null, phone: null, address: null },
  recordState: 'Active', lockState: 'Unlocked', escalationReason: null, runnerVersion: 1, createdOn: '2026-09-01', lastVerifiedOn: null, ...change,
});
const draftInput = (id: string, change: Record<string, unknown> = {}) => ({
  creator_record_id: id, thread_key: fp(`${id}:thread`), template_key: 'first_base_verification' as const, draft_date: '2026-09-09',
  body: 'Hi {first name}, thanks for reaching out. Could you confirm the remaining details for sample review?', ...change,
});
const scoreResult = (missing: string[]) => {
  const checks = ['complete_fulfillment_details', 'requested_asin', 'exact_product_match', 'storefront_visible', 'recent_post_verified',
    'content_quality', 'category_fit', 'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk'];
  return { score: 10 - missing.length, checks: Object.fromEntries(checks.map((check) => [check, !missing.includes(check)])), missing } as never;
};

describe.skipIf(!available)('Creator Connections records, drafts and the creator:write key class', () => {
  let db: TestDatabase;
  let orgId: string;
  let foreignOrg: string;
  const asOwner = <T>(fn: (sql: Parameters<Parameters<typeof withAuthenticatedActor>[2]>[0]) => Promise<T>) =>
    withAuthenticatedActor(db, { orgId, userId: OWNER }, fn);

  beforeAll(async () => {
    db = await createTestDatabase('wp333_creators');
    const [a] = await db.sql`select app.seed_tenant_fixture('creators-records', ${OWNER}, 'owner') as id`;
    orgId = String(a!['id']);
    const [b] = await db.sql`select app.seed_tenant_fixture('creators-records-foreign', ${FOREIGN}, 'owner') as id`;
    foreignOrg = String(b!['id']);
    for (const [user, role] of [[ADMIN, 'admin'], [ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await db.sql`select public.auth_user_stub(${user})`;
      await db.sql`insert into public.org_members(org_id, user_id, role) values (${orgId}, ${user}, ${role})`;
    }
    const shared = fp('shared-storefront');
    await persistCreatorImport(db, {
      orgId, startedAt: '2026-09-09T06:14:00.000Z', source: 'control-runner', files: ['registry', 'queue'],
      records: { read: 5, invalid: 0, rows: [
        record('CCR-SW-26-0134', { fingerprints: { ...record('CCR-SW-26-0134').fingerprints, email: fp('email-a') } }),
        // A candidate the runner refuses: one contact fingerprint where it needs two.
        record('CCR-SW-26-0091', { fingerprints: { ...record('CCR-SW-26-0091').fingerprints, email: fp('email-a') } }),
        // Two records on one storefront, both locked in Conflict.
        record('CCR-SW-26-0117', { lockState: 'Conflict', escalationReason: 'multiple_active_records_match', runnerVersion: 2, lastVerifiedOn: '2026-08-31',
          fingerprints: { ...record('CCR-SW-26-0117').fingerprints, storefront: shared } }),
        record('CCR-SW-26-0203', { lockState: 'Conflict', escalationReason: 'multiple_active_records_match', runnerVersion: 3, lastVerifiedOn: '2026-09-04',
          fingerprints: { ...record('CCR-SW-26-0203').fingerprints, storefront: shared } }),
        record('CCR-SW-26-0072'),
      ] },
      actions: { read: 1, invalid: 0, rows: [{ eventKey: 'conflict:CCR-SW-26-0117:2', creatorRecordId: 'CCR-SW-26-0117', action: 'identity_conflict_locked',
        occurredAt: null, reservationId: null, asin: null, reasonCode: 'multiple_active_records_match', evidenceReference: null, recordVersion: 2 }] },
      queue: { runDate: '2026-09-09', read: 1, invalid: 0, rows: [{ runDate: '2026-09-09', queueId: '20260909-CCR-SW-26-0134', occurrence: 1,
        creatorRecordId: 'CCR-SW-26-0134', brand: 'Synthetic brand', campaignTab: 'Synthetic tab', currentStatus: 'Verification Confirmed', computedScore: 8,
        missing: ['recent_post_verified', 'performance_or_revenue'], dueDate: '2026-09-09', actionType: 'RECONCILE_QUALIFICATION', gateResult: 'BLOCKED',
        queueState: 'Escalated', reason: 'status_score_drift' }] },
      sweeps: null, shipments: null,
    });
  }, 180_000);
  afterAll(async () => { await db?.drop(); });

  describe('drafts', () => {
    let first: string;

    it('stores a submission once: the same record, thread, template, day and text is one draft', async () => {
      const inserted = await asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0134')));
      expect(inserted).toMatchObject({ status: 'draft', outcome: 'inserted', withdrew: null });
      first = inserted.draftId;
      const replay = await asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0134')));
      expect(replay).toEqual({ draftId: first, status: 'draft', outcome: 'unchanged', withdrew: null });
      const [{ drafts, events }] = await db.sql<[{ drafts: number; events: number }]>`select
        (select count(*)::int from public.creator_drafts where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0134') as drafts,
        (select count(*)::int from public.creator_action_log where org_id = ${orgId} and draft_id = ${first}) as events`;
      expect(drafts).toBe(1);
      expect(events).toBe(1);
    });

    it('withdraws the open draft when a new text arrives for the thread, and logs both', async () => {
      const next = await asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0134', { body: 'Hi {first name}, one more question before review.' })));
      expect(next).toMatchObject({ outcome: 'inserted', withdrew: first });
      const rows = await db.sql<{ id: string; status: string }[]>`select id, status from public.creator_drafts
        where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0134' order by created_at`;
      expect(rows.map((row) => row.status)).toEqual(['withdrawn', 'draft']);
      const actions = await db.sql<{ action: string; source: string }[]>`select action, source from public.creator_action_log
        where org_id = ${orgId} and draft_id = ${first} order by recorded_at, action`;
      expect(actions).toEqual([{ action: 'draft_submitted', source: 'mcp' }, { action: 'draft_withdrawn', source: 'mcp' }]);
      first = next.draftId;
    });

    it('stamps the author from the session and refuses, in the database, a rendered name or a Conflict-locked record', async () => {
      const [row] = await db.sql`select created_by from public.creator_drafts where id = ${first}`;
      expect(row).toEqual({ created_by: OWNER });
      const stamped = await asOwner((sql) => submitCreatorDraft(sql, orgId, ADMIN, draftInput('CCR-SW-26-0091', { thread_key: fp('CCR-SW-26-0091:thread') })));
      const [author] = await db.sql`select created_by from public.creator_drafts where id = ${stamped.draftId}`;
      expect(author).toEqual({ created_by: OWNER });
      const direct = (id: string, body: string, digest: string) => asServiceRole(db, (sql) => sql`insert into public.creator_drafts(org_id, creator_record_id,
          thread_fp, template_key, body, draft_date, submission_digest, source, status_source)
        values (${orgId}, ${id}, ${fp(`${id}:thread-direct`)}, 'proof_request', ${body}, '2026-09-09', ${fp(digest)}, 'mcp', 'mcp')`);
      await expect(direct('CCR-SW-26-0072', 'Hi Synthetic, a rendered name.', 'direct-1')).rejects.toThrow(/creator_drafts_body_check|check constraint/);
      await expect(direct('CCR-SW-26-0117', 'Hi {first name}, synthetic.', 'direct-2')).rejects.toThrow(/locked in Conflict/);
      await expect(asServiceRole(db, (sql) => sql`insert into public.creator_drafts(org_id, creator_record_id, thread_fp, template_key, body, draft_date,
          submission_digest, source, status_source)
        values (${orgId}, 'CCR-SW-26-0072', ${fp('x-thread')}, 'recipient_mismatch_clarification', 'Hi {first name}, synthetic.', '2026-09-09', ${fp('direct-3')},
          'mcp', 'mcp')`)).rejects.toThrow(/check constraint/);
    });

    it('refuses a draft for an unknown record, a Conflict-locked record and a thread the record does not own', async () => {
      const refusal = (input: ReturnType<typeof draftInput>) => asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, input));
      await expect(refusal(draftInput('CCR-SW-26-9999'))).rejects.toMatchObject({ code: 'record_not_found' });
      await expect(refusal(draftInput('CCR-SW-26-0117'))).rejects.toMatchObject({ code: 'record_conflict_locked' });
      await expect(refusal(draftInput('CCR-SW-26-0072', { thread_key: fp('someone-else') }))).rejects.toMatchObject({ code: 'thread_mismatch' });
      await expect(refusal(draftInput('CCR-SW-26-0072', { thread_key: fp('someone-else') }))).rejects.toBeInstanceOf(CreatorWriteRefusal);
    });

    it('lets owners, admins and analysts read drafts, viewers none, and only owners and admins submit', async () => {
      for (const user of [OWNER, ADMIN, ANALYST]) {
        const snapshot = await asUser(db, user, (sql) => readCreatorDrafts({ sql }, orgId));
        expect(snapshot.draftDate, user).toBe('2026-09-09');
        expect(snapshot.rows, user).toHaveLength(3);
        expect(snapshot.submittedEver, user).toBe(4);
      }
      expect((await asUser(db, VIEWER, (sql) => sql`select 1 from public.creator_drafts`)).length).toBe(0);
      const insert = (sql: typeof db.sql, org: string) => sql`insert into public.creator_drafts(org_id, creator_record_id, thread_fp, template_key, body,
          draft_date, submission_digest, source, status_source)
        values (${org}, 'CCR-SW-26-0072', ${fp('CCR-SW-26-0072:thread')}, 'proof_request', 'Hi {first name}, synthetic text.', '2026-09-09', ${fp('digest-x')}, 'web', 'web')`;
      for (const user of [ANALYST, VIEWER]) await expect(asUser(db, user, (sql) => insert(sql, orgId))).rejects.toThrow(/row-level security/);
      await expect(asUser(db, ADMIN, (sql) => insert(sql, foreignOrg))).rejects.toThrow(/row-level security/);
    });

    it('lets one owner or admin approve one draft, stamps who and when from the session, and sends nothing', async () => {
      const tables = await db.sql<{ name: string }[]>`select quote_ident(table_schema) || '.' || quote_ident(table_name) as name
        from information_schema.tables where table_schema in ('public', 'mcp') and table_type = 'BASE TABLE' order by 1`;
      const countAll = async () => Object.fromEntries(await Promise.all(tables.map(async ({ name }) =>
        [name, (await db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${name}`))[0]!.n] as const)));
      const before = await countAll();
      await expect(transitionCreatorDraft(db, { orgId, userId: ANALYST }, first, 'approved')).rejects.toBeInstanceOf(AgencyAccessDenied);
      await expect(transitionCreatorDraft(db, { orgId, userId: VIEWER }, first, 'approved')).rejects.toBeInstanceOf(AgencyAccessDenied);
      await expect(transitionCreatorDraft(db, { orgId: foreignOrg, userId: FOREIGN }, first, 'approved')).rejects.toMatchObject({ code: 'draft_not_found' });
      const approved = await transitionCreatorDraft(db, { orgId, userId: ADMIN }, first, 'approved');
      expect(approved).toMatchObject({ id: first, status: 'approved', approvedBy: ADMIN, closedAt: null });
      expect(approved.approvedAt).not.toBeNull();
      const after = await countAll();
      const changed = Object.keys(before).filter((name) => before[name] !== after[name]);
      expect(changed).toEqual(['public.creator_action_log']);
      expect(after['public.creator_action_log']).toBe(before['public.creator_action_log']! + 1);
      const [entry] = await db.sql`select action, actor_user_id, source, occurred_at is not null as timed from public.creator_action_log
        where org_id = ${orgId} and draft_id = ${first} and action = 'draft_approved'`;
      expect(entry).toEqual({ action: 'draft_approved', actor_user_id: ADMIN, source: 'web', timed: true });
    });

    it('refuses a replacement while a thread has an approved draft, then moves it to sent by hand exactly once', async () => {
      await expect(asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0134', { body: 'Hi {first name}, a third text.' }))))
        .rejects.toMatchObject({ code: 'approved_draft_open' });
      const sent = await transitionCreatorDraft(db, { orgId, userId: OWNER }, first, 'sent_by_hand');
      expect(sent).toMatchObject({ status: 'sent_by_hand', approvedBy: ADMIN, closedBy: OWNER });
      await expect(transitionCreatorDraft(db, { orgId, userId: OWNER }, first, 'withdrawn')).rejects.toMatchObject({ code: 'transition_refused' });
      await expect(transitionCreatorDraft(db, { orgId, userId: OWNER }, first, 'approved')).rejects.toMatchObject({ code: 'transition_refused' });
      const actions = await db.sql<{ action: string }[]>`select action from public.creator_action_log where org_id = ${orgId} and draft_id = ${first}
        order by recorded_at, action`;
      expect(actions.map((row) => row.action)).toEqual(['draft_submitted', 'draft_approved', 'draft_sent_by_hand']);
    });

    it('keeps a draft immutable, undeletable, and unapprovable without a current owner or admin, even as the service role', async () => {
      await expect(asServiceRole(db, (sql) => sql`update public.creator_drafts set body = 'changed' where id = ${first}`)).rejects.toThrow(/immutable/);
      await expect(asServiceRole(db, (sql) => sql`delete from public.creator_drafts where id = ${first}`)).rejects.toThrow(/append-only/);
      const [open] = await db.sql<{ id: string }[]>`select id from public.creator_drafts where org_id = ${orgId} and status = 'draft' limit 1`;
      const pending = open?.id ?? (await asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0072')))).draftId;
      await expect(asServiceRole(db, (sql) => sql`update public.creator_drafts set status = 'approved' where id = ${pending}`))
        .rejects.toThrow(/owner or admin/);
      await expect(asServiceRole(db, (sql) => sql`update public.creator_action_log set source = 'web' where draft_id = ${first}`)).rejects.toThrow(/append-only/);
    });

    it('holds approval while the last import failed, and only approval', async () => {
      const { draftId } = await asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0091', { thread_key: fp('CCR-SW-26-0091:thread'),
        body: 'Hi {first name}, a text while the import is down.' })));
      await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, failure, files, counts, source)
        values (${orgId}, clock_timestamp(), clock_timestamp(), 'failed', 'file_unreadable', '{queue}',
          '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}'::jsonb, 'control-runner')`;
      await expect(transitionCreatorDraft(db, { orgId, userId: OWNER }, draftId, 'approved')).rejects.toMatchObject({ code: 'transition_refused' });
      expect((await transitionCreatorDraft(db, { orgId, userId: OWNER }, draftId, 'withdrawn')).status).toBe('withdrawn');
      await db.sql`insert into public.creator_import_runs(org_id, started_at, finished_at, status, files, counts, source)
        values (${orgId}, clock_timestamp(), clock_timestamp(), 'succeeded', '{registry}',
          '{"records":null,"action_log":null,"queue_items":null,"sweep_runs":null,"sample_shipments":null}'::jsonb, 'control-runner')`;
    });

    it('refuses to approve a draft once its record is locked in Conflict', async () => {
      const { draftId } = await asOwner((sql) => submitCreatorDraft(sql, orgId, OWNER, draftInput('CCR-SW-26-0072', { body: 'Hi {first name}, synthetic text for a record about to lock.' })));
      await db.sql`update public.creator_records set lock_state = 'Conflict' where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0072'`;
      try {
        await expect(transitionCreatorDraft(db, { orgId, userId: OWNER }, draftId, 'approved')).rejects.toMatchObject({ code: 'transition_refused' });
        expect((await transitionCreatorDraft(db, { orgId, userId: OWNER }, draftId, 'withdrawn')).status).toBe('withdrawn');
      } finally {
        await db.sql`update public.creator_records set lock_state = 'Unlocked' where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0072'`;
      }
    });
  });

  describe('score and the skill\'s own entries', () => {
    it('records the runner score beside the tracker status and typed score, once per result and day', async () => {
      const input = { creator_record_id: 'CCR-SW-26-0134', scored_on: '2026-09-10', current_status: 'Verification Confirmed', tracker_score: 10,
        result: scoreResult(['recent_post_verified', 'performance_or_revenue']) };
      expect(await asOwner((sql) => recordCreatorScore(sql, orgId, OWNER, input)))
        .toEqual({ record: 'updated', actionLog: { read: 1, inserted: 1, updated: 0, unchanged: 0 } });
      expect(await asOwner((sql) => recordCreatorScore(sql, orgId, OWNER, input)))
        .toEqual({ record: 'unchanged', actionLog: { read: 1, inserted: 0, updated: 0, unchanged: 1 } });
      const [{ n: logged }] = await db.sql<[{ n: number }]>`select count(*)::int as n from public.creator_action_log where org_id = ${orgId} and action = 'score_recorded'`;
      expect(await asOwner((sql) => recordCreatorScore(sql, orgId, OWNER, { ...input, scored_on: '2026-09-08', tracker_score: null })))
        .toEqual({ record: 'older_than_held', actionLog: { read: 0, inserted: 0, updated: 0, unchanged: 0 } });
      const [{ n: after }] = await db.sql<[{ n: number }]>`select count(*)::int as n from public.creator_action_log where org_id = ${orgId} and action = 'score_recorded'`;
      expect(after).toBe(logged);
      const [row] = await db.sql`select status, computed_score, tracker_score, tracker_scored_on::text as on from public.creator_records
        where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0134'`;
      expect(row).toEqual({ status: 'Verification Confirmed', computed_score: 8, tracker_score: 10, on: '2026-09-10' });
      const [event] = await db.sql`select reason_code from public.creator_action_log where org_id = ${orgId} and action = 'score_recorded'
        and creator_record_id = 'CCR-SW-26-0134' and event_key like 'score:CCR-SW-26-0134:2026-09-10:%'`;
      expect(event).toEqual({ reason_code: 'tracker_score_disagrees' });
      await expect(asOwner((sql) => recordCreatorScore(sql, orgId, OWNER, { ...input, creator_record_id: 'CCR-SW-26-9999' })))
        .rejects.toMatchObject({ code: 'record_not_found' });
    });

    it('appends entries idempotently and refuses a key reused for other content', async () => {
      const entry = { eventKey: 'sent-0134-1', creatorRecordId: 'CCR-SW-26-0134', action: 'message_sent_by_hand', occurredAt: '2026-09-09T06:38:00.000Z',
        reservationId: null, asin: null, reasonCode: null, evidenceReference: 'ev:thread-synthetic-1' };
      expect(await asOwner((sql) => appendCreatorActions(sql, orgId, OWNER, [entry]))).toEqual({ read: 1, inserted: 1, updated: 0, unchanged: 0 });
      expect(await asOwner((sql) => appendCreatorActions(sql, orgId, OWNER, [entry]))).toEqual({ read: 1, inserted: 0, updated: 0, unchanged: 1 });
      await expect(asOwner((sql) => appendCreatorActions(sql, orgId, OWNER, [{ ...entry, reasonCode: 'other' }]))).rejects.toMatchObject({ code: 'event_key_reused' });
      await expect(asOwner((sql) => appendCreatorActions(sql, orgId, OWNER, [{ ...entry, eventKey: 'x', creatorRecordId: 'CCR-SW-26-9999' }])))
        .rejects.toMatchObject({ code: 'record_not_found' });
      const [stored] = await db.sql`select event_key, actor_user_id, source from public.creator_action_log where org_id = ${orgId} and event_key = 'skill:sent-0134-1'`;
      expect(stored).toEqual({ event_key: 'skill:sent-0134-1', actor_user_id: OWNER, source: 'mcp' });
    });

    it('writes MCP rows through the import\'s keys and digests: a row the import wrote is unchanged', async () => {
      const again = await asOwner((sql) => writeCreatorMcpRows(sql, orgId, { records: [record('CCR-SW-26-0072')], actions: [{ eventKey: 'conflict:CCR-SW-26-0117:2',
        creatorRecordId: 'CCR-SW-26-0117', action: 'identity_conflict_locked', occurredAt: null, reservationId: null, asin: null,
        reasonCode: 'multiple_active_records_match', evidenceReference: null, recordVersion: 2 }] }));
      expect(again).toEqual({ records: { read: 1, inserted: 0, updated: 0, unchanged: 1 }, action_log: { read: 1, inserted: 0, updated: 0, unchanged: 1 } });
      const [{ runs }] = await db.sql<[{ runs: number }]>`select count(*)::int as runs from public.creator_import_runs where org_id = ${orgId} and source = 'mcp'`;
      expect(runs).toBe(0);
      await expect(asUser(db, ANALYST, (sql) => writeCreatorMcpRows(sql, orgId, { records: [record('CCR-SW-26-0555')] }))).rejects.toThrow(/row-level security/);
    });

    it('never lets an older runner version overwrite a newer record, on either path', async () => {
      const locked = record('CCR-SW-26-0203', { lockState: 'Conflict', escalationReason: 'multiple_active_records_match', runnerVersion: 3,
        lastVerifiedOn: '2026-09-04', fingerprints: { ...record('CCR-SW-26-0203').fingerprints, storefront: fp('shared-storefront') } });
      const stale = { ...locked, lockState: 'Unlocked' as const, escalationReason: null, runnerVersion: 2 };
      expect((await asOwner((sql) => writeCreatorMcpRows(sql, orgId, { records: [stale] }))).records).toEqual({ read: 1, inserted: 0, updated: 0, unchanged: 1 });
      const run = await persistCreatorImport(db, { orgId, startedAt: new Date().toISOString(), source: 'control-runner', files: ['registry'],
        records: { read: 1, invalid: 0, rows: [stale] }, actions: null, queue: null, sweeps: null, shipments: null });
      expect(run.counts.records).toMatchObject({ updated: 0, unchanged: 1 });
      const [held] = await db.sql`select lock_state, runner_version from public.creator_records where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0203'`;
      expect(held).toEqual({ lock_state: 'Conflict', runner_version: 3 });
    });
  });

  describe('reads', () => {
    it('shows one record with its refused candidate, its score, its queue row and everything since', async () => {
      const detail = await asUser(db, ANALYST, (sql) => readCreatorRecord({ sql }, orgId, 'CCR-SW-26-0134'));
      expect(detail).not.toBeNull();
      expect(detail!.record.qualification).toMatchObject({ score: 8, missing: ['recent_post_verified', 'performance_or_revenue'] });
      expect(detail!.trackerScore).toEqual({ score: 10, scoredOn: '2026-09-10' });
      expect(detail!.identity).toBeNull();
      expect(detail!.refusedCandidates).toEqual([{ creatorRecordId: 'CCR-SW-26-0091', lockState: 'Unlocked', shared: ['email'], rule: 'one_contact_fingerprint' }]);
      expect(detail!.matching).toEqual([]);
      expect(detail!.queueItem?.actionType).toBe('RECONCILE_QUALIFICATION');
      expect(detail!.events.map((event) => event.action)).toEqual(expect.arrayContaining(['score_recorded', 'message_sent_by_hand', 'draft_submitted']));
      expect(detail!.drafts.length).toBeGreaterThanOrEqual(2);
      expect(await asUser(db, ANALYST, (sql) => readCreatorRecord({ sql }, orgId, 'CCR-SW-26-9999'))).toBeNull();
      expect(await asUser(db, VIEWER, (sql) => readCreatorRecord({ sql }, orgId, 'CCR-SW-26-0134'))).toBeNull();
    });

    it('shows a conflict with the record it collides with on one storefront', async () => {
      const conflict = await asUser(db, ANALYST, (sql) => readCreatorConflict({ sql }, orgId, 'CCR-SW-26-0117'));
      expect(conflict?.lockedSince).toBe('2026-08-31');
      expect(conflict?.counterparts.map((item) => [item.record.creatorRecordId, item.shared, item.namedByResolution]))
        .toEqual([['CCR-SW-26-0203', ['storefront'], false]]);
      expect(conflict?.events.map((event) => [event.creatorRecordId, event.action])).toEqual([['CCR-SW-26-0117', 'identity_conflict_locked']]);
    });

    it('applies the runner\'s rungs between two records', async () => {
      const base = (await asUser(db, ANALYST, (sql) => readCreatorRecord({ sql }, orgId, 'CCR-SW-26-0134')))!.record;
      const other = { ...base, creatorRecordId: 'CCR-SW-26-0999', fingerprints: { ...base.fingerprints, storefront: null, email: null } };
      expect(creatorIdentityOverlap(base, other)).toEqual({ kind: 'match', shared: ['thread'] });
      expect(creatorIdentityOverlap(base, { ...other, campaignId: 'campaign-other' })).toEqual({ kind: 'refused', shared: ['thread'], rule: 'thread_on_other_campaign' });
      expect(creatorIdentityOverlap(base, { ...other, fingerprints: { ...other.fingerprints, thread: null } })).toBeNull();
    });

    it('groups the records the queue did not name by reported status and returns the tracker scores it did', async () => {
      await db.sql`update public.creator_records set status = 'Awaiting Sample', computed_score = 10, missing_checks = '{}', qualified_on = '2026-09-09'
        where org_id = ${orgId} and creator_record_id = 'CCR-SW-26-0091'`;
      const snapshot = await asUser(db, ANALYST, (sql) => readCreatorQueue({ sql }, orgId));
      expect(snapshot.trackerScores).toEqual([{ creatorRecordId: 'CCR-SW-26-0134', trackerScore: 10, scoredOn: '2026-09-10' }]);
      expect(snapshot.idle).toEqual([{ status: null, recognised: null, records: 4 }, { status: 'Awaiting Sample', recognised: false, records: 1 }]);
      expect(snapshot.idle.reduce((sum, group) => sum + group.records, 0)).toBe(snapshot.registryRecords - 1);
    });
  });

  describe('the creator:write key class', () => {
    const insertKey = (scope: string, profiles: string, createdBy = OWNER) => db.sql`insert into mcp.api_keys(org_id, label, key_prefix, token_hash, scope,
        profile_ids, expires_at, created_by)
      values (${orgId}, 'synthetic creator key', ${`wza_${scope === 'read' ? 'rrrrrrrr' : 'cccccccc'}`}, ${fp(`${scope}:${profiles}:${createdBy}:${Math.random()}`)},
        ${scope}::mcp.key_scope, ${profiles}::uuid[], now() + interval '30 days', ${createdBy}) returning id`;

    it('carries no profile allowlist', async () => {
      const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId} limit 1`;
      await expect(insertKey('creator:write', `{${profile!.id}}`)).rejects.toThrow(/api_keys_creator_write_no_profiles/);
      expect(await insertKey('creator:write', '{}')).toHaveLength(1);
    });

    it('authorizes a creator:write key for its issuing owner or admin only, and never through the read check', async () => {
      const [creator] = await insertKey('creator:write', '{}');
      const [adminKey] = await insertKey('creator:write', '{}', ADMIN);
      const [analystKey] = await insertKey('creator:write', '{}', ANALYST);
      const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId} limit 1`;
      const [read] = await insertKey('read', `{${profile!.id}}`);
      const writeCheck = (user: string, key: string) => asUser(db, user, (sql) => sql`select * from app.authorize_mcp_creator_write_key(${key}::uuid, ${orgId}::uuid)`);
      const readCheck = (user: string, key: string) => asUser(db, user, (sql) => sql`select * from app.authorize_mcp_read_key(${key}::uuid, ${orgId}::uuid)`);
      expect(await writeCheck(OWNER, String(creator!['id']))).toHaveLength(1);
      expect(await writeCheck(ADMIN, String(adminKey!['id']))).toHaveLength(1);
      expect(await writeCheck(ANALYST, String(analystKey!['id']))).toHaveLength(0);
      expect(await writeCheck(ADMIN, String(creator!['id']))).toHaveLength(0);
      expect(await writeCheck(OWNER, String(read!['id']))).toHaveLength(0);
      expect(await readCheck(OWNER, String(creator!['id']))).toHaveLength(0);
      expect(await readCheck(OWNER, String(read!['id']))).toHaveLength(1);
      await db.sql`update mcp.api_keys set revoked_at = now() where id = ${String(creator!['id'])}`;
      expect(await writeCheck(OWNER, String(creator!['id']))).toHaveLength(0);
    });
  });
});
