import { e2eTestMatch } from './src/e2e-suite-registry';
/** Anonymous frame and guard redirects in a fresh authenticated-test Next process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: e2eTestMatch('auth-guards-anonymous-b'),
  outputDir: './node_modules/.cache/playwright/auth-guards-anonymous-b',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-guards-anonymous-b',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'auth-guards-anonymous-b', use: { ...devices['Desktop Chrome'] } }],
});
