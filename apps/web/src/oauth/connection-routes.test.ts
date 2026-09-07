import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { cancelAmazonConnection } from '@wizard-ads/db';
import { AmazonConnectionOperation } from '@wizard-ads/shared';
import { GET as start } from '../../app/api/amazon/oauth/start/route';
import { GET as callback } from '../../app/api/amazon/oauth/callback/route';
import { GET as status, POST as cancel } from '../../app/api/amazon/connections/[operationId]/route';
import { createState, nonceCookieName, verifyState } from './state';
import { bulkSetSync, toggleSync } from '../../app/settings/profiles/actions';

let db: TestDatabase;
let currentUser: { id: string; email: string } | null;
let cookieOrg: string;
let challenge = false;
vi.mock('../data/db', () => ({ database: () => db, requireDatabase: () => db }));
vi.mock('../auth/security-authorization', () => ({
  currentOperatorIdentity: () => ({ user: currentUser, security: null }),
  authorizeOperatorRole: () => challenge ? { status: 'challenge', href: '/login/verify' } : { status: 'ok' },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: cookieOrg }) }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const available = await databaseAvailable();
const origin = 'http://127.0.0.1:3987';
const key = 's'.repeat(48);
const code = ['synthetic', 'callback', 'code'].join('-');
describe.skipIf(!available)('web consent admission and status on actual authenticated transactions', () => {
  beforeAll(async () => { db = await createTestDatabase('web_connection_routes'); }, 60_000);
  afterAll(async () => { await db?.drop(); });
  beforeEach(() => {
    vi.stubEnv('WIZARD_ADS_APP_URL', origin); vi.stubEnv('WIZARD_ADS_SECURE_COOKIES', '0');
    vi.stubEnv('OPENSPELL_AMAZON_CONNECTIONS_ENABLED', '1');
    vi.stubEnv('AMAZON_LWA_CLIENT_ID', 'synthetic-web-client');
    vi.stubEnv('AMAZON_OAUTH_REDIRECT_URI', origin + '/api/amazon/oauth/callback');
    vi.stubEnv('AMAZON_OAUTH_STATE_KEY', key); vi.stubEnv('AMAZON_LWA_CLIENT_SECRET', '');
    challenge = false;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No provider call belongs in the web tier'));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  async function agency() {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name)
      values (${randomUUID()},'Synthetic web agency') returning id`;
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${org!.id},${userId},'owner')`;
    return { userId, orgId: org!.id };
  }
  function signIn(actor: { userId: string; orgId: string }) {
    currentUser = { id: actor.userId, email: 'owner@example.test' }; cookieOrg = actor.orgId;
  }
  async function begin() {
    const actor = await agency(); signIn(actor);
    const response = await start(new Request(origin + '/api/amazon/oauth/start?org=' + actor.orgId));
    expect(response.status).toBe(302);
    const url = new URL(response.headers.get('location')!);
    const state = url.searchParams.get('state')!;
    const nonce = response.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    const verified = verifyState(key, state, nonce);
    if (!verified.ok) throw new Error('Expected verified test consent');
    return { actor, state, nonce, operationId: verified.claims.operationId };
  }
  function requestFor(state: string, nonce: string, extras: Record<string, string> = {}) {
    return new Request(origin + '/api/amazon/oauth/callback?' + new URLSearchParams({ state, code, ...extras }),
      { headers: { cookie: `${nonceCookieName(false)}=${nonce}` } });
  }
  function routeRequest(orgId: string, operationId: string, method = 'GET', requestOrigin = origin) {
    return new Request(origin + '/api/amazon/connections/' + operationId + '?org=' + orgId,
      { method, headers: { origin: requestOrigin } });
  }
  const context = (operationId: string) => ({ params: Promise.resolve({ operationId }) });

  it('persists a bound operation before redirect and enqueues one encrypted code across callback replay', async () => {
    const f = await begin();
    const first = await callback(requestFor(f.state, f.nonce));
    const second = await callback(requestFor(f.state, f.nonce));
    expect(first.status).toBe(303); expect(second.headers.get('location')).toBe(first.headers.get('location'));
    expect(first.headers.get('referrer-policy')).toBe('no-referrer');
    expect(first.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(first.headers.get('location')).not.toContain(code);
    const response = await status(routeRequest(f.actor.orgId, f.operationId), context(f.operationId));
    const saved = AmazonConnectionOperation.parse((await response.json()).operation);
    expect(saved).toMatchObject({ orgId: f.actor.orgId, operationId: f.operationId, state: 'queued', connectionId: null });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(await db.sql`select id from app.amazon_connection_operations where org_id=${f.actor.orgId}`).toHaveLength(1);
    expect(await db.sql`select id from vault.secrets where name=${'openspell:amazon-consent:' + f.operationId}`).toHaveLength(1);
    expect(await db.sql`select id from public.ads_connections where org_id=${f.actor.orgId}`).toHaveLength(0);
    expect(await db.sql`select id from public.ad_profiles where org_id=${f.actor.orgId}`).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('keeps signed agency scope when the navigation cookie selects another permitted agency', async () => {
    const f = await begin(); const other = await agency();
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${other.orgId},${f.actor.userId},'admin')`;
    cookieOrg = other.orgId;
    const response = await callback(requestFor(f.state, f.nonce));
    expect(new URL(response.headers.get('location')!).searchParams.get('org')).toBe(f.actor.orgId);
    expect(await db.sql`select org_id from app.amazon_connection_operations where state='queued' and initiated_by=${f.actor.userId}`)
      .toEqual([{ org_id: f.actor.orgId }]);
    expect(await status(routeRequest(other.orgId, f.operationId), context(f.operationId))).toHaveProperty('status', 404);
  });

  it('denies a second agency guessed identifiers and never substitutes its current agency', async () => {
    const f = await begin(); const other = await agency(); signIn(other);
    expect((await status(routeRequest(f.actor.orgId, f.operationId), context(f.operationId))).status).toBe(403);
    expect((await status(routeRequest(other.orgId, f.operationId), context(f.operationId))).status).toBe(404);
    expect((await cancel(routeRequest(f.actor.orgId, f.operationId, 'POST'), context(f.operationId))).status).toBe(403);
    const attempted = await start(new Request(origin + '/api/amazon/oauth/start?org=' + f.actor.orgId));
    expect(attempted.status).toBe(403);
    expect((await callback(requestFor(f.state, f.nonce))).headers.get('location')).toContain('different+session');
    expect(await db.sql`select state from app.amazon_connection_operations where id=${f.operationId}`)
      .toEqual([{ state: 'awaiting_consent' }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('refuses removed membership, required authentication and forged origin cancellation', async () => {
    const f = await begin();
    expect((await cancel(routeRequest(f.actor.orgId, f.operationId, 'POST', 'https://foreign.test'), context(f.operationId))).status).toBe(403);
    challenge = true;
    expect((await status(routeRequest(f.actor.orgId, f.operationId), context(f.operationId))).status).toBe(403);
    await callback(requestFor(f.state, f.nonce));
    challenge = false;
    await db.sql`delete from public.org_members where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
    expect((await status(routeRequest(f.actor.orgId, f.operationId), context(f.operationId))).status).toBe(403);
    await callback(requestFor(f.state, f.nonce));
    expect(await db.sql`select code_secret_id from app.amazon_connection_operations where id=${f.operationId}`)
      .toEqual([{ code_secret_id: null }]);
  });

  it('cancels durably once without reflecting Amazon error descriptions', async () => {
    const f = await begin();
    const privateValue = ['synthetic', 'private-response-detail'].join('-');
    const response = await callback(requestFor(f.state, f.nonce, { error: 'access_denied', error_description: privateValue }));
    expect(response.headers.get('location')).not.toContain(privateValue);
    const cancelled = await cancel(routeRequest(f.actor.orgId, f.operationId, 'POST'), context(f.operationId));
    expect((await cancelled.json()).operation.state).toBe('cancelled');
    expect(await db.sql`select id from public.audit_log where target_id=${f.operationId} and action='amazon.connection_settled'`)
      .toHaveLength(1);
  });

  it('rejects unavailable configuration and altered state before consuming a code', async () => {
    const f = await begin();
    vi.stubEnv('AMAZON_OAUTH_STATE_KEY', '');
    const zeroKeyState = createState('0'.repeat(32), { org: f.actor.orgId, sub: f.actor.userId,
      nonce: f.nonce, operationId: f.operationId });
    expect((await callback(requestFor(zeroKeyState, f.nonce))).headers.get('location')).toContain('could+not+be+verified');
    vi.stubEnv('AMAZON_OAUTH_STATE_KEY', key);
    const altered = f.state.slice(0, -1) + (f.state.endsWith('a') ? 'b' : 'a');
    await callback(requestFor(altered, f.nonce));
    expect(await db.sql`select code_secret_id from app.amazon_connection_operations where id=${f.operationId}`)
      .toEqual([{ code_secret_id: null }]);
    await cancelAmazonConnection(db, f.actor, f.operationId);
    vi.stubEnv('OPENSPELL_AMAZON_CONNECTIONS_ENABLED', '0');
    expect((await start(new Request(origin + '/api/amazon/oauth/start'))).status).toBe(503);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('binds profile selection to the submitted agency and rolls back mixed-agency bulk changes', async () => {
    const actor = await agency(); const other = await agency(); signIn(actor);
    const insertProfile = async (orgId: string) => {
      const [row] = await db.sql<{ id: string }[]>`insert into public.ad_profiles(org_id,amazon_profile_id,region,
        country_code,currency_code,timezone) values (${orgId},${randomUUID()},'EU','DE','EUR','UTC') returning id`;
      return row!.id;
    };
    const ownId = await insertProfile(actor.orgId); const secondId = await insertProfile(actor.orgId);
    const foreignId = await insertProfile(other.orgId);
    const form = new FormData(); form.set('orgId', actor.orgId); form.set('enabled', '1');
    form.append('profileIds', ownId); form.append('profileIds', foreignId);
    await expect(bulkSetSync(form)).rejects.toThrow('Selected profile count did not match');
    expect(await db.sql`select sync_enabled from public.ad_profiles where id=any(${[ownId,secondId,foreignId]}::uuid[])`)
      .toEqual([{ sync_enabled: false },{ sync_enabled: false },{ sync_enabled: false }]);
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${other.orgId},${actor.userId},'admin')`;
    cookieOrg = other.orgId;
    form.delete('profileIds'); form.append('profileIds', ownId); form.append('profileIds', secondId);
    await bulkSetSync(form);
    expect(await db.sql`select count(*)::int as n from public.ad_profiles where org_id=${actor.orgId} and sync_enabled`)
      .toEqual([{ n: 2 }]);
    expect(await db.sql`select sync_enabled from public.ad_profiles where id=${foreignId}`).toEqual([{ sync_enabled: false }]);
    await db.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    form.set('profileId', ownId); form.set('enabled', '0');
    await expect(toggleSync(form)).rejects.toThrow('no organisation');
    expect(await db.sql`select sync_enabled from public.ad_profiles where id=${ownId}`).toEqual([{ sync_enabled: true }]);
  });
});
