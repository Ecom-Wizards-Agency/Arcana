/** Current role/capability checks accept only an open transaction. */
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot, QueryHandle, Sql } from '@wizard-ads/db';
import { isOrgRole, authorize } from '../auth/roles';
import type { Capability, OrgRole } from '../auth/roles';
import { RequestAuthError, type RequestActor } from './request-context';

type ActorTransaction = AuthenticatedEditorTransaction | AuthenticatedReadSnapshot;
/** Reject concrete root handles at compile time, including RequestDatabase.
 * Older page loaders erase their SQL type to QueryHandle; verify those at runtime.
 * Remove this compatibility shape when their annotations retain transaction types.
 */
type TransactionOnly<T extends QueryHandle> = T & (T['sql'] extends Sql ? never : unknown);

export function requireOrgRole(handle: ActorTransaction): Promise<OrgRole>;
export function requireOrgRole<T extends QueryHandle>(handle: TransactionOnly<T>, actor: RequestActor): Promise<OrgRole>;
export async function requireOrgRole(handle: QueryHandle, suppliedActor?: RequestActor): Promise<OrgRole> {
  // A widened QueryHandle must still be a real postgres.js transaction. A root
  // connection cannot authorize a later write, even when its type was erased.
  if ('begin' in handle.sql || !('savepoint' in handle.sql)) throw new RequestAuthError('Resource not found', 403);
  const actor = 'actor' in handle ? (handle as ActorTransaction).actor : suppliedActor;
  if (!actor || (suppliedActor && (actor.orgId !== suppliedActor.orgId || actor.userId !== suppliedActor.userId))) {
    throw new RequestAuthError('Resource not found', 403);
  }
  const rows = await handle.sql<{ role: string }[]>`select role::text as role from public.org_members
    where org_id=${actor.orgId} and user_id=${actor.userId} and user_id=auth.uid()`;
  const role = rows[0]?.role;
  if (!role) throw new RequestAuthError('Resource not found', 403);
  return isOrgRole(role) ? role : 'viewer';
}

export function requireCapability(handle: ActorTransaction, capability: Capability): Promise<OrgRole>;
export function requireCapability<T extends QueryHandle>(handle: TransactionOnly<T>, actor: RequestActor, capability: Capability): Promise<OrgRole>;
export async function requireCapability(
  handle: QueryHandle, actorOrCapability: RequestActor | Capability, suppliedCapability?: Capability,
): Promise<OrgRole> {
  const role = typeof actorOrCapability === 'string'
    ? await requireOrgRole(handle as ActorTransaction)
    : await requireOrgRole(handle, actorOrCapability);
  const capability = typeof actorOrCapability === 'string' ? actorOrCapability : suppliedCapability!;
  try { authorize(role, capability); }
  catch { throw new RequestAuthError(`role ${role} is not permitted to ${capability}`, 403); }
  return role;
}
