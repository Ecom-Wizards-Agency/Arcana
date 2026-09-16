/** Anonymous frame and guarded-route redirect proofs in a fresh Next process. */
import { expect, test } from '@playwright/test';
import { GUARDED_ROUTE_HALVES } from '../src/e2e-guard-routes';
import { signOut } from './support/auth';
import { assertAnonymousGuardRoutes } from './support/guards-anonymous';

test.describe.configure({ mode: 'serial' });

test('the index sends an anonymous visitor directly to sign in', async ({ page }) => {
  await signOut(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  const nav = page.getByTestId('app-nav');
  await expect(nav).toBeVisible();
  await expect(nav.getByTestId('nav-signin')).toBeVisible();
  await expect(nav.getByTestId('nav-signout')).toHaveCount(0);
  await expect(nav.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await expect(page.getByTestId('feedback-entry')).toHaveCount(0);
  await expect(page.getByTestId('home-signin')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Arcana' })).toBeVisible();
});

test('half a: guarded screens send an anonymous visitor to the login page', async ({ page }) => {
  await assertAnonymousGuardRoutes(page, GUARDED_ROUTE_HALVES.a);
});
