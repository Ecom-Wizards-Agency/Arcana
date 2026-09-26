// Exception: provider lifecycle commands own authenticated transactions and manager locks.
import { randomUUID } from 'node:crypto';
import {
  AgencyAccessDenied, createSpApiConnectionLifecycle, setSpApiBindingReporting, SpApiBindingReportingError, SpApiConnectionCommandError,
} from '@wizard-ads/db';
import {
  SpApiBindingReportingRequest, SpApiConnectionBegin, SpApiConnectionSubmit, SpApiStartDatabaseRefusal, Uuid,
  type SpApiConsentRefusal, type SpApiConnectionOperation, type SpApiDeployment, type SpApiStartRefusal,
} from '@wizard-ads/shared';
import { currentOperatorIdentity, authorizeOperatorRole } from '../auth/security-authorization';
import { authOrigin } from '../auth/origin';
import { can } from '../auth/roles';
import { database } from '../data/db';
import { membershipFor, resolveOrgContext } from '../data/orgs';
import { secureCookies, spApiConnectionsEnabled, spApiOAuthConfig, stateSigningKey } from '../env';
import {
  isSpApiStartSetting, SP_API_START_DATABASE_REFUSALS, spApiStartRefusalMessage, type SpApiStartSettingName,
} from '../screens/settings-connections/spapi-start-refusal';
import { createNonce, nonceDigest } from './state';
import { createSpApiState, verifySpApiState, spApiNonceCookie, spApiNonceName } from './spapi-state';

const settings = '/settings/connections';
const headers = { 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, Authorization' };
const json = (status: number, body: unknown): Response => Response.json(body, { status, headers });
const one = (params: URLSearchParams, name: string): string | null => {
  const values = params.getAll(name); return values.length === 1 ? values[0]! : null;
};

/** The step that failed decides the class; an error's own text is never shown or logged. */
type Stage = 'origin' | 'request' | 'identity' | 'membership' | 'deployment' | 'selection' | 'signing' | 'database' | 'redirect' | 'callback';

/** Loggable facts only: error and setting names, schema paths and SQLSTATE. No values or identifiers. */
interface ErrorFacts {
  readonly error: string;
  readonly setting?: { readonly name: SpApiStartSettingName; readonly problem: 'missing' | 'invalid' };
  readonly paths?: readonly string[];
  readonly sqlstate?: string;
  readonly routine?: string;
  readonly listed?: SpApiStartDatabaseRefusal;
}

interface Diagnosis {
  readonly refusal: SpApiStartRefusal;
  /** A fixed sub-reason for the server log. */
  readonly cause: string;
  readonly stage: Stage;
  readonly facts?: ErrorFacts;
}

const classified = (refusal: SpApiStartRefusal, cause: string, stage: Stage, facts?: ErrorFacts): Diagnosis =>
  ({ refusal, cause, stage, facts });
const session = (cause: string): Diagnosis => classified({ refusal: 'session', detail: null }, cause, 'identity');
const role = (cause: string): Diagnosis => classified({ refusal: 'role', detail: null }, cause, 'membership');

class CallbackRefusal extends Error {
  constructor(readonly reason: SpApiConsentRefusal, readonly diagnosis?: Diagnosis) { super('Seller consent refused'); }
}

/** An unexpected admission error, tagged with the step that raised it. */
class StageFailure extends Error {
  constructor(readonly stage: Stage, readonly failure: unknown) { super('Seller connection step failed'); }
}

async function step<T>(stage: Stage, run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { throw new StageFailure(stage, error); }
}

// `required()` and the auth flag readers name the variable first; nothing after it is read.
const SETTING_ERROR = /^([A-Z][A-Z0-9_]*) (is not set|is required|must)\b/;
const deploymentSettings = {
  clientId: 'SP_API_LWA_CLIENT_ID', applicationId: 'SP_API_APPLICATION_ID',
  redirectUri: 'SP_API_OAUTH_REDIRECT_URI', region: 'SP_API_OAUTH_REGION',
} as const satisfies Record<keyof SpApiDeployment, SpApiStartSettingName>;
const isDeploymentKey = (key: string): key is keyof typeof deploymentSettings => Object.hasOwn(deploymentSettings, key);

function schemaPaths(error: Error): string[] | undefined {
  if (error.name !== 'ZodError' || !('issues' in error) || !Array.isArray(error.issues)) return undefined;
  const paths = error.issues.map((issue: unknown) => {
    const path: unknown = typeof issue === 'object' && issue !== null && 'path' in issue ? issue.path : [];
    return (Array.isArray(path) ? path : []).map((part: unknown) => typeof part === 'number' ? String(part)
      : typeof part === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(part) ? part : '?').join('.') || '(root)';
  });
  return [...new Set(paths)].slice(0, 10);
}

function errorFacts(error: unknown): ErrorFacts {
  if (!(error instanceof Error)) return { error: typeof error };
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'Error';
  const match = SETTING_ERROR.exec(error.message);
  const setting = match?.[1];
  const facts: { -readonly [K in keyof ErrorFacts]: ErrorFacts[K] } = { error: name, paths: schemaPaths(error) };
  if (isSpApiStartSetting(setting)) facts.setting = { name: setting, problem: match?.[2] === 'must' ? 'invalid' : 'missing' };
  // postgres.js errors carry SQLSTATE in `code` and the raising C routine; bound values are never read.
  if ('severity' in error && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code)) {
    const sqlstate = error.code;
    facts.sqlstate = sqlstate;
    if ('routine' in error && typeof error.routine === 'string' && /^[a-z_][a-z0-9_]{0,63}$/i.test(error.routine)) facts.routine = error.routine;
    facts.listed = SpApiStartDatabaseRefusal.options.find((key) =>
      SP_API_START_DATABASE_REFUSALS[key].sqlstate === sqlstate && SP_API_START_DATABASE_REFUSALS[key].text === error.message);
  }
  return facts;
}

