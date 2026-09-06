import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => {
  const end = vi.fn(async () => {});
  const query = Object.assign(vi.fn(async () => [{ '?column?': 1 }]), { end });
  return { end, query, postgres: vi.fn(() => query) };
});
vi.mock('postgres', () => ({ default: probe.postgres }));

import { databaseAvailable } from './harness.js';

describe('test database availability policy', () => {
  beforeEach(() => {
    vi.stubEnv('WIZARD_ADS_TEST_REQUIRE_DATABASE', undefined);
    probe.end.mockReset().mockResolvedValue(undefined);
    probe.query.mockReset().mockResolvedValue([{ '?column?': 1 }]);
    probe.postgres.mockReset().mockReturnValue(probe.query);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('allows an optional local suite to skip an unavailable database and closes its probe', async () => {
    probe.query.mockRejectedValueOnce(new Error('synthetic unreachable database'));
    expect(await databaseAvailable()).toBe(false);
    expect(probe.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it('fails a required suite without exposing the driver error or connection credentials', async () => {
    vi.stubEnv('WIZARD_ADS_TEST_REQUIRE_DATABASE', '1');
    const privateDetail = ['postgres://synthetic:', 'private-value@example.test/database'].join('');
    probe.query.mockRejectedValueOnce(new Error(privateDetail));
    const failure = await databaseAvailable().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Required test database is unavailable. Check WIZARD_ADS_TEST_DATABASE_URL or DATABASE_URL.',
    );
    expect((failure as Error).stack).not.toContain(privateDetail);
    expect((failure as Error).cause).toBeUndefined();
    expect(probe.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it.each([undefined, '0', '1'])('runs a reachable database with required flag %s and releases the probe', async (required) => {
    vi.stubEnv('WIZARD_ADS_TEST_REQUIRE_DATABASE', required);
    expect(await databaseAvailable()).toBe(true);
    expect(probe.query).toHaveBeenCalledOnce();
    expect(probe.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });

  it.each([undefined, '1'])('contains connection initialization failures with required flag %s', async (required) => {
    vi.stubEnv('WIZARD_ADS_TEST_REQUIRE_DATABASE', required);
    probe.postgres.mockImplementationOnce(() => { throw new Error('synthetic private connection initialization detail'); });
    if (required === '1') {
      await expect(databaseAvailable()).rejects.toThrow('Required test database is unavailable.');
    } else expect(await databaseAvailable()).toBe(false);
    expect(probe.end).not.toHaveBeenCalled();
  });

  it('keeps the required-database failure when cleanup also fails', async () => {
    vi.stubEnv('WIZARD_ADS_TEST_REQUIRE_DATABASE', '1');
    probe.query.mockRejectedValueOnce(new Error('synthetic query failure'));
    probe.end.mockRejectedValueOnce(new Error('synthetic cleanup failure'));
    await expect(databaseAvailable()).rejects.toThrow('Required test database is unavailable.');
    expect(probe.end).toHaveBeenCalledExactlyOnceWith({ timeout: 1 });
  });
});

it('requires database evidence in both CI jobs and preserves the flag through Turbo', async () => {
  const workflow = await readFile(new URL('../../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const [check, e2e] = workflow.split('\n  e2e:');
  for (const step of ['Apply and verify migrations', 'Test']) {
    const body = check!.split(`      - name: ${step}\n`)[1]?.split('\n      - ')[0];
    expect(body, `missing required database flag on check/${step}`)
      .toMatch(/WIZARD_ADS_TEST_REQUIRE_DATABASE:\s*["']1["']/);
  }
  expect(e2e?.split('\n    steps:')[0], 'missing required database flag on e2e job')
    .toMatch(/WIZARD_ADS_TEST_REQUIRE_DATABASE:\s*["']1["']/);
  const turbo = JSON.parse(await readFile(new URL('../../../../turbo.json', import.meta.url), 'utf8')) as {
    tasks: { test: { env: string[] } };
  };
  expect(turbo.tasks.test.env).toContain('WIZARD_ADS_TEST_REQUIRE_DATABASE');
});
