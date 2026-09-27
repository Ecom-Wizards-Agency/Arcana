import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ exchange: vi.fn(), verify: vi.fn(), initialize: vi.fn(), signOut: vi.fn() }));
vi.mock('../../../../src/auth/origin', () => ({ authOrigin: () => 'https://review.example.test' }));
vi.mock('../../../../src/auth/supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: async () => ({ auth: {
    exchangeCodeForSession: mocks.exchange, verifyOtp: mocks.verify, initialize: mocks.initialize, signOut: mocks.signOut,
  } }),
}));
import { GET, POST } from './route';

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

describe('owner/admin-issued recovery link', () => {
  const tokenHash = 'a1b2c3d4'.repeat(7);
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.initialize.mockResolvedValue({ error: null });
    mocks.verify.mockResolvedValue({ error: null, data: { session: { access_token: 'synthetic' }, user: { id: 'synthetic' } } });
  });
  const post = (fields: Record<string, string>, origin: string | null = 'https://review.example.test') => {
    const body = new URLSearchParams(fields);
    return POST(new Request('https://review.example.test/auth/recovery/callback', {
      method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) },
    }));
  };

  it('renders an explicit confirmation on GET and consumes nothing', async () => {
    const response = await GET(new Request(`https://review.example.test/auth/recovery/callback?next=%2Fdashboard&token_hash=${tokenHash}`));
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(html).toContain('Continue to set a new password');
    expect(html.match(/<form method="post" action="\/auth\/recovery\/callback">/g)).toHaveLength(1);
    expect(html).toContain(`name="token_hash" value="${tokenHash}"`);
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it('refuses a malformed token hash on GET and escapes the continuation', async () => {
    const bad = await GET(new Request('https://review.example.test/auth/recovery/callback?token_hash=%3Cscript%3E'));
    expect(new URL(bad.headers.get('location')!).pathname).toBe('/forgot-password');
    const escaped = await GET(new Request(`https://review.example.test/auth/recovery/callback?next=%2Fdashboard%3Fa%3D%22%3E%3Cx&token_hash=${tokenHash}`));
    const html = await escaped.text();
    expect(html).not.toContain('"><x');
    expect(html).toContain('name="next" value="/dashboard?a=%22%3E%3Cx"');
  });

  it('verifies once on a same-origin POST and continues to password replacement', async () => {
    const response = await post({ token_hash: tokenHash, next: '/dashboard' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://review.example.test/recover-password?next=%2Fdashboard');
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith({ token_hash: tokenHash, type: 'recovery' });
  });

  it('refuses cross-origin or missing Origin POSTs and failed verification without a session', async () => {
    expect((await post({ token_hash: tokenHash }, 'https://other.example.test')).status).toBe(403);
    expect((await post({ token_hash: tokenHash }, null)).status).toBe(403);
    expect(mocks.verify).not.toHaveBeenCalled();
    mocks.verify.mockResolvedValue({ error: { code: 'otp_expired' }, data: { session: null, user: null } });
    const expired = await post({ token_hash: tokenHash, next: 'https://external.example.test' });
    const destination = new URL(expired.headers.get('location')!);
    expect(expired.status).toBe(303);
    expect(destination.pathname).toBe('/forgot-password');
    expect(destination.searchParams.get('next')).toBe('/dashboard');
    expect(mocks.verify).toHaveBeenCalledTimes(1);
  });
});
