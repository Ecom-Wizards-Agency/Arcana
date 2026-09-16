/** Guard sweep half B in its own Next process. */
import { test } from '@playwright/test';
import { GUARDED_ROUTE_HALVES } from '../src/e2e-guard-routes';
import { assertAnonymousGuardRoutes } from './support/guards-anonymous';

test.describe.configure({ mode: 'serial' });

test('half b: guarded screens send an anonymous visitor to the login page', async ({ page }) => {
  await assertAnonymousGuardRoutes(page, GUARDED_ROUTE_HALVES.b);
});
