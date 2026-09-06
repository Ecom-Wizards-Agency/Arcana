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
});
