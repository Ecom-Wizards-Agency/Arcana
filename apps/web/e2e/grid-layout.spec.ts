import { PerformanceVerdict, parseGridView } from '@wizard-ads/shared';
import { columnsFor } from '@wizard-ads/ui';
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { gridWarmRoutes, warmRoutes } from './support/route-warmup';

// Compile /grid and the two reads its workspace makes before either test's clock starts.
test.beforeAll(async () => {
  await warmRoutes(gridWarmRoutes((await readState()).fixtureProfileId));
});

test('performance frame preserves measured strips across density, theme and attribution states', async ({ page }, info) => {
  // Fourteen page loads and 24 full-page captures took 55 to 60 s on four
  // contended cores. The dev server writes its compile cache about 60 s after
  // the beforeAll compile, and that stall landed inside this test in three of
  // five runs: 84 to 87 s measured against the suite's 90 s.
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1024 });
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  // Measure each layout on its canonical URL; profile-context owns redirects.
  const gridQuery = new URLSearchParams({ entity: 'targets', profile: fixtureProfileId });
  const gridUrl = ['/grid', '?', gridQuery.toString()].join('');
  let banner = true;
  let measurement: 'original' | 'missing' | 'zero' | 'large' = 'original';
  await page.route('**/api/grid/rows?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.rows = payload.rows.map((row: { dimensions: Record<string, unknown> }) => ({ ...row, dimensions: { ...row.dimensions, asin: 'B000SYN001' } }));
    if (measurement !== 'original') payload.rows = payload.rows.map((row: object) => ({ ...row,
      totals: { impressions: 0, clicks: 0, spend: measurement === 'large' ? 123456789012.34 : 0, sales: 0, orders: 0, units: 0 }, comparison: null,
      measurement: { missing: measurement === 'missing' ? ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] : [], comparisonMissing: [] },
    }));
    payload.performance = { ...payload.performance, unattributed: banner ? { adGroups: 3, spend: 174.25, days: 14 } : null };
    await route.fulfill({ response, json: payload });
  });
  // The assignment read owns the reconciled banner after WP-272.
  await page.route('**/targets/product-assignments?*', async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const items = [50,60,64.25].map((spend,index) => ({ adGroupId:`synthetic-layout-${index}`, campaignId:'synthetic-campaign', name:`Synthetic group ${index}`, asins:['B000SYN001','B000SYN002'], spend, assignedAsin:banner ? null : 'B000SYN001', source:banner ? 'unassigned' : 'derived', derivedAt:'2026-09-16T00:00:00Z', derived:banner ? { asin:null, source:'unassigned' } : { asin:'B000SYN001', source:'derived' }, ambiguous:false, reason:null, candidates:[] }));
    await route.fulfill({ json: { profileId:fixtureProfileId,start:query.get('start'),end:query.get('end'),days:14,canAssign:true,items,count:3,unassignedCount:banner ? 3 : 0,unassignedSpend:banner ? 174.25 : 0 } });
  });
  for (const theme of ['light', 'dark']) for (const density of ['normal', 'compact']) for (const present of [true, false]) {
    banner = present;
    await page.goto(gridUrl);
    await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await page.getByLabel('Row density').selectOption(density);
    if (present) await expect(page.getByTestId('grid-unattributed')).toBeVisible();
    const offset = present ? 0 : -120;
    for (const [id, y, height] of [['grid-provenance', 176, 120], ['grid-kpis', 296, 100], ['grid-performance-toolbar', 396, 47], ['grid-chip-rail', 443, 33]] as const) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(Math.abs(box!.x - 240), `${id} x`).toBeLessThanOrEqual(2);
      expect(Math.abs(box!.y - (y + offset)), `${id} y`).toBeLessThanOrEqual(2);
      expect(Math.abs(box!.width - 1200), `${id} width`).toBeLessThanOrEqual(2);
      expect(Math.abs(box!.height - height), `${id} height`).toBeLessThanOrEqual(2);
    }
    const table = await page.getByTestId('grid-shell').boundingBox();
    expect(Math.abs(table!.y - (476 + offset)), 'table y').toBeLessThanOrEqual(2);
    const worktable = await page.getByTestId('grid-worktable').boundingBox();
    expect(Math.abs(worktable!.x - 240), 'worktable x').toBeLessThanOrEqual(2);
    expect(Math.abs(worktable!.width - 1200), 'worktable width').toBeLessThanOrEqual(2);
    if (present) expect(Math.abs(worktable!.height - 582), 'worktable height').toBeLessThanOrEqual(2);
    await expect(page.getByTestId('grid-unattributed')).toHaveCount(present ? 1 : 0);
    const path = info.outputPath(`targets-${theme}-${density}-banner-${present}.png`);
    await page.screenshot({ path, fullPage: true });
    await info.attach(`targets-${theme}-${density}-banner-${present}`, { path, contentType: 'image/png' });
  }
  await page.goto(`${gridUrl}&asin=B000SYN001`);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByText('Product is B000SYN001')).toBeVisible();
  await page.getByRole('button', { name: 'Remove product scope', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('asin')).toBeNull();
  await page.getByRole('button', { name: /^Filter \(/ }).click();
  const verdict = page.locator('[data-quick-verdict="Insufficient evidence"]');
  await expect(verdict.locator('[data-quick-count]')).toHaveText('1');
  await verdict.click();
  await expect(page.getByRole('button', { name: 'Remove filter VERDICT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV (1 of 1)', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Columns \(/ }).click();
  await page.getByRole('button', { name: 'Performance columns', exact: true }).click();
  await page.getByRole('button', { name: 'Close controls', exact: true }).click();
  await expect(page.getByRole('button', { name: `Columns (${columnsFor('targets').filter((column) => column.referenceOrder !== undefined).length})`, exact: true })).toBeVisible();
  const subjects = page.getByTestId('grid-subject-headers');
  for (const subject of ['RANK & ORGANIC', 'SPONSORED PRODUCTS', 'SQP', 'BRAND ANALYTICS']) await expect(subjects).toContainText(subject);
  await expect(page.locator('[data-rank-day]')).toHaveCount(14);
  const original = page.getByRole('columnheader', { name: 'Target', exact: true });
  const pinnedBefore = await original.boundingBox();
  await page.getByTestId('grid-scroller').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await expect.poll(async () => (await original.boundingBox())?.x).toBe(pinnedBefore?.x);
  await expect(page.getByTestId('grid-scroll-disclosure')).toBeVisible();
  const full = info.outputPath('targets-full-columns.png');
  await page.screenshot({ path: full, fullPage: true });
  await info.attach('targets-full-columns', { path: full, contentType: 'image/png' });

  const comparisonRequest = page.waitForRequest((request) => request.url().includes('/api/grid/rows?') && request.url().includes('compareFrom=2026-06-01'));
  await page.goto(`${gridUrl}&from=2026-07-01&to=2026-07-14&compareFrom=2026-06-01&compareTo=2026-06-14`);
  const selectedComparison = new URL((await comparisonRequest).url());
  expect(selectedComparison.searchParams.get('compareTo')).toBe('2026-06-14');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');

  measurement = 'missing';
  await page.goto(gridUrl);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  const kpiValues = page.getByTestId('grid-kpis').locator('button strong');
  await expect(kpiValues).toHaveText(Array(8).fill('—'));
  const totals = page.getByTestId('grid-scroller').getByRole('row').filter({ hasText: 'Total · 1 row' });
  await expect(totals).toHaveCount(1);
  await expect(totals).not.toContainText('$0.00');
  await expect(totals.getByRole('cell').filter({ hasText: /^0(?:\.0%|%)?$/ })).toHaveCount(0);
  await expect(totals.getByRole('cell').filter({ hasText: /^—$/ })).not.toHaveCount(0);
  measurement = 'zero';
  await page.goto(gridUrl);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Chart spend', exact: true }).locator('strong')).toHaveText('$0.00');
  await expect(page.getByRole('button', { name: 'Chart clicks', exact: true }).locator('strong')).toHaveText('0');

  measurement = 'large';
  await page.goto(gridUrl);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.wa-shell-chips')).toHaveAttribute('aria-busy', 'false');
  const capture = async (state: string) => { const path = info.outputPath(`patterns-${state}.png`); await page.screenshot({ path, fullPage: true }); await info.attach(state, { path, contentType: 'image/png' }); };
  await capture('resting');
  const clipped = page.getByTestId('grid-scroller').locator('[data-numeric-value][data-truncated=true]').first();
  await clipped.scrollIntoViewIfNeeded();
  await expect(clipped).toBeInViewport();
  await expect(clipped.locator('[data-truncation-marker]')).toBeVisible();
  await expect(clipped).toHaveAttribute('title', await clipped.getAttribute('data-numeric-value') ?? '');
  await capture('truncation');
  await page.getByTestId('grid-scroller').evaluate((element) => { element.scrollLeft = 0; });
  const picker = page.locator('.wa-topbar details.wa-date-range:not(.wa-shell-comparison)');
  await picker.locator('summary').click();
  await expect(picker.getByRole('dialog')).toBeVisible();
  await capture('date-picker');
  await picker.getByRole('button', { name: 'Custom', exact: true }).last().click();
  await picker.getByLabel('Comparison from').fill('2026-01-01');
  await picker.getByLabel('Comparison to').fill('2026-01-28');
  await expect(picker.getByRole('status')).toContainText('Totals would be compared');
  await capture('date-mismatch');
  await picker.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: /^Filter \(/ }).click();
  await expect(page.locator('[data-quick-verdict]')).toHaveCount(PerformanceVerdict.shape.diagnosis.options.length);
  await capture('quick-filters');
  await page.getByRole('button', { name: '+ Add a condition on any column' }).click();
  await expect(page.getByLabel('Filter column')).toBeVisible();
  await page.getByRole('button', { name: 'Close controls', exact: true }).click();
  await page.getByRole('button', { name: /^Columns \(/ }).click();
  const manager = page.getByRole('dialog', { name: 'Adjust columns' });
  const catalog = columnsFor('targets');
  await expect(manager.locator('input[type=checkbox]')).toHaveCount(catalog.length);
  await capture('columns');
  // WP-316 (V20): SQP and Brand Analytics are one subject in the grouped chooser.
  await manager.getByRole('button', { name: /^SQP & Brand Analytics / }).click();
  const expected = catalog.filter((column) => column.subject === 'SQP' || column.subject === 'BRAND ANALYTICS').length;
  await expect(manager.getByText('needs ingestion', { exact: true })).toHaveCount(expected);
  for (const tag of await manager.getByText('needs ingestion', { exact: true }).all()) await expect(tag).toBeVisible();
  await capture('columns-sqp-brand-analytics');
  await manager.getByRole('button', { name: /^Efficiency / }).click();
  await expect(manager.getByRole('group', { name: 'ACOS comparison columns' }).getByRole('checkbox')).toHaveCount(3);
  await capture('columns-efficiency-nested');
  await manager.getByRole('button', { name: /^All / }).click();
  const chosenBid = manager.locator('[data-chosen-column="bid"]');
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await chosenBid.dispatchEvent('dragstart', { dataTransfer: transfer });
  const pinDivider = manager.locator('[data-pin-divider="true"]');
  await pinDivider.dispatchEvent('dragover', { dataTransfer: transfer });
  await expect(manager.locator('[data-insertion-line]')).toHaveCount(1);
  await capture('columns-drag');
  await pinDivider.dispatchEvent('drop', { dataTransfer: transfer });
  await manager.getByRole('button', { name: 'Show all columns', exact: true }).click();
  await manager.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByTestId('grid-scroller').evaluate((element) => { element.scrollLeft = 0; });
  const legend = page.getByRole('button', { name: 'SIGNALS legend', exact: true });
  await legend.focus(); await legend.press('Enter');
  await expect(page.getByRole('dialog', { name: 'SIGNALS legend' })).toBeVisible();
  await capture('signals-legend');
  await legend.press('Escape');
  await expect(legend).toBeFocused();
  const campaign = page.getByRole('columnheader', { name: 'Campaign', exact: true });
  await campaign.dispatchEvent('dragstart', { dataTransfer: transfer });
  const zone = page.getByTestId('grid-group-bar');
  await expect(zone).toBeVisible();
  await capture('grouping-drag');
  await zone.dispatchEvent('drop', { dataTransfer: transfer });
  await page.getByLabel('Add grouping level').selectOption('match_type');
  await expect(page.getByTestId('grid-group-chip')).toHaveCount(2);
  await capture('grouping-two-levels');
  await expect(page.locator('[data-share-bar]').first()).toBeVisible();
  await expect(page.locator('[data-group-share]')).toHaveText(['100%', '100%']);
  for (const share of await page.locator('[data-group-share]').all()) await expect(share.getByText('100%', { exact: true })).toBeInViewport({ ratio: 1 });
  await capture('grouped-result');
  measurement = 'zero';
  await page.reload();
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('[data-group-share]')).toHaveText(['—', '—']);
  await expect(page.locator('.wa-shell-chips')).toHaveAttribute('aria-busy', 'false');
  await capture('grouped-zero-total');
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await capture('grouping-collapsed');
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page.getByRole('button', { name: 'Remove grouping level Campaign', exact: true }).click();
  await page.getByRole('button', { name: 'Remove grouping level Match', exact: true }).click();

});

test('ASIN scope follows removal, same-value reselection and browser back and forward', async ({ page }) => {
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  const rows = ['B000SYN001', 'B000SYN002'].map((asin, index) => ({ id: `target:scope-${index}`, currencyCode: 'USD',
    dimensions: { asin, target_id: `scope-${index}`, targeting: `Synthetic scope ${index}`, target_state: 'enabled', match_type: 'exact', verdict: 'Insufficient evidence' },
    totals: { spend: 10, sales: 20, impressions: 100, clicks: 5, orders: 1, units: 1 }, comparison: null,
  }));
  await page.route('**/api/grid/rows?*', (route) => route.fulfill({ json: { rows, rowCount: rows.length, truncated: false } }));
  // Open the canonical URL like the layout test; profile-context owns the redirect.
  // Without a profile the redirect streams from the page body: goto settled on the
  // first document while the second was still loading. The workspace is ready only
  // after its saved-view read, so wait for that read before the 15 s expectations.
  const views = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname === '/grid/views');
  await page.goto(`/grid?${new URLSearchParams({ entity: 'targets', profile: fixtureProfileId, asin: 'B000SYN001' })}`);
  expect((await views).status()).toBe(200);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  const scope = page.getByRole('button', { name: 'Remove product scope', exact: true });
  const assertScope = async (scoped: boolean) => {
    await expect(scope).toHaveCount(scoped ? 1 : 0);
    await expect(page.getByRole('button', { name: scoped ? 'Export CSV (1 of 1)' : 'Export CSV (2 of 2)', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('asin')).toBe(scoped ? 'B000SYN001' : null);
  };
  await assertScope(true);
  await scope.click();
  await assertScope(false);
  await page.evaluate(() => {
    const url = new URL(window.location.href); url.searchParams.set('asin', 'B000SYN001');
    window.history.pushState(null, '', url);
  });
  await assertScope(true);
  await page.goBack();
  await assertScope(false);
  await page.goForward();
  await assertScope(true);
});

// One browser state per assignment source, each with its screenshot under the test output directory.
for (const source of ['derived', 'derived_parent', 'proposed', 'manual', 'unassigned'] as const) {
  test(`product assignment ${source} state`, async ({ page }, testInfo) => {
    await signIn(page, 'admin');
    const { fixtureProfileId } = await readState();
    const unresolved = source === 'proposed' || source === 'unassigned';
    const assignedAsin = source === 'unassigned' ? null : source === 'derived_parent' ? 'B000000099' : 'B000000001';
    await page.route('**/targets/product-assignments?**', async (route) => {
      const params = new URL(route.request().url()).searchParams;
      const start = params.get('start')!, end = params.get('end')!;
      const candidates = ['B000000001', 'B000000002'].map((asin, index) => ({ asin, skus: [], parentAsin: null, spend: index ? 5 : 20 }));
      await route.fulfill({ json: { profileId: fixtureProfileId, start, end, days: Math.round((Date.parse(end)-Date.parse(start))/86400000)+1,
        canAssign: true, count: 1, unassignedCount: unresolved ? 1 : 0, unassignedSpend: unresolved ? 25 : 0,
        items: [{ adGroupId: 'synthetic-state', campaignId: 'synthetic-campaign', name: 'Synthetic assignment',
          asins: candidates.map((candidate) => candidate.asin), assignedAsin, source, derivedAt: '2026-09-16T00:00:00Z',
          derived: source === 'manual' ? { asin: 'B000000099', source: 'derived_parent' } : { asin: assignedAsin, source },
          ambiguous: source === 'proposed', reason: source === 'unassigned' ? 'No enabled or paused product ads.' : source === 'proposed' ? 'Products do not share a known parent; review the highest-spend candidate.' : null,
          candidates: source === 'proposed' ? candidates : [], spend: 25 }],
      } });
    });
    await page.goto(`/grid?entity=targets&profile=${fixtureProfileId}`);
    const banner = page.getByTestId('grid-unattributed');
    await expect(page.getByRole('button', { name: unresolved ? 'Link them' : 'Product assignments', exact: true })).toBeVisible();
    await expect(banner).toHaveCount(unresolved ? 1 : 0);
    if (unresolved) {
      await expect(banner).toContainText('1 ad group needs a product check · $25.00 of spend over');
      await expect(banner).toContainText('so proposed groups rest on a guess and unassigned groups show none');
    }
    await page.getByRole('button', { name: unresolved ? 'Link them' : 'Product assignments', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Assign products to ad groups' });
    await expect(dialog.getByTestId('product-assignment-row')).toHaveCount(1);
    await expect(dialog.locator(`[data-assignment-source="${source}"]`)).toBeVisible();
    await expect(dialog.getByRole('combobox')).toHaveCount(unresolved ? 1 : 0);
    await expect(dialog.getByRole('button', { name: 'Save assignment' })).toHaveCount(unresolved ? 1 : 0);
    await expect(dialog.getByRole('button', { name: 'Revert to derived' })).toHaveCount(source === 'manual' ? 1 : 0);
    if (source === 'manual') await expect(dialog).toContainText('Derived: B000000099 (derived parent)');
    if (source === 'proposed') await expect(dialog.getByRole('list', { name: 'Assignment candidates' }).getByRole('listitem')).toHaveCount(2);
    const path = testInfo.outputPath(`product-assignment-${source}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`product-assignment-${source}`, { path, contentType: 'image/png' });
  });
}

test('table readability: codes read as words, a partial selection shows, the legend stays compact and a dragged edge persists', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await signIn(page, 'admin');
  const { fixtureProfileId } = await readState();
  const totals = { impressions: 100, clicks: 5, spend: 10, sales: 40, orders: 1, units: 1 };
  const target = (index: number, targeting: string, kind: string, matchType: string) => ({ id: `target:readable-${index}`, currencyCode: 'USD', totals, comparison: null,
    dimensions: { target_id: `readable-${index}`, targeting, target_kind: kind, match_type: matchType, target_state: 'enabled', campaign_name: 'Synthetic campaign', verdict: 'Insufficient evidence', not_the_query: kind !== 'keyword' } });
  const rows = [target(0, 'synthetic readable phrase', 'keyword', 'exact'), target(1, 'QUERY_HIGH_REL_MATCHES', 'target', 'close_match'), target(2, 'ASIN_SAME_AS="B000SYN009"', 'target', 'asin_same_as')];
  await page.route('**/api/grid/rows?*', (route) => route.fulfill({ json: { rows, rowCount: rows.length, truncated: false } }));
  await page.goto(`/grid?entity=targets&profile=${fixtureProfileId}`);
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  const grid = page.getByTestId('grid-scroller');
  const capture = async (state: string) => { const path = info.outputPath(`readability-${state}.png`); await page.screenshot({ path, fullPage: true }); await info.attach(state, { path, contentType: 'image/png' }); };

  // Codes read as words (V19, D3, D6).
  await expect(grid.getByRole('link', { name: 'Close match', exact: true })).toBeVisible();
  await expect(grid.getByRole('link', { name: 'Product: B000SYN009', exact: true })).toBeVisible();
  for (const code of ['QUERY_HIGH_REL_MATCHES', 'ASIN_SAME_AS', 'close_match', 'asin_same_as', 'not the query']) await expect(grid).not.toContainText(code);
  await expect(grid.getByText('Many searches', { exact: true })).toHaveCount(2);

  // Select-all shows none, some and all, whole inside its column (J4).
  const all = grid.getByRole('checkbox', { name: 'Select all 3 matching rows', exact: true });
  await expect(all).toHaveAttribute('data-selection-state', 'none');
  const column = (await page.getByRole('columnheader', { name: 'Select', exact: true }).boundingBox())!;
  const box = (await all.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(column.x);
  expect(box.x + box.width).toBeLessThanOrEqual(column.x + column.width);
  await grid.getByRole('checkbox', { name: 'Select Close match in Synthetic campaign', exact: true }).check();
  await expect(all).toHaveAttribute('aria-checked', 'mixed');
  expect(await all.evaluate((input) => (input as HTMLInputElement).indeterminate)).toBe(true);
  await capture('partial-selection');
  await all.click();
  await expect(all).toHaveAttribute('data-selection-state', 'all');

  // The legend opens on request only, compact, and a press outside dismisses it (V23).
  const legend = page.getByRole('button', { name: 'SIGNALS legend', exact: true });
  await legend.hover();
  await expect(page.getByRole('dialog', { name: 'SIGNALS legend' })).toHaveCount(0);
  await legend.click();
  const popover = page.getByRole('dialog', { name: 'SIGNALS legend' });
  await expect(popover).toBeVisible();
  expect((await popover.boundingBox())!.width).toBeLessThanOrEqual(320);
  await capture('compact-legend');
  await page.getByTestId('grid-scroll-disclosure').click({ position: { x: 4, y: 4 } });
  await expect(popover).toHaveCount(0);

  // A real pointer drag on the visible edge resizes; it never becomes a header drag (V4).
  await page.evaluate(() => { (window as unknown as { headerDrags: number }).headerDrags = 0; document.addEventListener('dragstart', () => { (window as unknown as { headerDrags: number }).headerDrags += 1; }, true); });
  const spend = page.getByRole('columnheader', { name: 'Spend', exact: true });
  const before = Math.round((await spend.boundingBox())!.width);
  const edge = (await spend.getByRole('separator', { name: 'Resize Spend', exact: true }).boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 30, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.move(edge.x + edge.width / 2 + 60, edge.y + edge.height / 2, { steps: 6 });
  await capture('resizing');
  await page.mouse.up();
  expect(await page.evaluate(() => (window as unknown as { headerDrags: number }).headerDrags)).toBe(0);
  await expect.poll(async () => Math.round((await spend.boundingBox())!.width)).toBe(before + 60);
  await expect.poll(() => parseGridView(new URL(page.url()).searchParams.get('view'))?.widths['spend']).toBe(before + 60);
  await page.reload();
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => Math.round((await page.getByRole('columnheader', { name: 'Spend', exact: true }).boundingBox())!.width)).toBe(before + 60);
});
