import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { researchScreenshots, researchInteractionScreenshot } from './support/research-screenshots';
import { brandLensWarmRoutes, warmRoutes } from './support/route-warmup';
const RESEARCH_WINDOW = { from: '2026-08-01', to: '2026-08-28' };
// Compile the page, its re-read and its override handler before the test's clock starts.
test.beforeAll(async () => {
  await warmRoutes(brandLensWarmRoutes((await readState()).fixtureProfileId, RESEARCH_WINDOW));
});
test('Brand lens classifies keyword targets and persists an operator override', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.goto(`/brand-lens?${new URLSearchParams({profile:fixtureProfileId,...RESEARCH_WINDOW})}`);
  await page.getByRole('button', { name: 'Add to Brand tokens' }).click();
  await expect(page.getByRole('textbox', { name: 'Add to Brand tokens' })).toBeVisible();
  await researchInteractionScreenshot(page, testInfo, 'brand-lens', 'add-token');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', {
    name: 'Classify keywords',
    exact: true
  }).click();
  await page.getByRole('button', { name: /change classification for/ }).first().click();
  await expect(page.getByRole('menu')).toBeVisible();
  await researchInteractionScreenshot(page, testInfo, 'brand-lens', 'classification-menu');
  // The choice saves the override, then re-reads the stamped decisions the chip renders from.
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/brand-lens/overrides');
  const reread = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/api/brand-lens');
  await page.getByRole('menuitem', { name: 'Generic', exact: true }).click();
  expect((await saved).status()).toBe(200);
  expect((await reread).status()).toBe(200);
  await expect(page.getByText('changed', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', {
    name: 'Campaign exclusions',
    exact: true
  }).click();
  await expect(page.getByText('Classifying a term does not block it.', { exact: false })).toBeVisible();
  await researchScreenshots(page, testInfo, 'brand-lens');
});
