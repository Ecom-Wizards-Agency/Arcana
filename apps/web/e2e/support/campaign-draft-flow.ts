import { createDb } from '@wizard-ads/db';
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
function required(name: string) { const value = process.env[name]; if (!value) throw new Error(`Missing browser fixture setting: ${name}`); return value; }
/** Uses only the disposable database created by the tags-goto runner. */
export async function verifyCampaignDraftFlow(page: Page) {
  const db = createDb({ connectionString: required('DATABASE_URL') });
  const userId = required('WIZARD_ADS_E2E_USER_A');
  try {
    const [tenant] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'builder-' + randomUUID()},${userId},'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} limit 1`;
    const profileId = profile!.id;
    const naming = { variable_order: ['Goal', 'AdType', 'MatchType', 'Keyword', 'Custom1'], delimiter: ' / ', custom1_value: 'QA' };
    await db.sql`update public.profile_strategy set doc=jsonb_set(jsonb_set(doc,'{naming}',${JSON.stringify(naming)}::jsonb),'{caps}',${JSON.stringify({ campaign_exposure_ceiling: 2.4 })}::jsonb) where org_id=${orgId}`;
    const [group] = await db.sql<{ id: string }[]>`update public.optimization_groups set bid_floor=0.12,bid_ceiling=0.96 where org_id=${orgId} returning id`;
    await page.setExtraHTTPHeaders({ 'x-wizard-ads-auth-bridge': required('WIZARD_ADS_AUTH_BRIDGE_SECRET'), 'x-wizard-ads-user-id': userId, 'x-wizard-ads-org-id': orgId });
    await page.goto(`/campaigns/new?profile=${profileId}`);
    await expect(page).toHaveURL(new RegExp(`/campaigns\\?profile=${profileId}`));
    await expect(page.getByRole('heading', { name: 'Choose products' })).toBeVisible();
    await page.getByRole('checkbox').check();
    await page.getByLabel('Optimization group').selectOption(group!.id);
    await page.getByLabel('Daily budget', { exact: true }).fill('7.25');
    await page.getByLabel('Starting bid', { exact: true }).fill('0.36');
    await page.getByLabel('Top-of-search adjustment', { exact: true }).fill('140');
    await page.getByRole('button', { name: 'Continue to play & targets' }).click();
    await page.getByLabel('Keywords', { exact: true }).fill('synthetic draft keyword');
    await expect(page.getByText('1 keywords × 1 products = 1 campaigns, 1 keyword each')).toBeVisible();
    await page.getByRole('button', { name: 'Review draft', exact: true }).click();
    await page.getByRole('button', { name: 'Save campaign draft' }).click();
    await expect(page).toHaveURL(/\/campaigns\/draft\?/);
    await page.getByRole('button', { name: 'Validate draft', exact: true }).click();
    await expect(page.getByText(/Budget, name and exposure checks passed for this draft/)).toBeVisible();
    await page.getByRole('button', { name: 'Continue to confirmation' }).click();
    await expect(page.getByRole('button', { name: 'Yes, create 1 campaign in Amazon', exact: true })).toBeDisabled();
    await expect(page.getByText(/Creation in Amazon is not available yet/)).toBeVisible();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export bulk sheet' }).click()]);
    expect(download.suggestedFilename()).toBe('campaign-draft.xlsx');
    const draftId = new URL(page.url()).searchParams.get('draft'); expect(draftId).toBeTruthy();
    const [counts] = await db.sql<{ drafts: string; validated: string; approvals: string }[]>`select count(*)::text as drafts,count(*) filter(where status='validated')::text as validated,count(*) filter(where status='approved')::text as approvals from public.campaign_drafts where org_id=${orgId} and profile_id=${profileId} and created_by=${userId} and id=${draftId}`;
    expect(counts).toEqual({ drafts: '1', validated: '1', approvals: '0' });
    const [mirror] = await db.sql<{ count: string }[]>`select count(*)::text as count from public.campaigns where org_id=${orgId}`;
    expect(mirror?.count).toBe('1');
  } finally { await db.close(); }
}
