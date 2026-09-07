import { cancelAmazonConnection, readAmazonConnection } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { currentOperatorIdentity, authorizeOperatorRole } from '../../../../../src/auth/security-authorization';
import { authOrigin } from '../../../../../src/auth/origin';
import { can } from '../../../../../src/auth/roles';
import { database } from '../../../../../src/data/db';
import { resolveOrgContext } from '../../../../../src/data/orgs';
import { amazonConnectionsEnabled } from '../../../../../src/env';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type RouteContext = { params: Promise<{ operationId: string }> };

function json(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store, max-age=0', Vary: 'Cookie, Authorization' } });
}

async function respond(request: Request, context: RouteContext, cancel: boolean): Promise<Response> {
  try {
    if (cancel && request.headers.get('origin') !== new URL(authOrigin()).origin) return json(403, { error: 'Request origin refused' });
    const operationId = Uuid.safeParse((await context.params).operationId);
    const orgId = Uuid.safeParse(new URL(request.url).searchParams.get('org'));
    if (!operationId.success || !orgId.success) return json(404, { error: 'Connection not found' });
    const identity = await currentOperatorIdentity();
    if (identity.security?.state === 'unavailable') return json(503, { error: 'Account security could not be verified' });
    if (!identity.user) return json(401, { error: 'Sign in to view this connection' });
    const handle = database();
    if (!handle || !amazonConnectionsEnabled()) return json(503, { error: 'Amazon connections are temporarily unavailable' });
    const org = (await resolveOrgContext(handle, identity.user, orgId.data)).active;
    if (!org || (cancel && !can(org.role, 'manageConnection'))) return json(403, { error: 'Connection access refused' });
    if (authorizeOperatorRole(identity, org.role, '/settings/connections').status !== 'ok') {
      return json(403, { error: 'Verify account security before continuing' });
    }
    const actor = { orgId: org.orgId, userId: identity.user.id };
    const operation = cancel
      ? await cancelAmazonConnection(handle, actor, operationId.data)
      : await readAmazonConnection(handle, actor, operationId.data);
    return operation ? json(200, { operation }) : json(404, { error: 'Connection not found' });
  } catch {
    return json(503, { error: 'Connection status could not be reconciled. Refresh to check its saved state.' });
  }
}

export function GET(request: Request, context: RouteContext): Promise<Response> { return respond(request, context, false); }
/** Explicit cancellation only; this endpoint cannot connect, select or synchronize profiles. */
export function POST(request: Request, context: RouteContext): Promise<Response> { return respond(request, context, true); }
