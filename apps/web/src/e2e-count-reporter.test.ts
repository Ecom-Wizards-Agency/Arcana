import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FullConfig, FullResult, Suite } from '@playwright/test/reporter';
import E2ECountReporter, {
  countE2ETests,
  hasE2ESelectionArgs,
  parseE2ESuiteSummary,
  readAndValidateE2ESuiteSummary,
  validateE2ESuiteSummary,
} from '../e2e/e2e-count-reporter.js';

function testCase(
  id: string,
  outcome: 'expected' | 'unexpected' | 'skipped',
  status?: 'passed' | 'failed',
  expectedStatus: 'passed' | 'failed' | 'skipped' = 'passed',
) {
  return {
    id,
    outcome: () => outcome,
    expectedStatus,
    results: status === undefined ? [] : [{ status }],
  };
}

describe('E2E count reporter', () => {
  it('accounts for each discovered test and separates completion from skips', () => {
    expect(countE2ETests([
      testCase('pass', 'expected', 'passed'),
      testCase('fail', 'unexpected', 'failed'),
      testCase('skip', 'skipped'),
    ])).toEqual({ discovered: 3, completed: 2, passed: 1, failed: 1, skipped: 1, incomplete: 0 });
  });

  it('writes a typed summary artifact after the run ends', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'openspell-e2e-summary-'));
    const outputFile = join(directory, 'suite.json');
    try {
      const suite = { allTests: () => [testCase('pass', 'expected', 'passed'), testCase('skip', 'skipped')] } as unknown as Suite;
      const reporter = new E2ECountReporter({ outputFile });
      reporter.onBegin({} as FullConfig, suite);
      reporter.onError();
      await reporter.onEnd({ status: 'passed' } as FullResult);

      expect(JSON.parse(await readFile(outputFile, 'utf8'))).toEqual({
        version: 1,
        discovered: 2,
        completed: 1,
        passed: 1,
        failed: 0,
        skipped: 1,
        incomplete: 0,
        status: 'passed',
        errors: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects a passing process when its summary is incomplete or the full count drifts', () => {
    const summary = parseE2ESuiteSummary(JSON.stringify({
      version: 1,
      discovered: 2,
      completed: 2,
      passed: 2,
      failed: 0,
      skipped: 0,
      incomplete: 0,
      status: 'passed',
      errors: 0,
    }));

    expect(() => validateE2ESuiteSummary(summary, 3, true)).toThrow('expected 3 discovered tests');
    expect(() => validateE2ESuiteSummary(summary, 3, false)).not.toThrow();
    expect(() => validateE2ESuiteSummary({ ...summary, skipped: 2, completed: 0, passed: 0 }, 2, true, true))
      .not.toThrow();
    expect(() => validateE2ESuiteSummary({ ...summary, completed: 1 }, 2, false))
      .toThrow('completed + skipped + incomplete does not equal discovered');
  });

  it('uses final results, refuses duplicate or incomplete tests, and distinguishes selection flags', async () => {
    expect(countE2ETests([
      testCase('expected-failure', 'expected', 'failed', 'failed'),
      {
        ...testCase('retried', 'expected', 'failed'),
        results: [{ status: 'failed' }, { status: 'passed' }],
      },
    ])).toMatchObject({ discovered: 2, completed: 2, passed: 0, failed: 2, incomplete: 0 });
    expect(() => countE2ETests([testCase('same', 'expected', 'passed'), testCase('same', 'expected', 'passed')]))
      .toThrow('duplicate test');
    expect(countE2ETests([testCase('missing-result', 'unexpected')])).toMatchObject({ incomplete: 1, completed: 0 });

    expect(hasE2ESelectionArgs(['--workers=1', '--timeout=90000'])).toBe(false);
    expect(hasE2ESelectionArgs(['--workers', '1', '--timeout', '90000'])).toBe(false);
    expect(hasE2ESelectionArgs(['--trace', 'retain-on-failure', '--headed'])).toBe(false);
    expect(hasE2ESelectionArgs(['--grep', 'role'])).toBe(true);
    expect(hasE2ESelectionArgs(['-g', 'role'])).toBe(true);
    expect(hasE2ESelectionArgs(['e2e/roles.spec.ts'])).toBe(true);

    await expect(readAndValidateE2ESuiteSummary('/tmp/openspell-summary-does-not-exist.json', 0, true))
      .rejects.toThrow();
  });
});
