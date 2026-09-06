import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SpWriteManualApprovalRequest, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import { serializeSpWritePlanFingerprint } from '@wizard-ads/shared/sp-writes';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { executeSyntheticKeywordWrite } from '../testing/sp-write-synthetic-execution.js';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { approveAndQueueSpWrite } from './sp-write-approval.js';
import { previewSpWriteInverse } from './sp-write-inverse-preview.js';
import { readSpWriteOperation } from './sp-write-operation-read.js';
import { previewSpWrite } from './sp-write-plan-builder.js';
import { recordSpWritePreviewEvidence } from './sp-write-preview-evidence.js';
import { readRecordedSpWritePreview } from './sp-write-recorded-preview.js';
import { exportAcceptedRecommendations } from './recommendations.js';
import { prepareMcpKeywordBidPreview } from './mcp-write-preview.js';
import { issueMcpWriteDelegation } from './mcp-writes.js';
import type { QuerySql } from '../client.js';

const available = await databaseAvailable();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

describe.skipIf(!available)('recorded SP preview read boundary', () => {
  let database: TestDatabase;
  let enabledGate: string;

  beforeAll(async () => {
    database = await createTestDatabase('recorded_preview');
    enabledGate = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls)
      values (${enabledGate}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id) values (true, ${enabledGate})`;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function fixture() {
    const userId = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id = ${orgId}`;
    const profileId = profile!.id;
    const [run] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs
      where org_id = ${orgId} and profile_id = ${profileId}`;
    const [grant] = await database.sql<{ version_id: string }[]>`select version_id::text
      from public.sp_write_profile_grant_heads where org_id = ${orgId} and profile_id = ${profileId}`;
    const enabledVersion = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id, connection_id, region,
        marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${enabledVersion}, org_id, profile_id, true, amazon_profile_id, connection_id, region,
        marketplace_id, currency_code, api_dialect, created_by from public.sp_write_profile_grant_versions
      where version_id = ${grant!.version_id}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${enabledVersion}
      where org_id = ${orgId} and profile_id = ${profileId}`;
    const recommendationId = randomUUID();
    await database.sql`insert into public.recommendations
      (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
      values (${recommendationId}, ${run!.id}, ${orgId}, ${profileId}, 'high_acos', 'keyword', 'kw-1', 'bid',
        '0.9'::jsonb, '0.7'::jsonb, '{}'::jsonb, 'accepted')`;
    const source = await exportAcceptedRecommendations(database, { orgId, profileId, runId: run!.id,
      ids: [recommendationId], tag: randomUUID(), optGroup: 'synthetic', lever: 'bid', note: 'Synthetic recorded preview', actorId: userId });
    const actor = { orgId, userId };
    const preview = await previewSpWrite(database, actor, { requestId: randomUUID(), profileId, applyBatchId: source.batchId });
    return { actor, profileId, preview, recommendationId, disabledVersion: grant!.version_id, enabledVersion };
  }

  function identity(preview: SpWritePreview) { return { profileId: preview.plan.profileId, planId: preview.plan.id }; }
  function confirmation(preview: SpWritePreview): SpWriteManualApprovalRequest {
    return { profileId: preview.plan.profileId, approval: { approvalRequestId: randomUUID(), plan: preview.binding,
      approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null, preapprovedInversePlan: null } };
  }
  async function counts(orgId: string) {
    const [row] = await database.sql`select
      (select count(*)::int from public.sp_write_plans where org_id = ${orgId}) as plans,
      (select count(*)::int from public.sp_write_preview_evidence where org_id = ${orgId}) as evidence,
      (select count(*)::int from public.sp_write_approval_requests where org_id = ${orgId}) as approvals,
      (select count(*)::int from public.sp_write_authorization_receipts where org_id = ${orgId}) as receipts,
      (select count(*)::int from public.sp_write_execution_requests where org_id = ${orgId}) as requests,
      (select count(*)::int from public.sp_write_outbox where org_id = ${orgId}) as outbox`;
    return row;
  }

  it('reloads the exact frozen preview without recording, approving or enqueueing anything', async () => {
    const f = await fixture(); const before = await counts(f.actor.orgId);
    for (let index = 0; index < 2; index++) {
      const result = await readRecordedSpWritePreview(database, f.actor, identity(f.preview));
      expect(result.preview).toEqual(f.preview);
      expect(result.freshness).toMatchObject({ status: 'current', reasons: [] });
      expect(result.currentRows).toHaveLength(f.preview.plan.actions.length);
      expect(result.currentRows[0]).toMatchObject({ actionId: f.preview.plan.actions[0]!.actionId,
        observation: { values: { bid: { amount: '0.9', currencyCode: 'USD' } } } });
      expect(result.currentRows[0]?.syncedAt).toMatch(/Z$/);
      expect(result.admission).toBeNull();
    }
    expect(await counts(f.actor.orgId)).toEqual(before);
    await expect(readRecordedSpWritePreview(database, f.actor, { ...identity(f.preview), planId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('isolates actor membership, profile and plan, including read-only members', async () => {
    const f = await fixture(); const other = await fixture(); const before = await counts(f.actor.orgId);
    for (const [actor, request] of [
      [other.actor, identity(f.preview)],
      [{ ...f.actor, userId: other.actor.userId }, identity(f.preview)],
      [f.actor, { ...identity(f.preview), profileId: other.profileId }],
    ] as const) {
      await expect(readRecordedSpWritePreview(database, actor, request)).rejects.toMatchObject({ code: 'not_found' });
    }
    await database.sql`insert into public.org_members (org_id, user_id, role)
      values (${f.actor.orgId}, ${other.actor.userId}, 'viewer')`;
    await expect(readRecordedSpWritePreview(database, { ...f.actor, userId: other.actor.userId }, identity(f.preview)))
      .rejects.toMatchObject({ code: 'not_found' });
    await database.sql`update public.org_members set role = 'admin'
      where org_id = ${f.actor.orgId} and user_id = ${other.actor.userId}`;
    expect((await readRecordedSpWritePreview(database, { ...f.actor, userId: other.actor.userId }, identity(f.preview))).preview).toEqual(f.preview);
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('reports exact synchronized drift and unavailable entities without changing the saved amounts', async () => {
    const f = await fixture();
    await database.sql`update public.keywords set bid = 0.9123 where org_id = ${f.actor.orgId} and amazon_id = 'kw-1'`;
    const stale = await readRecordedSpWritePreview(database, f.actor, identity(f.preview));
    expect(stale.preview).toEqual(f.preview);
    expect(stale.freshness).toMatchObject({ status: 'stale', reasons: expect.arrayContaining(['current_value_changed']) });
    expect(stale.currentRows[0]?.observation).toMatchObject({ values: { bid: { amount: '0.9123' } } });
    await database.sql`update public.keywords set state = 'archived' where org_id = ${f.actor.orgId} and amazon_id = 'kw-1'`;
    const missing = await readRecordedSpWritePreview(database, f.actor, identity(f.preview));
    expect(missing.freshness).toMatchObject({ status: 'unavailable', reasons: expect.arrayContaining(['entity_unavailable']) });
    expect(missing.currentRows[0]?.observation).toBeNull();
    expect(missing.preview).toEqual(f.preview);
  });

  it('keeps one read-only snapshot when a sync changes the bid between its queries', async () => {
    const f = await fixture(); let changed = false;
    const connection = new Proxy(database.sql, { get(target, key, receiver) {
      if (key !== 'begin') return Reflect.get(target, key, receiver);
      return (options: string, callback: (sql: QuerySql) => Promise<unknown>) => target.begin(options, async (sql) => {
        const [mode] = await sql<{ transaction_read_only: string }[]>`show transaction_read_only`;
        expect(mode?.transaction_read_only).toBe('on');
        const snapshot = new Proxy(sql, { apply(query, owner, args: unknown[]) {
          const statement = Array.isArray(args[0]) ? args[0].join(' ') : '';
          return Promise.resolve(Reflect.apply(query, owner, args)).then(async (result: unknown) => {
            if (!changed && statement.includes('select plan.artifact_text')) {
              changed = true;
              await database.sql`update public.keywords set bid = 0.9123
                where org_id = ${f.actor.orgId} and amazon_id = 'kw-1'`;
            }
            return result;
          });
        } });
        return callback(snapshot);
      });
    } });
    const before = await counts(f.actor.orgId);
    const during = await readRecordedSpWritePreview({ sql: connection }, f.actor, identity(f.preview));
    expect(changed).toBe(true);
    expect(during.freshness.status).toBe('current');
    expect(during.currentRows[0]?.observation).toMatchObject({ values: { bid: { amount: '0.9' } } });
    const after = await readRecordedSpWritePreview(database, f.actor, identity(f.preview));
    expect(after.freshness.reasons).toContain('current_value_changed');
    expect(after.currentRows[0]?.observation).toMatchObject({ values: { bid: { amount: '0.9123' } } });
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('reports changed source, grants, connection configuration and disabled execution gates', async () => {
    const f = await fixture(); const before = await counts(f.actor.orgId);
    await database.sql`update public.apply_batches set note = 'Synthetic changed source'
      where id = ${f.preview.evidence!.provenance.applyBatchId}`;
    expect((await readRecordedSpWritePreview(database, f.actor, identity(f.preview))).freshness.reasons).toContain('source_changed');
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${f.disabledVersion}
      where org_id = ${f.actor.orgId} and profile_id = ${f.profileId}`;
    expect((await readRecordedSpWritePreview(database, f.actor, identity(f.preview))).freshness.reasons).toContain('grant_changed');
    await database.sql`update public.ad_profiles set sync_enabled = false where org_id = ${f.actor.orgId} and id = ${f.profileId}`;
    expect((await readRecordedSpWritePreview(database, f.actor, identity(f.preview))).freshness.reasons).toContain('profile_changed');
    await database.sql`update public.ad_profiles set connection_id = null where org_id = ${f.actor.orgId} and id = ${f.profileId}`;
    expect((await readRecordedSpWritePreview(database, f.actor, identity(f.preview))).freshness.reasons).toContain('profile_changed');
    const disabled = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions (version_id, enabled, max_unresolved_calls)
      values (${disabled}, false, 1)`;
    await database.sql`update public.sp_write_environment_gate_head set version_id = ${disabled}`;
    try {
      expect((await readRecordedSpWritePreview(database, f.actor, identity(f.preview))).freshness.reasons).toContain('gate_disabled');
    } finally { await database.sql`update public.sp_write_environment_gate_head set version_id = ${enabledGate}`; }
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('keeps expired previews readable without extending their lifetime', async () => {
    const f = await fixture(); const preview = structuredClone(f.preview);
    if (preview.evidence?.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') throw new Error('synthetic evidence missing');
    preview.plan.id = randomUUID(); preview.evidence.planId = preview.plan.id;
    const now = Date.now();
    preview.plan.generatedAt = new Date(now - 120_000).toISOString();
    preview.plan.frozenAt = new Date(now - 120_000).toISOString();
    preview.plan.expiresAt = new Date(now - 60_000).toISOString();
    preview.plan.fingerprint = digest(serializeSpWritePlanFingerprint(preview.plan));
    await recordSpWritePreviewEvidence(database, preview.plan, preview.evidence);
    const before = await counts(f.actor.orgId);
    const result = await readRecordedSpWritePreview(database, f.actor, identity(preview));
    expect(result.preview.plan.expiresAt).toBe(preview.plan.expiresAt);
    expect(result.freshness.reasons).toEqual(['expired']);
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('reports a saved approval without starting or repeating execution', async () => {
    const f = await fixture(); const request = confirmation(f.preview);
    await withAuthenticatedActor(database, f.actor, (sql) => sql`
      select app.approve_sp_write_preview_v1(${f.preview.plan.id}::uuid, ${JSON.stringify(request.approval)})`);
    const before = await counts(f.actor.orgId);
    const approved = await readRecordedSpWritePreview(database, f.actor, identity(f.preview));
    expect(approved.admission).toMatchObject({ kind: 'approved_pending_start', approvalRequestId: request.approval.approvalRequestId });
    expect(await counts(f.actor.orgId)).toEqual(before);
    const admitted = await approveAndQueueSpWrite(database, f.actor, request);
    const queuedBefore = await counts(f.actor.orgId);
    expect((await readRecordedSpWritePreview(database, f.actor, identity(f.preview))).admission).toEqual(admitted);
    expect(await counts(f.actor.orgId)).toEqual(queuedBefore);
  });

  it('reads a recorded inverse through its verified original source evidence', async () => {
    const f = await fixture();
    const admitted = await approveAndQueueSpWrite(database, f.actor, confirmation(f.preview));
    const original = await readSpWriteOperation(database, f.actor, { profileId: f.profileId, ...admitted.operation });
    await executeSyntheticKeywordWrite(database, f.preview.plan, original.receipt);
    const inverse = await previewSpWriteInverse(database, f.actor, { profileId: f.profileId,
      requestId: randomUUID(), original: admitted.operation });
    const before = await counts(f.actor.orgId);
    const result = await readRecordedSpWritePreview(database, f.actor, identity(inverse));
    expect(result.preview).toEqual(inverse);
    expect(result.preview.evidence).toBeNull();
    expect(result.freshness.status).toBe('current');
    expect(result.currentRows[0]?.observation).toMatchObject({ values: { bid: { amount: '0.7' } } });
    expect(result.admission).toBeNull();
    expect(await counts(f.actor.orgId)).toEqual(before);
  });

  it('reads MCP decimal proposals using their recorded v2 source evidence', async () => {
    const f = await fixture(); const tokenHash = digest(randomUUID());
    const delegation = await issueMcpWriteDelegation(database, f.actor, { label: 'Synthetic recorded reader', profileIds: [f.profileId],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), limits: { action: 'keyword.bid', maximumRowsPerCall: 2,
        maximumRowsPerUtcDay: 3, maximumAbsoluteDeltaByCurrency: [{ amount: '0.2', currencyCode: 'USD' }], maximumRelativeDelta: '0.25' } },
    { tokenHash, keyPrefix: 'wza_syntheti' });
    const saved = await prepareMcpKeywordBidPreview(database, { orgId: f.actor.orgId, keyId: delegation.keyId, tokenHash },
      { requestId: randomUUID(), profileId: f.profileId, source: { kind: 'keyword_proposals', note: 'Synthetic precise proposal',
        rows: [{ keywordId: 'kw-1', expectedBid: '0.9', requestedBid: '0.8123' }] } });
    const before = await counts(f.actor.orgId);
    const result = await readRecordedSpWritePreview(database, f.actor, identity(saved.preview));
    expect(result.preview).toEqual(saved.preview);
    expect(result.preview.evidence?.schemaVersion).toBe('openspell.sp-write-preview-evidence.v2');
    expect(result.freshness.status).toBe('current');
    expect(await counts(f.actor.orgId)).toEqual(before);
  });
});
