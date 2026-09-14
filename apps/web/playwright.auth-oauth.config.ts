import { e2eTestMatch } from './src/e2e-suite-registry';
/** The Amazon OAuth round trip in a fresh authenticated Next dev process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: e2eTestMatch('auth-oauth'),
  outputDir: './node_modules/.cache/playwright/auth-oauth',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-oauth',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'auth-oauth', use: { ...devices['Desktop Chrome'] } }],
});
