import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reset: vi.fn(),
}));

vi.mock('./config', () => ({
  authFeatureConfig: () => ({ passwordRecovery: true }),
}));
vi.mock('./origin', () => ({ authOrigin: () => 'https://app.example.test' }));
vi.mock('./supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: () => Promise.resolve({
    auth: { resetPasswordForEmail: mocks.reset },
  }),
}));

import { requestPasswordRecovery } from './recovery';

describe('password recovery request', () => {
  beforeEach(() => mocks.reset.mockReset());

  it.each([
    ['accepted', { data: {}, error: null }],
    ['unknown account', { data: null, error: new Error('not found') }],
  ])('returns the same public result when the provider reports %s', async (_case, providerResult) => {
    mocks.reset.mockResolvedValue(providerResult);
    await expect(requestPasswordRecovery('member@example.test')).resolves.toEqual({ status: 'sent' });
    expect(mocks.reset).toHaveBeenCalledWith('member@example.test', {
      redirectTo: 'https://app.example.test/auth/recovery/callback?next=%2Fdashboard',
    });
  });

  it.each([
    ['/invite/synthetic-invitation', '%2Finvite%2Fsynthetic-invitation'],
    ['https://other.example.test', '%2Fdashboard'],
    ['//other.example.test', '%2Fdashboard'],
  ])('preserves only a safe continuation: %s', async (next, encoded) => {
    await requestPasswordRecovery('member@example.test', next);
    expect(mocks.reset).toHaveBeenCalledExactlyOnceWith('member@example.test', {
      redirectTo: `https://app.example.test/auth/recovery/callback?next=${encoded}`,
    });
  });
});
