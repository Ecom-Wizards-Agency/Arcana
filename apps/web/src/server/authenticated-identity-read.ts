import { AuthenticatedIdentity } from '@wizard-ads/shared';
import type { QuerySql, RequestDatabase } from '@wizard-ads/db';

/** Grid selects its agency inside the read, so it cannot use an OrgActor entry.
 * Its existing receipt contract observes revocation on the next statement,
 * so this single read-only transaction intentionally uses READ COMMITTED.
 */
export async function withAuthenticatedIdentityRead<T>(
  database: Pick<RequestDatabase, 'sql'>,
  rawIdentity: AuthenticatedIdentity,
  read: (sql: QuerySql) => Promise<T>,
): Promise<T> {
  const identity = AuthenticatedIdentity.parse(rawIdentity);
  const claims = JSON.stringify({ sub: identity.userId, role: 'authenticated' });
  const result = await database.sql.begin('read only', async (sql) => {
    await sql`select set_config('request.jwt.claims', ${claims}, true),
      set_config('request.jwt.claim.sub', ${identity.userId}, true),
      set_config('request.jwt.claim.role', 'authenticated', true)`;
    await sql`set local role authenticated`;
    return { value: await read(sql) };
  });
  return result.value;
}
