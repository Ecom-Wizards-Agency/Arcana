import { describe, expect, it } from 'vitest';
import { AdsProfileDiscoveryResult, AmazonConnectionBegin, AmazonConnectionOperation, AmazonConnectionRegionProgress, AmazonConnectionSubmit } from './amazon-connections.js';

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

  it('does not report completion from pending regions or an unattached grant', () => {
    const value = { version: 1, operationId: '10000000-0000-4000-8000-000000000001',
      orgId: '10000000-0000-4000-8000-000000000002', connectionId: null, state: 'completed', reason: null,
      createdAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-01T00:05:00Z', updatedAt: '2026-09-01T00:01:00Z',
      regions: ['NA', 'EU', 'FE'].map((region) => ({ region, state: 'pending', received: null,
        parsed: 0, rejected: 0, upserted: 0, created: 0, reason: null })),
    };
    expect(AmazonConnectionOperation.safeParse(value).success).toBe(false);
    expect(AmazonConnectionOperation.safeParse({ ...value, state: 'queued' }).success).toBe(true);
    const completed = { ...value, connectionId: '10000000-0000-4000-8000-000000000003',
      regions: value.regions.map((region) => ({ ...region, state: 'completed', received: 1, parsed: 1, upserted: 1, created: 1 })),
    };
    expect(AmazonConnectionOperation.safeParse(completed).success).toBe(true);
    expect(AmazonConnectionOperation.safeParse({ ...completed, state: 'empty', reason: 'no_profiles' }).success).toBe(false);
    expect(AmazonConnectionOperation.safeParse({ ...completed, state: 'partial', reason: 'discovery_incomplete' }).success).toBe(false);
  });

  it('bounds callback schemes and refuses credential-bearing callback URLs', () => {
    const value = { requestId: '10000000-0000-4000-8000-000000000001', nonceHash: 'a'.repeat(64),
      clientId: 'synthetic-client', scope: 'synthetic-scope' };
    for (const redirectUri of ['javascript:alert(1)', 'http://example.test/callback', 'https://user:pass@example.test/callback']) {
      expect(AmazonConnectionBegin.safeParse({ ...value, redirectUri }).success).toBe(false);
    }
    expect(AmazonConnectionBegin.safeParse({ ...value, redirectUri: 'http://127.0.0.1:3000/callback' }).success).toBe(true);
  });
});
