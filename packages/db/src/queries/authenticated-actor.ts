import { AuthenticatedIdentity, OrgActor } from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { DbHandle, QuerySql } from '../client.js';

const readSnapshot = Symbol('authenticated read snapshot');

/** Minted only inside the fixed authenticated, read-only repeatable snapshot. */
export interface AuthenticatedReadSnapshot {
  readonly sql: postgres.TransactionSql;
  readonly actor: Readonly<OrgActor>;
  readonly [readSnapshot]: true;
}

export class AgencyAccessDenied extends Error {
  constructor() {
    super('Resource not found');
    this.name = 'AgencyAccessDenied';
  }
}

/**
 * Establish current-user RLS for one complete database operation. Identity must
 * come from the server's verified session/key, never a supplied HTTP user ID.
 * Also set the legacy scalar claims because hosted auth.uid() can prefer them
 * over request.jwt.claims. PostgreSQL restores every setting on commit/error.
 *
 * Pre-membership operations (membership listing and invitation acceptance) use
 * this boundary. Ordinary agency operations use withAuthenticatedActor below.
 */
export async function withAuthenticatedIdentity<T>(
  handle: Pick<DbHandle, 'sql'>,
  rawIdentity: AuthenticatedIdentity,
  operation: (sql: QuerySql) => Promise<T>,
): Promise<T> {
  return authenticatedTransaction(handle, rawIdentity, '', operation);
}

async function authenticatedTransaction<T>(
  handle: Pick<DbHandle, 'sql'>,
  rawIdentity: AuthenticatedIdentity,
  mode: '' | 'isolation level repeatable read read only',
  operation: (sql: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const identity = AuthenticatedIdentity.parse(rawIdentity);
  const claims = JSON.stringify({ sub: identity.userId, role: 'authenticated' });
  const operationWithClaims = async (sql: postgres.TransactionSql) => {
    await sql`
      select set_config('request.jwt.claims', ${claims}, true),
             set_config('request.jwt.claim.sub', ${identity.userId}, true),
             set_config('request.jwt.claim.role', 'authenticated', true)
    `;
    await sql`set local role authenticated`;
    return { value: await operation(sql) };
  };
  const result = mode === ''
    ? await handle.sql.begin(operationWithClaims)
    : await handle.sql.begin(mode, operationWithClaims);
  return result.value;
}

/**
 * Select one current membership under authenticated RLS, with no fallback.
 * Callers still filter every query by actor.orgId/profile: a user may belong to
 * several agencies. This is a read boundary, not a cached mutation permission.
 * Privileged commands recheck and lock their required role when admitting work.
 */
export async function withAuthenticatedActor<T>(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  operation: (sql: QuerySql) => Promise<T>,
): Promise<T> {
  const actor = OrgActor.parse(rawActor);
  return withAuthenticatedIdentity(handle, { userId: actor.userId }, async (sql) => {
    await requireMembership(sql, actor);
    return operation(sql);
  });
}

async function requireMembership(sql: QuerySql, actor: OrgActor): Promise<void> {
  const rows = await sql<{ present: boolean }[]>`
    select exists (
      select 1 from public.org_members
       where org_id = ${actor.orgId} and user_id = auth.uid()
    ) as present
  `;
  if (rows[0]?.present !== true) throw new AgencyAccessDenied();
}

/**
 * One coherent read at the verified actor's current membership snapshot.
 * Unlike ordinary read-committed operations, later revocations affect the next
 * snapshot; they cannot retract this already-authorized read. Never use this
 * boundary to admit a mutation. The database enforces read-only execution.
 */
export async function withAuthenticatedReadSnapshot<T>(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  read: (snapshot: AuthenticatedReadSnapshot) => Promise<T>,
): Promise<T> {
  const actor = OrgActor.parse(rawActor);
  return authenticatedTransaction(handle, { userId: actor.userId }, 'isolation level repeatable read read only', async (sql) => {
    await requireMembership(sql, actor);
    return read({ sql, actor, [readSnapshot]: true });
  });
}
