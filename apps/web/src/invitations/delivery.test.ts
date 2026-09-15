import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ context: vi.fn(), invite: vi.fn(), configured: vi.fn() }));
vi.mock('@wizard-ads/db', () => ({ teamInvitationDeliveryContext: mocks.context }));
vi.mock('../auth/admin', () => ({
  supabaseAdminConfigured: mocks.configured,
  supabaseAdminClient: () => ({ auth: { admin: { inviteUserByEmail: mocks.invite } } }),
}));
vi.mock('./recipient', () => ({
  invitationPath: (_kind: string, token: string) => `/invite/${token}`,
  invitationTokenHash: (token: string) => token.length === 43 ? 'a'.repeat(64) : null,
}));
import { deliverTeamInvitation } from './delivery';

describe('scoped team Auth delivery', () => {
  const actor = { orgId: '22222222-2222-4222-8222-222222222222', userId: '11111111-1111-4111-8111-111111111111' };
  const token = randomBytes(32).toString('base64url');
  const handle = {} as Parameters<typeof deliverTeamInvitation>[0];
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('WIZARD_ADS_APP_URL', 'https://app.example.test');
    mocks.configured.mockReturnValue(true);
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
    mocks.configured.mockReturnValue(false);
    expect(await deliverTeamInvitation(handle, actor, token)).toBe('unavailable');
    expect(mocks.context).not.toHaveBeenCalled();
    mocks.configured.mockReturnValue(true);
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
