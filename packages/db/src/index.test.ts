import { describe, expect, it } from 'vitest';
import * as databasePackage from './index.js';
import { PACKAGE_NAME } from './index.js';
import { getIntegrationSecret } from './worker.js';

describe('@wizard-ads/db', () => {
  it('is wired into the workspace', () => {
    expect(PACKAGE_NAME).toBe('@wizard-ads/db');
  });

  it('keeps decrypted integration reads off the root export used by web', () => {
    expect('getIntegrationSecret' in databasePackage).toBe(false);
    expect(getIntegrationSecret).toBeTypeOf('function');
  });

  it('keeps installation provisioning off the product query export', () => {
    expect('provisionAgency' in databasePackage).toBe(false);
    expect('reissueAgencyBootstrapInvitation' in databasePackage).toBe(false);
    expect('revokeAgencyBootstrapInvitation' in databasePackage).toBe(false);
    expect('agencyBootstrapDeliveryContext' in databasePackage).toBe(false);
  });
});
