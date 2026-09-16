import { expect, type Page, type TestInfo } from '@playwright/test';
import { createDb, withAuthenticatedReadSnapshot } from '@wizard-ads/db';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { campaignRouteCases } from './campaign-route-cases';
import { readState, USERS } from './fixture';
import { signIn } from './auth';
import { fixtureReverseName } from '../../src/screens/campaigns/render-fixture';

export async function captureCampaignStates(page: Page, testInfo: TestInfo) {
  const fixture = await readState(); const db = createDb({ connectionString: fixture.connectionString });
  const [profile] = await db.sql<{ label: string }[]>`select coalesce(account_name,amazon_profile_id) as label from public.ad_profiles where org_id=${fixture.orgId} and id=${fixture.fixtureProfileId}`;
  expect(profile).toBeTruthy();
  const cases = campaignRouteCases(fixture, profile!.label);
  expect(cases).toHaveLength(72); expect(new Set(cases.map((item) => `${item.screen}--${item.key}`)).size).toBe(72);
  const directory = resolve(testInfo.project.outputDir, '..', 'wp270-round3', 'screenshots'); await mkdir(directory, { recursive: true });
  try {
    // Created only in the disposable browser database; production has no fixture table.
    await db.sql`create table public.campaign_screen_fixtures (id uuid primary key, org_id uuid not null references public.orgs(id), profile_id uuid not null references public.ad_profiles(id), created_by uuid not null, screen_id text not null, mode text not null, payload jsonb not null)`;
    await db.sql`select app.install_tenant_rls('public.campaign_screen_fixtures')`;
    await db.sql`create policy campaign_fixture_actor on public.campaign_screen_fixtures as restrictive for select to authenticated using(created_by=auth.uid())`;
    for (const item of cases) await db.sql`insert into public.campaign_screen_fixtures values(${item.id},${fixture.orgId},${fixture.fixtureProfileId},${USERS.admin},${item.screen === 'campaigns-new' ? 'campaigns' : item.screen},${item.mode},${JSON.stringify(item.payload)}::text::jsonb)`;
    const [persisted] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.campaign_screen_fixtures where org_id=${fixture.orgId} and created_by=${USERS.admin}`;
    expect(persisted?.count).toBe(72);
    const otherActorRows = await withAuthenticatedReadSnapshot(db, { orgId: fixture.orgId, userId: USERS.viewer }, (snapshot) => snapshot.sql`select id from public.campaign_screen_fixtures`);
    expect(otherActorRows).toHaveLength(0);
    const [before] = await db.sql`select (select count(*) from public.sync_jobs where org_id=${fixture.orgId}) as jobs,(select count(*) from public.campaign_drafts where org_id=${fixture.orgId} and status='approved') as approvals`;
    await signIn(page, 'admin'); await page.setViewportSize({ width: 1440, height: 1024 });
    const captures: Array<Record<string, unknown>> = [];
    for (const item of cases) {
      const query = new URLSearchParams({ profile: fixture.fixtureProfileId, fixture: item.id }); if (item.step) query.set('step', item.step);
      const route = `${item.path}?${query}`;
      await page.goto(route, { waitUntil: item.mode === 'loading' ? 'commit' : 'domcontentloaded' });
      await expect(page.getByTestId('shell-title')).toBeVisible(); await expect(page.locator('.wa-sidebar')).toBeVisible();
      if (item.mode !== 'loading') await expect(page.locator('.wa-shell-chips')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#wa-main')).not.toHaveClass(/wa-content--public/);
      await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get('profile')).toBe(fixture.fixtureProfileId);
      if (item.action === 'edit') await page.getByRole('button', { name: 'Edit draft', exact: true }).click();
      if (item.action === 'rationale') await page.locator('.campaign-bid-secondary > summary').click();
      if (item.action === 'calculation') await page.getByRole('button', { name: 'View bid calculation', exact: true }).click();
      if (item.action === 'used') await page.getByRole('tab', { name: 'Used in this account' }).click();
      if (item.action === 'keyword-set') await page.getByLabel('Campaign structure').selectOption('set-product');
      if (item.action === 'reverse-read' || item.action === 'reverse-unparseable') {
        const name = fixtureReverseName;
        await page.getByLabel('Existing campaign name').fill(item.action === 'reverse-read' ? name : 'unparseable');
        await page.getByRole('button', { name: 'Read it', exact: true }).click();
      }
      await expect(page.locator('#wa-main')).toContainText(item.expected);
      await page.evaluate(() => window.scrollTo(0, 0));
      if (item.mode === 'loading') await expect(page.getByLabel('Screen loading')).toBeVisible();
      if (item.mode === 'error') await expect(page.getByTestId('app-error')).toBeVisible();
      if (item.key.includes('confirm-') || item.key.includes('retry-')) {
        const button = page.getByRole('button', { name: /^Yes, (create|retry) 1 (campaign|keyword) in Amazon$/ });
        if (item.key.endsWith('executor-fixture')) { await expect(button).toBeEnabled(); await button.click(); } else await expect(button).toBeDisabled();
        await expect(page.getByRole('button', { name: 'Export bulk sheet', exact: true })).toBeVisible();
      }
      if (item.screen === 'campaigns' && item.key.startsWith('targets-')) {
        await expect(page.locator('.campaign-live-preview')).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('link', { name: 'Reverse Builder', exact: true })).toBeInViewport({ ratio: 1 });
      }
      if (item.key.startsWith('bid-') && item.key !== 'bid-rationale') {
        await expect(page.getByRole('heading', { name: 'Set starting bid', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('button', { name: 'Use this bid', exact: true })).toBeInViewport({ ratio: 1 });
        if (item.key === 'bid-reconcile-warning') await expect(page.getByText('Source totals do not reconcile', { exact: true })).toBeInViewport({ ratio: 1 });
      }
      if (item.key === 'bid-rationale') {
        await expect(page.getByRole('heading', { name: 'The bid, and why', exact: true })).toBeInViewport({ ratio: 1 });
        await expect(page.locator('.campaign-bid-secondary')).toHaveAttribute('open', '');
        await expect(page.getByLabel('Bid evidence')).toBeInViewport({ ratio: 1 });
        await expect(page.getByText(/1 – 30 May 2026/)).toBeInViewport({ ratio: 1 });
        await expect(page.locator('.campaign-rationale blockquote')).toBeInViewport({ ratio: 1 });
      }
      if (item.key === 'retry-unavailable') {
        await expect(page.getByText(/Unresolved keyword: “synthetic lantern”/)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Export bulk sheet', exact: true })).toBeDisabled();
        await expect(page.getByText(/Export the bulk sheet to create these campaigns/)).toHaveCount(0);
      }
      if (item.screen === 'campaigns-assets' && item.key === 'used') {
        await expect(page.getByRole('button', { name: 'Reuse asset', exact: true })).toBeDisabled();
        await expect(page.getByText('Thumbnail unavailable. Refresh the asset library before reuse.')).toBeVisible();
      }
      if (item.key === 'edit') { await expect(page.getByLabel('Edited values summary')).toBeVisible(); await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeInViewport({ ratio: 1 }); }
      if (item.key.startsWith('confirm-')) { await expect(page.getByText('Created resources cannot be deleted through rollback.')).toBeVisible(); }
      if (item.key === 'partial') await expect(page.getByRole('cell', { name: 'Failed · 429', exact: true })).toBeVisible();
      if (item.key === 'nine-checks') { await expect(page.locator('.campaign-check-chip[data-runnable="true"]')).toHaveCount(5); await expect(page.locator('.campaign-check-chip[data-runnable="false"]')).toHaveCount(4); }
      await page.evaluate(async () => { await document.fonts.ready; }); await page.mouse.move(0, 0);
      const path = join(directory, `${item.screen}--${item.key}.png`);
      await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display:none; }' });
      const bytes = (await stat(path)).size; expect(bytes).toBeGreaterThan(0);
      await testInfo.attach(`${item.screen}--${item.key}`, { path, contentType: 'image/png' });
      captures.push({ state: `${item.screen}--${item.key}`, route, resolvedRoute: new URL(page.url()).pathname, fixtureId: item.id, profileId: fixture.fixtureProfileId, expected: item.expected, viewport: { width: 1440, height: 1024 }, path, bytes, evidence: item.screen === 'campaigns-new' ? 'Canonical boundary through the query-preserving alias' : 'Persisted actor-bound route data; registered screen and operator shell' });
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ expected: cases.length, captured: captures.length, captures }, null, 2));
    }
    expect(captures).toHaveLength(72);
    const [after] = await db.sql`select (select count(*) from public.sync_jobs where org_id=${fixture.orgId}) as jobs,(select count(*) from public.campaign_drafts where org_id=${fixture.orgId} and status='approved') as approvals`;
    expect(after).toEqual(before);
  } finally { await db.close(); }
}
