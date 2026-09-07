/** Amazon callback validates browser/session custody and submits one protected operation.
 * Token exchange and profile discovery execute exclusively in the worker.
 */
import { NextResponse } from 'next/server';
import { cancelAmazonConnection, submitAmazonConnection } from '@wizard-ads/db';
import { amazonConnectionsEnabled, secureCookies, stateSigningKey } from '../../../../../src/env';
import { can } from '../../../../../src/auth/roles';
import { authOrigin } from '../../../../../src/auth/origin';
import { ORG_COOKIE } from '../../../../../src/cookies';
import {
  authorizeOperatorRole,
  currentOperatorIdentity,
} from '../../../../../src/auth/security-authorization';
import { database } from '../../../../../src/data/db';
import { membershipFor, resolveOrgContext } from '../../../../../src/data/orgs';
import {
  clearedNonceCookie,
  nonceCookieName,
  nonceDigest,
  verifyState,
} from '../../../../../src/oauth/state';
import type { StateFailure } from '../../../../../src/oauth/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SETTINGS = '/settings/connections';

export async function GET(request: Request): Promise<Response> {
  const secure = secureCookies();
  const url = new URL(request.url);

  const cookieNonce = readCookie(request, nonceCookieName(secure));
  let verification;
  try { verification = verifyState(stateSigningKey(), url.searchParams.get('state'), cookieNonce); }
  catch { return finish(secure, failure('the authorization could not be verified; start again')); }
  if (!verification.ok) {
    return finish(secure, failure(stateMessage(verification.reason)));
  }

  const identity = await currentOperatorIdentity();
  const user = identity.user;
  if (identity.security?.state === 'unavailable') {
    return finish(secure, failure('account security could not be verified; start again'));
  }
  if (!user) return finish(secure, failure('your session ended; sign in and try again'));
  if (user.id !== verification.claims.sub) {
    return finish(secure, failure('this authorization was started by a different session'));
  }

  const handle = database();
  if (handle === null) return finish(secure, failure('the database is not configured'));

  const context = await resolveOrgContext(handle, user, verification.claims.org);
  const membership = membershipFor(context, verification.claims.org);
  if (!membership || !can(membership.role, 'manageConnection')) {
    return finish(secure, failure('you may no longer connect Amazon Ads for that organisation'));
  }
  const authorization = authorizeOperatorRole(identity, membership.role, SETTINGS);
  if (authorization.status !== 'ok') {
    return finish(
      secure,
      failure('verify account security from Settings, then start the connection again'),
    );
  }

  const actor = { orgId: membership.orgId, userId: user.id };
  const { operationId } = verification.claims;
  const destination = `${SETTINGS}?${new URLSearchParams({ org: actor.orgId, operation: operationId })}`;
  if (!amazonConnectionsEnabled()) {
    return finish(secure, failure('Amazon connections are temporarily unavailable'));
  }
  if (url.searchParams.has('error')) {
    // Never echo provider descriptions. They may contain request identifiers.
    try { await cancelAmazonConnection(handle, actor, operationId); }
    catch { return finish(secure, failure('The connection could not be reconciled; check Connections')); }
    return finish(secure, destination, actor.orgId);
  }
  const code = url.searchParams.get('code');
  if (!code || code.length > 8192) return finish(secure, failure('Amazon returned no usable authorization code'));
  try {
    await submitAmazonConnection(handle, actor, {
      operationId, nonceHash: nonceDigest(verification.claims.nonce), code,
    });
  } catch {
    // The commit may have succeeded. The durable status page is the recovery
    // destination; never repeat the exchange or serialize a query error here.
  }
  return finish(secure, destination, actor.orgId);
}

/** Redirect, always clearing the nonce. Never a body: the code is in the URL. */
function finish(secure: boolean, location: string, verifiedOrgId?: string): Response {
  const response = NextResponse.redirect(absolute(location), 303);
  if (verifiedOrgId !== undefined) {
    response.cookies.set(ORG_COOKIE, verifiedOrgId, {
      httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 365,
    });
  }
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.append('Set-Cookie', clearedNonceCookie(secure));
  return response;
}

/**
 * `NextResponse.redirect` insists on an absolute URL. The base is the app's own
 * origin from the environment when it is set, and localhost otherwise; it is
 * never taken from the request, because a redirect target built from a header
 * an attacker controls is an open redirect.
 */
function absolute(path: string): string {
  return new URL(path, authOrigin()).toString();
}

function failure(message: string): string {
  return `${SETTINGS}?${new URLSearchParams({ oauth_error: message }).toString()}`;
}

function stateMessage(reason: StateFailure): string {
  switch (reason) {
    case 'expired':
      return 'the authorization link expired (it is valid for 15 minutes); start again';
    case 'missing':
      return 'the authorization could not be verified; start again from this page';
    case 'nonce_mismatch':
      return 'the authorization was opened in a different browser session; start again';
    case 'bad_signature':
    case 'malformed':
    case 'not_yet_valid':
      return 'the authorization state was altered and was rejected; nothing was stored';
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const index = trimmed.indexOf('=');
    if (index > 0 && trimmed.slice(0, index) === name) return trimmed.slice(index + 1);
  }
  return null;
}
