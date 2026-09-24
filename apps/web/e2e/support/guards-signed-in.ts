import { expect, test, type Page } from '@playwright/test';
import type { GuardedRoute } from '../../src/e2e-guard-routes';
import { signIn } from './auth';
import { guardRoutePath } from './guard-route-path';

export async function assertSignedInGuardRoutes(page: Page, routes: readonly GuardedRoute[]): Promise<void> {
  // Each guarded route compiles on first visit. Night mode can exceed eight
  // minutes before Timeline loads; keep the hydration assertions below and
  // allow this half of the route list to finish on the four-core runner.
  test.setTimeout(900_000);
  await signIn(page, 'admin');

  const timelineErrors: string[] = [];
  const captureTimelineError = (message: string) => {
    if (new URL(page.url()).pathname === '/timeline') timelineErrors.push(message);
  };
  page.on('pageerror', error => captureTimelineError(error.message));
  page.on('console', message => { if (message.type() === 'error') captureTimelineError(message.text()); });
  const landed: string[] = [];
  for (const { path, signedIn } of routes) {
    const requestedPath = guardRoutePath(path);
    const expectedPath = new URL(requestedPath, 'https://example.test').pathname;
    const expectedFollowUp = signedIn.canonicalProfile === true;
    await page.goto(requestedPath).catch((error: unknown) => {
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
    if (expectedPath === '/timeline') {
      // Exercise a state change so this asserts successful hydration, not only SSR.
      const kind = page.getByRole('button', {name:'experiment',exact:true});
      await expect(kind).toHaveAttribute('aria-pressed','true');
      await kind.click();
      await expect(kind).toHaveAttribute('aria-pressed','false');
      expect(timelineErrors).toEqual([]);
    }
    landed.push(new URL(page.url()).pathname);
  }

  // Declared redirects retain their destination; every other route stays on
  // its concrete requested pathname, counted against every descriptor.
  expect(landed).toEqual(routes.map(({ path, signedIn }) => (
    signedIn.kind === 'redirect' ? signedIn.pathname : guardRoutePath(path)
  )));
  await expect(page.getByTestId('app-nav')).toBeVisible();
}
