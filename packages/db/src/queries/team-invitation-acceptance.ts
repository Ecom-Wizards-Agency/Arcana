import {
  BootstrapTokenDigest, TeamAcceptanceReceipt, TeamInvitationDeliveryContext, TeamInvitationView,
  type AuthenticatedIdentity, type OrgActor,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';
import { withAuthenticatedActor, withAuthenticatedIdentity } from './authenticated-actor.js';

const TokenHash = BootstrapTokenDigest.shape.tokenHash;

export async function inspectTeamInvitation(handle: Pick<DbHandle, 'sql'>, rawTokenHash: string): Promise<TeamInvitationView | null> {
  const tokenHash = TokenHash.parse(rawTokenHash);
  const result = await handle.sql.begin(async (sql) => {
    await sql`select set_config('request.jwt.claims', '{"role":"anon"}', true),
                     set_config('request.jwt.claim.sub', '', true),
                     set_config('request.jwt.claim.role', 'anon', true)`;
    await sql`set local role anon`;
    const rows = await sql<{ invitation: unknown }[]>`select public.inspect_team_invitation(${tokenHash}) as invitation`;
    if (rows.length !== 1) throw new Error('Invitation inspection response count mismatch');
    return { value: rows[0]!.invitation === null ? null : TeamInvitationView.parse(rows[0]!.invitation) };
  });
  return result.value;
}

export async function acceptTeamInvitation(
  handle: Pick<DbHandle, 'sql'>, identity: AuthenticatedIdentity, rawTokenHash: string,
): Promise<TeamAcceptanceReceipt> {
  const tokenHash = TokenHash.parse(rawTokenHash);
  return withAuthenticatedIdentity(handle, identity, async (sql) => {
    const rows = await sql<{ receipt: unknown }[]>`select app.accept_team_invitation(${tokenHash}) as receipt`;
    if (rows.length !== 1) throw new Error('Invitation acceptance response count mismatch');
    return TeamAcceptanceReceipt.parse(rows[0]!.receipt);
  });
}

export async function teamInvitationDeliveryContext(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, rawTokenHash: string,
): Promise<TeamInvitationDeliveryContext> {
  const tokenHash = TokenHash.parse(rawTokenHash);
  return withAuthenticatedActor(handle, actor, async (sql) => {
    const rows = await sql<{ context: unknown }[]>`
      select app.team_invitation_delivery_context(${actor.orgId},${tokenHash}) as context
    `;
    if (rows.length !== 1) throw new Error('Invitation delivery response count mismatch');
    return TeamInvitationDeliveryContext.parse(rows[0]!.context);
  });
}
