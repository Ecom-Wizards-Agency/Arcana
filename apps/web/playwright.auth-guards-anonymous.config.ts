/** Anonymous frame and guard redirects in a fresh authenticated-test Next process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /guards-anonymous\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/auth-guards-anonymous',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-guards-anonymous',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'auth-guards-anonymous', use: { ...devices['Desktop Chrome'] } }],
});
