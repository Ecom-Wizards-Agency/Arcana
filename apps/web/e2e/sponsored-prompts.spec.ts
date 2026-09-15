import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState, USERS } from './support/fixture';
import { captureCreativeStates, waitForCreativeShell } from './support/creative-screenshots';
import { seedPromptImportProfile } from './support/sponsored-prompt-fixture';

test('prompt import preserves observations, detects returns and keeps visits per user', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const state = await seedPromptImportProfile(await readState());
  const db = createDb({ connectionString: state.connectionString });
  const now = Date.now();
  const stamp = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  const observed = (promptText: string, daysAgo: number, status: 'live' | 'paused', spend: number) => ({
    adProduct: 'SP', campaignId: 'c-1', adGroupId: 'ag-1', promptText, observedAt: stamp(daysAgo), status,
    intervalStart: stamp(daysAgo + 1), intervalEnd: stamp(daysAgo), spend, clicks: 3, sales: 13, orders: 1,
  });
  const rows = [
    observed('Synthetic returning prompt', 8, 'live', 2),
    observed('Synthetic returning prompt', 6, 'paused', 1),
    observed('Synthetic returning prompt', 2, 'live', 3),
    observed('Synthetic unchanged prompt', 8, 'live', 4),
    observed('Synthetic newly sponsored prompt', 1, 'live', 5),
  ];
  const payload = { profileId: state.fixtureProfileId, metricSemantics: 'disjoint_interval_deltas', rows };
  const route = `/prompts?${new URLSearchParams({ profile: state.fixtureProfileId })}`;
  try {
    await signIn(page, 'admin');
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.goto(route);
    await expect(page.getByRole('main', { name: 'Sponsored prompts' })).toBeVisible();
    await expect(page.getByText(/No prompts imported|No prompt observations|Import.*first/i).first()).toBeVisible();
    await page.getByLabel('Prompt export JSON').fill(JSON.stringify(payload));
    const imported = page.waitForResponse((response) => response.url().endsWith('/api/prompts/import') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Import observations', exact: true }).click();
    expect((await imported).ok()).toBe(true);
    await expect(page.getByRole('status')).toHaveText('5 observations imported; 0 already present; 5 verified.');
    await expect(page.getByText('The cost of the pause loop', { exact: true })).toBeVisible();
    await page.getByLabel('Upload prompt export').setInputFiles({
      name: 'synthetic-prompt-observations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(payload)),
    });
    await expect(page.getByRole('status')).toHaveText('Export loaded. Review it, then import observations.');
    const uploaded = page.waitForResponse((response) => response.url().endsWith('/api/prompts/import') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Import observations', exact: true }).click();
    expect((await uploaded).ok()).toBe(true);
    await expect(page.getByRole('status')).toHaveText('0 observations imported; 5 already present; 5 verified.');
    const duplicate = await page.request.post('/api/prompts/import', { data: payload });
    expect(duplicate.ok()).toBe(true);
    expect(await duplicate.json()).toMatchObject({ offered: rows.length, inserted: 0, alreadyPresent: rows.length, verified: rows.length });
    // Leave the importer before changing actors. A final current marker cannot
    // be advanced by an older visit receipt from the import refresh.
    await page.goto(`/creative?${new URLSearchParams({ profile: state.fixtureProfileId })}`);
    await expect(page.getByTestId('creative-screen')).toBeVisible();
    const [count] = await db.sql<{ prompts: number; observations: number }[]>`
      select (select count(*)::int from public.sponsored_prompts where org_id=${state.orgId} and profile_id=${state.fixtureProfileId}) as prompts,
        (select count(*)::int from public.sponsored_prompt_observations where org_id=${state.orgId} and profile_id=${state.fixtureProfileId}) as observations`;
    expect(count).toEqual({ prompts: 3, observations: rows.length });
    const adminVisit = await db.sql<{ last_visited_at: Date }[]>`
      insert into public.sponsored_prompt_visits(org_id,profile_id,user_id,last_visited_at)
      values (${state.orgId},${state.fixtureProfileId},${USERS.admin},statement_timestamp())
      on conflict (org_id,profile_id,user_id) do update set last_visited_at=excluded.last_visited_at returning last_visited_at`;
    expect(adminVisit).toHaveLength(1);
    const visits = await db.sql`
      insert into public.sponsored_prompt_visits(org_id,profile_id,user_id,last_visited_at)
      values (${state.orgId},${state.fixtureProfileId},${USERS.analyst},${stamp(3)})
      on conflict (org_id,profile_id,user_id) do update set last_visited_at=excluded.last_visited_at returning user_id`;
    expect(visits).toHaveLength(1);
    await signIn(page, 'analyst');
    await page.goto(route);
    const returned = page.getByRole('row').filter({ hasText: 'Synthetic returning prompt' });
    await expect(returned).toContainText(/returned/i);
    const dateWords = (daysAgo: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(stamp(daysAgo)));
    await expect(returned).toContainText(`back ${dateWords(2)}`);
    await expect(page.getByRole('heading', { name: `WHAT CHANGED SINCE ${dateWords(3)}`, exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Synthetic newly sponsored prompt' })).toContainText(/newly sponsored/i);
    await expect(page.getByRole('row').filter({ hasText: 'Synthetic unchanged prompt' })).toHaveCount(0);
    await page.getByRole('button', { name: /Expand/ }).click();
    await expect(page.getByRole('row').filter({ hasText: 'Synthetic unchanged prompt' })).toBeVisible();
    await expect(page.getByText(/Your imports record 1 paused prompts/)).toBeVisible();
    const consoleLink = returned.getByRole('link', { name: /Pause in console/ });
    await expect(consoleLink).toHaveAttribute('target', '_blank');
    await expect(consoleLink).toHaveAttribute('rel', 'noopener noreferrer');
    const consoleUrl = new URL(await consoleLink.getAttribute('href') ?? '');
    expect(consoleUrl.protocol).toBe('https:');
    expect(consoleUrl.hostname).toBe('advertising.amazon.com');
    expect(consoleUrl.pathname).toBe('/cm/sp/campaigns/c-1/ad-groups');
    expect(consoleUrl.search).toBe('');
    expect(consoleUrl.username).toBe('');
    expect(consoleUrl.password).toBe('');
    expect(consoleUrl.href).not.toContain(state.fixtureProfileId);
    expect(consoleUrl.href).not.toContain(state.orgId);
    expect(consoleUrl.href).not.toContain('ag-1');
    const screenshot = testInfo.outputPath('sponsored-prompts-persisted.png');
    await waitForCreativeShell(page);
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    await testInfo.attach('Imported prompt observations', { path: screenshot, contentType: 'image/png' });
    const [unchangedAdminVisit] = await db.sql<{ last_visited_at: Date }[]>`select last_visited_at from public.sponsored_prompt_visits
      where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and user_id=${USERS.admin}`;
    expect(unchangedAdminVisit?.last_visited_at).toEqual(adminVisit[0]?.last_visited_at);
    await page.goto(`/sponsored-prompts?${new URLSearchParams({ profile: state.fixtureProfileId })}`);
    await expect(page).toHaveURL(new RegExp(`/prompts\\?profile=${state.fixtureProfileId}$`));
    await expect(page.getByRole('main', { name: 'Sponsored prompts' })).toBeVisible();
  } finally { await db.close(); }
});

test('sponsored prompts capture every declared visual state in the operator shell', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const { fixtureProfileId } = await readState();
  await signIn(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.goto(`/prompts?${new URLSearchParams({ profile: fixtureProfileId })}`);
  await expect(page.getByRole('main', { name: 'Sponsored prompts' })).toBeVisible();
  const markup = JSON.parse(execFileSync(process.execPath,
    ['--import', 'tsx', 'e2e/support/render-creative-states.ts', 'sponsored-prompts'],
    { encoding: 'utf8' })) as Record<string, string>;
  const paths = await captureCreativeStates(page, testInfo, 'sponsored-prompts', markup, 'main[aria-label="Sponsored prompts"]');
  expect(paths).toHaveLength(Object.keys(markup).length);
});
