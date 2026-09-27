import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authInvitationLinker, authInvitationSender } from './operator.js';

const email = 'owner@example.test';
const destination = 'https://app.example.test/agency-invite/synthetic';
const key = ['synthetic', 'operator', 'auth', 'key'].join('-');

describe('operator Auth delivery with the installed SDK', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends exactly one invitation with the saved recipient and no preconfirmation or password', async () => {
    const requests: Array<{ url: URL; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe('https://auth.example.test');
      expect(parsed.pathname).toBe('/auth/v1/invite');
      expect(init.method).toBe('POST');
      requests.push({ url: parsed, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ id: randomUUID(), email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: null }), { status: 200 });
    });
    const send = authInvitationSender('https://auth.example.test', key);
    expect(await send(email, destination)).toBe('accepted_by_provider');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({ email });
    expect(requests[0]!.url.searchParams.get('redirect_to')).toBe(destination);
  });

  it('preserves confirmed-account refusal without requesting a reset or creating another account', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'email_exists', msg: 'synthetic existing account' }), {
      status: 422, headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await authInvitationSender('https://auth.example.test', key)(email, destination)).toBe('existing_account');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns an uncertain delivery after response loss with no automatic retry or raw error', async () => {
    const fetch = vi.fn(async () => { throw new Error(`synthetic transport ${key}`); });
    vi.stubGlobal('fetch', fetch);
    expect(await authInvitationSender('https://auth.example.test', key)(email, destination)).toBe('uncertain');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('operator link delivery with the installed SDK', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const hashed = 'f0'.repeat(28);

  it('asks Auth for one invite link, sends no email and returns the application link with the token hash', async () => {
    const requests: Array<{ url: URL; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({
        id: randomUUID(), email, aud: 'authenticated', role: 'authenticated', email_confirmed_at: null,
        action_link: 'https://auth.example.test/auth/v1/verify', email_otp: '000000', hashed_token: hashed,
        redirect_to: destination, verification_type: 'invite',
      }), { status: 200 });
    });
    const link = await authInvitationLinker('https://auth.example.test', key)(email, destination);
    expect(link).toEqual({ status: 'link_ready', url: `${destination}?token_hash=${hashed}` });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/auth/v1/admin/generate_link');
    expect(requests[0]!.body).toMatchObject({ type: 'invite', email });
    expect(requests[0]!.url.searchParams.get('redirect_to') ?? requests[0]!.body['redirect_to']).toBe(destination);
  });

  it('returns the plain application link for a confirmed account and after response loss', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ code: 'email_exists', msg: 'synthetic existing account' }), {
      status: 422, headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await authInvitationLinker('https://auth.example.test', key)(email, destination)).toEqual({ status: 'existing_account', url: destination });
    fetch.mockImplementation(async () => { throw new Error(`synthetic transport ${key}`); });
    expect(await authInvitationLinker('https://auth.example.test', key)(email, destination)).toEqual({ status: 'uncertain', url: destination });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
