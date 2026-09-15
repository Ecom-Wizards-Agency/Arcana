/** Live, authenticated references for the utility routes awaiting design frames. */
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signIn } from './support/auth';
import { readState, BASE_URL } from './support/fixture';

const routes = [
  '/settings/account', '/settings/profiles', '/settings/connections', '/settings/members', '/settings/integrations',
  '/bugs', '/roadmap', '/feedback', '/feedback/new', '/tags', '/crosscheck', '/sync-status', '/connect-claude',
  '/experiments', '/experiments/new', '/experiments/[experimentId]', '/recommendations',
];

test('captures all 17 undesigned routes inside the signed-in operator shell in both themes', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const state = await readState();
  const db = createDb({ connectionString: state.connectionString, max: 1 });
  let experimentId: string;
  let recommendationRunId: string;
  try {
    const rows = await db.sql<{id: string}[]>`select id from public.experiments where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} order by created_at limit 1`;
    expect(rows).toHaveLength(1);
    experimentId = rows[0]!.id;
    const runs = await db.sql<{id: string}[]>`select id from public.recommendation_runs where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and status='succeeded' order by created_at limit 1`;
    expect(runs).toHaveLength(1);
    recommendationRunId = runs[0]!.id;
    // Complete the synthetic succeeded run's display timestamp for the ready review grid.
    const pending = await db.sql<{id: string}[]>`select id from public.recommendation_runs where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and status='succeeded' and finished_at is null`;
    const completed = await db.sql<{id: string}[]>`update public.recommendation_runs set finished_at=created_at where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and status='succeeded' and finished_at is null returning id`;
    expect(completed.map((row) => row.id).sort()).toEqual(pending.map((row) => row.id).sort());
  } finally { await db.close(); }
  const output = process.env['WP272_LIVE_CAPTURE_DIR'] ?? resolve(info.project.outputDir, '..', 'wp272-live');
  await mkdir(output, { recursive: true });
  const captures: {route: string; url: string; theme: string; screenshot: string; mode: string}[] = [];
  for (const route of routes) {
    // Feedback's real ready response is a client redirect bridge. Capture its server
    // response before the effect redirects; this leaves production behavior intact.
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1024 } });
    const page = await context.newPage();
    if (route === '/feedback') await page.route('**/_next/static/**/*.js', (request) => request.abort());
    try {
      await signIn(page, 'admin');
      const path = route.replace('[experimentId]',experimentId);
      const query = new URLSearchParams({ profile:state.fixtureProfileId });
      if (route === '/recommendations') query.set('run',recommendationRunId);
      await page.goto(`${path}?${query}`);
      await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
      await expect(page.locator('.wa-support-screen')).toBeVisible();
      await expect(page.getByTestId('app-error')).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get('profile')).toBe(state.fixtureProfileId);
      if (route === '/recommendations') await expect(page.getByTestId('queue-count')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (route !== '/feedback') {
        await expect(page.getByTestId('theme-toggle')).toContainText(/Light|Dark/);
        await expect(page.getByText('Loading freshness…', { exact: true })).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByText('Loading crosscheck…', { exact: true })).toHaveCount(0, { timeout: 60_000 });
      }
      for (const theme of ['light','dark']) {
        if (route === '/feedback') {
          await page.evaluate((value) => { document.documentElement.dataset['theme']=value; },theme);
        } else {
          if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTestId('theme-toggle').click();
          await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
          await expect(page.getByTestId('theme-toggle')).toContainText(theme === 'dark' ? 'Dark' : 'Light');
        }
        const screenshot = resolve(output,`${route.slice(1).replaceAll('/','-').replaceAll('[','').replaceAll(']','')}-${theme}.png`);
        await page.screenshot({ path:screenshot, animations:'disabled', style:'nextjs-portal { display:none; }' });
        captures.push({ route, url:page.url(), theme, screenshot, mode:route === '/feedback' ? 'live server redirect bridge with hydration bundles held' : 'live hydrated ready screen' });
        await info.attach(`${route} ${theme}`,{path:screenshot,contentType:'image/png'});
      }
    } finally { await context.close(); }
  }
  expect(captures).toHaveLength(routes.length*2);
  expect(new Set(captures.map((capture) => capture.route)).size).toBe(17);
  await writeFile(resolve(output,'manifest.json'),JSON.stringify(captures,null,2));
});
