import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { visualStates } from '../src/screens/market-position/render-fixture';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('market position measures competitors, saves threshold and preserves missing ranks', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const state = await readState();
  const database = createDb({ connectionString: state.connectionString });
  let asin: string;
  const competitor = 'B000000268';
  try {
    const [product] = await database.sql<{ asin: string }[]>`select asin from public.product_ads where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and asin is not null order by asin limit 1`;
    if (!product) throw new Error('Market-position browser fixture needs an advertised product');
    asin = product.asin;
    await database.sql`insert into public.competitor_links(org_id,profile_id,our_asin,competitor_asin,enabled)
      values (${state.orgId},${state.fixtureProfileId},${asin},${competitor},true)
      on conflict (org_id,our_asin,competitor_asin) do update set enabled=true`;
    await database.sql`insert into public.keepa_bsr_observations(org_id,asin,category,observed_at,bsr) values
      (${state.orgId},${asin},'Synthetic category','2026-06-01T12:00:00Z',900),
      (${state.orgId},${asin},'Synthetic category','2026-06-03T12:00:00Z',900),
      (${state.orgId},${asin},'Synthetic category','2026-06-04T12:00:00Z',1000),
      (${state.orgId},${competitor},'Synthetic category','2026-06-01T12:00:00Z',1300),
      (${state.orgId},${competitor},'Synthetic category','2026-06-03T12:00:00Z',1300),
      (${state.orgId},${competitor},'Synthetic category','2026-06-04T12:00:00Z',1100)`;
    await signIn(page, 'admin');
    const query = new URLSearchParams({ profile: state.fixtureProfileId, asin, from: '2026-06-01', to: '2026-06-04' });
    await page.goto(`/market-position?${query.toString()}`);
    await expect(page.getByRole('main', { name: 'Market position details' })).toBeVisible();
    await expect(page.getByTestId('proximity-alert')).toHaveCount(1);
    await expect(page.getByText(/both your rank worsening and their gain/)).toBeVisible();
    const paths = page.locator('[data-series-mark="line"] path');
    expect(await paths.count()).toBeGreaterThanOrEqual(2);
    for (const path of await paths.all()) expect((await path.getAttribute('d'))?.match(/M/g)).toHaveLength(2);
    await expect(page.locator('[data-isolated-rank]')).toHaveCount(3);
    const screenshot = testInfo.outputPath('market-position.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach('Market position', { path: screenshot, contentType: 'image/png' });
    await page.getByRole('button', { name: 'Adjust threshold' }).click();
    await page.getByLabel('Threshold (% of your BSR)').fill('5');
    await page.getByRole('button', { name: 'Save threshold' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Threshold saved.' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'Adjust threshold' }).click();
    await expect(page.getByLabel('Threshold (% of your BSR)')).toHaveValue('5');
    await expect(page.getByTestId('proximity-alert')).toHaveCount(0);
    await database.sql`delete from public.competitor_links where org_id=${state.orgId} and our_asin=${asin}`;
    await page.reload();
    await expect(page.getByRole('link', { name: 'Manage competitor links' })).toHaveAttribute('href', '/settings/integrations');
    await expect(page.getByTestId('rank-stat').nth(1)).toContainText('Not measured');
    // Render the real presentation against all synthetic states in the real shell.
    // These are visual fixtures, separate from the persisted-route assertions above.
    query.set('from', '2026-08-18');
    query.set('to', '2026-09-07');
    await page.goto(`/market-position?${query}`);
    await expect(page.getByRole('main', { name: 'Market position details' })).toBeVisible();
    const visualMarkup = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'e2e/support/render-market-position.ts'], { encoding: 'utf8' })) as Record<string, string>;
    const shell = await page.content();
    const screenshots: string[] = [];
    const screenshotDirectory = resolve(testInfo.project.outputDir, '..', 'profile-context', 'market-position');
    await mkdir(screenshotDirectory, { recursive: true });
    for (const visualState of visualStates) {
      const markup = visualMarkup[visualState]!;
      await page.setContent(shell.replace(/<script[\s\S]*?<\/script>/g, ''));
      await page.locator('main[aria-label="Market position details"]').evaluate((element, html) => { element.outerHTML = html; }, markup);
      await page.evaluate(async () => { await document.fonts.ready; });
      const labelsFit = await page.locator('svg.wa-chart').evaluateAll((charts) => charts.every((chart) => {
        const right = chart.getBoundingClientRect().right;
        return [...chart.querySelectorAll('[data-testid^="end-label-"]')].every((label) => label.getBoundingClientRect().right <= right + 1);
      }));
      expect(labelsFit, `${visualState}: rank end labels fit the chart`).toBe(true);
      if (!['loading', 'error'].includes(visualState)) {
        await expect(page.getByTestId('rank-stat')).toHaveCount(6);
        expect(await page.getByRole('main', { name: 'Market position details' }).locator('h1').count()).toBe(0);
      }
      const path = join(screenshotDirectory, ['shell-market-position', visualState, '1440x1024.png'].join('-'));
      await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
      await testInfo.attach(`Market position ${visualState}`, { path, contentType: 'image/png' });
      screenshots.push(path);
    }
    expect(screenshots).toHaveLength(visualStates.length);
  } finally { await database.close(); }
});
