/** Full-page target analysis and shareable return navigation. */
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { parseGridView } from '@wizard-ads/shared';
import { signIn } from './support/auth';
import { applyRequestedCpuThrottle } from './support/cpu-throttle';
import { readState } from './support/fixture';

test.beforeEach(async ({ page }) => applyRequestedCpuThrottle(page));

test('target page and goto restore the complete shared grid analysis', async ({ page },testInfo) => {
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
      on conflict(profile_id,date,campaign_id,ad_group_id,target_id) do update set bid=excluded.bid,cpc=excluded.cpc,suggested_bid_low=excluded.suggested_bid_low,suggested_bid_median=excluded.suggested_bid_median,suggested_bid_high=excluded.suggested_bid_high,max_potential_cpc=excluded.max_potential_cpc
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
  await page.setViewportSize({width:1440,height:1024});
  let releaseTarget!: () => void;
  const targetGate = new Promise<void>((resolve) => { releaseTarget = resolve; });
  await page.route('**/api/targets/kw-1?**',async (request) => { await targetGate; await request.continue(); });
  const row = rowLink.locator('xpath=ancestor::*[@role="row"][1]');
  await row.getByRole('cell').nth(1).click();
  await expect(page.getByText('Loading bid history…')).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('target-loading.png'),style:'nextjs-portal { display: none; }'});
  releaseTarget();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('tab',{name:'Corridor',exact:true})).toBeVisible();
  await page.unroute('**/api/targets/kw-1?**');
  await page.screenshot({path:testInfo.outputPath('target-drawer.png'),style:'nextjs-portal { display: none; }'});
  await drawer.getByLabel('Realised CPC', { exact: true }).uncheck();
  await drawer.getByRole('button', { name: 'Add to compare', exact: true }).click();
  await drawer.getByRole('button',{name:'Close target',exact:true}).click();
  await expect(drawer).toHaveCount(0);
  const drawerView = parseGridView(new URL(page.url()).searchParams.get('view'));
  expect(drawerView?.target?.series.realisedCpc).toBe(false);
  expect(drawerView?.compare).toEqual([{ profileId: fixtureProfileId, targetId: 'kw-1' }]);
  expect(drawerView).toMatchObject(parseGridView(analysis)!);
  await page.getByLabel('Row density').selectOption('comfortable');
  await expect.poll(() => parseGridView(new URL(page.url()).searchParams.get('view'))?.density).toBe('comfortable');
  expect(parseGridView(new URL(page.url()).searchParams.get('view'))?.target).toEqual(drawerView?.target);
  expect(parseGridView(new URL(page.url()).searchParams.get('view'))?.compare).toEqual(drawerView?.compare);
  await page.getByLabel('Row density').selectOption('compact');
  await row.getByRole('cell').nth(1).click();
  await expect(drawer.getByLabel('Realised CPC', { exact: true })).not.toBeChecked();
  await expect(drawer.getByRole('region', { name: 'Compare targets', exact: true })).toContainText('(1/4)');
  await drawer.getByLabel('Realised CPC', { exact: true }).check();
  await drawer.getByRole('link',{name:'Open full ↗',exact:true}).click();
  // Target detail compiles on first use in this suite.
  await expect(page.getByRole('heading', { name: 'widget', exact: true, level: 1 })).toBeVisible({ timeout: 60_000 });
  const mainCorridor = page.getByRole('region', { name: 'Bid corridor chart' }).first();
  await expect(mainCorridor).toBeVisible();
  await expect(mainCorridor.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('region', { name: 'Target metrics' })).toContainText('spend');
  await expect(page.getByRole('region', { name: 'Target metrics' })).toContainText('ACOS');
  await page.reload();
  await expect(page.getByRole('region',{name:'Compare targets',exact:true})).toContainText('(1/4)');
  await page.getByRole('tab', { name: 'Rank', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rank observations' }).locator('tbody tr')).toHaveCount(1);
  const returnLink = page.getByRole('link', { name: 'Back to grid', exact: true });
  const returnedView = new URL((await returnLink.getAttribute('href'))!,page.url()).searchParams.get('view');
  await returnLink.click();
  await expect(page.getByLabel('Row density')).toHaveValue('compact');
  expect(new URL(page.url()).searchParams.get('view')).toBe(returnedView);
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
