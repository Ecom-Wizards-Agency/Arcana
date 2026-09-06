/** Ordered nested grouping through the real session guard and production grid model. */
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { applyRequestedCpuThrottle } from './support/cpu-throttle';
import { expectDateRangePresets } from './support/date-range';
import { readState } from './support/fixture';

test.beforeEach(async ({ page }) => applyRequestedCpuThrottle(page));

test('grid restores the matching saved filter, grouping, and sort before becoming interactive', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  const savedLayout = {
    id: 'saved-campaign-layout',
    name: 'Saved campaign layout',
    entity: 'campaigns',
    columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
    pinned: ['campaign_name'],
    widths: { campaign_name: 280 },
    filter: {
      groups: [{ filters: [{ key: 'CAMPAIGN_ID', conditions: [{ operator: '=', values: ['c-1'] }] }] }],
    },
    sort: [{ columnId: 'clicks', direction: 'asc' }],
    groupBy: ['campaign_state'],
    dateRange: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
  await page.addInitScript(
    ({ key, value }) => window.localStorage.setItem(key, value),
    {
      key: 'wizard-ads:layout:v1',
      value: JSON.stringify({ campaigns: savedLayout }),
    },
  );

  // Hold hydration so the server-rendered data boundary is observable without
  // timing guesses. Releasing the promise lets the real Next chunks fetch the
  // complete rows and restore the saved layout before exposing controls.
  let releaseChunks = (): void => {};
  const chunksReleased = new Promise<void>((resolve) => {
    releaseChunks = resolve;
  });
  await page.route(/\/_next\/static\/chunks\/.*\.js(?:\?.*)?$/, async (route) => {
    await chunksReleased;
    await route.continue();
  });

  const gridQuery = new URLSearchParams({ profile: fixtureProfileId, entity: 'campaigns' });
  await page.goto(`/grid?${gridQuery.toString()}`, { waitUntil: 'commit' });
  try {
    await expect(page.getByTestId('grid-data-loading')).toBeVisible();
    await expect(page.getByTestId('grid-data-ready')).toHaveCount(0);
    await expect(page.getByTestId('grid-scroller')).toHaveCount(0);
    await expect(page.getByTestId('grid-start-experiment')).toHaveCount(0);
    const preReadyLayout = await page.evaluate(() => {
      const raw = window.localStorage.getItem('wizard-ads:layout:v1');
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as {
        campaigns?: { filter?: unknown; groupBy?: unknown; sort?: unknown };
      };
      return parsed.campaigns ?? null;
    });
    expect(preReadyLayout).toMatchObject({
      filter: savedLayout.filter,
      groupBy: savedLayout.groupBy,
      sort: savedLayout.sort,
    });
  } finally {
    releaseChunks();
  }

  const workspace = page.getByTestId('grid-data-ready');
  await expect(workspace).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('treegrid', { name: 'Results grouped by campaign_state' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'Clicks' })).toHaveAttribute('aria-sort', 'ascending');
  const restoredFilter = page.getByRole('button', { name: 'Remove filter CAMPAIGN_ID' }).locator('..');
  await expect(restoredFilter).toContainText('Campaign ID equals c-1');
  const restoredLevels = page.getByRole('list', { name: 'Ordered grouping levels' });
  await expect(restoredLevels.getByRole('listitem')).toHaveCount(1);
  await expect(restoredLevels.getByRole('listitem')).toContainText('State');
  await expect(page.getByTestId('grid-start-experiment')).toHaveAttribute('href', /campaigns=c-1/);

  await page.getByRole('columnheader', { name: 'Spend' }).click();
  await expect(page.getByRole('columnheader', { name: 'Spend' })).toHaveAttribute('aria-sort', 'descending');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('wizard-ads:layout:v1');
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as { campaigns?: { sort?: unknown } };
        return parsed.campaigns?.sort ?? null;
      }),
    )
    .toEqual([{ columnId: 'spend', direction: 'desc' }]);
});

