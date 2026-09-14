/** Full-page target analysis and shareable return navigation. */
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { applyRequestedCpuThrottle } from './support/cpu-throttle';
import { readState } from './support/fixture';

test.beforeEach(async ({ page }) => applyRequestedCpuThrottle(page));

test('target page and goto restore the complete shared grid analysis', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId, orgId, connectionString } = await readState();
  const database = createDb({ connectionString, max: 1 });
  let date: string;
  try {
    const ranks = await database.sql<{ date: string }[]>`
      insert into public.rank_observations(org_id, profile_id, asin, keyword, observed_on, organic_rank, sponsored_rank)
      values (${orgId}, ${fixtureProfileId}, 'SYNTHETIC1', 'widget', current_date - 2, 12, 3)
      returning observed_on::text as date
    `;
    expect(ranks).toHaveLength(1);
    date = ranks[0]!.date;
    const points = await database.sql`
      insert into public.bid_series_daily(org_id, profile_id, target_id, campaign_id, ad_group_id, is_keyword, date, bid, cpc, suggested_bid_low, suggested_bid_median, suggested_bid_high, max_potential_cpc)
      values (${orgId}, ${fixtureProfileId}, 'kw-1', 'c-1', 'ag-1', true, ${date}, 2, 1, 1, 2, 3, 4)
      returning target_id
    `;
    expect(points).toHaveLength(1);
  } finally { await database.close(); }
  const route = `/grid?entity=targets&profile=${fixtureProfileId}&from=${date}&to=${date}`;
  await page.goto(route);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  const historyLength = await page.evaluate(() => window.history.length);
  await page.getByLabel('Row density').selectOption('compact');
  const analysis = new URL(page.url()).searchParams.get('view');
  expect(analysis).toMatch(/^1\./);
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength);
  const rowLink = page.locator('a[href^="/targets/kw-1?"]').first();
  await expect(rowLink).toBeVisible();
  await rowLink.click();
  await expect(page.getByRole('heading', { name: 'widget', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bid corridor chart' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bid corridor chart' }).locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Target metrics' })).toContainText('Spend');
  await expect(page.getByRole('region', { name: 'Target metrics' })).toContainText('ACOS');
  await expect(page.getByRole('region', { name: 'Rank observations' }).locator('tbody tr')).toHaveCount(1);
  await page.getByRole('link', { name: 'Back to grid', exact: true }).click();
  await expect(page.getByLabel('Row density')).toHaveValue('compact');
  expect(new URL(page.url()).searchParams.get('view')).toBe(analysis);
  const created = await page.request.post('/api/goto', { data: {
    route, state: { view: analysis },
  } });
  expect(created.status()).toBe(201);
  const link = await created.json() as { path: string };
  await page.getByLabel('Row density').selectOption('comfortable');
  await page.goto(link.path);
  await expect(page.getByLabel('Row density')).toHaveValue('compact');
  expect(new URL(page.url()).searchParams.get('view')).toBe(analysis);
});
