import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  context: vi.fn(), invite: vi.fn(), generate: vi.fn(), issueLink: vi.fn(),
}));
vi.mock('@wizard-ads/db', () => ({
  teamInvitationDeliveryContext: mocks.context,
  issueTeamInvitationLinkForActor: mocks.issueLink,
}));
// The real admin wrapper runs against this SDK double.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { admin: { inviteUserByEmail: mocks.invite, generateLink: mocks.generate } } }),
}));
const configure = (enabled: boolean) => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://auth.example.test');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', enabled ? ['synthetic', 'service', 'key'].join('-') : '');
};
vi.mock('./recipient', () => ({
  invitationPath: (_kind: string, token: string) => `/invite/${token}`,
  invitationTokenHash: (token: string) => token.length === 43 ? 'a'.repeat(64) : null,
}));
import {
  createTeamInvitationLink, deliverTeamInvitation, invitationLinkInstruction, invitationLinkStatusLabel,
} from './delivery';

describe('scoped team Auth delivery', () => {
  const actor = { orgId: '22222222-2222-4222-8222-222222222222', userId: '11111111-1111-4111-8111-111111111111' };
  const token = randomBytes(32).toString('base64url');
  const handle = {} as Parameters<typeof deliverTeamInvitation>[0];
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('WIZARD_ADS_APP_URL', 'https://app.example.test');
    configure(true);
    mocks.context.mockResolvedValue({ invitationId: actor.orgId, email: 'saved@example.test' });
    mocks.invite.mockResolvedValue({ error: null, data: { user: { email: 'saved@example.test' } } });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('uses the current database-authorized recipient and exact installation origin', async () => {
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('accepted_by_provider');
    expect(mocks.context).toHaveBeenCalledWith(handle, actor, 'a'.repeat(64));
    expect(mocks.invite).toHaveBeenCalledExactlyOnceWith('saved@example.test', { redirectTo: `https://app.example.test/invite/${token}` });
  });

  it('does not contact Auth when configuration or current authorization is unavailable', async () => {
    configure(false);
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('unavailable');
    expect(mocks.context).not.toHaveBeenCalled();
    configure(true);
    mocks.context.mockRejectedValue(new Error('synthetic revoked membership'));
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('failed');
    expect(mocks.invite).not.toHaveBeenCalled();
  });

  it('distinguishes existing accounts, provider refusal and uncertain outcomes without retry', async () => {
    mocks.invite.mockResolvedValue({ error: { code: 'email_exists', status: 422 }, data: { user: null } });
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('existing_account');
    mocks.invite.mockResolvedValue({ error: { status: 429 }, data: { user: null } });
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('failed');
    mocks.invite.mockRejectedValue(new Error('synthetic response loss'));
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('uncertain');
    expect(mocks.invite).toHaveBeenCalledTimes(3);
  });
});

describe('team invitation link delivery', () => {
  const actor = { orgId: '22222222-2222-4222-8222-222222222222', userId: '11111111-1111-4111-8111-111111111111' };
  const token = randomBytes(32).toString('base64url');
  const handle = {} as Parameters<typeof createTeamInvitationLink>[0];
  const hashed = randomBytes(28).toString('hex');
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('WIZARD_ADS_APP_URL', 'https://app.example.test');
    configure(true);
    // The database admits the saved recipient under current manager authority.
    mocks.issueLink.mockImplementation(async (_handle, _actor, _hash, issue: (email: string) => Promise<unknown>) => ({
      ...(await issue('saved@example.test') as object), invitationId: actor.orgId,
    }));
    mocks.generate.mockResolvedValue({
      error: null, data: { user: { email: 'saved@example.test' }, properties: { hashed_token: hashed, action_link: 'https://auth.example.test/verify' } },
    });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns a new-account invite link once, without sending email', async () => {
    const link = await createTeamInvitationLink(handle, actor, token);
    expect(link).toEqual({ status: 'link_ready', url: `https://app.example.test/invite/${token}?token_hash=${hashed}` });
    expect(mocks.issueLink).toHaveBeenCalledExactlyOnceWith(handle, actor, 'a'.repeat(64), expect.any(Function));
    expect(mocks.generate).toHaveBeenCalledExactlyOnceWith({
      type: 'invite', email: 'saved@example.test', options: { redirectTo: `https://app.example.test/invite/${token}` },
    });
    expect(mocks.invite).not.toHaveBeenCalled();
    expect(mocks.context).not.toHaveBeenCalled();
  });

  it('returns the plain invitation path for an existing account or unavailable Auth administration', async () => {
    mocks.generate.mockResolvedValue({ error: { code: 'email_exists', status: 422 }, data: { user: null, properties: null } });
    expect(await createTeamInvitationLink(handle, actor, token)).toEqual({ status: 'existing_account', url: `https://app.example.test/invite/${token}` });
    configure(false);
    expect(await createTeamInvitationLink(handle, actor, token)).toEqual({ status: 'unavailable', url: `https://app.example.test/invite/${token}` });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.invite).not.toHaveBeenCalled();
  });

  it('never returns a token hash from a refused, lost or mismatched response', async () => {
    const outcomes: string[] = [];
    for (const response of [
      async () => ({ error: { status: 429 }, data: { user: null, properties: null } }),
      async () => { throw new Error('synthetic response loss'); },
      async () => ({ error: null, data: { user: { email: 'other@example.test' }, properties: { hashed_token: hashed } } }),
    ]) {
      mocks.generate.mockImplementationOnce(response);
      const link = await createTeamInvitationLink(handle, actor, token);
      expect(link.url).toBe(`https://app.example.test/invite/${token}`);
      outcomes.push(link.status);
    }
    expect(outcomes).toEqual(['failed', 'uncertain', 'uncertain']);
    expect(mocks.generate).toHaveBeenCalledTimes(3);
  });

  it('refuses a malformed token before any database or Auth call', async () => {
    await expect(createTeamInvitationLink(handle, actor, 'short')).rejects.toThrow('Invalid invitation token.');
    expect(mocks.issueLink).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it('states the exact copy for the link shown once', () => {
    expect(invitationLinkStatusLabel('link_ready')).toBe('Link ready');
    expect(invitationLinkInstruction('link_ready', 'person@example.test')).toBe(
      'Send this link to person@example.test yourself; it opens the invitation and lets them set a password. It is shown only now.',
    );
    for (const status of ['existing_account', 'unavailable', 'failed', 'uncertain'] as const) {
      expect(invitationLinkInstruction(status, 'person@example.test')).toMatch(/^Send this link to person@example\.test yourself.*It is shown only now\.$/);
    }
  });
});
