import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { withAuthenticatedActor } from './queries/authenticated-actor.js';
import {
  issueMemberRecoveryLinkForActor, issueTeamInvitationLinkForActor, MemberRecoveryLinkRefused,
} from './queries/access-links.js';

const available = await databaseAvailable();
const OWNER = 'c1c1c1c1-c1c1-41c1-81c1-c1c1c1c1c1c1';
const ADMIN = 'd2d2d2d2-d2d2-42d2-82d2-d2d2d2d2d2d2';
const ANALYST = 'e3e3e3e3-e3e3-43e3-83e3-e3e3e3e3e3e3';
const VIEWER = 'f4f4f4f4-f4f4-44f4-84f4-f4f4f4f4f4f4';
const FOREIGN_OWNER = 'a5a5a5a5-a5a5-45a5-85a5-a5a5a5a5a5a5';
const OUTSIDER = 'b6b6b6b6-b6b6-46b6-86b6-b6b6b6b6b6b6';
const synthetic = (label: string) => `https://app.example.test/${label}/${randomUUID()}`;

describe.skipIf(!available)('owner/admin one-time access links', () => {
  let database: TestDatabase;
  let orgId: string;
  let foreignOrg: string;

  beforeAll(async () => {
    database = await createTestDatabase('access_links');
    const [row] = await database.sql<{ a: string; b: string }[]>`
      select app.seed_tenant_fixture('links-a', ${OWNER}, 'owner') as a,
             app.seed_tenant_fixture('links-b', ${FOREIGN_OWNER}, 'owner') as b
    `;
    orgId = row!.a; foreignOrg = row!.b;
    for (const [userId, role] of [[ADMIN, 'admin'], [ANALYST, 'analyst'], [VIEWER, 'viewer']] as const) {
      await database.sql`select public.auth_user_stub(${userId})`;
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${userId},${role})`;
    }
    await database.sql`select public.auth_user_stub(${OUTSIDER})`;
    for (const userId of [OWNER, ADMIN, ANALYST, VIEWER, FOREIGN_OWNER, OUTSIDER]) {
      await database.sql`update auth.users set email = ${`${userId.slice(0, 8)}@example.test`} where id = ${userId}`;
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  const actor = (userId: string, org = orgId) => ({ orgId: org, userId });
  async function invitation(email = `${randomUUID()}@example.test`) {
    const token = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(token).digest('hex');
    await withAuthenticatedActor(database, actor(ADMIN), async (sql) => {
      await sql`select app.issue_team_invitation(${orgId},${email},'viewer',${hash},${token.slice(0, 12)})`;
    });
    return { email, hash };
  }
  const audits = async (action: string) => database.sql<{ actor_id: string; target_type: string; target_id: string; payload: Record<string, unknown> }[]>`
    select actor_id, target_type, target_id, payload from public.audit_log where org_id = ${orgId} and action = ${action} order by id`;

  it('admits one team link for the saved recipient and audits it without the link', async () => {
    const saved = await invitation();
    const url = synthetic('invite');
    const issue = vi.fn().mockResolvedValue({ status: 'link_ready', url });
    const before = (await audits('team.invitation_link_issued')).length;
    const result = await issueTeamInvitationLinkForActor(database, actor(ADMIN), saved.hash, issue);
    expect(result).toMatchObject({ status: 'link_ready', url });
    expect(issue).toHaveBeenCalledExactlyOnceWith(saved.email);
    const rows = await audits('team.invitation_link_issued');
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)).toEqual({ actor_id: ADMIN, target_type: 'org_invitation', target_id: result.invitationId, payload: { status: 'link_ready' } });
    expect(JSON.stringify(rows)).not.toContain(url);
  });

  it('refuses analysts, viewers, other organisations and a throwing provider with no audit', async () => {
    const saved = await invitation();
    const issue = vi.fn().mockResolvedValue({ status: 'link_ready', url: synthetic('invite') });
    const before = (await audits('team.invitation_link_issued')).length;
    for (const refused of [actor(ANALYST), actor(VIEWER), actor(FOREIGN_OWNER, foreignOrg), actor(FOREIGN_OWNER)]) {
      await expect(issueTeamInvitationLinkForActor(database, refused, saved.hash, issue)).rejects.toMatchObject({ name: 'AgencyAccessDenied' });
    }
    expect(issue).not.toHaveBeenCalled();
    const failing = vi.fn().mockRejectedValue(new Error('synthetic provider loss'));
    await expect(issueTeamInvitationLinkForActor(database, actor(OWNER), saved.hash, failing)).rejects.toThrow('synthetic provider loss');
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await audits('team.invitation_link_issued')).toHaveLength(before);
  });

  it('issues one member reset link per ten minutes and audits the target member', async () => {
    const issue = vi.fn(async (email: string) => email.length > 0 ? synthetic('auth/recovery/callback') : null);
    const first = await issueMemberRecoveryLinkForActor(database, actor(ADMIN), { userId: VIEWER }, issue);
    expect(first.email).toBe(`${VIEWER.slice(0, 8)}@example.test`);
    await expect(issueMemberRecoveryLinkForActor(database, actor(OWNER), { userId: VIEWER }, issue))
      .rejects.toMatchObject({ reason: 'rate_limited' });
    expect(issue).toHaveBeenCalledTimes(1);
    let rows = await audits('auth.recovery_link_issued');
    expect(rows).toEqual([{ actor_id: ADMIN, target_type: 'user', target_id: VIEWER, payload: {} }]);
    expect(JSON.stringify(rows)).not.toContain(first.url);

    await database.sql`update public.audit_log set created_at = clock_timestamp() - interval '11 minutes'
      where org_id = ${orgId} and action = 'auth.recovery_link_issued'`;
    await issueMemberRecoveryLinkForActor(database, actor(OWNER), { userId: VIEWER }, issue);
    expect(issue).toHaveBeenCalledTimes(2);
    rows = await audits('auth.recovery_link_issued');
    expect(rows.map((row) => row.actor_id)).toEqual([ADMIN, OWNER]);
  });

  it('refuses analysts, viewers, other organisations, self, non-members and admin resets of an owner', async () => {
    const issue = vi.fn(async () => synthetic('auth/recovery/callback'));
    const before = (await audits('auth.recovery_link_issued')).length;
    for (const refused of [actor(ANALYST), actor(VIEWER), actor(FOREIGN_OWNER)]) {
      await expect(issueMemberRecoveryLinkForActor(database, refused, { userId: ADMIN }, issue))
        .rejects.toMatchObject({ name: 'AgencyAccessDenied' });
    }
    const reasons: string[] = [];
    for (const [by, target, org] of [
      [ADMIN, ADMIN, orgId], [ADMIN, OUTSIDER, orgId], [ADMIN, FOREIGN_OWNER, orgId], [FOREIGN_OWNER, ADMIN, foreignOrg], [ADMIN, OWNER, orgId],
    ] as const) {
      const error = await issueMemberRecoveryLinkForActor(database, actor(by, org), { userId: target }, issue).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MemberRecoveryLinkRefused);
      reasons.push((error as MemberRecoveryLinkRefused).reason);
    }
    expect(reasons).toEqual(['self', 'not_member', 'not_member', 'not_member', 'owner_only']);
    expect(issue).not.toHaveBeenCalled();
    expect(await audits('auth.recovery_link_issued')).toHaveLength(before);
  });

  it('refuses a member whose password also guards a workspace the issuer does not manage', async () => {
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${foreignOrg},${ANALYST},'viewer')`;
    const issue = vi.fn(async () => synthetic('auth/recovery/callback'));
    const before = (await audits('auth.recovery_link_issued')).length;
    try {
      for (const by of [OWNER, ADMIN]) {
        await expect(issueMemberRecoveryLinkForActor(database, actor(by), { userId: ANALYST }, issue))
          .rejects.toMatchObject({ reason: 'other_orgs' });
      }
      // An issuer who manages both workspaces may still issue one.
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${foreignOrg},${OWNER},'admin')`;
      await issueMemberRecoveryLinkForActor(database, actor(OWNER), { userId: ANALYST }, issue);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(await audits('auth.recovery_link_issued')).toHaveLength(before + 1);
    } finally {
      await database.sql`delete from public.org_members where org_id = ${foreignOrg} and user_id in (${ANALYST}, ${OWNER})`;
      await database.sql`update public.audit_log set created_at = clock_timestamp() - interval '11 minutes'
        where org_id = ${orgId} and action = 'auth.recovery_link_issued'`;
    }
  });

  it('records nothing when Auth returns no link', async () => {
    const before = (await audits('auth.recovery_link_issued')).length;
    const issue = vi.fn(async () => null);
    await expect(issueMemberRecoveryLinkForActor(database, actor(OWNER), { userId: ANALYST }, issue)).rejects.toThrow('Recovery link unavailable');
    expect(issue).toHaveBeenCalledTimes(1);
    expect(await audits('auth.recovery_link_issued')).toHaveLength(before);
  });
});
