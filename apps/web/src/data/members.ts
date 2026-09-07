/** Organisation membership reads and invariant-preserving writes. */
import { withAuthenticatedActor } from '@wizard-ads/db';
import type { Sql } from '@wizard-ads/db';
import { MemberRoleChange, type OrgActor } from '@wizard-ads/shared';
import { isOrgRole } from '../auth/roles';
import type { OrgRole } from '../auth/roles';

export interface SqlHandle {
  sql: Sql;
}

export interface MemberRecord {
  userId: string;
  email: string | null;
  role: OrgRole;
  createdAt: string;
  updatedAt: string;
}

export interface MemberChangeInput {
  orgId: string;
  userId: string;
  actorId: string;
}

interface MemberRow {
  user_id: string;
  email: string | null;
  role: string;
  created_at: string;
  updated_at: string;
}

export async function listMembers(handle: SqlHandle, actor: OrgActor): Promise<MemberRecord[]> {
  return withAuthenticatedActor(handle, actor, async (sql) => {
    const rows = await sql<MemberRow[]>`
      select user_id, email, role, created_at::text, updated_at::text
        from app.list_org_members(${actor.orgId}::uuid)
    `;
    return rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      role: isOrgRole(row.role) ? row.role : 'viewer',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  });
}

/** Change a role with current actor authority and final-owner protection. */
export async function updateMemberRole(
  handle: SqlHandle,
  input: MemberChangeInput & { role: OrgRole },
): Promise<number> {
  const command = MemberRoleChange.parse({ userId: input.userId, role: input.role });
  return withAuthenticatedActor(handle, { orgId: input.orgId, userId: input.actorId }, async (sql) => {
    const [row] = await sql<{ changed: number }[]>`
      select app.change_org_member_role(
        ${input.orgId}::uuid, ${command.userId}::uuid, ${command.role}::public.org_role
      ) as changed
    `;
    if (row?.changed !== 0 && row?.changed !== 1) throw new Error('Member change could not be reconciled.');
    return row.changed;
  });
}

/** Remove another member, with ownership and current-role checks inside admission. */
export async function removeMember(handle: SqlHandle, input: MemberChangeInput): Promise<number> {
  return withAuthenticatedActor(handle, { orgId: input.orgId, userId: input.actorId }, async (sql) => {
    const [row] = await sql<{ changed: number }[]>`
      select app.remove_org_member(${input.orgId}::uuid, ${input.userId}::uuid) as changed
    `;
    if (row?.changed !== 0 && row?.changed !== 1) throw new Error('Member change could not be reconciled.');
    return row.changed;
  });
}
