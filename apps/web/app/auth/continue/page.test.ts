import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  currentUser: vi.fn(),
  currentSessionSecurity: vi.fn(),
}));

vi.mock('../../../src/auth/config', () => ({ authFeatureConfig: mocks.config }));
vi.mock('../../../src/auth/session', () => ({
  currentUser: mocks.currentUser,
  currentSessionSecurity: mocks.currentSessionSecurity,
}));
vi.mock('next/navigation', () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));

import AuthContinuePage from './page';

const baseConfig = {
  passwordLogin: false,
  passwordRecovery: false,
  googleLogin: false,
  passkeyPolicy: 'off' as const,
  totpPolicy: 'off' as const,
};

describe('/auth/continue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WIZARD_ADS_APP_URL', 'https://app.example.test');
    mocks.config.mockReturnValue(baseConfig);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('preserves the pre-rollout path when assurance enforcement is off', async () => {
    mocks.currentUser.mockResolvedValue({ id: 'user-1', email: null });
    await expect(AuthContinuePage({ searchParams: Promise.resolve({ next: '/dashboard' }) })).rejects.toThrow('REDIRECT:/dashboard');
    expect(mocks.currentSessionSecurity).not.toHaveBeenCalled();
  });

  it('routes an enrolled aal1 session to the challenge', async () => {
    mocks.config.mockReturnValue({ ...baseConfig, totpPolicy: 'enforce-when-enrolled' });
    mocks.currentSessionSecurity.mockResolvedValue({
      state: 'authenticated',
      user: { id: 'user-1', email: null },
      current: 'aal1',
      next: 'aal2',
    });
    await expect(AuthContinuePage({ searchParams: Promise.resolve({ next: '/dashboard' }) })).rejects.toThrow(
      'REDIRECT:/auth/mfa/challenge?next=%2Fdashboard');
  });

  it('rejects an external continuation target', async () => {
    mocks.currentUser.mockResolvedValue({ id: 'user-1', email: null });
    await expect(AuthContinuePage({ searchParams: Promise.resolve({ next: '//evil.test' }) })).rejects.toThrow('REDIRECT:/dashboard');
  });

  it('preserves the invitation when primary authentication is missing', async () => {
    mocks.currentUser.mockResolvedValue(null);
    await expect(AuthContinuePage({ searchParams: Promise.resolve({ next: '/agency-invite/synthetic' }) })).rejects.toThrow(
      'REDIRECT:/login?next=%2Fagency-invite%2Fsynthetic');
  });
});
