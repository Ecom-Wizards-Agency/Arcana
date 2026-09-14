import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('groups preserve missing reporting and disclose current members and reload failures', async ({ page }) => {
  const state = await readState();
  await signIn(page, 'admin'); await page.setViewportSize({ width: 1440, height: 1024 });
  const folder = resolve('node_modules/.cache/playwright/wp269'); await mkdir(folder, { recursive: true });
  await page.goto(`/optimizer/groups?profile=${state.fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Optimization Groups', exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(folder, 'groups-list.png'), fullPage: true });
  const link = page.getByRole('link', { name: 'Open group', exact: true }).first();
  const href = await link.getAttribute('href'); expect(href).not.toBeNull();
  const database = createDb({ connectionString: state.connectionString });
  try {
    const facts = await database.sql<{ start: string; end: string }[]>`select min(date)::text as start, max(date)::text as end from public.fact_sp_target_daily where org_id = ${state.orgId} and profile_id = ${state.fixtureProfileId}`;
    expect(facts).toHaveLength(1);
    expect(facts[0]!.start).not.toBeNull();
    await page.goto(`${href}&from=${facts[0]!.start}&to=${facts[0]!.end}`);
    await expect(page.getByRole('img', { name: /history for/ })).toBeVisible();
    await page.screenshot({ path: resolve(folder, 'group-with-reporting.png'), fullPage: true });
  } finally { await database.close(); }
  await page.goto(`${href}&from=2025-01-01&to=2025-01-02`);
  await expect(page.getByText('No reporting data for this period', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Unavailable', exact: true })).toHaveCount(12);
  await page.screenshot({ path: resolve(folder, 'group-no-reporting.png'), fullPage: true });
  await page.locator('#wa-main').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('optimizer-group-settings-ready')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('button', { name: 'Group members', exact: true })).toBeEnabled();
  await page.screenshot({ path: resolve(folder, 'group-settings.png'), fullPage: true });
  const members = page.getByRole('button', { name: 'Group members', exact: true }); await members.click();
  await expect(page.getByRole('dialog', { name: 'Group members' })).toContainText('current campaigns');
  await page.screenshot({ path: resolve(folder, 'group-members.png'), fullPage: true });
  await page.route('**/api/optimizer/groups?*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
  await page.getByRole('button', { name: 'Reload members' }).click();
  await expect(page.getByRole('dialog', { name: 'Group members' }).getByRole('alert')).toContainText('Members could not be loaded. Try again.');
  await page.screenshot({ path: resolve(folder, 'group-members-failed.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Edit group settings', exact: true }).click();
  await expect(page.getByText('A scheduled run prepares a preview. It never sends anything.', { exact: true })).toBeVisible();
  await expect(page.locator('.wa-weekday-options input')).toHaveCount(7);
  await expect(page.locator('.wa-weekday-options input').first()).toBeEnabled();
  await page.screenshot({ path: resolve(folder, 'group-weekdays.png'), fullPage: true });
});
