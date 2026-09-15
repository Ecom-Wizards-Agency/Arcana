import { PerformanceVerdict } from '@wizard-ads/shared';
import { columnsFor } from '@wizard-ads/ui';
import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('performance frame preserves measured strips across density, theme and attribution states', async ({ page }, info) => {
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
  for (const theme of ['light', 'dark']) for (const density of ['normal', 'compact']) for (const present of [true, false]) {
    banner = present;
    await page.goto(gridUrl);
    await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
    await page.evaluate((value) => document.documentElement.setAttribute('data-theme', value), theme);
    await page.getByLabel('Row density').selectOption(density);
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
  await expect(verdict).toContainText('(1)');
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
  await capture('grouped-result');
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await capture('grouping-collapsed');
  await page.getByRole('button', { name: 'Expand all', exact: true }).click();
  await page.getByRole('button', { name: 'Remove grouping level Campaign', exact: true }).click();
  await page.getByRole('button', { name: 'Remove grouping level Match', exact: true }).click();

});

test('ASIN scope follows removal, same-value reselection and browser back and forward', async ({ page }) => {
  await signIn(page, 'admin');
  const rows = ['B000SYN001', 'B000SYN002'].map((asin, index) => ({ id: `target:scope-${index}`, currencyCode: 'USD',
    dimensions: { asin, target_id: `scope-${index}`, targeting: `Synthetic scope ${index}`, target_state: 'enabled', match_type: 'exact', verdict: 'Insufficient evidence' },
    totals: { spend: 10, sales: 20, impressions: 100, clicks: 5, orders: 1, units: 1 }, comparison: null,
  }));
  await page.route('**/api/grid/rows?*', (route) => route.fulfill({ json: { rows, rowCount: rows.length, truncated: false } }));
  await page.goto('/grid?entity=targets&asin=B000SYN001');
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
