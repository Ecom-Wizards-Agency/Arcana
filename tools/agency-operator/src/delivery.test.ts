import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authInvitationSender } from './operator.js';

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
