import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { invitationOrigin, parseAgencyCommand } from './command.js';

describe('installation operator command boundary', () => {
  it('accepts only explicit provisioning identity and normalizes the recipient', () => {
    const requestId = randomUUID();
    expect(parseAgencyCommand(['provision', '--request-id', requestId, '--name', ' Synthetic ', '--slug', 'synthetic', '--owner-email', 'Owner@Example.Test', '--send-email']))
      .toEqual({ operation: 'provision', request: { requestId, name: 'Synthetic', slug: 'synthetic', ownerEmail: 'owner@example.test' }, sendEmail: true });
  });

  it('refuses arbitrary roles, organization IDs, recipient rewrites and ambiguous options', () => {
    for (const args of [
      ['provision', '--role', 'owner'], ['reissue', '--owner-email', 'changed@example.test'],
      ['revoke', '--send-email'], ['provision', '--request-id', randomUUID(), '--request-id', randomUUID()],
      ['reissue', '--request-id', randomUUID(), '--expected-generation', '1e3'],
      ['reissue', '--request-id', randomUUID(), '--expected-generation', '2147483647'],
      ['provision', '--name'], ['sql', 'select 1'],
    ]) expect(() => parseAgencyCommand(args)).toThrow();
  });

  it('binds reissue and revocation to the explicit current generation', () => {
    const requestId = randomUUID();
    for (const operation of ['reissue', 'revoke'] as const) {
      expect(parseAgencyCommand([operation, '--request-id', requestId, '--expected-generation', '2']))
        .toMatchObject({ operation, requestId, expectedGeneration: 2 });
    }
  });

  it('refuses unsafe callback origins and never derives an installation endpoint', () => {
    expect(invitationOrigin('https://app.example.test/')).toBe('https://app.example.test');
    expect(invitationOrigin('http://127.0.0.1:3987')).toBe('http://127.0.0.1:3987');
    for (const value of [undefined, 'http://app.example.test', 'https://user:pass@app.example.test', 'https://app.example.test/path', 'https://app.example.test?next=foreign', 'https://app.example.test#fragment']) {
      expect(() => invitationOrigin(value)).toThrow();
    }
  });
});
