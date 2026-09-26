/**
 * One-time access links issued by an organisation owner or admin: team
 * invitation links and member password reset links. The link itself never
 * enters the database; each issuance writes one audit row in the same
 * transaction that holds current manager authority.
 */
import {
  ACCESS_LINK_AUDIT_ACTIONS, BootstrapTokenDigest, InvitationDeliveryStatus, MEMBER_RECOVERY_LINK_INTERVAL_MINUTES,
  MemberRecoveryLinkRequest, ORG_CAPABILITY_ROLES, OrgActor, OrgRole, TeamInvitationDeliveryContext,
  type MemberRecoveryLinkRefusal,
} from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { DbHandle } from '../client.js';
import { AgencyAccessDenied } from './authenticated-actor.js';

const TokenHash = BootstrapTokenDigest.shape.tokenHash;

export interface IssuedAccessLink {
  status: InvitationDeliveryStatus;
  /** Shown once to the issuing manager. Never persisted or logged. */
  url: string;
}

export class MemberRecoveryLinkRefused extends Error {
  constructor(readonly reason: MemberRecoveryLinkRefusal) {
    super('Recovery link refused');
    this.name = 'MemberRecoveryLinkRefused';
  }
}

/**
 * Admit one team invitation link for the saved open invitation. `issue` runs
 * only after current owner/admin authority and the invitation are locked, and
 * the audit row commits with that authority. A throwing `issue` leaves no row.
 */
export async function issueTeamInvitationLinkForActor(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  rawTokenHash: string,
  issue: (email: string) => Promise<IssuedAccessLink>,
): Promise<IssuedAccessLink & { invitationId: string }> {
  const tokenHash = TokenHash.parse(rawTokenHash);
  return withCurrentMemberManager(handle, rawActor, async (sql, actor) => {
    const rows = await sql<{ context: unknown }[]>`
      select app.team_invitation_delivery_context(${actor.orgId}, ${tokenHash}) as context
    `;
    if (rows.length !== 1) throw new Error('Invitation delivery response count mismatch');
    return TeamInvitationDeliveryContext.parse(rows[0]!.context);
  }, async (sql, actor, context) => {
    const link = await issue(context.email);
    const status = InvitationDeliveryStatus.parse(link.status);
    await audit(sql, actor, ACCESS_LINK_AUDIT_ACTIONS.team, 'org_invitation', context.invitationId, { status });
    return { status, url: link.url, invitationId: context.invitationId };
  });
}

/**
 * Admit one owner/admin password reset link for another current member. Only
 * an owner may reset an owner. One password guards every workspace a member
 * belongs to, so the issuer must hold the same authority in each of them. At
 * most one link per member per interval is admitted; the check and the audit
 * row share the organisation member lock. `issue` returns the link or null
 * when Auth did not produce one.
 */
export async function issueMemberRecoveryLinkForActor(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  rawTarget: MemberRecoveryLinkRequest,
  issue: (email: string) => Promise<string | null>,
): Promise<{ url: string; email: string }> {
  const target = MemberRecoveryLinkRequest.parse(rawTarget);
  return withCurrentMemberManager(handle, rawActor, async (sql, actor, role) => {
    if (target.userId === actor.userId) throw new MemberRecoveryLinkRefused('self');
    const rows = await sql<{ email: string | null; role: string }[]>`
      select email, role from app.list_org_members(${actor.orgId}::uuid) where user_id = ${target.userId}::uuid
    `;
    const member = rows[0];
    if (rows.length !== 1 || !member?.email) throw new MemberRecoveryLinkRefused('not_member');
    if (member.role === 'owner' && role !== 'owner') throw new MemberRecoveryLinkRefused('owner_only');
    return { email: member.email };
  }, async (sql, actor, member) => {
    const [unmanaged] = await sql<{ count: number }[]>`
      select count(*)::int as count from public.org_members target
       where target.user_id = ${target.userId}
         and not exists (
           select 1 from public.org_members issuer
            where issuer.org_id = target.org_id and issuer.user_id = ${actor.userId}
              and (issuer.role = 'owner' or (issuer.role = 'admin' and target.role <> 'owner')))
    `;
    if (unmanaged?.count !== 0) throw new MemberRecoveryLinkRefused('other_orgs');
    const [recent] = await sql<{ count: number }[]>`
      select count(*)::int as count from public.audit_log
       where org_id = ${actor.orgId} and action = ${ACCESS_LINK_AUDIT_ACTIONS.recovery}
         and target_type = 'user' and target_id = ${target.userId}
         and created_at > clock_timestamp() - make_interval(mins => ${MEMBER_RECOVERY_LINK_INTERVAL_MINUTES})
    `;
    if (recent?.count !== 0) throw new MemberRecoveryLinkRefused('rate_limited');
    const url = await issue(member.email);
    if (!url) throw new Error('Recovery link unavailable');
    await audit(sql, actor, ACCESS_LINK_AUDIT_ACTIONS.recovery, 'user', target.userId, {});
    return { url, email: member.email };
  });
}

