import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordCampaignCreationPreview } from '@wizard-ads/db/campaign-creation-previews';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { CampaignCreationPlanV2, serializeCampaignCreationPlanFingerprint } from '@wizard-ads/shared';
import { CampaignCreationApprovalView } from '@wizard-ads/shared/campaign-creation-approval';
import * as route from '../../app/api/campaign-creation/preview/route';
import { loadCampaignCreationApproval } from './creation-approval-loader';
import { campaignCreationApprovalFixtures } from './creation-approval-fixtures';

const available = await databaseAvailable();
const bridge = 'synthetic-campaign-preview-bridge';
const origin = 'http://localhost:3000';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe.skipIf(!available)('recorded campaign preview HTTP', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('campaign_preview_http');
    vi.stubEnv('DATABASE_URL', database.connectionString);
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
  }, 60_000);
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  async function fixture(format: 'spManual' | 'spAutomatic' | 'sbVideoStore' | 'sdVideo' = 'spManual') {
    const userId = randomUUID(); const orgId = randomUUID(); const profileId = randomUUID(); const connectionId = randomUUID();
    await database.sql`select public.auth_user_stub(${userId})`;
    await database.sql`insert into public.orgs (id,slug,name) values (${orgId},${orgId},'Synthetic HTTP tenant')`;
    await database.sql`insert into public.org_members (org_id,user_id,role) values (${orgId},${userId},'owner')`;
    await database.sql`insert into public.ads_connections (id,org_id,label,status)
      values (${connectionId},${orgId},'Synthetic connection','active')`;
    await database.sql`insert into public.ad_profiles
      (id,org_id,connection_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,account_name,sync_enabled)
      values (${profileId},${orgId},${connectionId},'900000000001','NA','US','USD','UTC','seller','Synthetic HTTP profile',true)`;
    const source = CampaignCreationPlanV2.parse(campaignCreationApprovalFixtures().sources[format].plan);
    const now = Date.now();
    const plan = CampaignCreationPlanV2.parse({ ...source, id: randomUUID(), orgId, profileId,
      providerScope: { ...source.providerScope, connectionId }, generatedAt: new Date(now - 2_000).toISOString(),
      frozenAt: new Date(now - 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
    plan.fingerprint = sha(serializeCampaignCreationPlanFingerprint(plan));
    const actor = { orgId, userId };
    const request = await recordCampaignCreationPreview(database, actor, plan);
    const headers = new Headers({ 'x-wizard-ads-auth-bridge': bridge,
      'x-wizard-ads-user-id': userId, 'x-wizard-ads-org-id': orgId });
    const url = `${origin}/api/campaign-creation/preview?${new URLSearchParams(request)}`;
    return { actor, plan, request, headers, url };
  }

  async function counts() {
    return await database.sql`select
      (select count(*) from public.campaign_creation_previews) as plans,
      (select count(*) from public.sp_write_approval_requests) as approvals,
      (select count(*) from public.sp_write_execution_requests) as executions,
      (select count(*) from public.sp_write_outbox) as outbox,
      (select count(*) from public.sync_jobs) as jobs`;
  }

  it.each(['spManual', 'spAutomatic', 'sbVideoStore', 'sdVideo'] as const)(
    'returns the exact saved %s view through the loader and uncached GET without side effects', async (format) => {
      const { plan, request, headers, url } = await fixture(format);
      const before = await counts();
      const loaded = await loadCampaignCreationApproval(headers, request);
      expect(loaded.plan).toEqual(plan);
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await route.GET(new Request(url, { headers }));
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const view = CampaignCreationApprovalView.parse(await response.json());
        expect(view.plan).toEqual(plan);
        expect(view.profile.label).toBe('Synthetic HTTP profile');
        expect(view.current.checks).toHaveLength(plan.counts.totalNodes);
        expect(view.current.checks.every((check) => check.result === 'unknown' && check.checkedAt === null)).toBe(true);
        expect(view.current.assets).toHaveLength(plan.counts.byKind['asset.require_existing']);
        expect(view.admission).toEqual({ kind: 'unavailable' });
        expect(view.recordedContext).toEqual({ guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' });
        expect(view).not.toHaveProperty('canApprove');
      }
      expect(await counts()).toEqual(before);
    });

  it('requires a signed-in current owner/admin and refuses client actor overrides', async () => {
    const { actor, url, headers } = await fixture();
    const missing = await route.GET(new Request(url));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    for (const role of ['analyst', 'viewer'] as const) {
      await database.sql`update public.org_members set role = ${role} where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
      expect((await route.GET(new Request(url, { headers }))).status).toBe(403);
    }
    await database.sql`update public.org_members set role = 'admin' where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
    expect((await route.GET(new Request(url, { headers }))).status).toBe(200);
    expect((await route.GET(new Request(`${url}&userId=${actor.userId}`, { headers }))).status).toBe(400);
    await database.sql`delete from public.org_members where org_id = ${actor.orgId} and user_id = ${actor.userId}`;
    expect((await route.GET(new Request(url, { headers }))).status).toBe(403);
  });

  it('hides foreign and missing records equally and never falls back to creating a new preview', async () => {
    const own = await fixture(); const other = await fixture();
    const before = await counts();
    for (const url of [other.url, `${origin}/api/campaign-creation/preview?${new URLSearchParams({ ...own.request, planId: randomUUID() })}`]) {
      const response = await route.GET(new Request(url, { headers: own.headers }));
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'not_found' });
    }
    expect(await counts()).toEqual(before);
  });

  it('rejects missing, duplicate, invalid and extra query fields and exposes no mutation handler', async () => {
    const { url, headers, request } = await fixture();
    for (const invalid of [`${origin}/api/campaign-creation/preview`, `${url}&planId=${request.planId}`,
      `${url}&profileId=${request.profileId}`, `${url}&approval=true`, `${url}&__proto__=x`,
      `${url}&constructor=x`, `${origin}/api/campaign-creation/preview?profileId=invalid`]) {
      const response = await route.GET(new Request(invalid, { headers }));
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ code: 'invalid_request' });
    }
    expect(Object.keys(route).sort()).toEqual(['GET', 'runtime']);
  });

  it('sanitizes semantic corruption and storage failures, with no cached failure or manufactured plan', async () => {
    const { actor, plan, headers, url } = await fixture();
    const invalid = structuredClone(plan);
    invalid.id = randomUUID();
    const artifact = JSON.stringify(invalid); // Deliberately stale fingerprint in owned storage.
    await database.sql`insert into public.campaign_creation_previews
      (org_id,profile_id,plan_id,artifact_text,artifact,artifact_sha256,recorded_by)
      values (${actor.orgId},${plan.profileId},${invalid.id},${artifact},${artifact}::jsonb,${sha(artifact)},${actor.userId})`;
    const badUrl = `${origin}/api/campaign-creation/preview?${new URLSearchParams({ profileId: plan.profileId, planId: invalid.id })}`;
    const corrupt = await route.GET(new Request(badUrl, { headers }));
    expect(corrupt.status).toBe(503);
    expect(corrupt.headers.get('cache-control')).toBe('no-store');
    expect(await corrupt.json()).toEqual({ code: 'unavailable' });
    await database.sql`alter table public.campaign_creation_previews rename to synthetic_preview_unavailable`;
    try {
      const unavailable = await route.GET(new Request(url, { headers }));
      expect(unavailable.status).toBe(503);
      expect(unavailable.headers.get('cache-control')).toBe('no-store');
      expect(await unavailable.json()).toEqual({ code: 'unavailable' });
    } finally { await database.sql`alter table public.synthetic_preview_unavailable rename to campaign_creation_previews`; }
    expect((await route.GET(new Request(url, { headers }))).status).toBe(200);
  });
});
