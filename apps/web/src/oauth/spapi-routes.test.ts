import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { createSpApiConnectionLifecycle } from '@wizard-ads/db';
import { startSpApiConsent, receiveSpApiConsent, spApiOperationRoute, spApiHealthRoute } from './spapi-routes';
import { createNonce, createState, nonceCookieName, verifyState } from './state';
import { createSpApiState, verifySpApiState, spApiNonceName } from './spapi-state';

let db: TestDatabase; let currentUser: { id: string; email: string } | null; let cookieOrg: string;
let challenge = false; let unavailable = false;
vi.mock('../data/db', () => ({ database: () => db }));
vi.mock('../auth/security-authorization', () => ({
  currentOperatorIdentity: () => ({ user: currentUser, security: unavailable ? { state: 'unavailable' } : null }),
  authorizeOperatorRole: () => challenge ? { status: 'challenge' } : { status: 'ok' },
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => ({ value: cookieOrg }) }) }));
const available = await databaseAvailable();
const origin = 'http://127.0.0.1:3987'; const key = 's'.repeat(48);
const code = ['synthetic', 'seller', 'consent'].join('-');
const denialCases = ['altered','expired','future','missing-state','missing-nonce','mismatched-nonce','wrong-user','wrong-org',
  'ads-state','forged-redirect','missing-seller','conflicting-seller','duplicate-seller','missing-code','duplicate-code','duplicate-state',
  'mixed-error','viewer','analyst','lost-assurance','membership-readded','gate-off','security-unavailable'] as const;

