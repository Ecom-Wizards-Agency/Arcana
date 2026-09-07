/**
 * The actor's role in the org they are acting in.
 *
 * `requireOrgMembership` in `request-context.ts` answers "is this actor in this
 * org"; capability checks also need the current role. The lookup accepts an
 * authenticated transaction and feeds the shared application capability table.
 * Mutation admission must independently check its required authority at commit.
 */
import type { QueryHandle } from '@wizard-ads/db';
import { isOrgRole } from '../auth/roles';
import type { Capability, OrgRole } from '../auth/roles';
import { authorize } from '../auth/roles';
import { RequestAuthError } from './request-context';
import type { RequestActor } from './request-context';

/**
 * Resolve the role, or refuse the request.
 *
 * A non-member gets 403 with the same message a missing row would produce, so
 * "you are not in that org" and "that org does not exist" are indistinguishable
 * from outside.
 */
export async function requireOrgRole(
  handle: QueryHandle,
  actor: RequestActor,
): Promise<OrgRole> {
  const rows = await handle.sql<{ role: string }[]>`
    select role::text as role from public.org_members
     where org_id = ${actor.orgId} and user_id = ${actor.userId}
  `;
  const role = rows[0]?.role;
  if (!role) throw new RequestAuthError('Resource not found', 403);
  // An unknown label is a schema drift, and reading it as `viewer` is the safe
  // direction: it grants nothing beyond reading.
  return isOrgRole(role) ? role : 'viewer';
}

/** Resolve the role and assert a capability, as one call. */
export async function requireCapability(
  handle: QueryHandle,
  actor: RequestActor,
  capability: Capability,
): Promise<OrgRole> {
  const role = await requireOrgRole(handle, actor);
  try {
    authorize(role, capability);
  } catch {
    throw new RequestAuthError(`role ${role} is not permitted to ${capability}`, 403);
  }
  return role;
}
