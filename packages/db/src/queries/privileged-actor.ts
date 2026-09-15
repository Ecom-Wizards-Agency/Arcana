import { OrgActor } from '@wizard-ads/shared';
import type postgres from 'postgres';

/**
 * Infrastructure for complete, audited server-owned domain operations only.
 * The caller owns the transaction and takes domain locks after this returns.
 * Later SQL retains its original privilege and bypasses RLS when that role can;
 * every domain operation must derive its scope from the returned actor.
 */
export async function lockPrivilegedOrgEditor(
  sql: postgres.TransactionSql,
  rawActor: OrgActor,
): Promise<Readonly<OrgActor>> {
  const actor = Object.freeze(OrgActor.parse(rawActor));
  const [previous] = await sql<{ role: string }[]>`select current_setting('role') as role`;
  if (!previous) throw new Error('Database authority could not be established');
  const claims = JSON.stringify({ sub: actor.userId, role: 'authenticated' });
  await sql`
    select set_config('request.jwt.claims', ${claims}, true),
           set_config('request.jwt.claim.sub', ${actor.userId}, true),
           set_config('request.jwt.claim.role', 'authenticated', true)
  `;
  await sql`set local role authenticated`;
  await sql`select app.lock_org_editor(${actor.orgId}::uuid)`;
  // Restore the captured role, not the session's potentially stronger default.
  // No catch/retry: failed admission or restoration aborts this transaction.
  await sql`select set_config('role', ${previous.role}, true)`;
  return actor;
}
