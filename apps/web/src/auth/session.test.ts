import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ client: vi.fn() }));

vi.mock('./supabase', () => ({
  supabaseConfigured: () => true,
  supabaseServerClient: mocks.client,
}));

import { authorizeSecurityChange } from './security-authorization';
import { currentSessionSecurity } from './session';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const FACTOR_ID = '22222222-2222-4222-8222-222222222222';
const USER = { id: USER_ID, email: 'member@example.test' };
const VERIFIED = { id: FACTOR_ID, factor_type: 'totp', status: 'verified' };
let clientCount = 0;

/** Exercise the pinned SDK's session cache and fresh /user response separately. */
function provider(cachedFactors: unknown, freshFactors: unknown) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ sub: USER_ID, aal: 'aal1', exp: expiresAt }),
    Buffer.from('synthetic-test-signature').toString('base64url'),
  ].join('.');
  const storageKey = `auth-impact-${++clientCount}`;
  const storage = new Map<string, string>([[storageKey, JSON.stringify({
    access_token: accessToken,
    refresh_token: ['synthetic', 'test', 'refresh'].join('-'),
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    user: { ...USER, factors: cachedFactors },
  })]]);
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://auth.example.test/auth/v1/user');
    expect(init?.method).toBe('GET');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${accessToken}`);
    return new Response(JSON.stringify({ ...USER, factors: freshFactors }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const client = createClient('https://auth.example.test', 'synthetic-public-key', {
    global: { fetch },
    auth: {
      storageKey,
      storage: {
        getItem: (key) => storage.get(key) ?? null,
        setItem: (key, value) => { storage.set(key, value); },
        removeItem: (key) => { storage.delete(key); },
      },
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  mocks.client.mockResolvedValue(client);
  return { client, fetch };
}

describe('fresh provider assurance with the pinned Supabase SDK', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WIZARD_ADS_E2E_AUTH', '0');
    vi.stubEnv('WIZARD_ADS_TOTP_POLICY', 'off');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('requires step-up with enrollment off when another session enrolled a verified factor', async () => {
    const { client, fetch } = provider([], [VERIFIED]);
    // getUser does not replace the SDK's cached session.user.factors.
    const fresh = await client.auth.getUser();
    expect(fresh.data.user?.factors).toEqual([VERIFIED]);
    expect((await client.auth.mfa.getAuthenticatorAssuranceLevel()).data).toMatchObject({
      currentLevel: 'aal1', nextLevel: 'aal1',
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(currentSessionSecurity()).resolves.toEqual({
      state: 'authenticated', user: USER, current: 'aal1', next: 'aal2',
    });
    await expect(authorizeSecurityChange('/settings/account')).resolves.toEqual({
      status: 'challenge', href: '/auth/mfa/challenge?next=%2Fsettings%2Faccount',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not require a removed factor because it remains in the cached session', async () => {
    const { client } = provider([VERIFIED], []);
    expect((await client.auth.mfa.getAuthenticatorAssuranceLevel()).data).toMatchObject({
      currentLevel: 'aal1', nextLevel: 'aal2',
    });
    await expect(currentSessionSecurity()).resolves.toEqual({
      state: 'authenticated', user: USER, current: 'aal1', next: 'aal1',
    });
    await expect(authorizeSecurityChange('/settings/account')).resolves.toEqual({
      status: 'ok', user: USER,
    });
  });

  it('accepts the provider optional factors property as an empty inventory', async () => {
    provider([VERIFIED], undefined);
    await expect(currentSessionSecurity()).resolves.toEqual({
      state: 'authenticated', user: USER, current: 'aal1', next: 'aal1',
    });
    await expect(authorizeSecurityChange('/settings/account')).resolves.toEqual({
      status: 'ok', user: USER,
    });
  });

  it.each([
    { factors: null },
    { factors: {} },
    { factors: [null] },
    { factors: [{ ...VERIFIED, status: 'unknown' }] },
  ])(
    'refuses malformed fresh factor inventory: %j', async ({ factors }) => {
      provider([], factors);
      await expect(currentSessionSecurity()).resolves.toEqual({
        state: 'unavailable', reason: 'unknown-assurance',
      });
      await expect(authorizeSecurityChange('/settings/account')).resolves.toEqual({
        status: 'error', message: 'Account security could not be verified. Try again.',
      });
    },
  );
});
