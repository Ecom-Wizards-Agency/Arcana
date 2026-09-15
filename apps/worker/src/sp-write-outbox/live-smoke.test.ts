import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeSpWriteBoundedAuthorizationFingerprint, type SpWriteBoundedAuthorization } from '@wizard-ads/shared/sp-writes';
import { hasher } from './artifacts.js';
import { readLiveWriteAuthorization } from './live-smoke.js';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function file(value?: unknown) {
  directory = await mkdtemp(join(tmpdir(), 'wp280-smoke-'));
  await mkdir(join(directory, '_local'));
  if (value !== undefined) await writeFile(join(directory, '_local/amazon-write-authorization.json'), JSON.stringify(value));
  return directory;
}
function authorization(): SpWriteBoundedAuthorization {
  const value: SpWriteBoundedAuthorization = {
    schemaVersion: 'openspell.sp-write-bounded-authorization.v1', authorizationId: randomUUID(),
    issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z',
    profiles: [{ providerScope: { amazonProfileId: 'synthetic-smoke-profile', connectionId: randomUUID(),
      region: 'NA', marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' },
      allowedEntities: [{ routeKey: 'sp.v3.keywords.update', amazonEntityId: 'synthetic-keyword',
        allowedChangeKeys: ['keyword.bid'], maxAbsoluteMoneyDelta: '0.1', maxAbsolutePlacementDelta: null }] }],
    constraints: { maxLogicalChangesPerPlan: 1, maxProviderRowsPerPlan: 1, maxConcurrentMutations: 1,
      maxCycles: 1, maxExecutions: 2, requireCurrentValueMatch: true, requireForwardObservationBeforeInverse: true,
      stopOnConflict: true, disableAfterCycle: true }, fingerprint: '0'.repeat(64),
  };
  value.fingerprint = hasher.digest(serializeSpWriteBoundedAuthorizationFingerprint(value));
  return value;
}
describe('live smoke authorization gate only; no live entry is invoked', () => {
  it('refuses a missing local authorization before runtime initialization', async () => {
    await expect(readLiveWriteAuthorization(await file())).rejects.toThrow('_local/amazon-write-authorization.json');
  });
  it('refuses malformed or altered authority', async () => {
    const value = authorization();
    value.fingerprint = 'f'.repeat(64);
    await expect(readLiveWriteAuthorization(await file(value), '2026-01-01T00:30:00.000Z')).rejects.toThrow('fingerprint mismatch');
    await writeFile(join(directory!, '_local/amazon-write-authorization.json'), '{}');
    await expect(readLiveWriteAuthorization(directory!)).rejects.toThrow();
  });
  it('accepts only the exact bounded window and retains the mandatory inverse constraints', async () => {
    const value = authorization();
    const root = await file(value);
    expect(await readLiveWriteAuthorization(root, '2026-01-01T00:30:00.000Z')).toEqual(value);
    await expect(readLiveWriteAuthorization(root, '2026-01-01T01:00:00.000Z')).rejects.toThrow('not current');
    await expect(readLiveWriteAuthorization(root, '2025-12-31T23:59:59.000Z')).rejects.toThrow('not current');
  });
});
