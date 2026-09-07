/** WP-171's optimization-group workflow in a fresh authenticated Next process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /optimization-groups\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/optimization-groups',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/optimization-groups',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'optimization-groups', use: { ...devices['Desktop Chrome'] } }],
});
