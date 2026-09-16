/** Guard sweep half B in its own Next process. */
import { expect, test } from '@playwright/test';
import { GUARDED_ROUTE_HALVES } from '../src/e2e-guard-routes';
import { assertSignedInGuardRoutes } from './support/guards-signed-in';
import { signIn } from './support/auth';

test.describe.configure({ mode: 'serial' });

test('half b: guarded screens open once there is a session', async ({ page }) => {
  await assertSignedInGuardRoutes(page, GUARDED_ROUTE_HALVES.b);
});

test('an unknown address is a not-found page, not a crash', async ({ page }) => {
  await signIn(page, 'admin');
  const shellRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    if (request.headers()['next-action'] !== undefined) shellRequests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto('/no-such-screen');
  expect(response?.status()).toBe(404);
  await expect(page.getByTestId('app-not-found')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(shellRequests.filter((url) => new URL(url).pathname === '/no-such-screen')).toEqual([]);
  expect(errors).toEqual([]);
  // The next request also proves the process survived navigation away from a shell read.
  expect((await page.reload())?.status()).toBe(404);
  await expect(page.getByTestId('app-not-found')).toBeVisible();
});
