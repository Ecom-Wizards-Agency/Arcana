import { describe, expect, it } from 'vitest';
import { authFeatureConfig } from './config';

describe('auth rollout config', () => {
  it('defaults to password login and recovery with optional providers and factors off', () => {
    expect(authFeatureConfig({})).toEqual({
      passwordLogin: true,
      passwordRecovery: true,
      googleLogin: false,
      totpPolicy: 'off',
      passkeyPolicy: 'off',
    });
  });

  it('retains explicit independent password and recovery rollback controls', () => {
    expect(authFeatureConfig({ WIZARD_ADS_PASSWORD_LOGIN: '0' })).toMatchObject({
      passwordLogin: false,
      passwordRecovery: true,
    });
    expect(authFeatureConfig({ WIZARD_ADS_PASSWORD_RECOVERY: '0' })).toMatchObject({
      passwordLogin: true,
      passwordRecovery: false,
    });
  });

  it('accepts each deliberate rollout state', () => {
    expect(
      authFeatureConfig({
        WIZARD_ADS_PASSWORD_LOGIN: '1',
        WIZARD_ADS_PASSWORD_RECOVERY: '1',
        WIZARD_ADS_GOOGLE_LOGIN: '1',
        WIZARD_ADS_TOTP_POLICY: 'require-for-privileged',
        WIZARD_ADS_PASSKEYS: 'sign-in',
      }),
    ).toEqual({
      passwordLogin: true,
      passwordRecovery: true,
      googleLogin: true,
      totpPolicy: 'require-for-privileged',
      passkeyPolicy: 'sign-in',
    });
  });

  it.each([
    ['WIZARD_ADS_PASSWORD_RECOVERY', 'yes'],
    ['WIZARD_ADS_GOOGLE_LOGIN', 'yes'],
    ['WIZARD_ADS_TOTP_POLICY', 'required'],
    ['WIZARD_ADS_PASSKEYS', 'enabled'],
  ])('rejects invalid %s instead of weakening it', (name, value) => {
    expect(() => authFeatureConfig({ [name]: value })).toThrow(name);
  });
});
