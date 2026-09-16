import { e2eTestMatch } from './src/e2e-suite-registry';
/** Signed-in frame and guarded routes in a fresh authenticated-test Next process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: e2eTestMatch('auth-guards-signed-in-b'),
  outputDir: './node_modules/.cache/playwright/auth-guards-signed-in-b',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-guards-signed-in-b',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'auth-guards-signed-in-b', use: { ...devices['Desktop Chrome'] } }],
});
