import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../config.js';
import { spWritePolicyFromEnv } from './policy.js';

const profile = '00000000-0000-4000-8000-000000000081';
describe('guarded write runtime enablement', () => {
  it('defaults every write and observation pass off, independently of credentials', () => {
    expect(spWritePolicyFromEnv({})).toEqual({ dispatchEnabled: false, reconcileEnabled: false, profileIds: [] });
    expect(spWritePolicyFromEnv({ OPENSPELL_SP_WRITE_PROFILE_IDS: profile }).dispatchEnabled).toBe(false);
  });
  it.each(['OPENSPELL_SP_WRITE_DISPATCH_ENABLED', 'OPENSPELL_SP_WRITE_RECONCILE_ENABLED'])(
    'requires an explicit profile allowlist for %s', (flag) => {
      expect(() => spWritePolicyFromEnv({ [flag]: '1' })).toThrow('explicit profile allowlist');
      expect(() => spWritePolicyFromEnv({ [flag]: 'true', OPENSPELL_SP_WRITE_PROFILE_IDS: profile })).toThrow('Invalid');
    });
  it('refuses malformed and repeated profiles and keeps dispatch separate from observation', () => {
    expect(() => spWritePolicyFromEnv({ OPENSPELL_SP_WRITE_PROFILE_IDS: 'invalid' })).toThrow();
    expect(() => spWritePolicyFromEnv({ OPENSPELL_SP_WRITE_PROFILE_IDS: `${profile},${profile}` })).toThrow('Duplicate');
    expect(spWritePolicyFromEnv({ OPENSPELL_SP_WRITE_PROFILE_IDS: profile, OPENSPELL_SP_WRITE_RECONCILE_ENABLED: '1' }))
      .toEqual({ dispatchEnabled: false, reconcileEnabled: true, profileIds: [profile] });
  });
  it('refuses activation in the report lane', () => {
    expect(() => configFromEnv({ WORKER_DEPLOYMENT_ROLE: 'evo-report-lane', WORKER_JOB_TYPES: 'creative.sync,report.request,report.poll,report.fetch',
      OPENSPELL_SP_WRITE_DISPATCH_ENABLED: '1', OPENSPELL_SP_WRITE_PROFILE_IDS: profile }))
      .toThrow('general');
  });
});
