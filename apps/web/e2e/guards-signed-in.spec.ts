/** Signed-in frame, guarded-route acceptance and not-found proofs in a fresh Next process. */
import { expect, test } from '@playwright/test';
import { GUARDED_ROUTES } from '../src/e2e-guard-routes';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

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

test('the same screens open once there is a session', async ({ page }) => {
  test.setTimeout(300_000); // same routes, same CI compile cost as above
  await signIn(page, 'admin');

  const landed: string[] = [];
  for (const { path, signedIn } of GUARDED_ROUTES) {
    const expectedPath = new URL(path, 'https://example.test').pathname;
    const expectedFollowUp = signedIn.canonicalProfile === true;
    await page.goto(path).catch((error: unknown) => {
      if (!expectedFollowUp || !String(error).includes('is interrupted by')) {
        throw error;
      }
    });
    if (signedIn.kind === 'requested' && signedIn.canonicalProfile === true) {
      await page.waitForURL(
        (url) => url.pathname === expectedPath && url.searchParams.has('profile'),
      );
    } else if (signedIn.kind === 'redirect') {
      await page.waitForURL(
        (url) => (
          url.pathname === signedIn.pathname
          && url.hash === signedIn.hash
          && (!signedIn.canonicalProfile || url.searchParams.has('profile'))
        ),
      );
      await expect(signedIn.pathname === '/' ? page.getByLabel('Performance summary') : page.locator(signedIn.artifact)).toBeVisible();
      await expect(signedIn.pathname === '/' ? page.getByTestId('shell-title') : page.getByRole('heading', { name: signedIn.heading, exact: true })).toBeVisible();
    }
    if (signedIn.kind === 'requested' && signedIn.heading !== undefined) {
      // The scoped Home adapter replaces the cockpit presentation; route admission is unchanged.
      await expect(expectedPath === '/' ? page.getByTestId('shell-title') : page.getByRole('heading', { name: signedIn.heading, exact: true })).toBeVisible();
    }
    landed.push(new URL(page.url()).pathname);
  }

  // The legacy strategy URL still redirects to Home. Assert that intentional
  // redirect exactly; every other route must stay on its requested pathname.
  expect(landed).toEqual(GUARDED_ROUTES.map(({ path, signedIn }) => (
    signedIn.kind === 'redirect' ? signedIn.pathname : path
  )));
  await expect(page.getByTestId('app-nav')).toBeVisible();
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