function diagnose(stage: Stage, error: unknown): Diagnosis {
  if (error instanceof StageFailure) return diagnose(error.stage, error.failure);
  if (error instanceof CallbackRefusal) return error.diagnosis ?? classified({ refusal: 'unexpected', detail: null }, error.reason, stage);
  const facts = errorFacts(error);
  const unexpected = (cause: string): Diagnosis => classified({ refusal: 'unexpected', detail: null }, cause, stage, facts);
  const setting = facts.setting;
  const configuration = (name: SpApiStartSettingName, problem: 'missing' | 'invalid'): Diagnosis =>
    classified({ refusal: 'configuration', detail: name }, `${problem}_setting`, stage, facts);
  if (setting?.name === 'AMAZON_OAUTH_STATE_KEY') {
    return classified({ refusal: 'signing_key', detail: null }, setting.problem === 'missing' ? 'missing' : 'too_short', stage, facts);
  }
  if (setting) return configuration(setting.name, setting.problem);
  const field = facts.paths?.[0]?.split('.')[0] ?? '';
  switch (stage) {
    case 'identity': return classified({ refusal: 'session', detail: null }, 'identity_error', stage, facts);
    case 'membership': return classified({ refusal: 'database', detail: null }, 'membership_read', stage, facts);
    case 'deployment': return isDeploymentKey(field) ? configuration(deploymentSettings[field], 'invalid') : unexpected('deployment_error');
    case 'selection':
      if (isDeploymentKey(field)) return configuration(deploymentSettings[field], 'invalid');
      if (field === 'label' || field === 'bindings') return classified({ refusal: 'selection', detail: field }, 'invalid_selection', stage, facts);
      return unexpected('invalid_request');
    case 'signing': return classified({ refusal: 'signing_key', detail: null }, 'unusable', stage, facts);
    case 'database':
    case 'callback':
      if (error instanceof AgencyAccessDenied) return classified({ refusal: 'role', detail: null }, 'membership_denied', stage, facts);
      if (facts.listed) return classified({ refusal: 'database', detail: facts.listed }, 'listed_refusal', stage, facts);
      if (facts.sqlstate) return classified({ refusal: 'database', detail: null }, 'unlisted_error', stage, facts);
      if (stage === 'callback') return unexpected('callback_error');
      return classified({ refusal: 'database', detail: null }, facts.paths ? 'unexpected_response'
        : error instanceof SpApiConnectionCommandError ? 'command_error' : 'begin_error', stage, facts);
    case 'origin': return configuration('WIZARD_ADS_APP_URL', 'invalid');
    case 'request': return unexpected('request_error');
    case 'redirect': return unexpected('after_begin');
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

function logged(value: Diagnosis) {
  const { refusal, cause, stage, facts } = value;
  return { refusal: refusal.refusal, detail: refusal.detail, cause, stage, error: facts?.error, setting: facts?.setting?.name,
    paths: facts?.paths, sqlstate: facts?.sqlstate, routine: facts?.routine };
}

/** A plain form POST is a document navigation; programmatic callers keep a JSON refusal. */
const navigation = (request: Request): boolean => request.headers.get('sec-fetch-mode') === 'navigate'
  || (request.headers.get('accept') ?? '').includes('text/html');

function refuseStart(request: Request, org: string | null, value: Diagnosis): Response {
  console.warn(JSON.stringify({ event: 'arcana.spapi_start_refused', ...logged(value) }));
  const { refusal } = value;
  if (navigation(request)) {
    try {
      const query = new URLSearchParams({ ...(org ? { org } : {}), spapi_error: refusal.refusal, ...(refusal.detail ? { spapi_detail: refusal.detail } : {}) });
      return new Response(null, { status: 303, headers: { ...headers, Location: new URL(`${settings}?${query}`, authOrigin()).href } });
    } catch { /* Without a configured origin the refusal is answered in place. */ }
  }
  const status = refusal.refusal === 'unavailable' ? 503 : refusal.refusal === 'selection' && refusal.detail === 'form' ? 400 : 403;
  return json(status, { error: spApiStartRefusalMessage(refusal), refusal: refusal.refusal, detail: refusal.detail });
}

async function admit(orgId: string, manager: boolean, expectedUser?: string) {
  if (!Uuid.safeParse(orgId).success) {
    throw new CallbackRefusal('mismatch', classified({ refusal: 'selection', detail: 'org' }, 'invalid_org', 'request'));
  }
  const identity = await step('identity', () => currentOperatorIdentity());
  // Checked before the user: enforced assurance reports an unverifiable session with no user.
  if (identity.security?.state === 'unavailable') {
    throw new CallbackRefusal('authority_changed', session(identity.security.reason === 'unknown-assurance' ? 'security_unknown_assurance' : 'security_provider_error'));
  }
  const user = identity.user;
  if (!user) throw new CallbackRefusal('wrong_actor', session('signed_out'));
  if (expectedUser !== undefined && user.id !== expectedUser) throw new CallbackRefusal('wrong_actor', session('different_user'));
  const handle = database();
  if (!handle) {
    throw new CallbackRefusal('submission_uncertain', classified({ refusal: 'configuration', detail: 'DATABASE_URL' }, 'database_unconfigured', 'membership'));
  }
  const context = await step('membership', () => resolveOrgContext(handle, user, orgId));
  const org = membershipFor(context, orgId);
  if (!org) throw new CallbackRefusal('authority_changed', role('not_member'));
  if (manager && !can(org.role, 'manageConnection')) throw new CallbackRefusal('authority_changed', role('role_cannot_manage'));
  const authorization = authorizeOperatorRole(identity, org.role, settings);
  if (authorization.status !== 'ok') {
    throw new CallbackRefusal('authority_changed', session(authorization.status === 'challenge' ? 'assurance_challenge' : 'assurance_error'));
  }
  return { actor: { orgId, userId: user.id }, handle,
    lifecycle: createSpApiConnectionLifecycle(handle, spApiConnectionsEnabled) };
}

/** Explicit profile selection starts consent; web submits no provider HTTP request. */
export async function startSpApiConsent(request: Request): Promise<Response> {
  let stage: Stage = 'origin';
  let org: string | null = null;
  try {
    const expected = new URL(authOrigin()).origin;
    stage = 'request';
    if (request.headers.get('origin') !== expected) {
      return refuseStart(request, null, classified({ refusal: 'origin', detail: null }, 'origin_mismatch', stage));
    }
    if (!spApiConnectionsEnabled()) return refuseStart(request, null, classified({ refusal: 'unavailable', detail: null }, 'gate_off', stage));
    const body = await request.text();
    if (body.length > 16_384) return refuseStart(request, null, classified({ refusal: 'selection', detail: 'form' }, 'body_size', stage));
    const form = new URLSearchParams(body);
    const orgId = one(form, 'org') ?? '';
    if (Uuid.safeParse(orgId).success) org = orgId;
    const { actor, lifecycle } = await admit(orgId, true);
    stage = 'deployment';
    const { authorizeUrl, beta, ...deployment } = spApiOAuthConfig();
    stage = 'selection';
    const nonce = createNonce();
    const input = SpApiConnectionBegin.parse({ ...deployment, requestId: randomUUID(), nonceHash: nonceDigest(nonce),
      label: one(form, 'label'), bindings: form.getAll('binding').map((value) => {
        const parts = value.split(':');
        return parts.length === 2 ? { profileId: parts[0], marketplaceId: parts[1] } : {};
      }) });
    stage = 'signing';
    const key = stateSigningKey();
    // Validate signing configuration before saving an operation.
    createSpApiState(key, { org: actor.orgId, sub: actor.userId, nonce, operationId: input.requestId });
    stage = 'database';
    const operation = await lifecycle.begin(actor, input);
    stage = 'redirect';
    const state = createSpApiState(key, { org: actor.orgId, sub: actor.userId, nonce, operationId: operation.operationId });
    const destination = new URL(authorizeUrl);
    destination.search = new URLSearchParams({ application_id: deployment.applicationId, state,
      redirect_uri: deployment.redirectUri, ...(beta ? { version: 'beta' } : {}) }).toString();
    return new Response(null, { status: 303, headers: { ...headers, Location: destination.href,
      'Set-Cookie': spApiNonceCookie(nonce, secureCookies()) } });
  } catch (error) { return refuseStart(request, org, diagnose(stage, error)); }
}

function operationRefusal(operation: SpApiConnectionOperation): SpApiConsentRefusal | null {
  if (operation.reason === 'expired') return 'expired';
  if (operation.reason === 'authority_changed') return 'authority_changed';
  return ['cancelled', 'reconnect_required'].includes(operation.state) ? 'operation_not_pending' : null;
}

/** Every exit clears only SP's nonce, including unexpected identity/storage errors. */
export async function receiveSpApiConsent(request: Request, params = new URL(request.url).searchParams): Promise<Response> {
  const result = new URLSearchParams();
  const secure = secureCookies();
  try {
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
    const matches = cookies.filter((part) => part.startsWith(`${spApiNonceName(secure)}=`));
    const nonce = matches.length === 1 ? matches[0]!.slice(spApiNonceName(secure).length + 1) : null;
    const verification = verifySpApiState(stateSigningKey(), one(params, 'state'), nonce);
    if (!verification.ok) {
      const reason = verification.reason;
      throw new CallbackRefusal(reason === 'expired' || reason === 'not_yet_valid' || reason === 'missing' ? reason : 'mismatch');
    }
    const { claims } = verification;
    const { actor, lifecycle } = await admit(claims.org, true, claims.sub);
    if (!spApiConnectionsEnabled()) throw new CallbackRefusal('not_configured');
    if (['org', 'profile', 'profileId', 'redirect', 'redirect_uri', 'code', 'marketplaceId'].some((key) => params.has(key))) throw new CallbackRefusal('mismatch');
    const operation = await lifecycle.operation(actor, claims.operationId);
    if (!operation || operation.orgId !== claims.org || operation.operationId !== claims.operationId) throw new CallbackRefusal('operation_not_pending');
    const refusal = operationRefusal(operation);
    if (refusal) throw new CallbackRefusal(refusal);
    // Only authenticated, operation-checked scope is included in recovery URLs.
    result.set('org', actor.orgId); result.set('spapi_operation', claims.operationId);
    if (params.has('error')) {
      if (!one(params, 'error') || params.has('spapi_oauth_code') || params.has('selling_partner_id')) throw new CallbackRefusal('invalid_consent');
      if (operation.state !== 'awaiting_consent') throw new CallbackRefusal('operation_not_pending');
      await lifecycle.cancel(actor, claims.operationId);
      throw new CallbackRefusal('provider_refused');
    }
    const parsed = SpApiConnectionSubmit.safeParse({ operationId: claims.operationId, nonceHash: nonceDigest(claims.nonce),
      code: one(params, 'spapi_oauth_code'), sellingPartnerId: one(params, 'selling_partner_id') });
    if (!parsed.success) throw new CallbackRefusal('invalid_consent');
    try {
      const submitted = await lifecycle.submit(actor, parsed.data);
      const refusal = operationRefusal(submitted);
      if (refusal) throw new CallbackRefusal(refusal);
      if (!['queued', 'exchanging', 'completed'].includes(submitted.state)) throw new CallbackRefusal('operation_not_pending');
      result.set('spapi_submission', operation.state === 'awaiting_consent' ? 'received' : 'already_received');
    } catch (error) {
      if (error instanceof CallbackRefusal) throw error;
      if (error instanceof SpApiConnectionCommandError && error.reason !== 'submission_uncertain') throw new CallbackRefusal(error.reason);
      // Read back once after a possibly committed submission. Never submit again,
      // and never turn an uncertain response into a success indication.
      try {
        const saved = await lifecycle.operation(actor, claims.operationId);
        const refusal = saved ? operationRefusal(saved) : null;
        if (refusal) throw new CallbackRefusal(refusal);
      } catch (readError) { if (readError instanceof CallbackRefusal) throw readError; }
      throw new CallbackRefusal('submission_uncertain');
    }
  } catch (error) {
    const reason = error instanceof CallbackRefusal ? error.reason : 'submission_uncertain';
    const known = error instanceof CallbackRefusal ? error.diagnosis : diagnose('callback', error);
    console.warn(JSON.stringify({ event: 'arcana.spapi_callback_refused', reason, ...(known ? logged(known) : { error: 'CallbackRefusal' }) }));
    result.set('spapi_error', reason);
  }
  const clearing = { ...headers, 'Set-Cookie': spApiNonceCookie(null, secure) };
  try { return new Response(null, { status: 303, headers: { ...clearing, Location: new URL(`${settings}?${result}`, authOrigin()).href } }); }
  catch { return Response.json({ error: 'not_configured' }, { status: 503, headers: clearing }); }
}

export async function spApiOperationRoute(request: Request, id: string, cancel: boolean): Promise<Response> {
  return connectionCommand(request, id, cancel, false);
}
export async function spApiHealthRoute(request: Request, id: string, revoke: boolean): Promise<Response> {
  return connectionCommand(request, id, revoke, true);
}
async function connectionCommand(request: Request, id: string, mutation: boolean, health: boolean): Promise<Response> {
  try {
    if (!Uuid.safeParse(id).success) return json(404, { error: 'Connection not found' });
    if (mutation && request.headers.get('origin') !== new URL(authOrigin()).origin) return json(403, { error: 'Request origin refused' });
    const { actor, lifecycle } = await admit(one(new URL(request.url).searchParams, 'org') ?? '', mutation);
    const value = health ? await (mutation ? lifecycle.revoke(actor, id) : lifecycle.health(actor, id))
      : await (mutation ? lifecycle.cancel(actor, id) : lifecycle.operation(actor, id));
    return value ? json(200, health ? { health: value } : { operation: value }) : json(404, { error: 'Connection not found' });
  } catch { return json(403, { error: 'Connection access could not be verified. Check account security and agency membership.' }); }
}

/**
 * Owner or admin switches weekly reporting for one binding of one connection.
 * The database relocks the role and writes the audit row; web calls no provider.
 */
export async function spApiBindingReportingRoute(request: Request, connectionId: string, bindingId: string): Promise<Response> {
  try {
    if (!Uuid.safeParse(connectionId).success || !Uuid.safeParse(bindingId).success) return json(404, { error: 'Profile binding not found' });
    if (request.headers.get('origin') !== new URL(authOrigin()).origin) return json(403, { error: 'Request origin refused' });
    const body = await request.text();
    let parsed: ReturnType<typeof SpApiBindingReportingRequest.safeParse>;
    try { parsed = SpApiBindingReportingRequest.safeParse(body.length <= 1_024 ? JSON.parse(body) : null); }
    catch { parsed = SpApiBindingReportingRequest.safeParse(null); }
    if (!parsed.success) return json(400, { error: 'Send {"enabled": true} or {"enabled": false}.' });
    const { actor, handle } = await admit(one(new URL(request.url).searchParams, 'org') ?? '', true);
    const binding = await setSpApiBindingReporting(handle, actor, { connectionId, bindingId, enabled: parsed.data.enabled });
    return binding ? json(200, { binding }) : json(404, { error: 'Profile binding not found' });
  } catch (error) {
    if (error instanceof SpApiBindingReportingError && error.reason === 'connection_inactive') {
      return json(409, { error: 'Reconnect the seller account before enabling reporting.' });
    }
    if (error instanceof SpApiBindingReportingError) {
      return json(503, { error: 'The reporting change could not be confirmed. Refresh to check the saved state.' });
    }
    return json(403, { error: 'Reporting access could not be verified. Check account security and agency membership.' });
  }
}
