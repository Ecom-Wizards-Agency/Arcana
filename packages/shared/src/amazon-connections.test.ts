import { describe, expect, it } from 'vitest';
import { AdsProfileDiscoveryResult, AmazonConnectionRegionProgress, AmazonConnectionSubmit } from './amazon-connections.js';

describe('Amazon connection counts and custody', () => {
  it('refuses missing, duplicate and out-of-range refusal accounting', () => {
    const result = { region: 'EU', received: 2, profiles: [], rejected: [
      { index: 0, reason: 'invalid_row' }, { index: 1, reason: 'invalid_profile_id' },
    ] };
    expect(AdsProfileDiscoveryResult.safeParse(result).success).toBe(true);
    expect(AdsProfileDiscoveryResult.safeParse({ ...result, received: 3 }).success).toBe(false);
    expect(AdsProfileDiscoveryResult.safeParse({ ...result, rejected: [result.rejected[0], result.rejected[0]] }).success).toBe(false);
    expect(AdsProfileDiscoveryResult.safeParse({ ...result, rejected: [result.rejected[0], { index: 2, reason: 'invalid_row' }] }).success).toBe(false);
  });

  it('does not label unwritten or unknown rows completed', () => {
    const value = { region: 'NA', state: 'completed', received: 3, parsed: 2, rejected: 1, upserted: 2, created: 1, reason: null };
    expect(AmazonConnectionRegionProgress.safeParse(value).success).toBe(true);
    for (const invalid of [{ upserted: 1 }, { received: null }, { created: 3 }, { reason: 'request_failed' }]) {
      expect(AmazonConnectionRegionProgress.safeParse({ ...value, ...invalid }).success).toBe(false);
    }
    expect(AmazonConnectionRegionProgress.safeParse({ ...value, state: 'failed', reason: 'persistence_failed', upserted: 0, created: 0 }).success).toBe(true);
  });

  it('callback submission cannot replace saved organization or installation scope', () => {
    const value = { operationId: '10000000-0000-4000-8000-000000000001', nonceHash: 'a'.repeat(64), code: 'synthetic-code' };
    expect(AmazonConnectionSubmit.safeParse(value).success).toBe(true);
    for (const key of ['orgId', 'clientId', 'redirectUri', 'scope', 'role']) {
      expect(AmazonConnectionSubmit.safeParse({ ...value, [key]: 'replacement' }).success).toBe(false);
    }
  });
});
