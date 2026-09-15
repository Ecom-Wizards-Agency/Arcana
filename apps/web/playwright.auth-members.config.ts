import { e2eTestMatch } from './src/e2e-suite-registry';
/** Member and invitation flows in a fresh authenticated Next dev process. */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: e2eTestMatch('auth-members'),
  outputDir: './node_modules/.cache/playwright/auth-members',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-members',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'auth-members', use: { ...devices['Desktop Chrome'] } }],
});
