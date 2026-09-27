/**
 * The precedence in `mcpEndpoint` is the whole point of the function, and the
 * bug it replaced was invisible in review: appending `/mcp` to the web app's
 * own origin produced a URL that looked right and 404ed, because the MCP server
 * is a separate deploy target. The third case below is the regression guard —
 * `WIZARD_ADS_APP_URL` must not reach the result at all.
 */
import { creatorMcfRecipientKeyId } from '@wizard-ads/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { mcfRecipientPublicKey, mcpEndpoint, optional, required } from './env';

/** `NodeJS.ProcessEnv` insists on `NODE_ENV`; nothing here reads it. */
const env = (values: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ...values,
});

describe('mcpEndpoint', () => {
  it('prefers the explicit public URL over everything else', () => {
    const endpoint = mcpEndpoint(
      env({
        NEXT_PUBLIC_MCP_URL: 'https://mcp.example.test/mcp',
        WIZARD_ADS_MCP_URL: 'https://server-var.example.test/mcp',
        WIZARD_ADS_APP_URL: 'https://app.example.test',
      }),
    );
    expect(endpoint).toBe('https://mcp.example.test/mcp');
  });

  it('falls back to the server variable when the public one is unset', () => {
    const endpoint = mcpEndpoint(
      env({
        WIZARD_ADS_MCP_URL: 'https://server-var.example.test/mcp',
        WIZARD_ADS_APP_URL: 'https://app.example.test',
      }),
    );
    expect(endpoint).toBe('https://server-var.example.test/mcp');
  });

  it('leaves an unconfigured installation unavailable without deriving from its app origin', () => {
    const endpoint = mcpEndpoint(env({ WIZARD_ADS_APP_URL: 'https://app.example.test' }));
    expect(endpoint).toBeNull();
  });

  it('treats an empty string as unset', () => {
    expect(mcpEndpoint(env({ NEXT_PUBLIC_MCP_URL: '  ', WIZARD_ADS_MCP_URL: '' }))).toBeNull();
  });

  it.each(['not a URL', 'javascript:alert(1)', 'https://synthetic:synthetic@example.test/mcp'])(
    'does not offer an invalid or credential-bearing endpoint: %s', (value) => {
      expect(mcpEndpoint(env({ WIZARD_ADS_MCP_URL: value }))).toBeNull();
    },
  );
});

describe('required and optional', () => {
  it('names the missing variable', () => {
    expect(() => required('SOME_MISSING_VAR', env())).toThrow(/SOME_MISSING_VAR is not set/);
  });

  it('returns the fallback only when the value is absent or empty', () => {
    expect(optional('A', 'fallback', env())).toBe('fallback');
    expect(optional('A', 'fallback', env({ A: '' }))).toBe('fallback');
    expect(optional('A', 'fallback', env({ A: 'set' }))).toBe('set');
  });
});

describe('mcfRecipientPublicKey', () => {
  // A fresh pair per run: no key material is written into this file.
  let publicJwk: JsonWebKey;
  let privateD: string;
  let keyId: string;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    privateD = String(privateJwk.d);
    keyId = await creatorMcfRecipientKeyId(publicJwk);
  });

  const read = (value: string | undefined) =>
    mcfRecipientPublicKey(env(value === undefined ? {} : { OPENSPELL_MCF_RECIPIENT_PUBLIC_KEY: value }));

  it('is absent when unset or blank', async () => {
    expect(await read(undefined)).toEqual({ status: 'absent' });
    expect(await read('')).toEqual({ status: 'absent' });
    expect(await read('   ')).toEqual({ status: 'absent' });
  });

  it('accepts a matching public key and reduces the jwk to its four members', async () => {
    const result = await read(JSON.stringify({ keyId, jwk: publicJwk }));
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.keyId).toBe(keyId);
    expect(Object.keys(result.jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(result.jwk).toEqual({ kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y });
  });

  it('refuses every malformed or mismatched value without echoing it', async () => {
    const otherKeyId = keyId.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const cases = [
      JSON.stringify({ keyId: otherKeyId, jwk: publicJwk }),
      JSON.stringify({ keyId: keyId.toUpperCase(), jwk: publicJwk }),
      JSON.stringify({ keyId, jwk: { ...publicJwk, d: privateD } }),
      JSON.stringify({ keyId, jwk: publicJwk, note: 'extra' }),
      JSON.stringify({ keyId }),
      JSON.stringify({ keyId, jwk: { ...publicJwk, crv: 'P-384' } }),
      JSON.stringify({ keyId, jwk: { ...publicJwk, x: publicJwk.y } }),
      '{"keyId":',
      'not json',
      JSON.stringify([keyId, publicJwk]),
      JSON.stringify('a string'),
      'null',
      '42',
    ];
    expect(cases).toHaveLength(13);
    const results = await Promise.all(cases.map((value) => read(value)));
    for (const result of results) expect(result).toEqual({ status: 'invalid' });
    for (const result of results) expect(JSON.stringify(result)).not.toContain(privateD);
  });
});
