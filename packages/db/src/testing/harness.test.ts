import { createServer } from 'node:net';
import { beforeAll, describe, expect, it } from 'vitest';
import { databaseAvailable } from './harness.js';

describe('database test availability', () => {
  let unavailableDatabase: string;
  beforeAll(async () => {
    // Reserve and release a loopback port. No DB, credential or shared service
    // is involved in exercising the real driver's connection-failure path.
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP port');
    unavailableDatabase = `postgres://synthetic:synthetic@127.0.0.1:${address.port}/unavailable`;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('allows a local checkout to report unavailable PostgreSQL', async () => {
    expect(await databaseAvailable({ WIZARD_ADS_TEST_DATABASE_URL: unavailableDatabase })).toBe(false);
  });

  it.each(['true', '1'])('fails CI=%s instead of skipping all database tests', async (CI) => {
    await expect(databaseAvailable({ CI, WIZARD_ADS_TEST_DATABASE_URL: unavailableDatabase }))
      .rejects.toThrow('Database tests are required in CI.');
  });
});
