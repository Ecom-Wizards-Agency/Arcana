import {
  BootstrapAcceptanceReceipt, BootstrapInvitationView, BootstrapTokenDigest,
  type AuthenticatedIdentity,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { withAuthenticatedIdentity } from './authenticated-actor.js';

const TokenHash = BootstrapTokenDigest.shape.tokenHash;

/** Anonymous bearer-link inspection, never a privileged table lookup. */
export async function inspectAgencyBootstrapInvitation(
  handle: Pick<DbHandle, 'sql'>, rawTokenHash: string,
): Promise<BootstrapInvitationView | null> {
  const tokenHash = TokenHash.parse(rawTokenHash);
  const result = await handle.sql.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', '{"role":"anon"}', true),
                     set_config('request.jwt.claim.sub', '', true),
                     set_config('request.jwt.claim.role', 'anon', true)`;
    await sql`set local role anon`;
    const rows = await sql<{ invitation: unknown }[]>`
      select public.inspect_agency_bootstrap_invitation(${tokenHash}) as invitation
    `;
    if (rows.length !== 1) throw new Error('Invitation inspection response count mismatch');
    return { value: rows[0]!.invitation === null ? null : BootstrapInvitationView.parse(rows[0]!.invitation) };
  });
  return result.value;
}

/** Identity comes from verified Auth. The token alone selects the organization. */
export async function acceptAgencyBootstrapInvitation(
  handle: Pick<DbHandle, 'sql'>, identity: AuthenticatedIdentity, rawTokenHash: string,
): Promise<BootstrapAcceptanceReceipt> {
  const tokenHash = TokenHash.parse(rawTokenHash);
  return withAuthenticatedIdentity(handle, identity, async (sql) => {
    const rows = await sql<{ receipt: unknown }[]>`select app.accept_bootstrap_invitation(${tokenHash}) as receipt`;
    if (rows.length !== 1) throw new Error('Invitation acceptance response count mismatch');
    return BootstrapAcceptanceReceipt.parse(rows[0]!.receipt);
  });
}
