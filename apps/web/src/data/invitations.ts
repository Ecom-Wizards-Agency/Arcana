/**
 * Organisation invitation lifecycle.
 *
 * The plaintext token leaves this module exactly once, in
 * `createInvitation`'s return value. Every stored/read value is either the
 * SHA-256 digest or a short display prefix. Public lookup is deliberately
 * unscoped because the visitor has no membership yet; after lookup, every
 * mutation carries the row's org id explicitly.
 */
import { createHash, randomBytes } from 'node:crypto';
import { withAuthenticatedActor } from '@wizard-ads/db';
import type { Sql, QuerySql } from '@wizard-ads/db';
import { TeamInvitationIssue, type OrgActor } from '@wizard-ads/shared';
import { isOrgRole } from '../auth/roles';
import type { OrgRole } from '../auth/roles';

export interface SqlHandle {
  sql: Sql;
}

export type InvitationRole = Exclude<OrgRole, 'owner'>;
export type InvitationStatus = 'pending' | 'expired' | 'revoked' | 'accepted';

const STORED_PREFIX_LENGTH = 12;

export interface InvitationRecord {
  id: string;
  orgId: string;
  orgName: string;
  email: string;
  role: InvitationRole;
  tokenPrefix: string;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: InvitationStatus;
}

export interface IssuedInvitation {
  invitation: InvitationRecord;
  /** Plaintext URL token. Shown once, never persisted or retrievable. */
  token: string;
}

export interface CreateInvitationInput {
  orgId: string;
  email: string;
  role: InvitationRole;
  invitedBy: string;
}

interface InvitationRow {
  id: string;
  org_id: string;
  org_name: string;
  email: string;
  role: string;
  token_prefix: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function invitationStatus(
  invitation: Pick<InvitationRecord, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt !== null) return 'accepted';
  if (invitation.revokedAt !== null) return 'revoked';
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'pending';
}

function toInvitation(row: InvitationRow, now: Date = new Date()): InvitationRecord {
  const role = isOrgRole(row.role) && row.role !== 'owner' ? row.role : 'viewer';
  const invitation: InvitationRecord = {
    id: row.id,
    orgId: row.org_id,
    orgName: row.org_name,
    email: row.email,
    role,
    tokenPrefix: row.token_prefix,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedBy: row.accepted_by,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: 'pending',
  };
  invitation.status = invitationStatus(invitation, now);
  return invitation;
}

const invitationColumns = (sql: QuerySql) => sql`
  i.id, i.org_id, o.name as org_name, i.email, i.role::text as role,
  i.token_prefix, i.invited_by, i.expires_at::text as expires_at,
  i.accepted_at::text as accepted_at, i.accepted_by,
  i.revoked_at::text as revoked_at, i.created_at::text as created_at,
  i.updated_at::text as updated_at
`;

/** Create a seven-day invitation, refusing members and live duplicates. */
export async function createInvitation(
  handle: SqlHandle,
  input: CreateInvitationInput,
): Promise<IssuedInvitation> {
  const email = input.email.trim().toLowerCase();
  if (email.length === 0) throw new Error('Enter an email address.');
  const requestedRole: unknown = input.role;
  if (!isOrgRole(requestedRole) || requestedRole === 'owner') {
    throw new Error('Invitations may grant admin, analyst, or viewer access.');
  }

  const token = newInviteToken();
  const tokenHash = hashInviteToken(token);
  const tokenPrefix = token.slice(0, STORED_PREFIX_LENGTH);

  const command = TeamInvitationIssue.parse({ email, role: input.role, tokenHash, tokenPrefix });
  const invitation = await withAuthenticatedActor(
    handle, { orgId: input.orgId, userId: input.invitedBy }, async (sql) => {
      const [issued] = await sql<{ id: string }[]>`
        select app.issue_team_invitation(
          ${input.orgId}::uuid, ${command.email}, ${command.role}::public.org_role,
          ${command.tokenHash}, ${command.tokenPrefix}
        ) as id
      `;
      if (!issued?.id) throw new Error('The invitation could not be stored.');
      const rows = await sql<InvitationRow[]>`
        select ${invitationColumns(sql)}
          from public.org_invitations i join public.orgs o on o.id = i.org_id
         where i.org_id = ${input.orgId} and i.id = ${issued.id}
      `;
      if (rows.length !== 1) throw new Error('The invitation could not be stored.');
      return toInvitation(rows[0]!);
    },
  );

  return { invitation, token };
}

/** Every currently usable invitation in an org, newest first. */
export async function listPendingInvitations(
  handle: SqlHandle,
  actor: OrgActor,
): Promise<InvitationRecord[]> {
  return withAuthenticatedActor(handle, actor, async (sql) => {
    const rows = await sql<InvitationRow[]>`
      select ${invitationColumns(sql)}
        from public.org_invitations i
        join public.orgs o on o.id = i.org_id
       where i.org_id = ${actor.orgId}
         and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()
       order by i.created_at desc
    `;
    return rows.map((row) => toInvitation(row));
  });
}

/** Revoke an open invitation with current manager authority and atomic audit. */
export async function revokeInvitation(
  handle: SqlHandle,
  orgId: string,
  invitationId: string,
  revokedBy: string,
): Promise<boolean> {
  return withAuthenticatedActor(handle, { orgId, userId: revokedBy }, async (sql) => {
    const [row] = await sql<{ revoked: boolean }[]>`
      select app.revoke_team_invitation(${orgId}::uuid, ${invitationId}::uuid) as revoked
    `;
    if (typeof row?.revoked !== 'boolean') throw new Error('The invitation could not be reconciled.');
    return row.revoked;
  });
}

/** Public, unscoped lookup. Callers must take org/email/role only from this row. */
export async function findInvitationByTokenHash(
  handle: SqlHandle,
  tokenHash: string,
): Promise<InvitationRecord | null> {
  const rows = await handle.sql<InvitationRow[]>`
    select ${invitationColumns(handle.sql)}
      from public.org_invitations i
      join public.orgs o on o.id = i.org_id
     where i.token_hash = ${tokenHash}
     limit 1
  `;
  return rows[0] === undefined ? null : toInvitation(rows[0]);
}

/**
 * Atomically claim an invitation once. A null `acceptedBy` is the provisional
 * new-user claim made before Supabase Auth has assigned the user's id.
 */
export async function claimInvitation(
  handle: SqlHandle,
  tokenHash: string,
  acceptedBy: string | null = null,
): Promise<InvitationRecord | null> {
  const rows = await handle.sql<InvitationRow[]>`
    with claimed as (
      update public.org_invitations
         set accepted_at = now(), accepted_by = ${acceptedBy}
       where token_hash = ${tokenHash}
         and accepted_at is null
         and revoked_at is null
         and expires_at > now()
      returning *
    )
    select ${invitationColumns(handle.sql)}
      from claimed i
      join public.orgs o on o.id = i.org_id
  `;
  return rows[0] === undefined ? null : toInvitation(rows[0]);
}

/** Reopen only a provisional claim; completed/user-bound claims cannot be undone. */
export async function unclaimInvitation(
  handle: SqlHandle,
  orgId: string,
  invitationId: string,
  acceptedBy: string | null = null,
): Promise<boolean> {
  const rows = await handle.sql<{ id: string }[]>`
    update public.org_invitations
       set accepted_at = null, accepted_by = null
     where id = ${invitationId}
       and org_id = ${orgId}
       and accepted_at is not null
       and accepted_by is not distinct from ${acceptedBy}
    returning id
  `;
  return rows.length === 1;
}
