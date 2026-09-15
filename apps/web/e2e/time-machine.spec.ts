/** Legacy Time Machine behavior through its query-preserving compatibility route. */
import { expect, test, type Page } from '@playwright/test';
const BRIDGE=process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET']??'';
const ORG_B=process.env['WIZARD_ADS_E2E_ORG_B']??'';
const USER_B=process.env['WIZARD_ADS_E2E_USER_B']??'';
const PROFILE_A=process.env['WIZARD_ADS_E2E_PROFILE_A']??'';
const MARKER='ZZ Time Machine Marker';
test.describe.configure({mode:'serial'});
const url=(params:Record<string,string>={})=>`/time-machine?${new URLSearchParams({profile:PROFILE_A,...params})}`;
async function open(page:Page,params:Record<string,string>={}) { await page.goto(url(params)); await expect(page.locator('main[data-interactive="true"]')).toBeVisible(); }
test('the timeline shows both a sync-detected change and an operator apply',async({page})=>{
  await open(page); await expect(page).toHaveURL(/\/change-queue\?/);
  expect(await page.getByTestId('entry-source').filter({hasText:'changed at Amazon'}).count()).toBeGreaterThan(0);
  expect(await page.getByTestId('entry-source').filter({hasText:'we sent it'}).count()).toBeGreaterThan(0);
  const marker=page.getByTestId('timeline-entry').filter({hasText:MARKER});
  await expect(marker).toHaveCount(1); await expect(marker).toContainText('$10.00');await expect(marker).toContainText('$15.00');
  await expect(page.getByRole('columnheader')).toHaveCount(8);
});
test('the active account is compact and the roster is not rendered as link navigation',async({page})=>{
  await open(page); await expect(page.getByRole('navigation',{name:'Profiles'})).toHaveCount(0);
  await expect(page.locator('main h1')).toHaveCount(0);
  await expect(page.locator('main[data-interactive="true"]')).toHaveAttribute('data-profile-id',PROFILE_A);
});
test('the initial response is bounded and older history remains reachable',async({page})=>{
  const response=await page.goto(url());expect(response).not.toBeNull();expect((await response!.body()).byteLength).toBeLessThan(750000);
  await expect(page.getByTestId('timeline-entry')).toHaveCount(50);await expect(page.getByTestId('timeline-newer')).toHaveCount(0);
  await page.getByTestId('timeline-older').click();await expect(page).toHaveURL(/before_at=/);await expect(page).toHaveURL(/before_id=/);
  await expect(page.getByTestId('timeline-entry')).not.toHaveCount(0);await page.getByTestId('timeline-newer').click();
  await expect(page).not.toHaveURL(/before_at=/);await expect(page.getByText(MARKER)).toHaveCount(1);
});
test('an exhausted history cursor offers a safe return to the newest changes',async({page})=>{
  await open(page,{before_at:'2000-01-01T00:00:00.000Z',before_id:'change:1'});
  await expect(page.getByTestId('timeline-empty-cursor')).toBeVisible();await page.getByTestId('timeline-newer').click();
  await expect(page.getByText(MARKER)).toHaveCount(1);
});
test('PostgreSQL-incompatible cursor timestamps are ignored before the query',async({page})=>{
  for(const before_at of ['2026-02-31T00:00:00.000Z','0000-01-01T00:00:00.000Z']) {
    await open(page,{before_at,before_id:'change:47'});await expect(page.getByText(MARKER)).toHaveCount(1);
    await expect(page.getByTestId('timeline-newer')).toHaveCount(0);await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
  }
});
test('reviews uniquely synchronized evidence and exports an exact inverse file',async({page})=>{
  await open(page,{source:'apply'});
  await page.locator('a[title="tm-e2e-ready-export"]').first().click();
  const preview=page.getByTestId('reversion-preview');await expect(preview.getByTestId('reversion-row')).toHaveCount(1);
  await expect(preview.getByTestId('reversion-row')).toHaveAttribute('data-state','ready');
  await expect(preview).toContainText('$0.90');await expect(preview).toContainText('$0.71');
  await expect(preview).toContainText('Nothing is sent to Amazon from this screen.');
  // Preserve the legacy export API regression check while the new UI uses proposals.
  const batchId=new URL(page.url()).searchParams.get('batch');
  const data={batchId,profileId:PROFILE_A,expectedRows:1,note:'Synthetic E2E reversion review',confirmation:'Yes, export reversion'};
  const response=await page.request.post('/api/time-machine/reversion',{data});
  expect(response.status()).toBe(201);const result=await response.json();
  expect(result.rows).toBe(1);expect(result.amazonUpdated).toBe(false);expect(result.downloads.rows).toMatch(/\/api\/recommendations\/export\/.+\?format=rows/);
});
test('filters narrow by source, entity type and field',async({page})=>{
  await open(page,{source:'apply'});await expect(page.getByText(MARKER)).toHaveCount(0);await expect(page.getByTestId('entry-source').filter({hasText:'changed at Amazon'})).toHaveCount(0);
  await open(page,{source:'sync'});await expect(page.getByText(MARKER)).toHaveCount(1);
  await open(page,{type:'keyword'});await expect(page.getByText(MARKER)).toHaveCount(0);
  await open(page,{type:'campaign'});await expect(page.getByText(MARKER)).toHaveCount(1);
  await open(page,{field:'bid'});await expect(page.getByText(MARKER)).toHaveCount(0);
  await open(page,{field:'budget'});await expect(page.getByText(MARKER)).toHaveCount(1);
  await open(page,{from:'2000-01-01',to:'2000-12-31'});await expect(page.getByTestId('timeline-empty-filtered')).toHaveText('No changes recorded in this range');await expect(page.getByTestId('timeline-entry')).toHaveCount(0);
});
test('the filter form carries the selected values',async({page})=>{
  await open(page,{source:'apply',type:'keyword',field:'bid'});await page.getByText('Filter',{exact:true}).click();
  await expect(page.getByTestId('filter-source')).toHaveValue('apply');await expect(page.getByTestId('filter-type')).toHaveValue('keyword');await expect(page.getByTestId('filter-field')).toHaveValue('bid');await expect(page.getByTestId('filter-clear')).toBeVisible();
});
test.describe('as another tenant',()=>{
  test.use({extraHTTPHeaders:{'x-wizard-ads-auth-bridge':BRIDGE,'x-wizard-ads-user-id':USER_B,'x-wizard-ads-org-id':ORG_B}});
  test("org B sees its own history but never org A's changes",async({page})=>{
    await page.goto('/time-machine');await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
    expect(await page.getByTestId('timeline-entry').count()).toBeGreaterThan(0);await expect(page.getByText(MARKER)).toHaveCount(0);
  });
});
