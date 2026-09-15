import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeLwaAuthorizationCode, SpApiCodeExchangeError } from './auth.js';

const code = ['synthetic', 'consent', 'value'].join('-');
const refresh = ['synthetic', 'refresh', 'value'].join('-');
const access = ['synthetic', 'access', 'value'].join('-');
const secret = ['synthetic', 'application', 'secret'].join('-');
const base = { clientId: 'synthetic-client', clientSecret: secret, redirectUri: 'https://example.test/callback', code };

describe('single-use LWA consent transport', () => {
  let logs: unknown[][];
  beforeEach(() => {
    logs = [];
    for (const method of ['log','warn','error','info','debug'] as const) {
      vi.spyOn(console,method).mockImplementation((...values: unknown[]) => { logs.push(values); });
    }
  });
  afterEach(() => {
    for (const value of [code,refresh,access,secret]) expect(JSON.stringify(logs)).not.toContain(value);
    vi.restoreAllMocks();
  });
  it('posts once to the fixed endpoint and returns only the refresh value', async () => {
    const fetch = vi.fn(async () => Response.json({ refresh_token: refresh, access_token: access }));
    expect(await exchangeLwaAuthorizationCode({ ...base, signal: new AbortController().signal, fetch })).toBe(refresh);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.amazon.com/auth/o2/token');
    expect(init.redirect).toBe('error'); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: 'authorization_code',code,client_id: base.clientId,client_secret: secret,redirect_uri: base.redirectUri,
    });
  });
  it.each([
    [400, { error: 'invalid_grant' }, 'exchange_refused'],
    [401, { error: 'invalid_client' }, 'exchange_refused'],
    [403, { error: 'access_denied' }, 'exchange_refused'],
    [500, { error: 'invalid_grant' }, 'exchange_uncertain'],
    [400, { error: 'unknown' }, 'exchange_uncertain'],
    [200, { access_token: access }, 'exchange_uncertain'],
    [200, { refresh_token: ' ' }, 'exchange_uncertain'],
    [200, 'unreadable', 'exchange_uncertain'],
  ] as const)('classifies status %s without exposing or retrying its body', async (status, body, outcome) => {
    const fetch = vi.fn(async () => typeof body === 'string' ? new Response(body, { status }) : Response.json({ ...body, error_description: code + refresh + secret }, { status }));
    const error = await exchangeLwaAuthorizationCode({ ...base, signal: new AbortController().signal, fetch }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SpApiCodeExchangeError);
    expect(error).toMatchObject({ outcome }); expect(error).not.toHaveProperty('cause');
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const value of [code, refresh, access, secret]) expect(JSON.stringify(error) + String(error)).not.toContain(value);
  });
  it('bounds response bytes and sanitizes broken response streams', async () => {
    const responses = [new Response('x'.repeat(131_073)), new Response(new ReadableStream({
      start(controller) { controller.error(Object.assign(new Error(code), { refresh, secret })); },
    }))];
    for (const response of responses) {
      const fetch = vi.fn(async () => response);
      await expect(exchangeLwaAuthorizationCode({ ...base, signal: new AbortController().signal, fetch }))
        .rejects.toMatchObject({ outcome: 'exchange_uncertain', message: 'SP-API consent exchange could not be confirmed' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('aborts an unresponsive provider without replay and makes no request after cancellation', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    const pending = exchangeLwaAuthorizationCode({ ...base, signal: controller.signal, fetch });
    controller.abort(new Error(secret));
    await expect(pending).rejects.toMatchObject({ outcome: 'exchange_uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    await expect(exchangeLwaAuthorizationCode({ ...base, signal: controller.signal, fetch })).rejects.toBeInstanceOf(SpApiCodeExchangeError);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('consumes a transport rejection that arrives with a synchronous abort', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(() => { controller.abort(); return Promise.reject(new Error(secret)); });
    await expect(exchangeLwaAuthorizationCode({ ...base, signal: controller.signal, fetch }))
      .rejects.toMatchObject({ outcome: 'exchange_uncertain' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('enforces its deadline even if injected transport ignores abort', async () => {
    vi.useFakeTimers();
    // Node AbortSignal.timeout uses its own clock; inject the deadline signal here.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const fetch = vi.fn(() => new Promise<Response>(() => {}));
      const pending = exchangeLwaAuthorizationCode({ ...base, signal: new AbortController().signal, fetch });
      const result = expect(pending).rejects.toMatchObject({ outcome: 'exchange_uncertain' });
      deadline.abort(); await result;
      expect(timeout).toHaveBeenCalledWith(30_000); expect(fetch).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); vi.useRealTimers(); }
  });
});
