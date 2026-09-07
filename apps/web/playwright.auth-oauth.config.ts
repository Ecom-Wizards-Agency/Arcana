/** The Amazon OAuth round trip in a fresh authenticated Next dev process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /oauth\.spec\.ts$/,
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