test('grid adds, reorders, and removes truthful nested grouping levels', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/grid?entity=campaigns');
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  // The complete row payload and saved layout must both be ready before an
  // early date-range or grouping change can be accepted.
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expectDateRangePresets(page);

  const addLevel = page.getByLabel('Add grouping level');
  await addLevel.selectOption({ label: 'State' });
  await addLevel.selectOption({ label: 'Ad type' });
  await addLevel.selectOption({ label: 'Campaign' });

  const tree = page.getByRole('treegrid');
  await expect(tree).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="1"]').first()).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="2"]').first()).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="3"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV \(1 deepest group\)/ })).toBeVisible();

  const levels = page.getByRole('list', { name: 'Ordered grouping levels' });
  await expect(levels.getByRole('listitem')).toHaveCount(3);
  await page.getByRole('button', { name: 'Move Campaign up' }).click();
  await expect(levels.getByRole('listitem').nth(1)).toContainText('Campaign');
  await page.getByRole('button', { name: 'Remove grouping level Ad type' }).click();
  await expect(levels.getByRole('listitem')).toHaveCount(2);
});

test('grid selects every categorical value, filters exact rows, and restores the saved selection', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/grid?entity=campaigns');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');

  const column = page.getByLabel('Filter column');
  const operator = page.getByLabel('Filter operator');
  await column.selectOption('AD_PRODUCT');
  await expect(operator.locator('option')).toHaveText(['is one of', 'is not one of']);

  const valuesButton = page.getByRole('button', { name: 'Filter values', exact: true });
  await valuesButton.click();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(valuesButton).toContainText('1 selected');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  const adTypeChip = page.getByRole('button', { name: 'Remove filter AD_PRODUCT' }).locator('..');
  await expect(adTypeChip).toContainText('Ad type is one of SP');
  await expect(page.getByRole('button', { name: 'Export CSV (1 of 1)' })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Remove filter AD_PRODUCT' }).locator('..')).toContainText(
    'Ad type is one of SP',
  );

  await column.selectOption('BUDGET_AMOUNT');
  expect(await operator.locator('option').allTextContents()).not.toContain('is one of');
  await column.selectOption('CAMPAIGN_ID');
  await expect(operator.locator('option')).toHaveText([
    'contains',
    'does not contain',
    'equals',
    'does not equal',
  ]);
});

test('grid sorts on a header click, groups by dragging headers into the group bar, and persists density', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/grid?entity=campaigns');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');

  // The workspace is full width and the grid fills its viewport container
  // rather than a fixed box.
  const viewport = page.getByTestId('grid-viewport');
  const viewportBox = await viewport.boundingBox();
  const contentBox = await page.locator('main').boundingBox();
  expect(viewportBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(viewportBox!.width).toBeGreaterThanOrEqual(contentBox!.width - 2);
  await expect(page.getByTestId('grid-scroller')).not.toHaveCSS('height', '620px');

  // Click-to-sort: first click descending, second ascending, shift-click nests a second key.
  const clicks = page.getByRole('columnheader', { name: 'Clicks', exact: true });
  await clicks.click();
  await expect(clicks).toHaveAttribute('aria-sort', 'descending');
  await clicks.click();
  await expect(clicks).toHaveAttribute('aria-sort', 'ascending');
  await page.getByRole('columnheader', { name: 'Spend', exact: true }).click({ modifiers: ['Shift'] });
  await expect(clicks).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.getByRole('columnheader', { name: 'Spend', exact: true })).toHaveAttribute('aria-sort', 'descending');

  // Drag a header into the group bar, then drag a second header to nest it.
  const bar = page.getByTestId('grid-group-bar');
  await expect(bar).toContainText('Drag a column header here');
  await page.getByRole('columnheader', { name: 'State', exact: true }).dragTo(bar);
  const levels = page.getByRole('list', { name: 'Ordered grouping levels' });
  await expect(levels.getByRole('listitem')).toHaveCount(1);
  await expect(levels.getByRole('listitem').first()).toContainText('State');
  await expect(page.getByRole('treegrid', { name: 'Results grouped by campaign_state' })).toBeVisible();

  await page.getByRole('columnheader', { name: 'Ad type', exact: true }).dragTo(bar);
  await expect(levels.getByRole('listitem')).toHaveCount(2);
  await expect(levels.getByRole('listitem').nth(1)).toContainText('Ad type');
  const tree = page.getByRole('treegrid', { name: 'Results grouped by campaign_state, ad_product' });
  await expect(tree).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="1"]').first()).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="2"]').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV \(1 deepest group\)/ })).toBeVisible();

  // Density persists with the layout, so it survives a reload.
  await page.getByLabel('Row density').selectOption('compact');
  await expect(page.getByTestId('grid-shell')).toHaveAttribute('data-density', 'compact');
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem('wizard-ads:layout:v1');
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as { campaigns?: { density?: unknown; groupBy?: unknown } };
        return parsed.campaigns ?? null;
      }),
    )
    .toMatchObject({ density: 'compact', groupBy: ['campaign_state', 'ad_product'] });
  await page.reload();
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('grid-shell')).toHaveAttribute('data-density', 'compact');
  await expect(page.getByLabel('Row density')).toHaveValue('compact');
});

