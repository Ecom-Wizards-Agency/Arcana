// Exception: provider lifecycle commands own authenticated transactions and manager locks.
import { randomUUID } from 'node:crypto';
import { createSpApiConnectionLifecycle } from '@wizard-ads/db';
import { SpApiConnectionBegin, SpApiConnectionSubmit, Uuid } from '@wizard-ads/shared';
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

async function admit(orgId: string, manager: boolean) {
  if (!Uuid.safeParse(orgId).success) throw new Error('Refused');
  const identity = await currentOperatorIdentity();
  if (!identity.user || identity.security?.state === 'unavailable') throw new Error('Refused');
  const handle = database();
  if (!handle) throw new Error('Unavailable');
  const context = await resolveOrgContext(handle, identity.user, orgId);
  const org = membershipFor(context, orgId);
  if (!org || (manager && !can(org.role, 'manageConnection'))
    || authorizeOperatorRole(identity, org.role, settings).status !== 'ok') throw new Error('Refused');
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

/** Every exit clears only SP's nonce, including unexpected identity/storage errors. */
export async function receiveSpApiConsent(request: Request): Promise<Response> {
  let destination = `${settings}?${new URLSearchParams({ spapi_error: 'Seller authorization could not be verified. Start again from Connections.' })}`;
  const secure = secureCookies();
  try {
    const params = new URL(request.url).searchParams;
    const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim());
    const matches = cookies.filter((part) => part.startsWith(`${spApiNonceName(secure)}=`));
    const nonce = matches.length === 1 ? matches[0]!.slice(spApiNonceName(secure).length + 1) : null;
    const verification = verifySpApiState(stateSigningKey(), one(params, 'state'), nonce);
    if (!verification.ok) throw new Error('Refused');
    const { claims } = verification;
    const { actor, lifecycle } = await admit(claims.org, true);
    if (actor.userId !== claims.sub || !spApiConnectionsEnabled()) throw new Error('Refused');
    // No callback may override the saved operation's deployment or selected scope.
    if (['org', 'profile', 'profileId', 'redirect', 'redirect_uri', 'code', 'marketplaceId'].some((key) => params.has(key))) throw new Error('Refused');
    const operation = await lifecycle.operation(actor, claims.operationId);
    if (!operation || operation.orgId !== claims.org || operation.operationId !== claims.operationId) throw new Error('Refused');
    if (params.has('error')) {
      if (!one(params, 'error') || params.has('spapi_oauth_code') || params.has('selling_partner_id')) throw new Error('Refused');
      await lifecycle.cancel(actor, claims.operationId);
    } else {
      const input = SpApiConnectionSubmit.parse({ operationId: claims.operationId, nonceHash: nonceDigest(claims.nonce),
        code: one(params, 'spapi_oauth_code'), sellingPartnerId: one(params, 'selling_partner_id') });
      // An uncertain DB response is recovered from the operation; never resubmit a code.
      try { await lifecycle.submit(actor, input); } catch { /* durable status owns recovery */ }
    }
    destination = `${settings}?${new URLSearchParams({ org: actor.orgId, spapi_operation: claims.operationId })}`;
  } catch { /* Sanitized redirect; never expose a provider value or database cause. */ }
  const clearing = { ...headers,'Set-Cookie': spApiNonceCookie(null, secure) };
  try { return new Response(null, { status: 303, headers: { ...clearing, Location: new URL(destination, authOrigin()).href } }); }
  catch { return Response.json({ error: 'Seller authorization could not be completed. Check the installation configuration.' }, { status: 503,headers: clearing }); }
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
