/** Signed-in frame, guarded-route acceptance and not-found proofs in a fresh Next process. */
import { expect, test } from '@playwright/test';
import { GUARDED_ROUTE_HALVES } from '../src/e2e-guard-routes';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { assertSignedInGuardRoutes } from './support/guards-signed-in';

test.describe.configure({ mode: 'serial' });

test('the index opens the signed-in operator dashboard with its active profile', async ({ page }) => {
  await signIn(page, 'admin');
  await page.goto('/');
  const { fixtureProfileId } = await readState();

  await page.waitForURL((url) =>
    url.pathname === '/' && url.searchParams.get('profile') === fixtureProfileId,
  );
  await expect(page.getByTestId('shell-title')).toBeVisible();

  const nav = page.getByTestId('app-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId('nav-identity')).toBeVisible();
  // The way out lives inside the avatar menu since the design system pass.
  await nav.getByTestId('nav-identity').locator('summary').click();
  await expect(nav.getByTestId('nav-signout')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nav.getByTestId('nav-signin')).toHaveCount(0);
  await expect(page.getByTestId('home-signed-in')).toHaveCount(0);
  await expect(page.getByTestId('feedback-entry')).toBeVisible();
});

test('half a: guarded screens open once there is a session', async ({ page }) => {
  await assertSignedInGuardRoutes(page, GUARDED_ROUTE_HALVES.a);
});
