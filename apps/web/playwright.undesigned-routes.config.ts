import { e2eTestMatch } from './src/e2e-suite-registry';
/**
 * Live captures of the undesigned utility routes in a fresh authenticated Next
 * process. They shared route acceptance's process until its compiled optimizer,
 * creative and dashboard graphs left the capture test near its time limit and
 * the dev server near its bounded heap.
 */
import { defineConfig, devices } from '@playwright/test';
import { withE2ESummaryReporter } from './e2e/e2e-count-reporter';
import routeAcceptanceConfig from './playwright.route-acceptance.config';

export default defineConfig({
  ...routeAcceptanceConfig,
  testMatch: e2eTestMatch('undesigned-routes'),
  outputDir: './node_modules/.cache/playwright/undesigned-routes',
  reporter: withE2ESummaryReporter(process.env['CI']
    ? [
        ['list'],
        [
          'html',
          {
            outputFolder: './node_modules/.cache/playwright/reports/undesigned-routes',
            open: 'never',
          },
        ],
      ]
    : [['list']]),
  projects: [{ name: 'undesigned-routes', use: { ...devices['Desktop Chrome'] } }],
});
