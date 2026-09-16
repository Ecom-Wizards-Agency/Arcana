// Exception: provider lifecycle commands own authenticated transactions and manager locks.
import { randomUUID } from 'node:crypto';
import { createSpApiConnectionLifecycle, SpApiConnectionCommandError } from '@wizard-ads/db';
import { SpApiConnectionBegin, SpApiConnectionSubmit, Uuid, type SpApiConsentRefusal, type SpApiConnectionOperation } from '@wizard-ads/shared';
import { currentOperatorIdentity, authorizeOperatorRole } from '../auth/security-authorization';
import { authOrigin } from '../auth/origin';
import { can } from '../auth/roles';
import { database } from '../data/db';
import { membershipFor, resolveOrgContext } from '../data/orgs';
import { secureCookies, spApiConnectionsEnabled, spApiOAuthConfig, stateSigningKey } from '../env';
import { createNonce, nonceDigest } from './state';
import { createSpApiState, verifySpApiState, spApiNonceCookie, spApiNonceName } from './spapi-state';

const settings = '/settings/connections';
const headers = { 'Cache-Control': 'no-store, max-age=0', 'Referrer-Policy': 'no-referrer', Vary: 'Cookie, Authorization' };
const json = (status: number, body: unknown): Response => Response.json(body, { status, headers });
const one = (params: URLSearchParams, name: string): string | null => {
  const values = params.getAll(name); return values.length === 1 ? values[0]! : null;
};

class CallbackRefusal extends Error {
  constructor(readonly reason: SpApiConsentRefusal) { super('Seller consent refused'); }
}

async function admit(orgId: string, manager: boolean, expectedUser?: string) {
  if (!Uuid.safeParse(orgId).success) throw new CallbackRefusal('mismatch');
  const identity = await currentOperatorIdentity();
  if (!identity.user || (expectedUser !== undefined && identity.user.id !== expectedUser)) throw new CallbackRefusal('wrong_actor');
  if (identity.security?.state === 'unavailable') throw new CallbackRefusal('authority_changed');
  const handle = database();
  if (!handle) throw new CallbackRefusal('submission_uncertain');
  const context = await resolveOrgContext(handle, identity.user, orgId);
  const org = membershipFor(context, orgId);
  if (!org || (manager && !can(org.role, 'manageConnection'))
    || authorizeOperatorRole(identity, org.role, settings).status !== 'ok') throw new CallbackRefusal('authority_changed');
  return { actor: { orgId, userId: identity.user.id },
    lifecycle: createSpApiConnectionLifecycle(handle, spApiConnectionsEnabled) };
}

/** Explicit profile selection starts consent; web submits no provider HTTP request. */
export async function startSpApiConsent(request: Request): Promise<Response> {
  try {
    if (request.headers.get('origin') !== new URL(authOrigin()).origin) return json(403, { error: 'Request origin refused' });
    if (!spApiConnectionsEnabled()) return json(503, { error: 'Seller connections are unavailable' });
    const body = await request.text();
    if (body.length > 16_384) return json(400, { error: 'Invalid connection selection' });
    const form = new URLSearchParams(body);
    const orgId = one(form, 'org') ?? '';
    const { actor, lifecycle } = await admit(orgId, true);
    const { authorizeUrl, beta, ...deployment } = spApiOAuthConfig();
    const nonce = createNonce();
    const input = SpApiConnectionBegin.parse({ ...deployment, requestId: randomUUID(), nonceHash: nonceDigest(nonce),
      label: one(form, 'label'), bindings: form.getAll('binding').map((value) => {
        const parts = value.split(':');
        return parts.length === 2 ? { profileId: parts[0], marketplaceId: parts[1] } : {};
      }) });
    const key = stateSigningKey();
    // Validate signing configuration before saving an operation.
    createSpApiState(key, { org: actor.orgId, sub: actor.userId, nonce, operationId: input.requestId });
    const operation = await lifecycle.begin(actor, input);
    const state = createSpApiState(key, { org: actor.orgId, sub: actor.userId, nonce, operationId: operation.operationId });
    const destination = new URL(authorizeUrl);
    destination.search = new URLSearchParams({ application_id: deployment.applicationId, state,
      redirect_uri: deployment.redirectUri, ...(beta ? { version: 'beta' } : {}) }).toString();
    return new Response(null, { status: 303, headers: { ...headers, Location: destination.href,
      'Set-Cookie': spApiNonceCookie(nonce, secureCookies()) } });
  } catch { return json(403, { error: 'The connection could not be started. Check account security, role and selected seller profiles.' }); }
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
    result.set('spapi_error', error instanceof CallbackRefusal ? error.reason : 'submission_uncertain');
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
