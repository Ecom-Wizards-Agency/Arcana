import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { createSpApiConnectionLifecycle, SpApiConnectionCommandError } from '@wizard-ads/db';
import { SpApiStartRefusalClass } from '@wizard-ads/shared';
import { startSpApiConsent, receiveSpApiConsent, spApiOperationRoute, spApiHealthRoute } from './spapi-routes';
import { createNonce, createState, nonceCookieName, verifyState } from './state';
import { createSpApiState, verifySpApiState, spApiNonceName } from './spapi-state';

let db: TestDatabase; let currentUser: { id: string; email: string } | null; let cookieOrg: string;
let challenge = false; let unavailable = false; let noDatabase = false; let identityFailure = false;
vi.mock('../data/db', () => ({ database: () => noDatabase ? null : db }));
vi.mock('../auth/security-authorization', () => ({
  currentOperatorIdentity: () => {
    if (identityFailure) throw new Error('synthetic identity provider failure');
    return { user: currentUser, security: unavailable ? { state: 'unavailable', reason: 'provider-error' } : null };
  },
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
    challenge = false; unavailable = false; noDatabase = false; identityFailure = false;
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
    const repeated = await receiveSpApiConsent(callbackRequest(params,f.nonce));
    expect(new URL(response.headers.get('location')!).searchParams.get('spapi_submission')).toBe('received');
    expect(new URL(repeated.headers.get('location')!).searchParams.get('spapi_submission')).toBe('already_received');
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
    const expectedReasons: Record<typeof denialCases[number], string> = {
      altered: 'mismatch', expired: 'expired', future: 'not_yet_valid', 'missing-state': 'missing',
      'missing-nonce': 'missing', 'mismatched-nonce': 'mismatch', 'wrong-user': 'wrong_actor',
      'wrong-org': 'authority_changed', 'ads-state': 'mismatch', 'forged-redirect': 'mismatch',
      'missing-seller': 'invalid_consent', 'conflicting-seller': 'invalid_consent', 'duplicate-seller': 'invalid_consent',
      'missing-code': 'invalid_consent', 'duplicate-code': 'invalid_consent', 'duplicate-state': 'missing',
      'mixed-error': 'invalid_consent', viewer: 'authority_changed', analyst: 'authority_changed',
      'lost-assurance': 'authority_changed', 'membership-readded': 'authority_changed',
      'gate-off': 'not_configured', 'security-unavailable': 'authority_changed',
    };
    const destination = new URL(response.headers.get('location')!);
    expect(destination.searchParams.get('spapi_error')).toBe(expectedReasons[kind]);
    expect(destination.searchParams.has('spapi_submission')).toBe(false);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(new URL(response.headers.get('location')!).origin).toBe(origin);
    expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.actor.orgId} and code_hash is not null`).toHaveLength(0);
    expect(await db.sql`select id from public.spapi_connections where org_id=${f.actor.orgId}`).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it('distinguishes reused consent from identical resubmission without queuing another exchange', async () => {
    const f = await begin();
    const params = new URLSearchParams({ state: f.state, spapi_oauth_code: code, selling_partner_id: 'synthetic-seller' });
    await receiveSpApiConsent(callbackRequest(params, f.nonce));
    params.set('spapi_oauth_code', code + '-different');
    const refused = await receiveSpApiConsent(callbackRequest(params, f.nonce));
    expect(new URL(refused.headers.get('location')!).searchParams.get('spapi_error')).toBe('reused');
    expect(await db.sql`select id from vault.secrets where name=${'openspell:spapi-consent:' + f.operationId}`).toHaveLength(1);
    expect(await db.sql`select id from public.audit_log where org_id=${f.actor.orgId} and action='spapi.consent_submitted'`).toHaveLength(1);
    const lifecycle = createSpApiConnectionLifecycle(db, () => true);
    expect((await lifecycle.custody.claim(randomUUID()))?.operation.operationId).toBe(f.operationId);
    expect(await lifecycle.custody.claim(randomUUID())).toBeNull();
    await lifecycle.cancel(f.actor, f.operationId);
  });
  it.each(['cancelled', 'expired-operation', 'wrong-initiator'] as const)('names %s refusal without queuing consent', async (kind) => {
    const f = await begin();
    if (kind === 'cancelled') await createSpApiConnectionLifecycle(db).cancel(f.actor, f.operationId);
    if (kind === 'expired-operation') await db.sql`update app.spapi_connection_operations set expires_at=clock_timestamp()-interval '1 second' where id=${f.operationId}`;
    if (kind === 'wrong-initiator') {
      const userId = randomUUID();
      await db.sql`insert into auth.users(id) values (${userId})`;
      await db.sql`insert into public.org_members(org_id,user_id,role) values (${f.actor.orgId},${userId},'admin')`;
      await db.sql`update app.spapi_connection_operations set initiated_by=${userId} where id=${f.operationId}`;
    }
    const response = await receiveSpApiConsent(callbackRequest(new URLSearchParams({ state: f.state, spapi_oauth_code: code, selling_partner_id: 'synthetic-seller' }), f.nonce));
    expect(new URL(response.headers.get('location')!).searchParams.get('spapi_error')).toBe(kind === 'cancelled' ? 'operation_not_pending' : kind === 'expired-operation' ? 'expired' : 'wrong_actor');
    expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.actor.orgId} and code_hash is not null`).toHaveLength(0);
    expect(await db.sql`select id from public.audit_log where org_id=${f.actor.orgId} and action='spapi.consent_submitted'`).toHaveLength(0);
  });
  it.each([false, true])('preserves uncertain response recovery with committed=%s and never resubmits', async (committed) => {
    const f = await begin();
    const realDb = db;
    let submissions = 0;
    const wrapped = { sql: { begin: async (run: (sql: unknown) => Promise<unknown>) => {
      let submitted = false;
      const result = await realDb.sql.begin(async (sql) => run(new Proxy(sql, { apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        if (args[0].join('').includes('app.submit_spapi_connection')) {
          submitted = true; submissions++;
          if (!committed) throw new Error('synthetic lost request');
        }
        return Reflect.apply(target, thisArg, args);
      } })));
      if (submitted) throw new SpApiConnectionCommandError();
      return result;
    } } };
    db = wrapped as unknown as TestDatabase;
    try {
      const response = await receiveSpApiConsent(callbackRequest(new URLSearchParams({ state: f.state, spapi_oauth_code: code, selling_partner_id: 'synthetic-seller' }), f.nonce));
      const destination = new URL(response.headers.get('location')!);
      expect(destination.searchParams.get('spapi_error')).toBe('submission_uncertain');
      expect(destination.searchParams.get('spapi_operation')).toBe(f.operationId);
      expect(destination.searchParams.has('spapi_submission')).toBe(false);
    } finally { db = realDb; }
    expect(submissions).toBe(1);
    expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.actor.orgId} and code_hash is not null`).toHaveLength(committed ? 1 : 0);
    await createSpApiConnectionLifecycle(db).cancel(f.actor, f.operationId);
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

  describe('classified start refusals', () => {
    const startEvent = 'arcana.spapi_start_refused'; const callbackEvent = 'arcana.spapi_callback_refused';
    let warn: MockInstance<typeof console.warn>; let saved: TestDatabase;
    beforeEach(() => { saved = db; warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterEach(() => { db = saved; });
    const lines = (): string[] => warn.mock.calls.map(([line]) => String(line));
    const entries = (event: string): unknown[] => lines().map((line): unknown => JSON.parse(line))
      .filter((entry) => typeof entry === 'object' && entry !== null && 'event' in entry && entry.event === event);
    const navigate = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' };
    const start = (form: URLSearchParams, extra: Record<string, string> = {}) => new Request(origin + '/api/amazon/spapi/oauth/start',
      { method: 'POST', headers: { origin, ...extra }, body: form });
    async function seller(accountType: 'seller' | 'vendor' = 'seller') {
      const userId = randomUUID(); await db.sql`insert into auth.users(id) values (${userId})`;
      const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic refused seller') returning id`;
      const orgId = org!.id;
      await db.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${userId},'owner')`;
      const [profile] = await db.sql<{ id: string }[]>`insert into public.ad_profiles
        (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,amazon_account_id)
        values (${orgId},${randomUUID()},'NA','US','USD','UTC',${accountType},'synthetic-seller') returning id`;
      currentUser = { id: userId, email: 'synthetic@example.test' }; cookieOrg = orgId;
      return { orgId, userId, form: new URLSearchParams({ org: orgId, label: 'Synthetic refused seller', binding: `${profile!.id}:ATVPDKIKX0DER` }) };
    }
    type Fixture = Awaited<ReturnType<typeof seller>>;
    const template = (strings: TemplateStringsArray): TemplateStringsArray => strings;
    /** Replace one statement inside the web handle's authenticated transactions. */
    function intercept(match: string, respond: (run: (strings: TemplateStringsArray) => unknown) => unknown): void {
      const real = db;
      const wrapped = { sql: { begin: async (run: (sql: unknown) => Promise<unknown>) => real.sql.begin(async (sql) => run(new Proxy(sql, {
        apply(target, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
          if (!args[0].join('').includes(match)) return Reflect.apply(target, thisArg, args);
          return respond((strings) => Reflect.apply(target, thisArg, [strings]));
        },
      }))) } };
      db = wrapped as unknown as TestDatabase;
    }
    const unlisted = Object.assign(new Error('synthetic unlisted database text'), { name: 'PostgresError', severity: 'ERROR', code: '57014', routine: 'ProcessInterrupts' });
    const generic = 'The database refused to start this connection. Try again; if it repeats, contact your installation operator.';
    const signIn = 'Your sign-in or account security could not be verified. Sign in again to continue.';
    const roleMessage = 'Your role in this agency cannot manage seller connections. Ask an owner or admin.';
    const signing = 'The connection signing key (AMAZON_OAUTH_STATE_KEY) is missing or shorter than 32 bytes. Contact your installation operator.';
    const bindingsMessage = 'Select between 1 and 50 seller profiles, each profile once, then start again.';
    const configured = (name: string) => `Seller connections are not fully configured: ${name} is missing or invalid. Contact your installation operator.`;
    const cases: { name: string; profile?: 'vendor'; arrange: (f: Fixture) => Request | Promise<Request>; status: number; refusal: string;
      detail: string | null; message: string; log: Record<string, unknown> }[] = [
      { name: 'origin mismatch', arrange: (f) => start(f.form, { origin: 'http://foreign.test' }), status: 403, refusal: 'origin', detail: null,
        message: 'The request did not come from this installation\'s configured address. Open Arcana at its usual address and start again.',
        log: { cause: 'origin_mismatch', stage: 'request' } },
      { name: 'admission gate off', arrange: (f) => { vi.stubEnv('OPENSPELL_SPAPI_CONNECTIONS_ENABLED', '0'); return start(f.form); }, status: 503,
        refusal: 'unavailable', detail: null, message: 'Seller connections are unavailable. Contact your installation operator.',
        log: { cause: 'gate_off', stage: 'request' } },
      { name: 'signed out', arrange: (f) => { currentUser = null; return start(f.form); }, status: 403, refusal: 'session', detail: null,
        message: signIn, log: { cause: 'signed_out', stage: 'identity' } },
      { name: 'session assurance unavailable', arrange: (f) => { unavailable = true; return start(f.form); }, status: 403, refusal: 'session',
        detail: null, message: signIn, log: { cause: 'security_provider_error', stage: 'identity' } },
      { name: 'assurance challenge pending', arrange: (f) => { challenge = true; return start(f.form); }, status: 403, refusal: 'session',
        detail: null, message: signIn, log: { cause: 'assurance_challenge', stage: 'identity' } },
      { name: 'identity provider failure', arrange: (f) => { identityFailure = true; return start(f.form); }, status: 403, refusal: 'session',
        detail: null, message: signIn, log: { cause: 'identity_error', stage: 'identity', error: 'Error' } },
      { name: 'role cannot manage connections', arrange: async (f) => {
        await db.sql`update public.org_members set role='analyst' where org_id=${f.orgId} and user_id=${f.userId}`; return start(f.form);
      }, status: 403, refusal: 'role', detail: null, message: roleMessage, log: { cause: 'role_cannot_manage', stage: 'membership' } },
      { name: 'not a member of the selected agency', arrange: (f) => { f.form.set('org', randomUUID()); return start(f.form); }, status: 403,
        refusal: 'role', detail: null, message: roleMessage, log: { cause: 'not_member', stage: 'membership' } },
      { name: 'membership refused inside the command', arrange: (f) => {
        intercept(' as present', (run) => run(template`select false as present`)); return start(f.form);
      }, status: 403, refusal: 'role', detail: null, message: roleMessage, log: { cause: 'membership_denied', stage: 'database', error: 'AgencyAccessDenied' } },
      { name: 'region variable unset', arrange: (f) => { vi.stubEnv('SP_API_OAUTH_REGION', ''); return start(f.form); }, status: 403,
        refusal: 'configuration', detail: 'SP_API_OAUTH_REGION', message: configured('SP_API_OAUTH_REGION'),
        log: { cause: 'missing_setting', stage: 'deployment', error: 'Error', setting: 'SP_API_OAUTH_REGION' } },
      { name: 'region variable invalid', arrange: (f) => { vi.stubEnv('SP_API_OAUTH_REGION', 'XX'); return start(f.form); }, status: 403,
        refusal: 'configuration', detail: 'SP_API_OAUTH_REGION', message: configured('SP_API_OAUTH_REGION'),
        log: { cause: 'invalid_setting', stage: 'deployment', error: 'ZodError', paths: ['region'] } },
      { name: 'application identity unset', arrange: (f) => { vi.stubEnv('SP_API_APPLICATION_ID', ''); return start(f.form); }, status: 403,
        refusal: 'configuration', detail: 'SP_API_APPLICATION_ID', message: configured('SP_API_APPLICATION_ID'),
        log: { cause: 'missing_setting', stage: 'deployment', error: 'Error', setting: 'SP_API_APPLICATION_ID' } },
      { name: 'database unconfigured', arrange: (f) => { noDatabase = true; return start(f.form); }, status: 403, refusal: 'configuration',
        detail: 'DATABASE_URL', message: configured('DATABASE_URL'), log: { cause: 'database_unconfigured', stage: 'membership' } },
      { name: 'application origin invalid', arrange: (f) => { vi.stubEnv('WIZARD_ADS_APP_URL', 'invalid-origin'); return start(f.form, navigate); },
        status: 403, refusal: 'configuration', detail: 'WIZARD_ADS_APP_URL', message: configured('WIZARD_ADS_APP_URL'),
        log: { cause: 'invalid_setting', stage: 'origin', error: 'TypeError' } },
      { name: 'invalid agency field', arrange: (f) => { f.form.set('org', 'not-an-agency'); return start(f.form); }, status: 403,
        refusal: 'selection', detail: 'org', message: 'The selected agency is not valid. Reload Connections and start again.',
        log: { cause: 'invalid_org', stage: 'request' } },
      { name: 'blank label', arrange: (f) => { f.form.set('label', '   '); return start(f.form); }, status: 403, refusal: 'selection',
        detail: 'label', message: 'Enter a seller connection label of 1 to 256 characters.',
        log: { cause: 'invalid_selection', stage: 'selection', error: 'ZodError', paths: ['label'] } },
      { name: 'no selected profile', arrange: (f) => { f.form.delete('binding'); return start(f.form); }, status: 403, refusal: 'selection',
        detail: 'bindings', message: bindingsMessage, log: { cause: 'invalid_selection', stage: 'selection', error: 'ZodError', paths: ['bindings'] } },
      { name: 'malformed profile selection', arrange: (f) => { f.form.set('binding', 'synthetic-malformed'); return start(f.form); }, status: 403,
        refusal: 'selection', detail: 'bindings', message: bindingsMessage,
        log: { cause: 'invalid_selection', stage: 'selection', error: 'ZodError', paths: ['bindings.0.profileId', 'bindings.0.marketplaceId'] } },
      { name: 'oversized form', arrange: (f) => { f.form.set('label', 'x'.repeat(17_000)); return start(f.form); }, status: 400, refusal: 'selection',
        detail: 'form', message: 'The connection form was too large. Select fewer profiles and start again.', log: { cause: 'body_size', stage: 'request' } },
      { name: 'signing key unset', arrange: (f) => { vi.stubEnv('AMAZON_OAUTH_STATE_KEY', ''); return start(f.form); }, status: 403,
        refusal: 'signing_key', detail: null, message: signing,
        log: { cause: 'missing', stage: 'signing', error: 'Error', setting: 'AMAZON_OAUTH_STATE_KEY' } },
      { name: 'signing key too short', arrange: (f) => { vi.stubEnv('AMAZON_OAUTH_STATE_KEY', 'short-synthetic-key'); return start(f.form); },
        status: 403, refusal: 'signing_key', detail: null, message: signing,
        log: { cause: 'too_short', stage: 'signing', error: 'Error', setting: 'AMAZON_OAUTH_STATE_KEY' } },
      { name: 'listed database refusal', profile: 'vendor', arrange: (f) => start(f.form), status: 403, refusal: 'database',
        detail: 'association_refused', message: 'The database refused this connection: SP-API profile association refused.',
        log: { cause: 'listed_refusal', stage: 'database', error: 'PostgresError', sqlstate: '42501', routine: 'exec_stmt_raise' } },
      { name: 'unlisted database error', arrange: (f) => { intercept('app.begin_spapi_connection', () => { throw unlisted; }); return start(f.form); },
        status: 403, refusal: 'database', detail: null, message: generic,
        log: { cause: 'unlisted_error', stage: 'database', error: 'PostgresError', sqlstate: '57014', routine: 'ProcessInterrupts' } },
      { name: 'unexpected database response', arrange: (f) => {
        intercept('app.begin_spapi_connection', (run) => run(template`select '{}'::jsonb as result`)); return start(f.form);
      }, status: 403, refusal: 'database', detail: null, message: generic, log: { cause: 'unexpected_response', stage: 'database', error: 'ZodError',
        paths: ['operationId', 'orgId', 'connectionId', 'state', 'reason', 'requestedBindings', 'attachedBindings', 'createdAt', 'updatedAt'] } },
      { name: 'unreadable request body', arrange: (f) => {
        const request = start(f.form);
        Object.defineProperty(request, 'text', { value: () => Promise.reject(new Error('synthetic body failure')) });
        return request;
      }, status: 403, refusal: 'unexpected', detail: null,
        message: 'The connection could not be started because of an unexpected server error. Try again; if it repeats, contact your installation operator.',
        log: { cause: 'request_error', stage: 'request', error: 'Error' } },
    ];
    it.each(cases)('refuses $name with its class, message and one sanitized log entry', async ({ profile, arrange, status, refusal, detail, message, log }) => {
      const f = await seller(profile);
      const response = await startSpApiConsent(await arrange(f));
      db = saved;
      expect(response.status).toBe(status);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.json()).toEqual({ error: message, refusal, detail });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(entries(startEvent)).toEqual([{ event: startEvent, refusal, detail, ...log }]);
      for (const hidden of [f.orgId, f.userId, 'Synthetic refused seller', 'synthetic-seller', key, 'short-synthetic-key', 'synthetic unlisted database text', 'synthetic body failure']) {
        expect(lines()[0]).not.toContain(hidden);
      }
      expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.orgId}`).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
    it('covers every start refusal class with a counted case table', () => {
      expect(cases).toHaveLength(25);
      expect([...new Set(cases.map((row) => row.refusal))].sort()).toEqual([...SpApiStartRefusalClass.options].sort());
    });
    it('returns a plain form POST to Connections with only fixed codes', async () => {
      const f = await seller(); f.form.delete('binding');
      const response = await startSpApiConsent(start(f.form, navigate));
      expect(response.status).toBe(303);
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const location = new URL(response.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(origin + '/settings/connections');
      expect([...location.searchParams]).toEqual([['org', f.orgId], ['spapi_error', 'selection'], ['spapi_detail', 'bindings']]);
      const foreign = await startSpApiConsent(start(f.form, { ...navigate, origin: 'http://foreign.test' }));
      expect([...new URL(foreign.headers.get('location')!).searchParams]).toEqual([['spapi_error', 'origin']]);
      vi.stubEnv('SP_API_OAUTH_REGION', '');
      f.form.set('binding', 'synthetic-malformed');
      const unset = await startSpApiConsent(start(f.form, { 'sec-fetch-mode': 'navigate' }));
      expect([...new URL(unset.headers.get('location')!).searchParams]).toEqual([['org', f.orgId], ['spapi_error', 'configuration'], ['spapi_detail', 'SP_API_OAUTH_REGION']]);
      expect(entries(startEvent)).toHaveLength(3);
      expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.orgId}`).toHaveLength(0);
    });
    it('logs callback refusals by reason and class without state, codes or identifiers', async () => {
      const f = await begin();
      warn.mockClear();
      const consent = new URLSearchParams({ state: f.state, spapi_oauth_code: code, selling_partner_id: 'synthetic-seller' });
      const missing = new URLSearchParams(consent); missing.delete('state');
      const outcomes: (string | null)[] = [];
      const receive = async (params: URLSearchParams) => {
        const response = await receiveSpApiConsent(callbackRequest(params, f.nonce));
        outcomes.push(new URL(response.headers.get('location')!).searchParams.get('spapi_error'));
      };
      await receive(missing);
      identityFailure = true; await receive(consent); identityFailure = false;
      await db.sql`update public.org_members set role='viewer' where org_id=${f.actor.orgId} and user_id=${f.actor.userId}`;
      await receive(consent);
      vi.stubEnv('AMAZON_OAUTH_STATE_KEY', ''); await receive(consent);
      expect(outcomes).toEqual(['missing', 'submission_uncertain', 'authority_changed', 'submission_uncertain']);
      expect(entries(callbackEvent)).toEqual([
        { event: callbackEvent, reason: 'missing', error: 'CallbackRefusal' },
        { event: callbackEvent, reason: 'submission_uncertain', refusal: 'session', detail: null, cause: 'identity_error', stage: 'identity', error: 'Error' },
        { event: callbackEvent, reason: 'authority_changed', refusal: 'role', detail: null, cause: 'role_cannot_manage', stage: 'membership' },
        { event: callbackEvent, reason: 'submission_uncertain', refusal: 'signing_key', detail: null, cause: 'missing', stage: 'callback', error: 'Error',
          setting: 'AMAZON_OAUTH_STATE_KEY' },
      ]);
      for (const line of lines()) {
        for (const hidden of [f.state, f.nonce, code, f.operationId, f.actor.orgId, f.actor.userId]) expect(line).not.toContain(hidden);
      }
      expect(await db.sql`select id from app.spapi_connection_operations where org_id=${f.actor.orgId} and code_hash is not null`).toHaveLength(0);
    });
  });
});
