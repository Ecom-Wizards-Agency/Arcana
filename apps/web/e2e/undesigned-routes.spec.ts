/** Live, authenticated references for the utility routes awaiting design frames. */
import { expect, test, type Browser, type TestInfo } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { signIn } from './support/auth';
import { readState, BASE_URL } from './support/fixture';

/**
 * The 17 routes in capture order, one logical test per group. Each group gets
 * its own budget for the first compile of its route graphs, so a slow route or
 * a screen added to one group cannot spend the time left for every other route.
 * The last test proves the combined manifest still covers all 17 routes in
 * both themes. Serial mode skips it when any group fails.
 */
const CAPTURE_GROUPS = [
  { name: 'settings', routes: ['/settings/account', '/settings/profiles', '/settings/connections', '/settings/members', '/settings/integrations'] },
  { name: 'feedback', routes: ['/bugs', '/roadmap', '/feedback', '/feedback/new'] },
  { name: 'utility', routes: ['/tags', '/crosscheck', '/sync-status', '/connect-claude'] },
  { name: 'experiment and recommendation', routes: ['/experiments', '/experiments/new', '/experiments/[experimentId]', '/recommendations'] },
] as const;
const routes: readonly string[] = CAPTURE_GROUPS.flatMap((group) => group.routes);
const THEMES = ['light', 'dark'] as const;
/** At most five routes per group; the single 17-route test had five minutes. */
const GROUP_TIMEOUT_MS = 180_000;

interface Capture { route: string; url: string; theme: string; screenshot: string; mode: string }

// The final test reads every group's captures; one failure skips the rest.
test.describe.configure({ mode: 'serial' });

let fixtureProfileId: string;
let experimentId: string;
let recommendationRunId: string;
const captures: Capture[] = [];

test.beforeAll(async () => {
  const state = await readState();
  fixtureProfileId = state.fixtureProfileId;
  const db = createDb({ connectionString: state.connectionString, max: 1 });
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
});

function captureDirectory(info: TestInfo): string {
  return process.env['WP272_LIVE_CAPTURE_DIR'] ?? resolve(info.project.outputDir, '..', 'wp272-live');
}

async function captureRoute(browser: Browser, info: TestInfo, output: string, route: string): Promise<Capture[]> {
  const routeCaptures: Capture[] = [];
  // Feedback's real ready response is a client redirect bridge. Capture its server
  // response before the effect redirects; this leaves production behavior intact.
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1440, height: 1024 } });
  const page = await context.newPage();
  if (route === '/feedback') await page.route('**/_next/static/**/*.js', (request) => request.abort());
  try {
    await signIn(page, 'admin');
    const path = route.replace('[experimentId]',experimentId);
    const query = new URLSearchParams({ profile:fixtureProfileId });
    if (route === '/recommendations') query.set('run',recommendationRunId);
    await page.goto(`${path}?${query}`);
    await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible();
    await expect(page.locator('.wa-support-screen')).toBeVisible();
    await expect(page.getByTestId('app-error')).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('profile')).toBe(fixtureProfileId);
    if (route === '/recommendations') await expect(page.getByTestId('queue-count')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    if (route !== '/feedback') {
      await expect(page.getByTestId('theme-toggle')).toContainText(/Light|Dark/);
      await expect(page.getByText('Loading freshness…', { exact: true })).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByText('Loading crosscheck…', { exact: true })).toHaveCount(0, { timeout: 60_000 });
    }
    for (const theme of THEMES) {
      if (route === '/feedback') {
        await page.evaluate((value) => { document.documentElement.dataset['theme']=value; },theme);
      } else {
        if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByTestId('theme-toggle').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
        await expect(page.getByTestId('theme-toggle')).toContainText(theme === 'dark' ? 'Dark' : 'Light');
      }
      const screenshot = resolve(output,`${route.slice(1).replaceAll('/','-').replaceAll('[','').replaceAll(']','')}-${theme}.png`);
      await page.screenshot({ path:screenshot, animations:'disabled', style:'nextjs-portal { display:none; }' });
      routeCaptures.push({ route, url:page.url(), theme, screenshot, mode:route === '/feedback' ? 'live server redirect bridge with hydration bundles held' : 'live hydrated ready screen' });
      await info.attach(`${route} ${theme}`,{path:screenshot,contentType:'image/png'});
    }
  } finally { await context.close(); }
  return routeCaptures;
}

for (const group of CAPTURE_GROUPS) {
  test(`captures the ${group.routes.length} ${group.name} routes inside the signed-in operator shell in both themes`, async ({ browser }, info) => {
    test.setTimeout(GROUP_TIMEOUT_MS);
    const output = captureDirectory(info);
    await mkdir(output, { recursive: true });
    const groupCaptures: Capture[] = [];
    for (const route of group.routes) groupCaptures.push(...await captureRoute(browser, info, output, route));
    expect(groupCaptures.map(({ route, theme }) => `${route} ${theme}`))
      .toEqual(group.routes.flatMap((route) => THEMES.map((theme) => `${route} ${theme}`)));
    captures.push(...groupCaptures);
  });
}

test('captures all 17 undesigned routes inside the signed-in operator shell in both themes', async () => {
  expect(captures).toHaveLength(routes.length*2);
  expect(new Set(captures.map((capture) => capture.route)).size).toBe(17);
  expect(captures.map(({ route, theme }) => `${route} ${theme}`))
    .toEqual(routes.flatMap((route) => THEMES.map((theme) => `${route} ${theme}`)));
  await writeFile(resolve(captureDirectory(test.info()),'manifest.json'),JSON.stringify(captures,null,2));
});
