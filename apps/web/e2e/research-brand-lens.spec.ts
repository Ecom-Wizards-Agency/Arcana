import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { researchScreenshots } from './support/research-screenshots';
test('Brand lens classifies keyword targets and persists an operator override', async ({ page }, testInfo) => {
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.goto(`/brand-lens?${new URLSearchParams({profile:fixtureProfileId,from:'2026-08-01',to:'2026-08-28'})}`);
  await page.getByRole('button', {
    name: 'Classify keywords',
    exact: true
  }).click();
  await page.getByRole('combobox', { name: /Override/ }).first().selectOption('generic:changed');
  await expect(page.getByText('changed', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', {
    name: 'Campaign exclusions',
    exact: true
  }).click();
  await expect(page.getByText('Classifying a term does not block it.', { exact: false })).toBeVisible();
  await researchScreenshots(page, testInfo, 'brand-lens');
});
