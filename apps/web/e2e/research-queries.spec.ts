import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { researchScreenshots } from './support/research-screenshots';
test('Queries keeps missing SQP explicit and persists reviewed vocabulary', async ({ page }, testInfo) => {
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.goto(`/queries?${new URLSearchParams({profile:fixtureProfileId,from:'2026-08-01',to:'2026-08-28'})}`);
  await expect(page.getByRole('heading', {
    name: 'Query Intelligence',
    exact: true
  })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Demand split' })).toContainText('Not measured');
  await page.getByLabel('Word or phrase').fill('synthetic research token');
  await page.getByRole('button', {
    name: 'Add word',
    exact: true
  }).click();
  await page.getByRole('button', {
    name: 'Approve synthetic research token',
    exact: true
  }).click();
  await expect(page.getByRole('region', { name: 'Query vocabulary' })).toContainText('Approved');
  await page.reload();
  await expect(page.getByRole('button', {
    name: 'Remove synthetic research token',
    exact: true
  })).toBeVisible();
  await page.goto(`/query-intelligence?profile=${fixtureProfileId}`);
  await expect(page).toHaveURL(/\/queries\?/);
  await researchScreenshots(page, testInfo, 'queries');
});
