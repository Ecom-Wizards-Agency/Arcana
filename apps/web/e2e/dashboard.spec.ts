/** Figma Home composition and both budget states through the authenticated loader. */
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb } from '@wizard-ads/db';
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { expectDateRangePresets } from './support/date-range';
import { readState } from './support/fixture';

test('Home renders five KPIs and the two-column decision cards in both budget states', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  const aliasQuery = new URLSearchParams([
    ['profile', fixtureProfileId],
    ['from', '2026-08-01'],
    ['to', '2026-08-31'],
    ['filter', 'one'],
    ['filter', 'two'],
  ]);
  const alias = await page.request.get(`/dashboard?${aliasQuery}`, { maxRedirects: 0 });
  expect(alias.status()).toBe(307);
  const destination = new URL(alias.headers()['location'] ?? '', alias.url());
  expect(destination.pathname).toBe('/');
  expect([...destination.searchParams.entries()].sort()).toEqual([...aliasQuery.entries()].sort());

  await page.goto(`/?profile=${fixtureProfileId}`);
  await expect(page.getByTestId('shell-title')).toBeVisible();
  await expectDateRangePresets(page);

  await expect(page.locator('.wa-home-kpi')).toHaveCount(5);
  await expect(page.getByRole('listbox', { name: /Primary metrics/ })).toHaveCount(0);
  await expect(page.getByText('Operating status', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Show the numbers', { exact: true })).toHaveCount(0);
  const cards = page.locator('.wa-home-grid > section');
  await expect(cards).toHaveCount(5);
  const first = await page.getByLabel('Proposals', { exact: true }).boundingBox();
  const flags = await page.getByLabel('Flags', { exact: true }).boundingBox();
  expect(first!.x).toBe(264);
  expect(flags!.x).toBeGreaterThan(first!.x + first!.width);
  expect(first!.y).toBe(flags!.y);
  await expect(page.getByTestId('shell-title')).toHaveText('Home');

  // Capture both Home budget states using this suite's disposable profile.
  const state = await readState();
  const database = createDb({ connectionString: state.connectionString, max: 1 });
  const [original] = await database.sql`select monthly_budget from public.ad_profiles where id=${fixtureProfileId}`;
  const insertedEvents: string[] = [];
  try {
    const events = await database.sql<{ id: string }[]>`insert into public.insights
      (org_id, profile_id, date, kind, title, body, source)
      values (${state.orgId}, ${fixtureProfileId}, current_date, 'competitor_deal',
        'Tracked competitor started a deal', 'A deal was observed for the nearest tracked competitor.', 'keepa') returning id`;
    expect(events).toHaveLength(1);
    insertedEvents.push(events[0]!.id);
    const ranks = await database.sql`insert into public.rank_observations
      (org_id, profile_id, asin, keyword, observed_on, organic_rank)
      values (${state.orgId}, ${fixtureProfileId}, 'B0HOME0001', 'sample keyword', current_date - 1, 12),
        (${state.orgId}, ${fixtureProfileId}, 'B0HOME0001', 'sample keyword', current_date - 8, 16) returning id`;
    expect(ranks).toHaveLength(2);
    for (const [name, budget] of [['home-no-budget', null], ['home-with-budget', 3000]] as const) {
      const changed = await database.sql`update public.ad_profiles set monthly_budget=${budget}
        where org_id=${state.orgId} and id=${fixtureProfileId} returning id`;
      expect(changed).toHaveLength(1);
      await page.reload();
      await expect(page.getByTestId('shell-title')).toBeVisible();
      await expect(page.getByLabel('Proposals', { exact: true })).toBeVisible();
      await expect(page.getByLabel('Campaigns near their limit')).toContainText('Not measured');
      await expect(page.getByLabel('Campaigns near their limit')).not.toContainText('0');
      await expect(page.getByLabel('Pacing', { exact: true })).toContainText(budget === null ? 'No monthly budget on file — pacing is not computed.' : 'Remaining · derived, not stored');
      await expect(page.getByLabel('Events this week')).toContainText('Keepa');
      await expect(page.getByLabel('Events this week')).toContainText('Analyst');
      await expect(page.getByLabel('Rank watch')).toContainText('Up 4 places');
      await expect(page.getByLabel('Market position', { exact: true })).toContainText('Not measured');
      const screenshotDirectory = resolve('node_modules/.cache/playwright/profile-context');
      await mkdir(screenshotDirectory, { recursive: true });
      const screenshotPath = resolve(screenshotDirectory, `${name}-1440x1024.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true,
        animations: 'disabled', style: 'nextjs-portal { display: none; }' });
      await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' });
      const geometry = await page.locator('.wa-home-kpi, .wa-home-card').evaluateAll((elements) => elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { label: element.getAttribute('aria-label'), x, y, width, height };
      }));
      await writeFile(resolve(screenshotDirectory, `${name}-geometry.json`), JSON.stringify(geometry, null, 2));
    }
    // Verify the populated market state separately; both frame captures show missing market evidence.
    {
        const links = await database.sql`insert into public.competitor_links
          (org_id, profile_id, our_asin, competitor_asin, enabled)
          values (${state.orgId}, ${fixtureProfileId}, 'B0HOME0001', 'B0HOME0002', true) returning id`;
        expect(links).toHaveLength(1);
        const observations = await database.sql`insert into public.keepa_bsr_observations
          (org_id, asin, category, observed_at, bsr)
          values (${state.orgId}, 'B0HOME0001', 'Sample category', current_timestamp, 240),
            (${state.orgId}, 'B0HOME0002', 'Sample category', current_timestamp, 210) returning id`;
        expect(observations).toHaveLength(2);
      }
    await page.reload();
    await expect(page.getByLabel('Market position', { exact: true })).toContainText('30 places behind');
    await expect(page.getByRole('link', { name: 'View market position →' })).toHaveAttribute('href', `/market-position?profile=${fixtureProfileId}`);
  } finally {
    await database.sql`delete from public.insights where org_id=${state.orgId} and id=any(${insertedEvents}::uuid[])`;
    await database.sql`delete from public.rank_observations where org_id=${state.orgId} and profile_id=${fixtureProfileId} and asin='B0HOME0001'`;
    await database.sql`delete from public.competitor_links where org_id=${state.orgId} and profile_id=${fixtureProfileId} and our_asin='B0HOME0001'`;
    await database.sql`delete from public.keepa_bsr_observations where org_id=${state.orgId} and asin in ('B0HOME0001', 'B0HOME0002')`;
    await database.sql`update public.ad_profiles set monthly_budget=${original!.monthly_budget}
      where org_id=${state.orgId} and id=${fixtureProfileId}`;
    await database.sql.end();
  }

  // Optimize Now remains reachable from Home for the selected profile.
  await page.goto(`/optimizer?profile=${fixtureProfileId}`);
  await expect(page.getByRole('heading', { name: 'Optimize Now', level: 1, exact: true })).toBeVisible({ timeout: 60_000 });
  const steps = page.getByRole('list', { name: 'Optimization progress' });
  await expect(steps).toBeVisible();
  await expect(steps.getByRole('listitem')).toHaveText([
    '1. Choose campaigns', '2. Review suggestions', '3. Confirm and results',
  ]);
  await expect(steps.getByRole('listitem').first()).toHaveAttribute('aria-current', 'step');
});

test('SP-API reader components expose measured, partial, stale and unavailable evidence', async ({ page }, testInfo) => {
  const { execFileSync } = await import('node:child_process');
  const rendered = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', 'e2e/support/render-spapi-evidence.ts'], {
    cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
  })) as Record<string, string>;
  const states = ['measured', 'partial', 'stale', 'unavailable'];
  expect(Object.keys(rendered)).toEqual(states);
  await page.setViewportSize({ width: 1440, height: 1024 });
  const screenshots: string[] = [];
  for (const state of states) {
    await page.setContent(rendered[state]!);
    await expect(page.getByTestId('sp-source-status')).toHaveCount(3);
    await expect(page.locator(`[data-state="${state}"]`)).toHaveCount(3);
    await expect(page.getByRole('columnheader', { name: 'TACOS', exact: true })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Click share', exact: true })).toBeVisible();
    if (state === 'measured') {
      await expect(page.getByRole('cell', { name: 'Not top 3', exact: true })).toHaveCount(1);
      await expect(page.getByRole('cell', { name: '2,400 EUR', exact: true })).toHaveCount(1);
      await expect(page.getByRole('cell', { name: '10.00%', exact: true })).toHaveCount(1);
      await expect(page.getByRole('cell', { name: 'Observed synthetic listing title', exact: true })).toHaveCount(1);
    } else await expect(page.getByRole('cell', { name: 'Not top 3', exact: true })).toHaveCount(0);
    const path = testInfo.outputPath(`spapi-${state}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    await testInfo.attach(`SP-API ${state}`, { path, contentType: 'image/png' }); screenshots.push(path);
  }
  expect(screenshots).toHaveLength(states.length);
});
