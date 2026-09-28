/**
 * The Creator sample screens carry a per-request nonce CSP (`apps/web/proxy.ts`)
 * so no third-party script can read the address form. These checks pin the
 * route scope, the nonce hand-off Next relies on, and the absence of any
 * foreign origin.
 */
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_SCRIPT } from '../../ui/theme-script';
import { THEME_SCRIPT_HASH_SOURCE, config, creatorSamplesCsp, proxy } from '../../../proxy';

const PREFLIGHT_URL = `http://127.0.0.1/creators/samples/CCS-${'0123456789abcdef'.repeat(2)}/preflight`;

function directives(csp: string): Map<string, string[]> {
  const entries = csp.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [name = '', ...sources] = part.split(/\s+/);
    return [name, sources] as const;
  });
  return new Map(entries);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('creator samples proxy', () => {
  it('matches only the creator sample routes', () => {
    expect(config).toEqual({ matcher: ['/creators/samples/:path*'] });
    expect(Object.keys(config)).toHaveLength(1);
  });

  it('sets a nonce CSP on the response and forwards the same nonce to Next', () => {
    const response = proxy(new NextRequest(PREFLIGHT_URL));
    const csp = response.headers.get('content-security-policy') ?? '';
    // NextResponse.next({ request: { headers } }) encodes each overridden
    // request header as `x-middleware-request-<name>` and lists the names.
    const forwardedNonce = response.headers.get('x-middleware-request-x-nonce') ?? '';
    const forwardedCsp = response.headers.get('x-middleware-request-content-security-policy');
    const overridden = (response.headers.get('x-middleware-override-headers') ?? '').split(',');

    expect(forwardedNonce).toMatch(/^[A-Za-z0-9+/]{22,}={0,2}$/);
    expect(Buffer.from(forwardedNonce, 'base64').length).toBeGreaterThanOrEqual(16);
    expect(csp).toContain(`script-src 'self' 'nonce-${forwardedNonce}'`);
    expect(forwardedCsp).toBe(csp);
    expect(overridden).toEqual(expect.arrayContaining(['x-nonce', 'content-security-policy']));
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('issues a fresh nonce per request', () => {
    const nonces = Array.from({ length: 5 }, () =>
      proxy(new NextRequest(PREFLIGHT_URL)).headers.get('x-middleware-request-x-nonce'));
    expect(nonces.every((nonce) => typeof nonce === 'string' && nonce.length > 0)).toBe(true);
    expect(new Set(nonces).size).toBe(5);
  });

  it('names no foreign origin or wildcard in any directive', () => {
    for (const dev of [false, true]) {
      const parsed = directives(creatorSamplesCsp('NONCE', dev));
      expect([...parsed.keys()]).toEqual([
        'default-src', 'script-src', 'style-src', 'img-src', 'font-src', 'connect-src',
        'object-src', 'base-uri', 'form-action', 'frame-ancestors',
      ]);
      const sources = [...parsed.values()].flat();
      expect(sources.filter((source) => /https?:|\*|strict-dynamic/.test(source))).toEqual([]);
    }
  });

  it('allows unsafe-eval only in development', () => {
    expect(creatorSamplesCsp('NONCE', false)).not.toContain('unsafe-eval');
    expect(directives(creatorSamplesCsp('NONCE', true)).get('script-src')).toContain("'unsafe-eval'");

    vi.stubEnv('NODE_ENV', 'production');
    expect(proxy(new NextRequest(PREFLIGHT_URL)).headers.get('content-security-policy')).not.toContain('unsafe-eval');
    vi.stubEnv('NODE_ENV', 'development');
    expect(proxy(new NextRequest(PREFLIGHT_URL)).headers.get('content-security-policy')).toContain("'unsafe-eval'");
  });

  it('allows the inline theme script by its exact sha256', () => {
    const digest = createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64');
    expect(THEME_SCRIPT_HASH_SOURCE).toBe(`'sha256-${digest}'`);
    expect(directives(creatorSamplesCsp('NONCE', false)).get('script-src'))
      .toEqual(["'self'", "'nonce-NONCE'", `'sha256-${digest}'`]);
  });
});
