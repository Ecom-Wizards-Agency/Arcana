/** Figma Home composition and both budget states through the authenticated loader. */
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDb, persistBudgetUsageRun, persistCatalogueCollection } from '@wizard-ads/db';
import { BudgetUsageConfig, ProductMetadataSnapshot, type AdProduct, type BudgetUsageObservation } from '@wizard-ads/shared';
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
  const [originalBudgetConfig] = await database.sql`select config from public.budget_usage_settings where org_id=${state.orgId} and profile_id=${fixtureProfileId}`;
  const insertedEvents: string[] = [];
  const budgetRunIds: string[] = [];
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
      await expect(page.getByLabel('Events this week', { exact: true })).toContainText('Keepa');
      await expect(page.getByLabel('Events this week', { exact: true })).toContainText('Analyst');
      await expect(page.getByLabel('Rank watch', { exact: true })).toContainText('Up 4 places');
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
    // Rank rows link to their product; sections collapse per user and stay collapsed across a reload.
    const productHref = `/grid?${new URLSearchParams({ profile: fixtureProfileId, entity: 'products', asin: 'B0HOME0001' })}`;
    const rankWatch = page.getByLabel('Rank watch', { exact: true });
    // No catalogue title yet: the row names the product by its ASIN.
    await expect(rankWatch.getByRole('link', { name: 'B0HOME0001', exact: true })).toHaveAttribute('href', productHref);
    const acquiredAt = new Date().toISOString();
    const absent = { state: 'absent' as const, reason: null };
    const title = ProductMetadataSnapshot.parse({ scope: { orgId: state.orgId, profileId: fixtureProfileId, marketplaceId: 'A1SYNTHETIC' },
      asin: 'B0HOME0001', sku: null, adProduct: 'SP',
      provenance: { family: 'product_metadata', contractVersion: 'product-metadata-v1-synthetic', providerObservedAt: null, acquiredAt, retrievedAt: acquiredAt },
      title: { state: 'returned', value: 'Synthetic home product', sourceField: 'synthetic' }, imageUrl: absent, category: absent,
      variationAsins: absent, price: absent, basisPrice: absent, availability: absent, inventoryQuantity: absent, bestSellerRank: absent });
    const persisted = await persistCatalogueCollection(database, { scope: title.scope, family: 'product_metadata', selectorKey: 'home-rank-title-synthetic',
      windowStart: acquiredAt, windowEnd: acquiredAt, acquiredAt, pages: 1, finalCursor: null, sourceRows: 1, parsedRows: 1, refusedRows: 0, duplicates: 0, rows: [title] });
    expect(persisted.counts.verifiedRows).toBe(1);
    await page.reload();
    await expect(rankWatch.getByRole('link', { name: 'Synthetic home product', exact: true })).toHaveAttribute('href', productHref);
    await expect(rankWatch.locator('.wa-home-rank-asin')).toHaveText(' · B0HOME0001');
    await expect(page.getByTestId('home-count-ranks')).toHaveText('1 keyword');
    await expect(page.getByLabel('Events this week', { exact: true }).getByTestId('home-count-events')).toHaveText(/^\d+ events?$/);
    const flagsCard = page.getByLabel('Flags', { exact: true });
    await expect(flagsCard.getByTestId('home-count-flags')).toHaveText(/^\d+ raised flags?$/);
    await expect(async () => {
      const hide = flagsCard.getByRole('button', { name: 'Hide Flags' });
      if (await hide.count() === 1) await hide.click();
      await expect(flagsCard.getByRole('button', { name: 'Show Flags' })).toHaveAttribute('aria-expanded', 'false', { timeout: 1_000 });
    }).toPass();
    await expect(flagsCard.locator('.wa-home-card-body')).toBeHidden();
    await page.reload();
    await expect(flagsCard.getByRole('button', { name: 'Show Flags' })).toHaveAttribute('aria-expanded', 'false');
    await expect(flagsCard.getByTestId('home-count-flags')).toHaveText(/^\d+ raised flags?$/);
    await flagsCard.getByRole('button', { name: 'Show Flags' }).click();
    await expect(flagsCard.getByRole('button', { name: 'Hide Flags' })).toHaveAttribute('aria-expanded', 'true');
    await expect(flagsCard.getByRole('group', { name: 'Filter flags' })).toBeVisible();

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

    // Synthetic observations exercise the authenticated Home reader; no provider is called.
    const insertedCampaigns = await database.sql`insert into public.campaigns
      (org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type)
      values (${state.orgId},${fixtureProfileId},'292000001','SP','Sample budget campaign','enabled',20,'daily') returning id`;
    expect(insertedCampaigns).toHaveLength(1);
    const budgetConfig = BudgetUsageConfig.parse({ apiEnabled: true, maxAgeSeconds: 3600, nearLimitPercent: 90 });
    await database.sql`insert into public.budget_usage_settings(org_id,profile_id,config)
      values (${state.orgId},${fixtureProfileId},${JSON.stringify(budgetConfig)}::jsonb)
      on conflict (profile_id) do update set config=excluded.config`;
    const campaignRows = await database.sql<{ amazon_id: string; ad_product: AdProduct; budget_type: 'daily' | 'lifetime'; currency_code: string; timezone: string }[]>`
      select c.amazon_id,c.ad_product,c.budget_type,p.currency_code,p.timezone from public.campaigns c
      join public.ad_profiles p on p.id=c.profile_id and p.org_id=c.org_id
      where c.org_id=${state.orgId} and c.profile_id=${fixtureProfileId} and c.deleted_at is null and c.state<>'archived' order by c.amazon_id`;
    const providerTime = new Date().toISOString();
    const selected = campaignRows.map((row) => ({ campaignId: row.amazon_id, adProduct: row.ad_product }));
    const observations: BudgetUsageObservation[] = campaignRows.map((row) => {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: row.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(providerTime));
      const part = (kind: string) => parts.find((value) => value.type === kind)!.value;
      const localDate = `${part('year')}-${part('month')}-${part('day')}`;
      return { orgId: state.orgId, profileId: fixtureProfileId, campaignId: row.amazon_id, adProduct: row.ad_product,
        source: 'amazon_ads_api', sourceIdentity: `home-fixture-${row.amazon_id}-${providerTime}`, currency: row.currency_code,
        budgetAmount: 20, budgetType: row.budget_type, period: row.budget_type === 'daily' ? { start: localDate, end: localDate } : null,
        usagePercent: row.amazon_id === '292000001' ? 95 : 0, providerUpdatedAt: providerTime, receivedAt: providerTime, completeness: 'complete' };
    });
    const completeRunId = randomUUID(); budgetRunIds.push(completeRunId);
    const counts = await persistBudgetUsageRun(database, { runId: completeRunId, scope: { orgId: state.orgId, profileId: fixtureProfileId },
      source: 'amazon_ads_api', receivedAt: providerTime, selected, observations, failures: [], populationComplete: true });
    expect(counts.selected).toBe(campaignRows.length);
    expect(counts.loadedRows).toBe(counts.verifiedLoadedRows);
    const screenshotDirectory = resolve('node_modules/.cache/playwright/profile-context');
    for (const mode of ['measured', 'partial', 'source-off'] as const) {
      if (mode === 'partial') {
        const runId = randomUUID(); budgetRunIds.push(runId);
        const failed = selected.find((row) => row.campaignId === '292000001')!;
        const partial = await persistBudgetUsageRun(database, { runId, scope: { orgId: state.orgId, profileId: fixtureProfileId },
          source: 'amazon_ads_api', receivedAt: new Date(Date.now() + 1).toISOString(), selected,
          observations: observations.filter((row) => row.campaignId !== failed.campaignId), failures: [{ ...failed, code: 'SYNTHETIC_FAILURE', details: null }], populationComplete: true });
        expect(partial.failed).toBe(1);
        expect(partial.sourceRows).toBe(partial.parsedRows + partial.refusedRows);
      }
      if (mode === 'source-off') await database.sql`update public.budget_usage_settings
        set config=${JSON.stringify({ ...budgetConfig, apiEnabled: false })}::jsonb where org_id=${state.orgId} and profile_id=${fixtureProfileId}`;
      await page.reload();
      const usage = page.getByLabel('Campaigns near their limit');
      if (mode === 'source-off') {
        await expect(usage).toContainText('sources are off');
        await expect(usage).not.toContainText('95% used');
      } else {
        await expect(usage).toContainText(`current usage evidence · ${mode}`);
        if (mode === 'measured') {
          await expect(usage).toContainText('95% used');
          await expect(usage).toContainText('Ads API');
          await expect(usage.locator('time').first()).toBeVisible();
        } else {
          await expect(usage.getByText('Sample budget campaign').locator('..')).toContainText('Usage not measured');
          await expect(usage).not.toContainText('95% used');
        }
      }
      const path = resolve(screenshotDirectory, `home-budget-usage-${mode}-1440x1024.png`);
      await page.screenshot({ path, fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
      await testInfo.attach(`home-budget-usage-${mode}`, { path, contentType: 'image/png' });
    }
  } finally {
    await database.sql`delete from public.budget_usage_runs where org_id=${state.orgId} and profile_id=${fixtureProfileId} and id=any(${budgetRunIds}::uuid[])`;
    await database.sql`delete from public.campaigns where org_id=${state.orgId} and profile_id=${fixtureProfileId} and amazon_id='292000001'`;
    if (originalBudgetConfig) await database.sql`update public.budget_usage_settings set config=${JSON.stringify(originalBudgetConfig.config)}::jsonb where org_id=${state.orgId} and profile_id=${fixtureProfileId}`;
    else await database.sql`delete from public.budget_usage_settings where org_id=${state.orgId} and profile_id=${fixtureProfileId}`;
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
