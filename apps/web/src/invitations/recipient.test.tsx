import { randomBytes } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  currentUser: vi.fn(), authorize: vi.fn(), inspectAgency: vi.fn(), inspectTeam: vi.fn(),
  acceptAgency: vi.fn(), acceptTeam: vi.fn(), initialize: vi.fn(), verify: vi.fn(), signOut: vi.fn(),
  client: vi.fn(), cookieSet: vi.fn(), configured: vi.fn(),
}));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: mocks.cookieSet }) }));
vi.mock('@wizard-ads/db', () => ({
  inspectAgencyBootstrapInvitation: mocks.inspectAgency, inspectTeamInvitation: mocks.inspectTeam,
  acceptAgencyBootstrapInvitation: mocks.acceptAgency, acceptTeamInvitation: mocks.acceptTeam,
}));
vi.mock('../data/db', () => ({ database: () => ({}), requireDatabase: () => ({}) }));
vi.mock('../auth/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('../auth/security-authorization', () => ({ authorizeSecurityChange: mocks.authorize }));
vi.mock('../auth/supabase', () => ({ supabaseConfigured: mocks.configured, supabaseServerClient: mocks.client }));

import { acceptOwnerInvitation, verifyOwnerInvitationEmail } from '../../app/agency-invite/[token]/actions';
import { acceptAsExistingUser } from '../../app/invite/[token]/actions';
import { InvitationLanding } from './landing';
import { invitationTokenHash } from './recipient';

const token = randomBytes(32).toString('base64url');
const providerToken = randomBytes(32).toString('hex');
const path = `/agency-invite/${token}`;
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.test' };
const orgId = '22222222-2222-4222-8222-222222222222';
const providerSuccess = () => ({ error: null, data: {
  session: {}, user: { ...user, email_confirmed_at: new Date().toISOString() },
} });
function verification() {
  const form = new FormData();
  form.set('auth_token_hash', providerToken);
  return verifyOwnerInvitationEmail(token, form);
}

describe('invitation recipient actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.currentUser.mockResolvedValue(null);
    mocks.inspectAgency.mockResolvedValue({ agencyName: 'Synthetic agency', ownerEmail: user.email, generation: 1, state: 'pending' });
    mocks.inspectTeam.mockResolvedValue({ agencyName: 'Synthetic team', email: user.email, role: 'analyst', state: 'pending' });
    mocks.authorize.mockResolvedValue({ status: 'ok', user });
    mocks.configured.mockReturnValue(true);
    mocks.initialize.mockResolvedValue({ error: null });
    mocks.verify.mockResolvedValue(providerSuccess());
    mocks.signOut.mockResolvedValue({ error: null });
    mocks.client.mockResolvedValue({ auth: { initialize: mocks.initialize, verifyOtp: mocks.verify, signOut: mocks.signOut } });
    mocks.acceptAgency.mockResolvedValue({ orgId, invitationId: orgId, generation: 1, outcome: 'accepted' });
    mocks.acceptTeam.mockResolvedValue({ orgId, invitationId: orgId, outcome: 'accepted' });
  });

  it('renders a GET landing without consuming Auth tokens or creating membership', async () => {
    const rendered = renderToStaticMarkup(await InvitationLanding({
      kind: 'agency', token, authToken: providerToken, error: undefined,
      acceptAction: async () => {}, verifyAction: async () => {},
    }));
    expect(rendered).toContain('Continue with email invitation');
    expect(rendered).toContain('Recover password');
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.acceptAgency).not.toHaveBeenCalled();
    expect(mocks.inspectAgency).toHaveBeenCalledWith({}, invitationTokenHash(token));
  });

  it('awaits SDK initialization before one fixed invite verification and password setup', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    mocks.initialize.mockImplementation(() => { started(); return new Promise((resolve) => { release = () => resolve({ error: null }); }); });
    const outcome = verification().catch((error: Error) => error);
    await entered;
    expect(mocks.verify).not.toHaveBeenCalled();
    release();
    const error = await outcome;
    expect(String(error)).toContain(`/recover-password?${new URLSearchParams({ next: path, setup: '1' }).toString()}`);
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ token_hash: providerToken, type: 'invite' });
    expect(mocks.acceptAgency).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('does not replace any existing session when following another invitation', async () => {
    mocks.currentUser.mockResolvedValue({ ...user, email: 'other@example.test' });
    await expect(verification()).rejects.toThrow(`${path}?error=account`);
    expect(mocks.client).not.toHaveBeenCalled();
    mocks.currentUser.mockResolvedValue(user);
    await expect(verification()).rejects.toThrow(`REDIRECT:${path}`);
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('rejects missing, malformed and closed invitation tokens before provider work', async () => {
    await expect(verifyOwnerInvitationEmail(token, new FormData())).rejects.toThrow('error=verification');
    const malformed = new FormData(); malformed.set('auth_token_hash', 'x'.repeat(257));
    await expect(verifyOwnerInvitationEmail(token, malformed)).rejects.toThrow('error=verification');
    await expect(verifyOwnerInvitationEmail('invalid', malformed)).rejects.toThrow('error=unavailable');
    for (const state of ['expired', 'revoked', 'accepted']) {
      mocks.inspectAgency.mockResolvedValue({ agencyName: 'Synthetic agency', ownerEmail: user.email, generation: 1, state });
      await expect(verification()).rejects.toThrow('error=unavailable');
    }
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it('refuses mismatched or unconfirmed provider identities and clears only the new local session', async () => {
    for (const dataUser of [{ ...user, email: 'other@example.test', email_confirmed_at: '2026-01-01' }, { ...user, email_confirmed_at: null }]) {
      mocks.verify.mockResolvedValue({ error: null, data: { user: dataUser, session: {} } });
      await expect(verification()).rejects.toThrow('error=verification');
    }
    expect(mocks.signOut.mock.calls).toEqual([[{ scope: 'local' }], [{ scope: 'local' }]]);
    expect(mocks.acceptAgency).not.toHaveBeenCalled();
  });

  it('reports initialization and lost verification responses without provider retries or secret errors', async () => {
    mocks.initialize.mockResolvedValue({ error: new Error('synthetic init error') });
    await expect(verification()).rejects.toThrow('error=verification');
    expect(mocks.verify).not.toHaveBeenCalled();
    mocks.initialize.mockResolvedValue({ error: null });
    mocks.verify.mockRejectedValue(new Error(`synthetic response loss ${providerToken}`));
    const error = await verification().catch((caught: Error) => caught);
    expect(String(error)).toContain('error=verification');
    expect(String(error)).not.toContain(providerToken);
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });

  it('requires login, matching account and enrolled-factor verification before acceptance', async () => {
    await expect(acceptOwnerInvitation(token)).rejects.toThrow('/login?next=');
    mocks.currentUser.mockResolvedValue({ ...user, email: 'other@example.test' });
    await expect(acceptOwnerInvitation(token)).rejects.toThrow('error=account');
    mocks.currentUser.mockResolvedValue(user);
    mocks.authorize.mockResolvedValue({ status: 'challenge', href: '/auth/mfa/challenge?next=invitation' });
    await expect(acceptOwnerInvitation(token)).rejects.toThrow('/auth/mfa/challenge');
    expect(mocks.acceptAgency).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it('uses only the verified identity and token, then selects the organization returned by SQL', async () => {
    mocks.currentUser.mockResolvedValue(user);
    await expect(acceptOwnerInvitation(token)).rejects.toThrow('/auth/continue?next=%2Fdashboard');
    expect(mocks.acceptAgency).toHaveBeenCalledExactlyOnceWith({}, { userId: user.id }, invitationTokenHash(token));
    expect(mocks.acceptTeam).not.toHaveBeenCalled();
    expect(mocks.cookieSet).toHaveBeenCalledWith(expect.any(String), orgId, expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    mocks.cookieSet.mockClear();
    await expect(acceptAsExistingUser(token)).rejects.toThrow('/auth/continue?next=%2Fdashboard');
    expect(mocks.acceptTeam).toHaveBeenCalledExactlyOnceWith({}, { userId: user.id }, invitationTokenHash(token));
    expect(mocks.cookieSet).toHaveBeenCalledTimes(1);
  });

  it('does not select an organization after an uncertain or refused acceptance', async () => {
    mocks.currentUser.mockResolvedValue(user);
    mocks.acceptAgency.mockRejectedValue(new Error('synthetic lost commit response'));
    await expect(acceptOwnerInvitation(token)).rejects.toThrow('error=acceptance');
    expect(mocks.acceptAgency).toHaveBeenCalledTimes(1);
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });
});
