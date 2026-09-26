import { describe, expect, it } from 'vitest';
import {
  SpApiBindingReportingRequest, SpApiConnectionBegin, SpApiConnectionSubmit, SpApiConnectionOperation, SpApiConsentRefusal,
  SpApiProfileBindingState,
} from './provider-connections.js';

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
  it('admits only enumerated callback refusal codes', () => {
    expect(SpApiConsentRefusal.options).toHaveLength(12);
    for (const reason of ['mismatch', 'expired', 'reused', 'wrong_actor', 'operation_not_pending']) {
      expect(SpApiConsentRefusal.parse(reason)).toBe(reason);
    }
    expect(SpApiConsentRefusal.safeParse('synthetic provider message').success).toBe(false);
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

describe('SP binding reporting contracts', () => {
  const state = { bindingId: id, connectionId: id, profileId: id, profileName: 'Synthetic seller', marketplaceId: 'ATVPDKIKX0DER',
    enabled: true, enabledAt: '2026-09-26T10:00:00.123456+00:00', profileSyncEnabled: true };
  it('accepts only an explicit boolean switch', () => {
    expect(SpApiBindingReportingRequest.parse({ enabled: true })).toEqual({ enabled: true });
    expect(SpApiBindingReportingRequest.parse({ enabled: false })).toEqual({ enabled: false });
    for (const body of [{}, { enabled: 'true' }, { enabled: 1 }, { enabled: true, orgId: id }, null]) {
      expect(SpApiBindingReportingRequest.safeParse(body).success).toBe(false);
    }
  });
  it('carries a reporting start only while enabled, and allows an unrecorded start', () => {
    expect(SpApiProfileBindingState.parse(state).enabledAt).toBe(state.enabledAt);
    expect(SpApiProfileBindingState.parse({ ...state, enabledAt: null }).enabledAt).toBeNull();
    expect(SpApiProfileBindingState.parse({ ...state, enabled: false, enabledAt: null }).enabled).toBe(false);
    expect(SpApiProfileBindingState.safeParse({ ...state, enabled: false }).success).toBe(false);
    expect(SpApiProfileBindingState.safeParse({ ...state, marketplaceId: 'lowercase' }).success).toBe(false);
    expect(SpApiProfileBindingState.safeParse({ ...state, refreshToken: hiddenValue }).success).toBe(false);
  });
});
