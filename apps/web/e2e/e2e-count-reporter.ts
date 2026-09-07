import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReporterDescription } from '@playwright/test';
import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestStatus } from '@playwright/test/reporter';

export const E2E_SUMMARY_FILE_ENV = 'WIZARD_ADS_E2E_SUMMARY_FILE';

export type E2ESuiteCounts = {
  discovered: number;
  completed: number;
  passed: number;
  failed: number;
  skipped: number;
  incomplete: number;
};

export type E2ESuiteSummary = E2ESuiteCounts & {
  version: 1;
  status: FullResult['status'];
  errors: number;
};

const STATUSES = new Set<FullResult['status']>(['passed', 'failed', 'timedout', 'interrupted']);

export type CountableTest = {
  id: string;
  expectedStatus: TestCase['expectedStatus'];
  outcome: TestCase['outcome'];
  results: readonly { status: TestStatus | undefined }[];
};

export function countE2ETests(tests: readonly CountableTest[]): E2ESuiteCounts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let incomplete = 0;
  const ids = new Set<string>();

  for (const test of tests) {
    if (ids.has(test.id)) throw new Error(`E2E summary has duplicate test '${test.id}'`);
    ids.add(test.id);
    if (test.outcome() === 'skipped') {
      skipped += 1;
      continue;
    }
    const finalResult = test.results.at(-1);
    if (finalResult === undefined || finalResult.status === undefined) {
      incomplete += 1;
    } else if (test.results.length === 1 && finalResult.status === 'passed' && test.outcome() === 'expected') {
      // Product acceptance requires an actual pass on the configured single
      // attempt. Expected failures and successful retries are not green checks.
      passed += 1;
    } else {
      failed += 1;
    }
  }

  return {
    discovered: tests.length,
    completed: passed + failed,
    passed,
    failed,
    skipped,
    incomplete,
  };
}

export function parseE2ESuiteSummary(raw: string): E2ESuiteSummary {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== 'object' || value === null) throw new Error('E2E summary must be an object');
  const candidate = value as Record<string, unknown>;
  const numericFields = ['discovered', 'completed', 'passed', 'failed', 'skipped', 'incomplete', 'errors'];
  for (const field of numericFields) {
    if (!Number.isInteger(candidate[field]) || (candidate[field] as number) < 0) {
      throw new Error(`E2E summary field '${field}' must be a non-negative integer`);
    }
  }
  if (candidate.version !== 1 || typeof candidate.status !== 'string' || !STATUSES.has(candidate.status as FullResult['status'])) {
    throw new Error('E2E summary has an invalid version or status');
  }
  return candidate as unknown as E2ESuiteSummary;
}

export function validateE2ESuiteSummary(
  summary: E2ESuiteSummary,
  expectedTests: number,
  enforceExpectedCount: boolean,
  listOnly = false,
): void {
  const problems: string[] = [];
  if (enforceExpectedCount && summary.discovered !== expectedTests) {
    problems.push(`expected ${expectedTests} discovered tests, received ${summary.discovered}`);
  }
  if (summary.completed + summary.skipped + summary.incomplete !== summary.discovered) {
    problems.push('completed + skipped + incomplete does not equal discovered');
  }
  if (summary.passed + summary.failed !== summary.completed) {
    problems.push('passed + failed does not equal completed');
  }
  if (summary.errors !== 0) problems.push(`reporter observed ${summary.errors} runner errors`);
  if (summary.incomplete !== 0) problems.push(`${summary.incomplete} tests had no completed result`);
  if (!listOnly && summary.failed !== 0) problems.push(`${summary.failed} tests failed`);
  if (!listOnly && summary.skipped !== 0) problems.push(`${summary.skipped} tests were skipped`);
  if (summary.status !== 'passed') problems.push(`Playwright ended with status '${summary.status}'`);
  if (problems.length > 0) throw new Error(`E2E summary mismatch: ${problems.join('; ')}`);
}

export async function readAndValidateE2ESuiteSummary(
  outputFile: string,
  expectedTests: number,
  enforceExpectedCount: boolean,
  listOnly = false,
): Promise<E2ESuiteSummary> {
  const summary = parseE2ESuiteSummary(await readFile(outputFile, 'utf8'));
  validateE2ESuiteSummary(summary, expectedTests, enforceExpectedCount, listOnly);
  return summary;
}

const SELECTION_FLAGS = new Set([
  '-g', '-G',
  '--grep',
  '--grep-invert',
  '--project',
  '--shard',
  '--test-list',
  '--test-list-invert',
  '--last-failed',
  '--only-changed',
]);

// Values of ordinary Playwright options are not positional test filters.
const VALUE_FLAGS = new Set([
  '--browser', '-c', '--config', '--debug', '--global-timeout', '-j', '--workers',
  '--last-failed-file', '--max-failures', '--output', '--repeat-each', '--reporter',
  '--retries', '--run-agents', '--timeout', '--trace', '--update-source-method',
  '-u', '--update-snapshots',
]);

export function hasE2ESelectionArgs(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) return true;
    const [flag] = argument.split('=', 1);
    if (flag !== undefined && SELECTION_FLAGS.has(flag)) return true;
    if (!argument.includes('=') && VALUE_FLAGS.has(argument) && !args[index + 1]?.startsWith('-')) index++;
  }
  return false;
}

export function withE2ESummaryReporter(reporters: ReporterDescription[]): ReporterDescription[] {
  const outputFile = process.env[E2E_SUMMARY_FILE_ENV];
  if (outputFile === undefined || outputFile.length === 0) return reporters;
  return [...reporters, ['./e2e/e2e-count-reporter.ts', { outputFile }]];
}

export default class E2ECountReporter implements Reporter {
  private suite: Suite | undefined;
  private errors = 0;

  public constructor(private readonly options: { outputFile: string }) {
    if (options.outputFile.length === 0) throw new Error('E2E summary output file is required');
  }

  public onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }

  public onError(): void {
    this.errors += 1;
  }

  public async onEnd(result: FullResult): Promise<void> {
    const counts = countE2ETests(this.suite?.allTests() ?? []);
    const summary: E2ESuiteSummary = {
      version: 1,
      ...counts,
      status: result.status,
      errors: this.errors + (this.suite === undefined ? 1 : 0),
    };
    await mkdir(dirname(this.options.outputFile), { recursive: true });
    await writeFile(this.options.outputFile, `${JSON.stringify(summary)}\n`, 'utf8');
  }

  public printsToStdio(): boolean {
    return false;
  }
}
