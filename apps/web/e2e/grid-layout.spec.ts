import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';

test('performance frame preserves measured strips across density, theme and attribution states', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await signIn(page, 'admin');
  let banner = true;
  let measurement: 'original' | 'missing' | 'zero' = 'original';
  await page.route('**/api/grid/rows?*', async (route) => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.rows = payload.rows.map((row: { dimensions: Record<string, unknown> }) => ({ ...row, dimensions: { ...row.dimensions, asin: 'B000SYN001' } }));
    if (measurement !== 'original') payload.rows = payload.rows.map((row: object) => ({ ...row,
      totals: { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 }, comparison: null,
      measurement: { missing: measurement === 'missing' ? ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] : [], comparisonMissing: [] },
    }));
    payload.performance = { ...payload.performance, unattributed: banner ? { adGroups: 3, spend: 174.25, days: 14 } : null };
    await route.fulfill({ response, json: payload });
  });
  for (const theme of ['light', 'dark']) for (const density of ['normal', 'compact']) for (const present of [true, false]) {
    banner = present;
    await page.goto('/grid?entity=targets');
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
  await page.goto('/grid?entity=targets&asin=B000SYN001');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByText('Product is B000SYN001')).toBeVisible();
  await page.getByRole('button', { name: 'Remove product scope', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('asin')).toBeNull();
  const verdict = page.locator('[data-quick-verdict="Insufficient evidence"]');
  await expect(verdict).toContainText('(1)');
  await verdict.click();
  await expect(page.getByRole('button', { name: 'Remove filter VERDICT' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV (1 of 1)', exact: true })).toBeVisible();

  await page.getByRole('button', { name: /^Columns \(/ }).click();
  await page.getByRole('button', { name: 'Performance columns', exact: true }).click();
  await page.getByRole('button', { name: 'Close controls', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Columns (26)', exact: true })).toBeVisible();
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
  await page.goto('/grid?entity=targets&from=2026-07-01&to=2026-07-14&compareFrom=2026-06-01&compareTo=2026-06-14');
  const selectedComparison = new URL((await comparisonRequest).url());
  expect(selectedComparison.searchParams.get('compareTo')).toBe('2026-06-14');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');

  measurement = 'missing';
  await page.goto('/grid?entity=targets');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  const kpiValues = page.getByTestId('grid-kpis').locator('button strong');
  await expect(kpiValues).toHaveText(Array(8).fill('—'));
  const totals = page.getByTestId('grid-scroller').getByRole('row').filter({ hasText: 'Total · 1 row' });
  await expect(totals).toHaveCount(1);
  await expect(totals).not.toContainText('$0.00');
  await expect(totals.getByRole('cell').filter({ hasText: /^0(?:\.0%|%)?$/ })).toHaveCount(0);
  await expect(totals.getByRole('cell').filter({ hasText: /^—$/ })).not.toHaveCount(0);
  measurement = 'zero';
  await page.goto('/grid?entity=targets');
  await expect(page.getByTestId('grid-data-ready')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Chart spend', exact: true }).locator('strong')).toHaveText('$0.00');
  await expect(page.getByRole('button', { name: 'Chart clicks', exact: true }).locator('strong')).toHaveText('0');
});
