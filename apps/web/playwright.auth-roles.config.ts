import { e2eTestMatch } from './src/e2e-suite-registry';
/**
 * The settings and role matrix in a fresh authenticated Next dev process.
 *
 * It deliberately inherits every safety property of the primary auth config:
 * the same production-refusing cookie seam, one worker, no retries, and the
 * same isolated database lifecycle. Only test selection and artifacts differ.
 */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: e2eTestMatch('auth-roles'),
  outputDir: './node_modules/.cache/playwright/auth-roles',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/auth-roles',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'auth-roles', use: { ...devices['Desktop Chrome'] } }],
});