/**
 * WP-24 ordered a tile row and a trend chart above this grid and never got
 * them. They are here now, and they are streamed: the document that carries
 * the grid workspace does not wait for the profile-daily query behind them,
 * because the rows the operator came for are fetched by the browser over
 * `/api/grid/rows` and cannot start until that document has arrived.
 */
test('grid carries the performance tiles and trend above the rows, streamed outside the row path', async ({
  page,
}) => {
  await signIn(page, 'admin');
  const rowRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/grid/rows') rowRequests.push(request.url());
  });
  await page.goto('/grid?entity=campaigns');

  const cockpit = page.getByRole('region', { name: 'Performance cockpit' });
  await expect(cockpit).toBeVisible();
  await expect(cockpit.getByRole('heading', { name: 'Performance trend' })).toBeVisible();
  await expect(cockpit.locator('.wa-cockpit__tile')).not.toHaveCount(0);

  // Above the grid, not beside or below it, and the rows still arrive.
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  const cockpitBox = await cockpit.boundingBox();
  const gridBox = await page.getByTestId('grid-viewport').boundingBox();
  expect(cockpitBox).not.toBeNull();
  expect(gridBox).not.toBeNull();
  expect(cockpitBox!.y + cockpitBox!.height).toBeLessThanOrEqual(gridBox!.y);
  await expect(page.getByTestId('grid-scroller')).toBeVisible();

  // The tiles and the chart are a second read on the same page and they cost
  // the rows nothing: the browser still makes exactly the one row request the
  // boundary is measured on.
  expect(rowRequests).toHaveLength(1);
});

/**
 * The operator's 2026-09-05 recording, on the surface it was recorded on.
 *
 * Scroll the whole campaign list, sort by spend, drag a header into the group
 * bar, nest a second level, then select campaigns across a filter and confirm
 * the count. The last step is the one WP-195 built and this conversion had to
 * keep: the header checkbox owns the complete filtered eligible population, not
 * the rows the virtualizer happens to have rendered, and narrowing or widening
 * the filter never touches what is already selected.
 *
 * The campaigns are seeded here rather than in global setup, on a window far
 * outside the `/grid` default period, so this test cannot change what the
 * earlier `/grid` assertions in this file see whatever order they run in.
 */
const OPTIMIZER_CAMPAIGN_COUNT = 40;
const OPTIMIZER_ENABLED_COUNT = 30;
const OPTIMIZER_PREFIX = 'WP209 Optimizer Campaign';
const OPTIMIZER_WINDOW = optimizerWindow();

