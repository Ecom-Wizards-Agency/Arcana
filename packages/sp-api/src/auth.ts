import { SpApiAuthError } from './errors.js';
import type { FetchLike, SpApiAccessTokenProvider } from './types.js';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const EXPIRY_MARGIN_MS = 60_000;

/** One-use exchange errors never retain request values, provider bodies or causes. */
export class SpApiCodeExchangeError extends Error {
  override readonly name = 'SpApiCodeExchangeError';
  constructor(readonly outcome: 'exchange_refused' | 'exchange_uncertain') {
    super(outcome === 'exchange_refused' ? 'SP-API consent was refused' : 'SP-API consent exchange could not be confirmed');
  }
}

/** A single bounded POST. Callers must never retry an authorization code. */
export async function exchangeLwaAuthorizationCode(options: {
  clientId: string; clientSecret: string; redirectUri: string; code: string;
  signal: AbortSignal; fetch?: FetchLike;
}): Promise<string> {
  const { clientId, clientSecret: applicationKey, redirectUri, code } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]);
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    if (signal.aborted) {
      // An injected transport can abort synchronously while returning a rejection.
      // Consume that rejection even though custody already treats the call as uncertain.
      void promise.catch(() => {});
      throw new SpApiCodeExchangeError('exchange_uncertain');
    }
    let abort: () => void = () => {};
    try {
      return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        abort = () => reject(new SpApiCodeExchangeError('exchange_uncertain'));
        signal.addEventListener('abort', abort, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', abort); }
  };
  try {
    signal.throwIfAborted();
    const response = await bounded((options.fetch ?? fetch)(LWA_TOKEN_URL, {
      method: 'POST', redirect: 'error', signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code,
        client_id: clientId, client_secret: applicationKey, redirect_uri: redirectUri }).toString(),
    }));
    if (!response.body) throw new SpApiCodeExchangeError('exchange_uncertain');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await bounded(reader.read());
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 131_072) throw new SpApiCodeExchangeError('exchange_uncertain');
        chunks.push(next.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(value)) throw new SpApiCodeExchangeError('exchange_uncertain');
    if (!response.ok) {
      const refusal = [400, 401, 403].includes(response.status)
        && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type', 'access_denied'].includes(String(value['error']));
      throw new SpApiCodeExchangeError(refusal ? 'exchange_refused' : 'exchange_uncertain');
    }
    const refresh = value['refresh_token'];
    if (typeof refresh !== 'string' || !refresh.trim() || refresh.length > 65_536) {
      throw new SpApiCodeExchangeError('exchange_uncertain');
    }
    signal.throwIfAborted();
    return refresh;
  } catch (error) {
    throw new SpApiCodeExchangeError(error instanceof SpApiCodeExchangeError ? error.outcome : 'exchange_uncertain');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeProviderErrorCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : 'request_refused';
}

export interface LwaRefreshTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  /** Read from worker-owned custody only when a fresh access token is needed. */
  refreshTokenProvider: () => Promise<string | null>;
  fetch?: FetchLike;
  now?: () => number;
}

/**
 * Cached LWA access tokens with lazy refresh-credential reads.
 *
 * The refresh value is never retained after the form body is built. Concurrent
 * callers share one exchange, and `invalidate` makes the next request reread
 * Vault after a rotation or provider-side 401.
 */
export class LwaRefreshTokenProvider implements SpApiAccessTokenProvider {
  private access: string | null = null;
  private expiresAt = 0;
  private inFlight: Promise<string> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  constructor(private readonly options: LwaRefreshTokenProviderOptions) {
    if (!options.clientId || !options.clientSecret) {
      throw new SpApiAuthError('SP-API LWA application credentials are not configured', null);
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    if (this.access !== null && this.now() < this.expiresAt) return this.access;
    if (this.inFlight !== null) return this.inFlight;
    const pending = this.exchange().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  invalidate(): void {
    this.access = null;
    this.expiresAt = 0;
  }

  private async exchange(): Promise<string> {
    const refresh = await this.options.refreshTokenProvider();
    if (!refresh) throw new SpApiAuthError('SP-API refresh credential is unavailable', null);
    const { clientId, clientSecret: lwaKey } = this.options;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
      client_secret: lwaKey,
    }).toString();
    const response = await this.fetchImpl(LWA_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      throw new SpApiAuthError('SP-API LWA returned a non-JSON response', response.status);
    }
    if (!response.ok) {
      const code = safeProviderErrorCode(isRecord(parsed) ? parsed['error'] : undefined);
      throw new SpApiAuthError(`SP-API LWA request failed: ${code}`, response.status);
    }
    if (!isRecord(parsed) || typeof parsed['access_token'] !== 'string') {
      throw new SpApiAuthError('SP-API LWA returned no access token', response.status);
    }
    const expiresIn = typeof parsed['expires_in'] === 'number' && parsed['expires_in'] > 0
      ? parsed['expires_in']
      : 3_600;
    this.access = parsed['access_token'];
    this.expiresAt = this.now() + Math.max(0, expiresIn * 1_000 - EXPIRY_MARGIN_MS);
    return this.access;
  }
}
