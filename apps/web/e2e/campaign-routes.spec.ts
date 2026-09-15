import { test } from '@playwright/test';
import { captureCampaignStates } from './support/campaign-screenshots';
test('captures all campaign states on signed-in routes with persisted fixtures', async ({ page }, testInfo) => {
  test.setTimeout(360_000);
  await captureCampaignStates(page, testInfo);
});
