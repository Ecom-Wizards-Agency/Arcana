import { E2E_SHARD_ENV, E2E_SHARD_TESTS_FILE_ENV, e2eTestMatch } from './src/e2e-suite-registry';
/** Cross-route operator acceptance in a fresh authenticated Next process. */
import { defineConfig, devices } from '@playwright/test';
import type { ReporterDescription } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import { BASE_URL } from './e2e/support/fixture';

// e2e/run.ts runs this suite as process shards, one dev server each. Playwright
// clears outputDir and the HTML report folder on every invocation, so each shard
// writes its own; the JSON list lets the runner prove no test ran in two shards.
const shard = process.env[E2E_SHARD_ENV];
if (shard !== undefined && !/^[1-9]\d*-of-[1-9]\d*$/.test(shard)) {
  throw new Error(`${E2E_SHARD_ENV} must look like '1-of-2', received '${shard}'`);
}
const artifactName = shard === undefined ? 'route-acceptance' : `route-acceptance-shard-${shard}`;
const testsFile = process.env[E2E_SHARD_TESTS_FILE_ENV];
const shardTestList: ReporterDescription[] =
  testsFile === undefined || testsFile.length === 0 ? [] : [['json', { outputFile: testsFile }]];

export default defineConfig({
  testDir: './e2e',
  testMatch: e2eTestMatch('route-acceptance'),
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  outputDir: `./node_modules/.cache/playwright/${artifactName}`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: withE2ESummaryReporter([
    ...(process.env['CI']
      ? ([
          ['list'],
          [
            'html',
            {
              outputFolder: `./node_modules/.cache/playwright/reports/${artifactName}`,
              open: 'never',
            },
          ],
        ] satisfies ReporterDescription[])
      : ([['list']] satisfies ReporterDescription[])),
    ...shardTestList,
  ]),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'route-acceptance', use: { ...devices['Desktop Chrome'] } }],
});
