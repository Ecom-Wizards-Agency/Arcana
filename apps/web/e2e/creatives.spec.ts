import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { CREATIVE_ASSETS, CREATIVE_CAMPAIGN_ID, CREATIVE_NAMES, seedCreativeWorkspace } from './support/creative-fixture';
import { captureCreativeStates } from './support/creative-screenshots';

test('creative workspace preserves selection, filters, evidence and detail routes', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const state = await readState();
  const period = await seedCreativeWorkspace(state);
  const db = createDb({ connectionString: state.connectionString });
  try {
    const updated = await db.sql`update public.creative_assets set url='https://example.test/expired-creative-thumbnail.png'
      where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and amazon_asset_id=${CREATIVE_ASSETS[0]} returning id`;
    expect(updated).toHaveLength(1);
  } finally { await db.close(); }
  await page.route('https://example.test/expired-creative-thumbnail.png', (route) => route.fulfill({ status: 403, body: 'Expired synthetic thumbnail' }));
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1024 });
  const query = new URLSearchParams({ profile: state.fixtureProfileId, ...period });
  await page.goto(`/creative?${query}`);
  await expect(page.getByTestId('creative-screen')).toBeVisible();
  await expect(page.getByRole('button', { name: /Open in-depth/ })).toBeDisabled();
  await expect(page.getByText('Destination not decided', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /View on Amazon/ })).toBeDisabled();
  await expect(page.getByText('No ASIN on this asset', { exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: `${CREATIVE_NAMES[0]}: Thumbnail expired or unavailable` }).first()).toBeVisible();
  const overflowingFallbacks = await page.getByRole('img', { name: `${CREATIVE_NAMES[0]}: Thumbnail expired or unavailable` }).evaluateAll((tiles) => tiles
    .filter((tile) => tile.scrollWidth > tile.clientWidth + 1 || tile.scrollHeight > tile.clientHeight + 1)
    .map((tile) => ({ text: tile.textContent, width: tile.clientWidth, height: tile.clientHeight })));
  expect(overflowingFallbacks, 'Expired thumbnail labels fit every tile').toEqual([]);
  const expiredScreenshot = testInfo.outputPath('creative-expired-thumbnail-persisted.png');
  await page.screenshot({ path: expiredScreenshot, fullPage: true, animations: 'disabled' });
  await testInfo.attach('Expired creative thumbnail', { path: expiredScreenshot, contentType: 'image/png' });
  await page.getByText('Sync evidence', { exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sync status →', exact: true })).toHaveAttribute('href', `/sync-status?profile=${state.fixtureProfileId}`);
  await page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[1]) }).click();
  await expect(page).toHaveURL(new RegExp(`asset=${CREATIVE_ASSETS[1]}`));
  await page.reload();
  await expect(page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[1]) })).toHaveAttribute('aria-pressed', 'true');
  const list = page.getByRole('complementary', { name: 'Creative list' });
  await list.getByLabel('Find creative').fill('no-matching-synthetic-cut');
  await expect(list.getByText('No creative rows match these filters.')).toBeVisible();
  await list.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[0]) })).toBeVisible();
  await list.getByRole('combobox', { name: /^Attribution/ }).selectOption('legacy');
  await expect(page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[0]) })).toHaveCount(0);
  await list.getByRole('combobox', { name: /^Attribution/ }).selectOption('all');
  await list.getByRole('combobox', { name: /^Campaign type/ }).selectOption('SB');
  await list.getByRole('combobox', { name: /^Sort by/ }).selectOption('spend_desc');
  await list.getByText('Attribution key', { exact: true }).click();
  await expect(list.getByText(/historical/i).first()).toBeVisible();
  await page.getByRole('button', { name: new RegExp(CREATIVE_NAMES[0]) }).click();
  for (const tab of ['Keywords', 'Spend', 'Placements', 'Change history']) {
    await page.getByRole('tab', { name: tab, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/creative/${CREATIVE_ASSETS[0]}\\?.*tab=${tab.toLowerCase().replace(' ', '-')}(?:&|$)`));
    expect(new URL(page.url()).searchParams.get('tab')).toBe(tab.toLowerCase().replace(' ', '-'));
    await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  await expect(page.getByText(/Needs ingestion: listing snapshots/)).toBeVisible();
  await page.getByRole('link', { name: 'Compare creatives', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/creative/campaign/' + CREATIVE_CAMPAIGN_ID));
  await expect(page.getByText(/1 keyword.*2 ad groups.*2 creatives/)).toBeVisible();
  await expect(page.getByRole('heading', { name: /floor.*not yet measured|not yet measured.*floor/i })).toBeVisible();
  await page.goto(`/creative/eligibility?${query}`);
  await expect(page.getByText('Awaiting review', { exact: true })).toBeVisible();
  await expect(page.getByText('Approved', { exact: true })).toBeVisible();
  await expect(page.getByText(/No moderation source|No source|Not measured/).first()).toBeVisible();
  const path = testInfo.outputPath('creative-eligibility-persisted.png');
  await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  await testInfo.attach('Persisted creative eligibility', { path, contentType: 'image/png' });
});

test('creative screens capture every declared visual state in the operator shell', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/creative?${new URLSearchParams({ profile: fixtureProfileId })}`);
  await expect(page.getByTestId('creative-screen')).toBeVisible();
  const markup = JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', 'e2e/support/render-creative-states.ts', 'creative'],
    { encoding: 'utf8' })) as Record<string, string>;
  const paths = await captureCreativeStates(page, testInfo, 'creative', markup, '[data-testid="creative-screen"]');
  expect(paths).toHaveLength(Object.keys(markup).length);
});
