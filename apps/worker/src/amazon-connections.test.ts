import { afterEach, describe, expect, it, vi } from 'vitest';
import { AmazonConnectionLoop, type AmazonConnectionProvider, type AmazonConnectionStore } from './amazon-connections.js';
import { createAmazonConnectionProvider } from './amazon-connection-adapters.js';

function ports() {
  const store: AmazonConnectionStore = {
    claim: vi.fn<AmazonConnectionStore['claim']>(async () => null),
    attach: vi.fn<AmazonConnectionStore['attach']>(),
    failExchange: vi.fn<AmazonConnectionStore['failExchange']>(),
    failDiscovery: vi.fn<AmazonConnectionStore['failDiscovery']>(),
    read: vi.fn<AmazonConnectionStore['read']>(),
    startRegion: vi.fn<AmazonConnectionStore['startRegion']>(),
    recordRegion: vi.fn<AmazonConnectionStore['recordRegion']>(),
  };
  const provider: AmazonConnectionProvider = {
    accepts: vi.fn(() => true), exchange: vi.fn<AmazonConnectionProvider['exchange']>(),
    discover: vi.fn<AmazonConnectionProvider['discover']>(),
  };
  return { store, provider };
}

describe('serialized connection consumer', () => {
  afterEach(() => vi.useRealTimers());

  it('never overlaps claims, joins in-flight custody on stop and cannot restart afterward', async () => {
    vi.useFakeTimers();
    const { store, provider } = ports();
    let finish: ((value: null) => void) | undefined;
    vi.mocked(store.claim).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loop = new AmazonConnectionLoop(store, provider, 100);
    loop.start(); loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(loop.status()).toMatchObject({ enabled: true, running: true, inFlight: 1 });
    let stopped = false;
    const stopping = loop.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(false);
    finish!(null); await stopping;
    expect(loop.status()).toMatchObject({ running: false, stopping: true, inFlight: 0 });
    loop.start(); await vi.advanceTimersByTimeAsync(10_000);
    expect(store.claim).toHaveBeenCalledTimes(1);
    expect(provider.exchange).not.toHaveBeenCalled();
  });

  it('reports repeated database failures without exposing their input, then recovers on a successful empty claim', async () => {
    vi.useFakeTimers();
    const { store, provider } = ports();
    const sensitive = ['synthetic', 'private-database-binding'].join('-');
    vi.mocked(store.claim).mockRejectedValueOnce(new Error(sensitive))
      .mockRejectedValueOnce(new Error(sensitive)).mockRejectedValueOnce(new Error(sensitive));
    const loop = new AmazonConnectionLoop(store, provider, 100);
    loop.start(); await vi.advanceTimersByTimeAsync(250);
    expect(loop.status()).toMatchObject({ consecutiveFailures: 3, lastSuccessAt: null, inFlight: 0 });
    expect(JSON.stringify(loop.status())).not.toContain(sensitive);
    await vi.advanceTimersByTimeAsync(100);
    expect(loop.status()).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: expect.any(String) });
    await loop.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('worker application configuration', () => {
  it('rejects missing or unsafe callback configuration without exposing configured values', () => {
    // Configuration fails before accessing the database or provider.
    const handle = {} as Parameters<typeof createAmazonConnectionProvider>[0];
    const key = ['synthetic', 'application-key'].join('-');
    for (const callback of [undefined, 'https://user:private@example.test/callback', 'http://foreign.test/callback',
      'https://example.test/callback#private', 'https://example.test/callback,']) {
      let error: unknown;
      try { createAmazonConnectionProvider(handle, { LWA_CLIENT_ID: 'synthetic-client', LWA_CLIENT_SECRET: key,
        ...(callback === undefined ? {} : { AMAZON_OAUTH_ALLOWED_REDIRECT_URIS: callback }) }); }
      catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(Error);
      const details = JSON.stringify(Object.getOwnPropertyDescriptors(error));
      expect(details).not.toContain(key);
      if (callback) expect(details).not.toContain(callback);
    }
  });
});
