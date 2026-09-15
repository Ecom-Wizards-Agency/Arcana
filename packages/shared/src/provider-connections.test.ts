import { describe, expect, it } from 'vitest';
import { SpApiConnectionBegin, SpApiConnectionSubmit, SpApiConnectionOperation } from './provider-connections.js';

const id = '11111111-1111-4111-8111-111111111111';
const hiddenValue = ['synthetic', 'refresh'].join('-');
const begin = { requestId: id, nonceHash: 'a'.repeat(64), clientId: 'synthetic-client',
  applicationId: 'synthetic-application', redirectUri: 'https://example.test/callback', region: 'NA',
  label: 'Synthetic seller', bindings: [{ profileId: id, marketplaceId: 'ATVPDKIKX0DER' }] };

describe('SP consent contracts', () => {
  it('begins from selected profiles without accepting a caller supplied seller', () => {
    expect(SpApiConnectionBegin.parse(begin).bindings).toHaveLength(1);
    expect(SpApiConnectionBegin.safeParse({ ...begin, sellingPartnerId: 'forged' }).success).toBe(false);
    expect(SpApiConnectionBegin.safeParse({ ...begin, bindings: [...begin.bindings, ...begin.bindings] }).success).toBe(false);
    expect(SpApiConnectionBegin.safeParse({ ...begin, bindings: [] }).success).toBe(false);
    expect(SpApiConnectionBegin.safeParse({ ...begin, redirectUri: 'https://user@example.test/callback' }).success).toBe(false);
    const mixed = 'a1111111-1111-4111-8111-111111111111';
    expect(SpApiConnectionBegin.parse({ ...begin,bindings: [{ ...begin.bindings[0],profileId: mixed.toUpperCase() }] }).bindings[0]!.profileId).toBe(mixed);
    expect(SpApiConnectionBegin.safeParse({ ...begin,bindings: [mixed,mixed.toUpperCase()].map((profileId) => ({ ...begin.bindings[0],profileId })) }).success).toBe(false);
  });
  it('requires seller-returned identity and confines consent to submission', () => {
    const input = { operationId: id, nonceHash: begin.nonceHash, code: 'synthetic-code' };
    expect(SpApiConnectionSubmit.safeParse(input).success).toBe(false);
    expect(SpApiConnectionSubmit.safeParse({ ...input, sellingPartnerId: '' }).success).toBe(false);
    expect(SpApiConnectionSubmit.parse({ ...input, sellingPartnerId: 'synthetic-seller' }).code).toBe(input.code);
    expect(SpApiConnectionSubmit.safeParse({ ...input, sellingPartnerId: 'seller', redirectUri: begin.redirectUri }).success).toBe(false);
    expect(SpApiConnectionOperation.safeParse({ ...input, refreshToken: hiddenValue }).success).toBe(false);
  });
});
