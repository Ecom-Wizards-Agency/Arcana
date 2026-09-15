import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { acceptTeamInvitation, inspectTeamInvitation } from '@wizard-ads/db';
import {
  createInvitation,
  hashInviteToken,
  invitationStatus,
  newInviteToken,
} from './invitations';

describe('invitation tokens and status', () => {
  it('generates 32 random bytes as base64url and hashes to SHA-256 hex', () => {
    const token = newInviteToken();
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hashInviteToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInviteToken(token)).toBe(hashInviteToken(token));
  });

  it('derives lifecycle status with terminal timestamps ahead of expiry', () => {
    const now = new Date('2026-08-27T12:00:00.000Z');
    expect(
      invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: '2026-08-28T00:00:00Z' }, now),
    ).toBe('pending');
    expect(
      invitationStatus({ acceptedAt: null, revokedAt: null, expiresAt: '2026-08-27T12:00:00Z' }, now),
    ).toBe('expired');
    expect(
      invitationStatus({ acceptedAt: null, revokedAt: '2026-08-26T00:00:00Z', expiresAt: '2026-08-28T00:00:00Z' }, now),
    ).toBe('revoked');
    expect(
      invitationStatus({ acceptedAt: '2026-08-26T00:00:00Z', revokedAt: null, expiresAt: '2026-08-25T00:00:00Z' }, now),
    ).toBe('accepted');
  });
});

const available = await databaseAvailable();

describe.skipIf(!available)('invitation persistence and claims', () => {
  let database: TestDatabase;
  let orgId: string;
  const ownerId = '38383838-3838-4838-8838-383838383838';

  beforeAll(async () => {
    database = await createTestDatabase('web_invitations');
    const rows = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('invite-test', ${ownerId}, 'owner')
    `;
    orgId = rows[0]?.seed_tenant_fixture ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('round-trips a created token through its stored hash', async () => {
    const issued = await createInvitation(database, {
      orgId,
      email: `ROUND-${randomUUID()}@EXAMPLE.TEST`,
      role: 'analyst',
      invitedBy: ownerId,
    });
    const found = await inspectTeamInvitation(database, hashInviteToken(issued.token));

    expect(found?.email).toBe(issued.invitation.email.toLowerCase());
    expect(found?.state).toBe('pending');
    const stored = await database.sql<{ token_hash: string }[]>`
      select token_hash from public.org_invitations where id = ${issued.invitation.id}
    `;
    expect(stored[0]?.token_hash).toBe(hashInviteToken(issued.token));
    expect(stored[0]?.token_hash).not.toBe(issued.token);
  });

  it('accepts once and reconciles a retry without a provisional claim', async () => {
    const issued = await createInvitation(database, {
      orgId,
      email: `claim-${randomUUID()}@example.test`,
      role: 'viewer',
      invitedBy: ownerId,
    });
    const tokenHash = hashInviteToken(issued.token);
    const userId = randomUUID();
    await database.sql`insert into auth.users(id,email,email_confirmed_at) values (${userId},${issued.invitation.email},now())`;
    const outcomes = await Promise.all([
      acceptTeamInvitation(database, { userId }, tokenHash),
      acceptTeamInvitation(database, { userId }, tokenHash),
    ]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(['accepted', 'already_accepted']);
    const [counts] = await database.sql`
      select (select count(*)::int from public.org_members where org_id=${orgId} and user_id=${userId}) as memberships,
             (select count(*)::int from public.audit_log where target_id=${issued.invitation.id} and action='invitation.accepted') as audits
    `;
    expect(counts).toEqual({ memberships: 1, audits: 1 });
  });
});
