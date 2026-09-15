import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
import { researchScreenshots } from './support/research-screenshots';
test('N-grams queues exactly the reviewed negative rows with calculation inputs', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const { fixtureProfileId, orgId, connectionString } = await readState();
  const db = createDb({ connectionString });
  try {
    await db.sql`update public.ad_profiles set target_acos=0.37 where id=${fixtureProfileId}`;
    const inserted = await db.sql`insert into public.fact_search_term_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,search_term,match_type,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d) values(${orgId},${fixtureProfileId},'2026-08-02','SP','c-1','ag-1','kw-1','synthetic component','exact',170,17,37,0,0,0),(${orgId},${fixtureProfileId},'2026-08-02','SP','c-1','ag-1','kw-1','converted component','exact',190,19,7,2,58,2) returning search_term`;
    expect(inserted).toHaveLength(2);
    await signIn(page, 'admin');
    await page.goto(`/ngrams?${new URLSearchParams({profile:fixtureProfileId,from:'2026-08-02',to:'2026-08-02'})}`);
    await expect(page.getByText('The search-terms column is locked and cannot be hidden.', { exact: true })).toBeVisible();
    await page.getByTestId('grid-row').filter({ hasText: 'synthetic component' }).click();
    await page.getByRole('button', {
      name: 'Review negative keyword',
      exact: true
    }).click();
    await page.getByRole('button', {
      name: 'View calculation',
      exact: true
    }).click();
    await expect(page.getByRole('dialog')).toContainText('ACOS is undefined');
    await page.keyboard.press('Escape');
    await page.getByRole('button', {
      name: 'Accept proposal',
      exact: true
    }).click();
    await expect(page.getByRole('heading', {
      name: 'Negative keywords queued',
      exact: true
    })).toBeVisible();
    const rows = await db.sql`select id,inputs from public.recommendations where org_id=${orgId} and entity_type='negative' and entity_name='synthetic component'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['inputs']).toHaveProperty('trace');
    await researchScreenshots(page, testInfo, 'ngrams');
  } finally {
    await db.sql.end();
  }
});
