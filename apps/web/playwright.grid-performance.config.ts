/**
 * Isolated authenticated Grid performance proof.
 *
 * It deliberately reuses the real auth setup and development server from the
 * main authenticated suite, but in a fresh process. The large fixture should
 * measure Grid readiness without its retained route graph consuming heap for
 * every unrelated route and role test that follows.
 */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import authConfig from './playwright.auth.config';

export default defineConfig({
  ...authConfig,
  testMatch: /grid-performance\.spec\.ts$/,
  outputDir: './node_modules/.cache/playwright/grid-performance',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/grid-performance',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'grid-performance', use: { ...devices['Desktop Chrome'] } }],
});
