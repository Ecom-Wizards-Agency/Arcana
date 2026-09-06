import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exchange: vi.fn() }));
vi.mock('../../../../src/auth/origin', () => ({ authOrigin: () => 'https://review.example.test' }));
vi.mock('../../../../src/auth/supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: async () => ({ auth: { exchangeCodeForSession: mocks.exchange } }),
}));
import { GET } from './route';

describe('recovery callback continuation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.exchange.mockResolvedValue({ error: null });
  });

  it('keeps the invitation on the configured review origin after code exchange', async () => {
    const response = await GET(new Request('https://untrusted.example.test/auth/recovery/callback?code=synthetic&next=%2Finvite%2Fsynthetic-token'));
    expect(mocks.exchange).toHaveBeenCalledExactlyOnceWith('synthetic');
    expect(response.headers.get('location')).toBe('https://review.example.test/recover-password?next=%2Finvite%2Fsynthetic-token');
  });

  it('refuses an external continuation', async () => {
    const response = await GET(new Request('https://review.example.test/auth/recovery/callback?code=synthetic&next=https%3A%2F%2Fexternal.example.test'));
    expect(response.headers.get('location')).toBe('https://review.example.test/recover-password?next=%2Fdashboard');
  });

  it.each(['missing', 'expired'])('retains the safe invitation when the recovery code is %s', async (kind) => {
    mocks.exchange.mockResolvedValue({ error: new Error('invalid') });
    const url = new URL('https://review.example.test/auth/recovery/callback');
    url.searchParams.set('next', '/invite/synthetic-token');
    if (kind === 'expired') url.searchParams.set('code', 'synthetic');
    const response = await GET(new Request(url));
    const destination = new URL(response.headers.get('location')!);
    expect(destination.origin).toBe('https://review.example.test');
    expect(destination.pathname).toBe('/forgot-password');
    expect(destination.searchParams.get('next')).toBe('/invite/synthetic-token');
    expect(mocks.exchange).toHaveBeenCalledTimes(kind === 'expired' ? 1 : 0);
  });
});