test('optimizer scrolls the whole campaign list, sorts by spend, nests dragged grouping levels, and keeps a filtered selection', async ({
  page,
}) => {
  const { fixtureProfileId } = await readState();
  await seedOptimizerCampaigns();
  await signIn(page, 'admin');
  const query = new URLSearchParams({
    profile: fixtureProfileId,
    from: OPTIMIZER_WINDOW.start,
    to: OPTIMIZER_WINDOW.end,
  });
  await page.goto(`/optimizer?${query.toString()}`);
  await expect(page.getByRole('heading', { name: 'Campaign Optimizer', exact: true })).toBeVisible();

  // Full width, and no pagination anywhere: the whole set is one scroller.
  const viewport = page.getByTestId('grid-viewport');
  const viewportBox = await viewport.boundingBox();
  const contentBox = await page.locator('main').boundingBox();
  expect(viewportBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(viewportBox!.width).toBeGreaterThanOrEqual(contentBox!.width - 2);
  await expect(page.getByRole('button', { name: 'Next →', exact: true })).toHaveCount(0);
  await expect(page.getByText(/\d+–\d+ of \d+/)).toHaveCount(0);
  const shown = page.locator('.wa-optimizer-campaigns__shown');
  await expect(shown).toHaveText(`${OPTIMIZER_CAMPAIGN_COUNT + 1} campaigns`);

  // Scroll the whole list. Spend descending is the default order, so the
  // cheapest seeded campaign only exists at the far end of the scroller.
  const scroller = page.getByTestId('grid-scroller');
  const rows = page.getByTestId('grid-row');
  await expect(rows.first()).toContainText(optimizerCampaignName(OPTIMIZER_CAMPAIGN_COUNT));
  await expect(page.getByText(optimizerCampaignName(1), { exact: true })).toHaveCount(0);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.getByText(optimizerCampaignName(1), { exact: true })).toBeVisible();

  // Sort by spend: click for ascending (it starts descending), click back.
  const spend = page.getByRole('columnheader', { name: 'Spend', exact: true });
  await expect(spend).toHaveAttribute('aria-sort', 'descending');
  await spend.click();
  await expect(spend).toHaveAttribute('aria-sort', 'ascending');
  // Re-sorting returns the scroller to the top, so the cheapest campaigns are
  // now the rendered ones and the most expensive is off-screen entirely.
  await expect(page.getByText(optimizerCampaignName(1), { exact: true })).toBeVisible();
  await expect(page.getByText(optimizerCampaignName(OPTIMIZER_CAMPAIGN_COUNT), { exact: true }))
    .toHaveCount(0);
  // Third state of the header cycle: descending, ascending, then no key at all.
  await spend.click();
  await expect(spend).toHaveAttribute('aria-sort', 'none');
  await spend.click();
  await expect(spend).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first()).toContainText(optimizerCampaignName(OPTIMIZER_CAMPAIGN_COUNT));

  // The selection and action columns never advertise an ordering.
  await expect(page.getByRole('columnheader', { name: 'Select', exact: true }))
    .not.toHaveAttribute('aria-sort', /.*/);
  await expect(page.getByRole('columnheader', { name: 'Recommendation', exact: true }))
    .not.toHaveAttribute('aria-sort', /.*/);

  // Drag a header into the group bar, then drag a second to nest it.
  const bar = page.getByTestId('grid-group-bar');
  await expect(bar).toContainText('Drag a column header here');
  await page.getByRole('columnheader', { name: 'State', exact: true }).dragTo(bar);
  const levels = page.getByRole('list', { name: 'Ordered grouping levels' });
  await expect(levels.getByRole('listitem')).toHaveCount(1);
  await expect(page.getByRole('treegrid', { name: 'Results grouped by campaign_state' })).toBeVisible();

  await page.getByRole('columnheader', { name: 'Bid strategy', exact: true }).dragTo(bar);
  await expect(levels.getByRole('listitem')).toHaveCount(2);
  await expect(levels.getByRole('listitem').nth(1)).toContainText('Bid strategy');
  const tree = page.getByRole('treegrid', { name: 'Results grouped by campaign_state, bidding_strategy' });
  await expect(tree).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="1"]').first()).toBeVisible();
  await expect(tree.locator('[role="row"][aria-level="2"]').first()).toBeVisible();

  // Back to the flat list, which is where selection lives.
  await page.getByRole('button', { name: 'Remove grouping level Bid strategy' }).click();
  await page.getByRole('button', { name: 'Remove grouping level State' }).click();
  await expect(levels.getByRole('listitem')).toHaveCount(0);

  // Select across a filter: the header owns every filtered eligible campaign,
  // and widening the filter afterwards keeps every one of them selected.
  const search = page.getByRole('search', { name: 'Filter optimizer campaigns' });
  await search.getByLabel('Find campaign').fill(OPTIMIZER_PREFIX);
  await expect(shown).toHaveText(`${OPTIMIZER_CAMPAIGN_COUNT} of ${OPTIMIZER_CAMPAIGN_COUNT + 1} campaigns`);
  const selectFiltered = page.getByTestId('optimizer-select-filtered');
  await expect(selectFiltered).toHaveAccessibleName(
    `Select all ${OPTIMIZER_ENABLED_COUNT} eligible campaigns matching current filters`,
  );
  await selectFiltered.check();
  await expect(page.getByTestId('optimizer-selection-count')).toContainText(
    `${OPTIMIZER_ENABLED_COUNT} campaigns selected`,
  );

  await search.getByLabel('Find campaign').fill('');
  await expect(shown).toHaveText(`${OPTIMIZER_CAMPAIGN_COUNT + 1} campaigns`);
  await expect(page.getByTestId('optimizer-selection-count')).toContainText(
    `${OPTIMIZER_ENABLED_COUNT} campaigns selected`,
  );
  await expect(selectFiltered).toHaveJSProperty('indeterminate', true);
  await expect(page.getByRole('radio', { name: `Selected campaigns (${OPTIMIZER_ENABLED_COUNT})`, exact: true }))
    .toBeChecked();
});

