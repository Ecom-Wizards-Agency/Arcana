import { e2eTestMatch } from './src/e2e-suite-registry';
/**
 * Account-scope and same-document navigation in a fresh authenticated Next
 * process. The sidebar layout regression rides here because it needs the same
 * authenticated frame and adds only a handful of dashboard loads.
 */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: e2eTestMatch('profile-context'),
  outputDir: './node_modules/.cache/playwright/profile-context',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/profile-context',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'profile-context', use: { ...devices['Desktop Chrome'] } }],
});
