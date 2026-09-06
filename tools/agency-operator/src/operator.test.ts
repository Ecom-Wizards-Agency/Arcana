import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asServiceRole, createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { inspectAgencyBootstrapInvitation } from '@wizard-ads/db';
import type { AgencyCommand } from './command.js';
import { runAgencyCommand, type AgencyCommandResult, type SendInvitation } from './operator.js';

const available = await databaseAvailable();
const provision = (sendEmail = false): Extract<AgencyCommand, { operation: 'provision' }> => ({
  operation: 'provision', sendEmail,
  request: { requestId: randomUUID(), name: 'Synthetic agency', slug: `synthetic-${randomUUID()}`, ownerEmail: `${randomUUID()}@example.test` },
});
function issued(result: AgencyCommandResult) {
  if (result.operation === 'revoke') throw new Error('Expected an invitation result');
  return result;
}
function hashFromLink(link: string) { return createHash('sha256').update(new URL(link).pathname.split('/').at(-1)!).digest('hex'); }

describe.skipIf(!available)('agency operator real persistence', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('agency_operator'); }, 60_000);
  afterAll(async () => { await database?.drop(); });
  const run = (command: AgencyCommand, sendInvitation?: SendInvitation) => asServiceRole(database, (sql) =>
    runAgencyCommand(command, { handle: { sql }, appOrigin: 'https://app.example.test', ...(sendInvitation ? { sendInvitation } : {}) }));

  it('returns a link matching the stored digest without creating any membership or settings', async () => {
    const command = provision();
    const result = issued(await run(command));
    expect(result.delivery).toBe('not_requested');
    expect(result.invitationUrl).toMatch(/^https:\/\/app\.example\.test\/agency-invite\/[A-Za-z0-9_-]{43}$/);
    const invitation = await inspectAgencyBootstrapInvitation(database, hashFromLink(result.invitationUrl!));
    expect(invitation).toMatchObject({ ownerEmail: command.request.ownerEmail, generation: 1, state: 'pending' });
    const [counts] = await database.sql`
      select (select count(*)::int from public.org_members where org_id=${result.receipt.orgId}) as members,
             (select count(*)::int from public.profile_strategy where org_id=${result.receipt.orgId}) as settings,
             (select count(*)::int from public.audit_log where org_id=${result.receipt.orgId}) as audits
    `;
    expect(counts).toEqual({ members: 0, settings: 0, audits: 1 });
  });

  it('concurrent retries create one agency, one usable link and one requested delivery', async () => {
    const command = provision(true);
    const sender = vi.fn<SendInvitation>().mockResolvedValue('accepted_by_provider');
    const results = (await Promise.all([run(command, sender), run(command, sender), run(command, sender)])).map(issued);
    expect(new Set(results.map((result) => result.receipt.orgId)).size).toBe(1);
    expect(results.filter((result) => result.invitationUrl !== null)).toHaveLength(1);
    expect(results.filter((result) => result.delivery === 'token_unavailable')).toHaveLength(2);
    expect(sender).toHaveBeenCalledExactlyOnceWith(command.request.ownerEmail, results.find((result) => result.invitationUrl)!.invitationUrl);
    const [counts] = await database.sql`select count(*)::int as count from public.orgs where slug=${command.request.slug}`;
    expect(counts!.count).toBe(1);
  });

  it('retains committed provisioning after a lost delivery response and never automatically resends', async () => {
    const command = provision(true);
    const sender = vi.fn<SendInvitation>().mockRejectedValue(new Error('synthetic response loss'));
    const result = issued(await run(command, sender));
    expect(result.delivery).toBe('uncertain');
    expect(result.invitationUrl).not.toBeNull();
    expect(issued(await run(command, sender))).toMatchObject({ receipt: { orgId: result.receipt.orgId }, invitationUrl: null, delivery: 'token_unavailable' });
    expect(sender).toHaveBeenCalledTimes(1);
    expect(await inspectAgencyBootstrapInvitation(database, hashFromLink(result.invitationUrl!))).toMatchObject({ state: 'pending' });
  });

  it('keeps confirmed-account delivery distinct from creating an account or accepting membership', async () => {
    const command = provision(true);
    const sender = vi.fn<SendInvitation>().mockResolvedValue('existing_account');
    const result = issued(await run(command, sender));
    expect(result.delivery).toBe('existing_account');
    expect(result.receipt.state).toBe('pending');
    expect(sender).toHaveBeenCalledTimes(1);
    const [count] = await database.sql`select count(*)::int as count from public.org_members where org_id=${result.receipt.orgId}`;
    expect(count!.count).toBe(0);
  });

  it('requires explicit generation reissue and preserves exactly one current invitation', async () => {
    const command = provision();
    const first = issued(await run(command));
    const second = issued(await run({ operation: 'reissue', requestId: command.request.requestId, expectedGeneration: 1, sendEmail: false }));
    expect(second.receipt).toMatchObject({ orgId: first.receipt.orgId, invitationId: first.receipt.invitationId, generation: 2, outcome: 'reissued' });
    expect(second.invitationUrl).not.toBe(first.invitationUrl);
    expect(await inspectAgencyBootstrapInvitation(database, hashFromLink(first.invitationUrl!))).toBeNull();
    expect(await inspectAgencyBootstrapInvitation(database, hashFromLink(second.invitationUrl!))).toMatchObject({ generation: 2, state: 'pending' });
    await expect(run({ operation: 'reissue', requestId: command.request.requestId, expectedGeneration: 1, sendEmail: false })).rejects.toMatchObject({ code: '22023' });
    const revoke = { operation: 'revoke', requestId: command.request.requestId, expectedGeneration: 2 } as const;
    expect(await run(revoke)).toMatchObject({ changed: true });
    expect(await run(revoke)).toMatchObject({ changed: false });
    expect(await inspectAgencyBootstrapInvitation(database, hashFromLink(second.invitationUrl!))).toMatchObject({ state: 'revoked' });
  });

  it('refuses missing delivery configuration before provisioning', async () => {
    const command = provision(true);
    await expect(run(command)).rejects.toThrow('not configured');
    const [counts] = await database.sql`select count(*)::int as count from public.orgs where slug=${command.request.slug}`;
    expect(counts!.count).toBe(0);
  });
});