async function audit(
  sql: postgres.TransactionSql, actor: Readonly<OrgActor>, action: string,
  targetType: string, targetId: string, payload: Record<string, unknown>,
): Promise<void> {
  const rows = await sql`insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, payload, source, created_at)
    values (${actor.orgId}, 'user', ${actor.userId}, ${action}, ${targetType}, ${targetId},
      ${JSON.stringify(payload)}::jsonb, 'web', clock_timestamp()) returning id`;
  if (rows.length !== 1) throw new Error('Access link audit could not be recorded');
}

/**
 * Current owner/admin authority for one complete command. The authenticated
 * phase reads under the caller's RLS while the organisation member lock is
 * held; the privileged phase then writes the audit before commit. Private:
 * never export a privileged callback.
 */
async function withCurrentMemberManager<R, T>(
  handle: Pick<DbHandle, 'sql'>,
  rawActor: OrgActor,
  authenticated: (sql: postgres.TransactionSql, actor: Readonly<OrgActor>, role: OrgRole) => Promise<R>,
  privileged: (sql: postgres.TransactionSql, actor: Readonly<OrgActor>, read: R) => Promise<T>,
): Promise<T> {
  const actor = Object.freeze(OrgActor.parse(rawActor));
  const result = await handle.sql.begin(async (sql) => {
    const [prior] = await sql<{
      role: string; claims: string | null; subject: string | null; claim_role: string | null; service: boolean;
    }[]>`select current_setting('role') as role,
      current_setting('request.jwt.claims', true) as claims,
      current_setting('request.jwt.claim.sub', true) as subject,
      current_setting('request.jwt.claim.role', true) as claim_role,
      app.is_service_role() as service`;
    if (!prior?.service) throw new Error('Database authority could not be established');
    await sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: actor.userId, role: 'authenticated' })}, true),
      set_config('request.jwt.claim.sub', ${actor.userId}, true), set_config('request.jwt.claim.role', 'authenticated', true)`;
    await sql`set local role authenticated`;
    // The command waits on one bounded Auth call while holding the member
    // lock; never leave that lock behind an abandoned connection.
    await sql`set local idle_in_transaction_session_timeout = '30s'`;
    // Member administration's lock order: organisation lock, then the acting
    // membership FOR SHARE, held until commit.
    await sql`select app.lock_org_editor(${actor.orgId}::uuid)`;
    const [membership] = await sql<{ role: string }[]>`select role::text as role from public.org_members
      where org_id = ${actor.orgId} and user_id = auth.uid()`;
    const role = OrgRole.safeParse(membership?.role);
    if (!role.success || !(ORG_CAPABILITY_ROLES.manageMembers as readonly string[]).includes(role.data)) {
      throw new AgencyAccessDenied();
    }
    const read = await authenticated(sql, actor, role.data);
    // Restore the actual caller, never a stronger session default.
    await sql`select set_config('role', ${prior.role}, true)`;
    await sql`select set_config('request.jwt.claims', ${prior.claims ?? ''}, true),
      set_config('request.jwt.claim.sub', ${prior.subject ?? ''}, true),
      set_config('request.jwt.claim.role', ${prior.claim_role ?? ''}, true)`;
    const [restored] = await sql<{ valid: boolean }[]>`select app.is_service_role() as valid`;
    if (!restored?.valid) throw new Error('Database authority could not be restored');
    return { value: await privileged(sql, actor, read) };
  }).catch((error: unknown) => {
    if (error instanceof MemberRecoveryLinkRefused || error instanceof AgencyAccessDenied) throw error;
    // Missing or revoked authority, and a closed invitation, are one refusal.
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '42501') {
      throw new AgencyAccessDenied();
    }
    throw error;
  });
  return result.value;
}
