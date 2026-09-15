import { expect, test } from '@playwright/test';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { researchScreenshots } from './support/research-screenshots';
test('Dayparting persists all 168 hours and cannot enable scheduled writes', async ({ page }, testInfo) => {
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.goto(`/dayparting?profile=${fixtureProfileId}`);
  await expect(page.getByRole('gridcell')).toHaveCount(168);
  await page.getByLabel('Schedule name').fill('Synthetic reviewed schedule');
  await page.getByLabel('Paint %').fill('37');
  await page.getByRole('button', {
    name: 'Weekday preset',
    exact: true
  }).click();
  const pending=page.waitForResponse(response=>response.url().endsWith('/api/dayparting/schedules')&&response.request().method()==='POST');
  await page.getByRole('group', { name: 'Campaign assignment' }).getByRole('checkbox').first().check();
  await page.getByRole('button', {
    name: 'Review schedule',
    exact: true
  }).click();
  const savedResponse=await pending;
  expect(savedResponse.ok(),await savedResponse.text()).toBe(true);
  await expect(page.getByRole('button', {
    name: 'Yes, enable this schedule for 1 campaign(s)',
    exact: true
  })).toBeDisabled();
  await expect(page.getByText('Scheduled writes are not available yet. The reviewed schedule can be exported.')).toBeVisible();
  const response = await page.request.get(`/api/dayparting/schedules?profileId=${fixtureProfileId}`);
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.schedules).toHaveLength(1);
  expect(body.schedules[0].modifiers.flat()).toHaveLength(168);
  expect(body.schedules[0].status).toBe('draft');
  await page.getByRole('button', {
    name: 'Review hourly evidence',
    exact: true
  }).click();
  await expect(page.getByRole('heading', {
    name: 'Hourly performance',
    exact: true
  }).first()).toBeVisible();
  await researchScreenshots(page, testInfo, 'dayparting');
});
