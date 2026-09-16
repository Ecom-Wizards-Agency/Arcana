import { expect, test, type Page } from '@playwright/test';
import type { GuardedRoute } from '../../src/e2e-guard-routes';
import { signOut } from './auth';
import { guardRoutePath } from './guard-route-path';

export async function assertAnonymousGuardRoutes(page: Page, routes: readonly GuardedRoute[]): Promise<void> {
  // One goto per guarded route; in CI each first visit pays a dev-server
  // compile, so the loop needs more than the per-test default.
  // Match the signed-in route loop's allowance for night mode.
  test.setTimeout(900_000);
  await signOut(page);

  const landed: string[] = [];
  for (const { path } of routes) {
    // A server-component `redirect()` can commit `/login` quickly enough to
    // interrupt Playwright's wait for the original document. That is the
    // protected outcome we want, so wait for the destination explicitly while
    // still surfacing every other navigation failure.
    await page.goto(guardRoutePath(path)).catch((error: unknown) => {
      if (!String(error).includes('is interrupted by another navigation')) throw error;
    });
    await page.waitForURL('**/login');
    landed.push(new URL(page.url()).pathname);
  }

  // Counted against the input rather than asserted one at a time, so a route
  // that silently stops redirecting cannot hide in a passing run.
  expect(landed).toEqual(routes.map(() => '/login'));
}