describe.skipIf(!available)('SP routes on authenticated database authority', () => {
  beforeAll(async () => { db = await createTestDatabase('web_spapi_routes'); }, 60_000);
  afterAll(async () => { await db?.drop(); });
  beforeEach(() => {
    vi.stubEnv('WIZARD_ADS_APP_URL',origin); vi.stubEnv('WIZARD_ADS_SECURE_COOKIES','0');
    vi.stubEnv('OPENSPELL_SPAPI_CONNECTIONS_ENABLED','1'); vi.stubEnv('SP_API_APPLICATION_ID','synthetic-application');
    vi.stubEnv('SP_API_LWA_CLIENT_ID','synthetic-client'); vi.stubEnv('SP_API_OAUTH_REGION','NA');
    vi.stubEnv('SP_API_OAUTH_REDIRECT_URI',origin + '/api/amazon/spapi/oauth/callback'); vi.stubEnv('AMAZON_OAUTH_STATE_KEY',key);
    challenge = false; unavailable = false;
    vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Provider HTTP forbidden in web'));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  async function begin() {
    const userId = randomUUID(); await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic web seller') returning id`;
    const actor = { orgId: org!.id,userId };
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const [profile] = await db.sql<{ id: string }[]>`insert into public.ad_profiles
      (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,amazon_account_id)
      values (${actor.orgId},${randomUUID()},'NA','US','USD','UTC','seller','synthetic-seller') returning id`;
    currentUser = { id: userId,email: 'synthetic@example.test' }; cookieOrg = actor.orgId;
    const form = new URLSearchParams({ org: actor.orgId,label: 'Synthetic seller',binding: `${profile!.id}:ATVPDKIKX0DER` });
    const response = await startSpApiConsent(new Request(origin + '/api/amazon/spapi/oauth/start', {
      method: 'POST',headers: { origin,host: 'forged.test','x-forwarded-host': 'forged.test' },body: form,
    }));
    expect(response.status).toBe(303); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const url = new URL(response.headers.get('location')!);
    expect(url.origin).toBe('https://sellercentral.amazon.com');
    expect(url.searchParams.get('application_id')).toBe('synthetic-application');
    expect(url.searchParams.get('redirect_uri')).toBe(origin + '/api/amazon/spapi/oauth/callback');
    const state = url.searchParams.get('state')!;
    const nonce = response.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
    expect(verifyState(key,state,nonce).ok).toBe(false);
    const verified = verifySpApiState(key,state,nonce); if (!verified.ok) throw new Error('Invalid synthetic state');
    return { actor,form,state,nonce,claims: verified.claims,operationId: verified.claims.operationId };
  }
  const statusRequest = (org: string,method = 'GET') => new Request(origin + '/status?' + new URLSearchParams({ org }),{ method,headers: { origin } });
  const callbackRequest = (params: URLSearchParams,nonce: string | null) => new Request(origin + '/api/amazon/spapi/oauth/callback?' + params,
    { headers: { cookie: `${nonce === null ? '' : `${spApiNonceName(false)}=${nonce}; `}${nonceCookieName(false)}=ads-cookie-kept` } });
  it('queues once, returns only saved metadata, and leaves Ads browser custody untouched', async () => {
    const f = await begin(); const params = new URLSearchParams({ state: f.state,spapi_oauth_code: code,selling_partner_id: 'synthetic-seller' });
    const response = await receiveSpApiConsent(callbackRequest(params,f.nonce));
    await receiveSpApiConsent(callbackRequest(params,f.nonce));
    expect(response.headers.get('set-cookie')).toContain(spApiNonceName(false) + '=;');
    expect(response.headers.get('set-cookie')).not.toContain(nonceCookieName(false) + '=');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('location')).not.toContain(code);
    expect(await db.sql`select id from vault.secrets where name=${'openspell:spapi-consent:' + f.operationId}`).toHaveLength(1);
    const lifecycle = createSpApiConnectionLifecycle(db,() => true);
    const claim = (await lifecycle.custody.claim(randomUUID()))!;
    expect(claim.operation.operationId).toBe(f.operationId);
    const completed = await lifecycle.custody.attach(f.operationId,claim.leaseId,'synthetic-refresh');
    expect(completed).toMatchObject({ state: 'completed',requestedBindings: 1,attachedBindings: 1 });
    const status = await spApiOperationRoute(statusRequest(f.actor.orgId),f.operationId,false);
    expect((await status.json()).operation).toEqual(completed);
    expect(await db.sql`select enabled from public.spapi_profile_bindings where org_id=${f.actor.orgId}`).toEqual([{ enabled: false }]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(denialCases)('rejects %s without queuing any code', async (kind) => {
    const f = await begin(); let state = f.state; let nonce: string | null = f.nonce;
    if (kind === 'altered') state = state.slice(0,10) + (state[10] === 'a' ? 'b' : 'a') + state.slice(11);
    if (kind === 'expired') state = createSpApiState(key,f.claims,Date.now()-16*60_000);
    if (kind === 'future') state = createSpApiState(key,f.claims,Date.now()+60_000);
    if (kind === 'ads-state') state = createState(key,f.claims);
    if (kind === 'wrong-org') state = createSpApiState(key,{ ...f.claims,org: randomUUID() });
    if (kind === 'wrong-user') currentUser = { id: randomUUID(),email: 'other@example.test' };
    if (kind === 'missing-nonce') nonce = null;
    if (kind === 'mismatched-nonce') nonce = createNonce();
    if (kind === 'viewer' || kind === 'analyst') await db.sql`update public.org_members set role=${kind} where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
    if (kind === 'lost-assurance') challenge = true;
    if (kind === 'security-unavailable') unavailable = true;
    if (kind === 'gate-off') vi.stubEnv('OPENSPELL_SPAPI_CONNECTIONS_ENABLED','0');
    if (kind === 'membership-readded') {
      await db.sql`delete from public.org_members where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
      await db.sql`insert into public.org_members(org_id,user_id,role,created_at) values (${f.actor.orgId},${f.actor.userId},'owner',clock_timestamp()+interval '1 second')`;
    }
    if (['viewer','analyst','lost-assurance','security-unavailable','gate-off'].includes(kind)) {
      const deniedStart = await startSpApiConsent(new Request(origin + '/api/amazon/spapi/oauth/start',{
        method: 'POST',headers: { origin },body: f.form,
      }));
      expect([403,503]).toContain(deniedStart.status);
      expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.actor.orgId}`).toHaveLength(1);
    }
    const params = new URLSearchParams({ state,spapi_oauth_code: code,selling_partner_id: 'synthetic-seller' });
    if (kind === 'missing-state') params.delete('state');
    if (kind === 'missing-seller') params.delete('selling_partner_id');
    if (kind === 'missing-code') params.delete('spapi_oauth_code');
    if (kind === 'conflicting-seller') params.set('selling_partner_id','other-seller');
    if (kind === 'duplicate-state') params.append('state',state);
    if (kind === 'duplicate-seller') params.append('selling_partner_id','other-seller');
    if (kind === 'duplicate-code') params.append('spapi_oauth_code','another-code');
    if (kind === 'forged-redirect') params.set('redirect_uri','https://foreign.test');
    if (kind === 'mixed-error') params.set('error','access_denied');
    const response = await receiveSpApiConsent(callbackRequest(params,nonce));
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new URL(response.headers.get('location')!).origin).toBe(origin);
    expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.actor.orgId} and code_hash is not null`).toHaveLength(0);
    expect(await db.sql`select id from public.spapi_connections where org_id=${f.actor.orgId}`).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('keeps cancellation and health available with admission off and denies foreign operations', async () => {
    const f = await begin(); vi.stubEnv('OPENSPELL_SPAPI_CONNECTIONS_ENABLED','0');
    expect((await spApiOperationRoute(statusRequest(f.actor.orgId),f.operationId,false)).status).toBe(200);
    const cancelled = await spApiOperationRoute(statusRequest(f.actor.orgId,'POST'),f.operationId,true);
    expect((await cancelled.json()).operation.state).toBe('cancelled');
    expect((await spApiOperationRoute(statusRequest(randomUUID()),f.operationId,false)).status).toBe(403);
    expect((await spApiHealthRoute(statusRequest(f.actor.orgId),randomUUID(),false)).status).toBe(404);
    expect((await startSpApiConsent(new Request(origin + '/start',{ method: 'POST',headers: { origin },body: f.form }))).status).toBe(503);
    expect(denialCases).toHaveLength(23);
  });
  it('clears SP custody when the pinned application origin is invalid', async () => {
    const f = await begin(); vi.stubEnv('WIZARD_ADS_APP_URL','invalid-origin');
    const response = await receiveSpApiConsent(callbackRequest(new URLSearchParams({ state: 'invalid' }),f.nonce));
    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