function optimizerCampaignId(index: number): string {
  return `wp209-optimizer-campaign-${String(index).padStart(2, '0')}`;
}

function optimizerCampaignName(index: number): string {
  return `${OPTIMIZER_PREFIX} ${String(index).padStart(2, '0')}`;
}

/**
 * A single day in the month after this one: inside the pre-created fact
 * partitions (`app.ensure_fact_partitions` opens the current month and two
 * ahead) and outside the default 30-day window every other test on this
 * fixture reads, so these campaigns carry spend here and nowhere else. The
 * same choice `grid-performance.spec.ts` makes, for the same two reasons.
 */
function optimizerWindow(): { start: string; end: string } {
  const now = new Date();
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 15))
    .toISOString()
    .slice(0, 10);
  return { start: day, end: day };
}

async function seedOptimizerCampaigns(): Promise<void> {
  const state = await readState();
  const database = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    const campaigns = Array.from({ length: OPTIMIZER_CAMPAIGN_COUNT }, (_, offset) => {
      const position = offset + 1;
      return {
        amazon_id: optimizerCampaignId(position),
        name: optimizerCampaignName(position),
        state: position <= OPTIMIZER_ENABLED_COUNT ? 'enabled' : 'paused',
        bidding_strategy: position % 2 === 0 ? 'manual' : 'auto_for_sales',
        spend: position,
      };
    });
    const inserted = await database.sql<{ amazon_id: string }[]>`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type,
         bidding_strategy, start_date)
      select ${state.orgId}, ${state.fixtureProfileId}, offered.amazon_id,
             'SP'::public.ad_product, offered.name, offered.state::public.entity_state,
             25.00, 'daily'::public.budget_type,
             offered.bidding_strategy::public.bidding_strategy, ${OPTIMIZER_WINDOW.start}::date
        from jsonb_to_recordset(${JSON.stringify(campaigns)}::jsonb) as offered(
          amazon_id text,
          name text,
          state text,
          bidding_strategy text
        )
      returning amazon_id
    `;
    expect(inserted).toHaveLength(OPTIMIZER_CAMPAIGN_COUNT);

    const facts = await database.sql<{ campaign_id: string }[]>`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d,
         units_sold_7d)
      select ${state.orgId}, ${state.fixtureProfileId}, ${OPTIMIZER_WINDOW.start}::date, 'SP',
             offered.amazon_id, 'wp209-ad-group', 'wp209-target',
             'keyword'::public.target_kind, 'exact'::public.match_type,
             offered.spend::int * 100, offered.spend::int * 4, offered.spend::numeric,
             2, offered.spend::numeric * 4, 2
        from jsonb_to_recordset(${JSON.stringify(campaigns)}::jsonb) as offered(
          amazon_id text,
          spend int
        )
      returning campaign_id
    `;
    expect(facts).toHaveLength(OPTIMIZER_CAMPAIGN_COUNT);
  } finally {
    await database.close();
  }
}
