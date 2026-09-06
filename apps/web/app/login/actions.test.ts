import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw { location };
  },
}));
vi.mock('../../src/auth/config', () => ({ authFeatureConfig: mocks.config }));
vi.mock('../../src/auth/origin', () => ({ authOrigin: () => 'https://app.example.test' }));
vi.mock('../../src/auth/supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: () => Promise.resolve({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
      signInWithOAuth: mocks.signInWithOAuth,
    },
  }),
}));

import { signInWithGoogle, signInWithPassword } from './actions';

async function redirectLocation(operation: Promise<void>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'location' in error &&
      typeof error.location === 'string'
    ) {
      return error.location;
    }
    throw error;
  }
  throw new Error('expected redirect');
}

function credentials(): FormData {
  const form = new FormData();
  form.set('email', 'member@example.test');
  form.set('password', 'synthetic passphrase');
  form.set('next', '/dashboard');
  return form;
}

describe('login actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.mockReturnValue({
      passwordLogin: false,
      passwordRecovery: false,
      googleLogin: false,
      totpPolicy: 'off',
      passkeyPolicy: 'off',
    });
  });

  it('refuses password and Google provider calls while their rollout flags are off', async () => {
    await expect(redirectLocation(signInWithPassword(credentials()))).resolves.toContain(
      'password+sign-in+is+not+enabled',
    );
    await expect(redirectLocation(signInWithGoogle(credentials()))).resolves.toContain(
      'Google+sign-in+is+not+enabled',
    );
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    expect(mocks.signInWithOAuth).not.toHaveBeenCalled();
  });

  it('continues successful password sign-in through the shared MFA boundary', async () => {
    mocks.config.mockReturnValue({ passwordLogin: true });
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    const form = credentials();
    form.set('next', '/settings/account');
    await expect(redirectLocation(signInWithPassword(form))).resolves.toBe(
      '/auth/continue?next=%2Fsettings%2Faccount',
    );
    expect(mocks.signInWithPassword).toHaveBeenCalledTimes(1);
  });

  it('does not reveal whether an account exists when password sign-in is refused', async () => {
    mocks.config.mockReturnValue({ passwordLogin: true });
    for (const code of ['invalid_credentials', 'user_not_found']) {
      mocks.signInWithPassword.mockResolvedValue({ data: {}, error: { code } });
      await expect(redirectLocation(signInWithPassword(credentials()))).resolves.toBe(
        '/login?next=%2Fdashboard&error=email+or+password+was+not+accepted',
      );
    }
  });

  it('refuses an external return destination after successful login', async () => {
    mocks.config.mockReturnValue({ passwordLogin: true });
    mocks.signInWithPassword.mockResolvedValue({ data: {}, error: null });
    const form = credentials();
    form.set('next', 'https://other.example.test');
    await expect(redirectLocation(signInWithPassword(form))).resolves.toBe(
      '/auth/continue?next=%2Fdashboard',
    );
  });
});
