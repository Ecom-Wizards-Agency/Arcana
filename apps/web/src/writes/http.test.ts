import { syntheticRecommendationMethodInputs } from '@wizard-ads/db/testing';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { exportAcceptedRecommendations } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { executeSyntheticKeywordWrite } from '@wizard-ads/db/testing';
import { SpWriteAdmission, type SpWriteConfirmedApprovalRequest, SpWriteOperationDetail, SpWritePreview, SpWriteRecordedPreview } from '@wizard-ads/shared/sp-write-application';
import { POST as preview, GET as recordedPreview } from '../../app/api/writes/preview/route.js';
import { loadSpWriteApproval } from './approval-loader.js';
import { POST as approve } from '../../app/api/writes/approve/route.js';
import { previewSpWriteInverse, approveAndQueueSpWrite } from '@wizard-ads/db/testing';
import { GET as status } from '../../app/api/writes/status/route.js';

const available = await databaseAvailable();
const OWNER = '31313131-3131-4131-8131-313131313131';
const OTHER = '42424242-4242-4242-8242-424242424242';
const ANALYST = '53535353-5353-4353-8353-535353535353';
const BRIDGE = 'synthetic-write-route-bridge';
const ORIGIN = 'http://localhost:3000';

describe.skipIf(!available)('SP write HTTP application', () => {
  let database: TestDatabase;
  let orgId: string;
  let otherOrgId: string;
  let profileId: string;
  let runId: string;

  beforeAll(async () => {
    database = await createTestDatabase('sp_write_http');
    const [tenants] = await database.sql<{ own: string; other: string }[]>`
      select app.seed_tenant_fixture('write-http-own', ${OWNER}, 'owner') as own,
             app.seed_tenant_fixture('write-http-other', ${OTHER}, 'owner') as other
    `;
    orgId = tenants!.own;
    otherOrgId = tenants!.other;
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const [run] = await database.sql<{ id: string }[]>`select id::text from public.recommendation_runs where org_id = ${orgId} and profile_id = ${profileId}`;
    runId = run!.id;
    await database.sql`select public.auth_user_stub(${ANALYST})`;
    await database.sql`insert into public.org_members (org_id, user_id, role) values (${orgId}, ${ANALYST}, 'analyst')`;
    const version = randomUUID();
    await database.sql`
      insert into public.sp_write_profile_grant_versions
        (grant_id, version_id, org_id, profile_id, enabled, amazon_profile_id,
         connection_id, region, marketplace_id, currency_code, api_dialect, created_by)
      select grant_id, ${version}, org_id, profile_id, true, amazon_profile_id,
             connection_id, region, marketplace_id, currency_code, api_dialect, created_by
      from public.sp_write_profile_grant_versions where org_id = ${orgId} and profile_id = ${profileId}
    `;
    await database.sql`update public.sp_write_profile_grant_heads set version_id = ${version}
      where org_id = ${orgId} and profile_id = ${profileId}`;
    vi.stubEnv('DATABASE_URL', database.connectionString);
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', BRIDGE);
    vi.stubEnv('WIZARD_ADS_APP_URL', ORIGIN);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  }, 60_000);
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  function headers(user = OWNER, org = orgId) {
    return { origin: ORIGIN, 'content-type': 'application/json',
      'x-wizard-ads-auth-bridge': BRIDGE, 'x-wizard-ads-user-id': user, 'x-wizard-ads-org-id': org };
  }
  function post(body: unknown, user = OWNER, org = orgId) {
    return new Request(`${ORIGIN}/api/writes`, { method: 'POST', headers: headers(user, org), body: JSON.stringify(body) });
  }
  async function source(method: Record<string, unknown> | null = syntheticRecommendationMethodInputs()) {
    const id = randomUUID();
    await database.sql`
      insert into public.recommendations
        (id, run_id, org_id, profile_id, reason, entity_type, entity_id, field, current_value, proposed_value, inputs, status)
      values (${id}, ${runId}, ${orgId}, ${profileId}, 'high_acos', 'keyword', 'kw-1', 'bid',
        '0.9'::jsonb, '0.7'::jsonb, ${JSON.stringify(method ?? {})}::text::jsonb, 'accepted')
    `;
    const batch = await exportAcceptedRecommendations(database, {
      orgId, profileId, runId, ids: [id], tag: randomUUID(), optGroup: 'synthetic', lever: 'bid-down',
      note: 'Synthetic HTTP write', actorId: OWNER,
    });
    return { requestId: randomUUID(), profileId, applyBatchId: batch.batchId };
  }
  function approval(frozen: SpWritePreview): SpWriteConfirmedApprovalRequest {
    return { profileId, confirmation: `Yes, apply ${frozen.plan.counts.logicalChanges} changes to Amazon`, approval: { approvalRequestId: randomUUID(), plan: frozen.binding,
      approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      boundedAuthorization: null, preapprovedInversePlan: null } };
  }
  async function detail(operation: SpWriteAdmission['operation']) {
    const response = await status(new Request(`${ORIGIN}/api/writes/status?${new URLSearchParams({ profileId, ...operation })}`, { headers: headers() }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    return SpWriteOperationDetail.parse(await response.json());
  }

  it('requires authentication, an owner/admin, the current tenant, exact JSON and the fixed origin', async () => {
    const body = await source();
    const unauthenticated = new Request(`${ORIGIN}/api/writes/preview`, { method: 'POST', body: '{}' });
    expect((await preview(unauthenticated)).status).toBe(401);
    expect((await preview(post(body, ANALYST))).status).toBe(403);
    expect((await preview(post(body, OTHER, otherOrgId))).status).toBe(403);
    expect((await preview(post({ ...body, userId: OWNER }))).status).toBe(400);
    const foreign = post(body);
    foreign.headers.set('origin', 'https://unrelated.example');
    expect((await preview(foreign)).status).toBe(403);
    const text = post(body);
    text.headers.set('content-type', 'text/plain');
    expect((await preview(text)).status).toBe(415);
    const huge = post({ padding: 'x'.repeat(17_000) });
    huge.headers.set('content-length', '2');
    expect((await preview(huge)).status).toBe(413);
  });

  it('keeps preview read-only and refuses approval while the environment gate is closed', async () => {
    const body = await source();
    const response = await preview(post(body));
    expect(response.status).toBe(200);
    const frozen = SpWritePreview.parse(await response.json());
    expect((await approve(post(approval(frozen)))).status).toBe(409);
    const [counts] = await database.sql<{ receipts: number; wakes: number }[]>`
      select (select count(*)::int from public.sp_write_authorization_receipts where plan_id = ${frozen.plan.id}) as receipts,
             (select count(*)::int from public.sp_write_outbox where plan_id = ${frozen.plan.id}) as wakes
    `;
    expect(counts).toEqual({ receipts: 0, wakes: 0 });
  });

  it('reloads an existing preview through GET and the server loader without recording or approving work', async () => {
    const frozen = SpWritePreview.parse(await (await preview(post(await source()))).json());
    const request = { profileId, planId: frozen.plan.id };
    const url = `${ORIGIN}/api/writes/preview?${new URLSearchParams(request)}`;
    const before = await database.sql`select
      (select count(*) from public.sp_write_plans) as plans,
      (select count(*) from public.sp_write_authorization_receipts) as receipts,
      (select count(*) from public.sp_write_outbox) as wakes`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = await loadSpWriteApproval(new Headers(headers()), request);
      expect(loaded.preview).toEqual(frozen);
      const response = await recordedPreview(new Request(url, { headers: headers() }));
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
      const read = SpWriteRecordedPreview.parse(await response.json());
      expect(read.preview).toEqual(frozen);
      expect(read.admission).toBeNull();
    }
    expect(await database.sql`select
      (select count(*) from public.sp_write_plans) as plans,
      (select count(*) from public.sp_write_authorization_receipts) as receipts,
      (select count(*) from public.sp_write_outbox) as wakes`).toEqual(before);
    expect((await recordedPreview(new Request(url, { headers: headers(ANALYST) }))).status).toBe(403);
    expect((await recordedPreview(new Request(url, { headers: headers(OTHER, otherOrgId) }))).status).toBe(404);
    expect((await recordedPreview(new Request(`${url}&planId=${frozen.plan.id}`, { headers: headers() }))).status).toBe(400);
  });

  it('uses HTTP preview, exact confirmation, replay and status, with an internal synthetic inverse', async () => {
    const environmentVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions
      (version_id, enabled, max_unresolved_calls) values (${environmentVersion}, true, 1)`;
    await database.sql`insert into public.sp_write_environment_gate_head (singleton, version_id) values (true, ${environmentVersion})`;
    const body = await source();
    const frozen = SpWritePreview.parse(await (await preview(post(body))).json());
    const confirmation = approval(frozen);
    const wrong = structuredClone(confirmation);
    wrong.approval.plan.counts = { logicalChanges: 2, providerRows: 2, uniqueEntities: 2,
      byRoute: { ...wrong.approval.plan.counts.byRoute, 'sp.v3.keywords.update': 2 } };
    expect((await approve(post(wrong))).status).toBe(400);
    const first = await approve(post(confirmation));
    expect(first.status).toBe(200);
    const admission = SpWriteAdmission.parse(await first.json());
    expect(admission.kind).toBe('queued');
    expect(await (await approve(post(confirmation))).json()).toEqual(admission);
    const queued = await detail(admission.operation);
    expect(queued.snapshot.accounting.pendingDispatch).toBe(1);
    await executeSyntheticKeywordWrite(database, frozen.plan, queued.receipt);
    try {
      const observed = await detail(admission.operation);
      expect(observed.snapshot.accounting.observedRequested).toBe(1);
      // This fixture appends provider evidence and directly edits the synthetic
      // mirror; it supplies no native reconciliation receipt.
      expect(observed.mirror).toEqual({ observations: 1, pending: 1, promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 });
      // Direct restore has no HTTP route in this round. Preserve the archived inverse proof internally.
      const inversePreview = await previewSpWriteInverse(database, { orgId, userId: OWNER },
        { requestId: randomUUID(), profileId, original: admission.operation });
      expect((await approve(post(approval(inversePreview)))).status).toBe(403);
      const inverseRequest = approval(inversePreview);
      const inverseAdmission = await approveAndQueueSpWrite(database, { orgId, userId: OWNER },
        { profileId, approval: inverseRequest.approval });
      const inverseQueued = await detail(inverseAdmission.operation);
      expect(inverseQueued.original).toEqual(admission.operation);
      expect((await detail(admission.operation)).inverses).toEqual([inverseAdmission.operation]);
      await executeSyntheticKeywordWrite(database, inversePreview.plan, inverseQueued.receipt);
      expect((await detail(inverseAdmission.operation)).snapshot.accounting.observedRequested).toBe(1);
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    }
  });

  it('refuses changed previews and returns controlled errors without exposing database diagnostics', async () => {
    const body = await source();
    const frozen = SpWritePreview.parse(await (await preview(post(body))).json());
    await database.sql`update public.keywords set bid = 1.1 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    try {
      const refused = await approve(post(approval(frozen)));
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ code: 'source_changed' });
    } finally {
      await database.sql`update public.keywords set bid = 0.9 where org_id = ${orgId} and amazon_id = 'kw-1'`;
    }
    const unknown = await source();
    await database.sql.unsafe(`
      create function app.test_write_http_storage_fault() returns trigger language plpgsql as $$
      begin raise exception 'synthetic internal database diagnostic'; end $$;
      create trigger test_write_http_storage_fault before insert on public.sp_write_preview_evidence
      for each row execute function app.test_write_http_storage_fault();
    `);
    try {
      const response = await preview(post(unknown));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: 'outcome_unknown' });
    } finally {
      await database.sql.unsafe('drop trigger test_write_http_storage_fault on public.sp_write_preview_evidence; drop function app.test_write_http_storage_fault()');
    }
    const duplicate = await status(new Request(`${ORIGIN}/api/writes/status?profileId=${profileId}&profileId=${profileId}`, { headers: headers() }));
    expect(duplicate.status).toBe(400);
  });
  it('scopes every new route to the selected agency even when the actor owns both agencies', async () => {
    await database.sql`insert into public.org_members (org_id,user_id,role) values (${otherOrgId},${OWNER},'owner')`;
    try {
      const body = await source();
      const frozen = SpWritePreview.parse(await (await preview(post(body))).json());
      const request = approval(frozen);
      const before = await database.sql`select count(*)::int from public.sp_write_authorization_receipts where plan_id=${frozen.plan.id}`;
      expect((await preview(post(body, OWNER, otherOrgId))).status).toBe(403);
      expect((await approve(post(request, OWNER, otherOrgId))).status).toBe(403);
      expect(await database.sql`select count(*)::int from public.sp_write_authorization_receipts where plan_id=${frozen.plan.id}`).toEqual(before);
      const read = `${ORIGIN}/api/writes/preview?${new URLSearchParams({ profileId, planId: frozen.plan.id })}`;
      expect((await recordedPreview(new Request(read, { headers: headers(OWNER, otherOrgId) }))).status).toBe(404);
      const admitted = SpWriteAdmission.parse(await (await approve(post(request))).json());
      const url = `${ORIGIN}/api/writes/status?${new URLSearchParams({ profileId, ...admitted.operation })}`;
      expect((await status(new Request(url, { headers: headers(OWNER, otherOrgId) }))).status).toBe(404);
    } finally {
      await database.sql`delete from public.org_members where org_id=${otherOrgId} and user_id=${OWNER}`;
    }
  });

  it('refuses missing, altered and mismatched confirmation text without recording approval', async () => {
    const frozen = SpWritePreview.parse(await (await preview(post(await source()))).json());
    const confirmed = approval(frozen);
    const { confirmation: _confirmation, ...missing } = confirmed;
    for (const request of [missing, { ...confirmed, confirmation: 'Yes, apply 2 changes to Amazon' },
      { ...confirmed, confirmation: confirmed.confirmation + ' ' }]) {
      expect((await approve(post(request))).status).toBe(400);
    }
    expect(await database.sql`select count(*)::int as count from public.sp_write_authorization_receipts where plan_id=${frozen.plan.id}`)
      .toEqual([{ count: 0 }]);
  });

  it('binds the WP-252 method identity, version, trace and settings and refuses missing method evidence', async () => {
    const frozen = SpWritePreview.parse(await (await preview(post(await source()))).json());
    if (frozen.evidence?.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') throw new Error('Expected recommendation evidence');
    const method = frozen.evidence.provenance.rows[0]!.method;
    expect(method).toMatchObject({ methodId: 'sp.reference-efficiency', methodVersion: 'reference.1',
      traceSha256: expect.stringMatching(/^[a-f0-9]{64}$/), settingSourcesSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const missing = SpWritePreview.parse(await (await preview(post(await source(null)))).json());
    expect((await approve(post(approval(missing)))).status).toBe(409);
    expect(await database.sql`select count(*)::int as count from public.sp_write_authorization_receipts where plan_id=${missing.plan.id}`)
      .toEqual([{ count: 0 }]);
  });

  it('refuses a frozen draft method with a stable code and records no receipt or outbox work', async () => {
    const draft = { ...syntheticRecommendationMethodInputs(), methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1' };
    const frozen = SpWritePreview.parse(await (await preview(post(await source(draft)))).json());
    const response = await approve(post(approval(frozen)));
    expect(response.status).toBe(422);
    await expect(database.sql`select app.assert_sp_write_method_evidence(${frozen.plan.id}::uuid, true)`).rejects.toThrow(/method_not_executable/);
    expect(await response.json()).toEqual({ code: 'method_not_executable' });
    expect(await database.sql`select
      (select count(*)::int from public.sp_write_authorization_receipts where plan_id=${frozen.plan.id}) as receipts,
      (select count(*)::int from public.sp_write_outbox where plan_id=${frozen.plan.id}) as wakes`)
      .toEqual([{ receipts: 0, wakes: 0 }]);
  });

  it('rolls back approval and outbox work when the exact confirmation audit is suppressed', async () => {
    const frozen = SpWritePreview.parse(await (await preview(post(await source()))).json());
    await database.sql.unsafe(`create function app.test_suppress_confirmation() returns trigger language plpgsql as $$
      begin if new.action='sp_write.confirmed' then return null; end if; return new; end $$;
      create trigger test_suppress_confirmation before insert on public.audit_log for each row execute function app.test_suppress_confirmation();`);
    try {
      expect((await approve(post(approval(frozen)))).status).toBe(409);
      expect(await database.sql`select
        (select count(*)::int from public.sp_write_authorization_receipts where plan_id=${frozen.plan.id}) as receipts,
        (select count(*)::int from public.sp_write_outbox where plan_id=${frozen.plan.id}) as wakes`).toEqual([{ receipts: 0, wakes: 0 }]);
    } finally {
      await database.sql.unsafe('drop trigger test_suppress_confirmation on public.audit_log; drop function app.test_suppress_confirmation()');
    }
  });

  it('rechecks current role for every route and approval replay after demotion', async () => {
    const sourceRequest = await source();
    const frozen = SpWritePreview.parse(await (await preview(post(sourceRequest))).json());
    const request = approval(frozen);
    const admitted = SpWriteAdmission.parse(await (await approve(post(request))).json());
    await database.sql`update public.org_members set role='analyst' where org_id=${orgId} and user_id=${OWNER}`;
    try {
      expect((await preview(post(sourceRequest))).status).toBe(403);
      expect((await approve(post(request))).status).toBe(403);
      const previewUrl = `${ORIGIN}/api/writes/preview?${new URLSearchParams({ profileId, planId: frozen.plan.id })}`;
      expect((await recordedPreview(new Request(previewUrl, { headers: headers() }))).status).toBe(403);
      const statusUrl = `${ORIGIN}/api/writes/status?${new URLSearchParams({ profileId, ...admitted.operation })}`;
      expect((await status(new Request(statusUrl, { headers: headers() }))).status).toBe(403);
      expect(await database.sql`select
        (select count(*)::int from public.sp_write_authorization_receipts where plan_id=${frozen.plan.id}) as receipts,
        (select count(*)::int from public.sp_write_outbox where plan_id=${frozen.plan.id}) as wakes`).toEqual([{ receipts: 1, wakes: 1 }]);
    } finally {
      await database.sql`update public.org_members set role='owner' where org_id=${orgId} and user_id=${OWNER}`;
    }
  });

});
