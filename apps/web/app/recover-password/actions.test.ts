import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ authorize: vi.fn(), update: vi.fn() }));
vi.mock('../../src/auth/security-authorization', () => ({ authorizeSecurityChange: mocks.authorize }));
vi.mock('../../src/auth/supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: async () => ({ auth: { updateUser: mocks.update } }),
}));
import { completePasswordRecovery } from './actions';

describe('recovery authenticator continuation', () => {
  beforeEach(() => vi.resetAllMocks());

  it('retains the invitation through step-up without changing the password first', async () => {
    mocks.authorize.mockResolvedValue({ status: 'challenge', href: '/auth/mfa/challenge?next=synthetic' });
    const form = new FormData();
    form.set('next', '/invite/synthetic-token');
    await expect(completePasswordRecovery({ status: 'idle' }, form)).resolves.toMatchObject({ status: 'challenge' });
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith('/recover-password?next=%2Finvite%2Fsynthetic-token');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('reports a lost password response without automatically retrying or leaking its error', async () => {
    mocks.authorize.mockResolvedValue({ status: 'ok', user: { id: 'synthetic-user' } });
    const passphrase = ['synthetic', 'chosen', 'password'].join('-');
    const form = new FormData();
    form.set('password', passphrase);
    form.set('confirmation', passphrase);
    form.set('next', '/agency-invite/synthetic');
    mocks.update.mockRejectedValue(new Error(`synthetic provider failure ${passphrase}`));
    const result = await completePasswordRecovery({ status: 'idle' }, form);
    expect(result).toMatchObject({ status: 'error', message: expect.stringContaining('could not be confirmed') });
    expect(JSON.stringify(result)).not.toContain(passphrase);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });
});
