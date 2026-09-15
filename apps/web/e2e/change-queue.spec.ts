import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { serializeApplyRows, type ApplyRow } from '@wizard-ads/shared';
import { createDb, recordEntityChanges } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState, USERS } from './support/fixture';

test('legacy route returns 307 and preserves the selected profile and dates',async({request})=>{
  const {fixtureProfileId:profile}=await readState();
  const params=new URLSearchParams({profile,from:'2026-01-01',to:'2026-01-02'});
  const response=await request.get(`/time-machine?${params}`,{maxRedirects:0});
  expect(response.status()).toBe(307);expect(response.headers()['location']).toBe(`/change-queue?${params}`);
});
test('acknowledging an observed change retains a visible receipt',async({page})=>{
  await signIn(page,'admin');
  const {fixtureProfileId:profile,orgId,connectionString}=await readState();
  const database=createDb({connectionString,max:1});
  try {
    const rows=await database.sql`insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,entity_name,field,old_value,new_value,source)
      values(${orgId},${profile},'keyword','synthetic-queue-marker','Synthetic queue acknowledgement','bid','1','2','sync') returning id`;
    expect(rows).toHaveLength(1);
  } finally {await database.close();}
  await page.goto(`/change-queue?${new URLSearchParams({profile})}`);
  const row=page.getByTestId('timeline-entry').filter({hasText:'Synthetic queue acknowledgement'});
  const badge=page.locator('[data-badge-source="change-queue"]');
  await expect(badge).not.toHaveText('—');
  const before=Number(await badge.textContent());
  expect(Number.isInteger(before)).toBe(true);
  await row.getByLabel('Actions for Synthetic queue acknowledgement').click();
  await row.getByRole('button',{name:'Acknowledge'}).click();
  await expect(row).toContainText('acknowledged');
  await expect(row.getByLabel('Actions for Synthetic queue acknowledgement')).toHaveCount(0);
  await expect(badge).toHaveText(String(before-1));
});
test('captures both screens at 1440 by 1024 in light and dark themes',async({page})=>{
  await signIn(page,'admin');
  const {fixtureProfileId:profile}=await readState();
  const scratch=process.env['WP_SCRATCH'];if(!scratch)throw new Error('WP_SCRATCH is required for browser artifacts');
  const screenshotDirectory=join(scratch,'tmp','wp265-screenshots');
  await page.setViewportSize({width:1440,height:1024});await mkdir(screenshotDirectory,{recursive:true});
  await page.goto(`/change-queue?${new URLSearchParams({profile})}`);
  await expect(page.locator('[data-badge-source="change-queue"]')).not.toHaveText('—');
  await expect(page.locator('main[data-interactive="true"]')).toBeVisible();
  await page.addStyleTag({content:'nextjs-portal { display:none !important; }'});
  const markup=JSON.parse(execFileSync('pnpm',['--config.verify-deps-before-run=false','exec','tsx','src/screens/time-machine/render-visual.tsx'],{encoding:'utf8'})) as Record<string,string>;
  for(const screen of ['change-queue','restore-preview']) {
    await page.locator('main.cq').evaluate((element,html)=>{element.outerHTML=html;},markup[screen]!);
    const frame=await page.locator('main.cq').boundingBox();
    expect(frame).not.toBeNull();
    expect(Math.abs(frame!.x-240)).toBeLessThanOrEqual(2);
    expect(Math.abs(frame!.y-56)).toBeLessThanOrEqual(2);
    expect(Math.abs(frame!.width-1200)).toBeLessThanOrEqual(2);
    await expect(page.getByRole('row')).toHaveCount(screen==='change-queue'?7:8);
    const widths=await page.locator('main th').evaluateAll(cells=>cells.map(cell=>cell.getBoundingClientRect().width));
    const expected=screen==='change-queue'?[130,300,96,92,92,168,300,118]:[250,82,82,82,96,130];
    for(let index=0;index<expected.length;index++) expect(Math.abs(widths[index]!-expected[index]!)).toBeLessThanOrEqual(2);
    const heights=await page.locator('main tbody tr').evaluateAll(rows=>rows.map(row=>row.getBoundingClientRect().height));
    expect(heights.every(height=>Math.abs(height-(screen==='change-queue'?40:38))<=2)).toBe(true);
    for(const theme of ['light','dark']) {
      await page.evaluate(value=>document.documentElement.dataset['theme']=value,theme);
      await page.screenshot({path:join(screenshotDirectory,`${screen}-${theme}.png`)});
      if(screen==='change-queue') {
        const wrapper=page.locator('.cq-table-wrap');
        expect(await wrapper.evaluate(element=>element.scrollWidth>element.clientWidth)).toBe(true);
        await wrapper.evaluate(element=>{element.scrollLeft=element.scrollWidth;});
        await expect(page.getByRole('columnheader',{name:'STATE',exact:true})).toBeInViewport();
        for(const state of ['confirmed','observed','unattributed','awaiting review','approved']) await expect(page.locator('tbody td:last-child').filter({hasText:state}).first()).toBeInViewport();
        await page.screenshot({path:join(screenshotDirectory,`change-queue-state-${theme}.png`)});
        await wrapper.evaluate(element=>{element.scrollLeft=0;});
      }
    }
  }
});

test('persists Change queue filters and density with URL precedence',async({page})=>{
  await signIn(page,'admin');
  const {fixtureProfileId:profile,orgId}=await readState();
  const url=`/change-queue?${new URLSearchParams({profile,source:'sync',density:'compact'})}`;
  await page.goto(url);
  await expect(page.getByLabel('Density',{exact:true})).toHaveValue('compact');
  await expect.poll(()=>page.evaluate(key=>localStorage.getItem(key),['changeQueue','wizard-ads','layout','v2',orgId,USERS.admin].join(':'))).not.toBeNull();
  await page.goto(`/change-queue?${new URLSearchParams({profile})}`);
  await expect(page.getByLabel('Density',{exact:true})).toHaveValue('compact');
  await expect(page.getByTestId('filter-source')).toHaveValue('sync');
  await page.goto(`/change-queue?${new URLSearchParams({profile,source:'apply',density:'comfortable'})}`);
  await expect(page.getByLabel('Density',{exact:true})).toHaveValue('comfortable');
  await expect(page.getByTestId('filter-source')).toHaveValue('apply');
  await page.goto(`/change-queue?${new URLSearchParams({profile,view:'2.e30'})}`);
  await expect(page.getByLabel('Density',{exact:true})).toHaveValue('normal');
  await expect(page.getByTestId('filter-source')).toHaveValue('');
});

test('builds and reviews only the two ready restore rows without creating execution work',async({page})=>{
  await signIn(page,'admin');
  const {fixtureProfileId:profileId,orgId,connectionString}=await readState();
  const db=createDb({connectionString,max:1});
  const batchId=randomUUID(),connectionId=randomUUID(),entities=Array.from({length:7},(_,i)=>`${batchId}-${i}`);
  try {
    const [run]=await db.sql<{id:string}[]>`select id from public.recommendation_runs where org_id=${orgId} and profile_id=${profileId} limit 1`;
    expect(run).toBeDefined();
    // The auth harness starts disconnected for onboarding tests. This guarded
    // preview needs an active synthetic connection, without credentials.
    await db.sql`insert into public.ads_connections(id,org_id,label,status) values(${connectionId},${orgId},'Synthetic restore connection','active')`;
    await db.sql`update public.ad_profiles set connection_id=${connectionId} where org_id=${orgId} and id=${profileId}`;
    const version=randomUUID();
    await db.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select g.grant_id,${version},g.org_id,g.profile_id,true,g.amazon_profile_id,${connectionId},g.region,g.marketplace_id,g.currency_code,g.api_dialect,g.created_by
      from public.sp_write_profile_grant_versions g join public.sp_write_profile_grant_heads h on h.version_id=g.version_id where h.org_id=${orgId} and h.profile_id=${profileId}`;
    await db.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${orgId} and profile_id=${profileId}`;
    const rows:ApplyRow[]=entities.map((entityId,i)=>({entityType:'keyword',entityId,field:i===5?'placement':'bid',old:1,new:2,name:`Synthetic restore ${i+1}`}));
    const hash=createHash('sha256').update(serializeApplyRows(rows)).digest('hex');
    await db.sql`insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,exported_at,exported_proposals,reversible_rows,unsupported_rows,artifact_sha256)
      values(${batchId},${orgId},${profileId},${batchId},'synthetic','bid','Synthetic browser restore',now()-interval '1 hour',7,7,0,${hash})`;
    for(const [i,entity] of entities.entries()) {
      const rec=randomUUID();
      await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
        values(${orgId},${profileId},${entity},'SP','enabled','c-1','ag-1','Synthetic restore','exact',${i===2?3:i===3?1:i===4?4:2},case when ${i===6} then now()-interval '2 hours' else now() end)`;
      await db.sql`insert into public.recommendations(id,run_id,org_id,profile_id,reason,entity_type,entity_id,field,current_value,proposed_value,inputs)
        values(${rec},${run!.id},${orgId},${profileId},'high_acos','keyword',${entity},${i===5?'placement':'bid'},'1','2','{}')`;
      await db.sql`insert into public.apply_rows(id,batch_id,org_id,profile_id,recommendation_id,entity_type,entity_id,entity_name,field,old_value,new_value)
        values(${randomUUID()},${batchId},${orgId},${profileId},${rec},'keyword',${entity},${`Synthetic restore ${i+1}`},${i===5?'placement':'bid'},'1','2')`;
      await db.sql`update public.recommendations set status='exported',export_batch_id=${batchId} where id=${rec}`;
    }
    await recordEntityChanges(db,entities.slice(0,5).map(amazonId=>({orgId,profileId,entityType:'keyword' as const,amazonId,field:'bid',oldValue:1,newValue:2,source:'sync' as const,observedAt:new Date()})));
    // Admission matches each observation to its apply row and batch.
    await db.sql`update public.entity_changes ec set apply_row_id=ar.id,apply_batch_id=ar.batch_id from public.apply_rows ar
      where ar.batch_id=${batchId} and ec.org_id=${orgId} and ec.profile_id=${profileId} and ec.entity_type='keyword' and ec.amazon_id=ar.entity_id and ec.field=ar.field and ec.apply_row_id is null`;
    // Restore evidence needs a mirror read at or after the linked observation; the stale seventh row keeps its old read.
    await db.sql`update public.keywords set synced_at=clock_timestamp() where org_id=${orgId} and profile_id=${profileId} and amazon_id=any(${entities.slice(0,6)}::text[])`;
    await page.goto(`/change-queue?${new URLSearchParams({profile:profileId,batch:batchId})}`);
    await expect(page.getByTestId('reversion-row')).toHaveCount(7);
    await expect(page.locator('.cq-counts')).toHaveText('ROWS IN BATCH7READY TO RESTORE2BLOCKED4NOTHING TO DO1');
    await page.getByRole('button',{name:'Build a restore proposal for 2 rows'}).click();
    await expect(page.getByRole('heading',{name:'Review restore proposal'})).toBeVisible({timeout:60_000});
    await expect(page.locator('tbody tr')).toHaveCount(2);
    const planId=new URL(page.url()).searchParams.get('proposal');expect(planId).not.toBeNull();
    await page.getByRole('link',{name:'Back to Change queue'}).click();
    const proposal=page.getByTestId('timeline-entry').filter({hasText:'Restore proposal · 2 changes'});
    await expect(proposal).toContainText('awaiting review');
    await expect(proposal.getByTestId('entry-source')).toHaveText('restore');
    await proposal.getByRole('link').click();
    await page.getByRole('button',{name:'Approve after checks pass'}).click();
    await expect(page.getByRole('button',{name:'Approved',exact:true})).toBeDisabled();
    const [counts]=await db.sql`select (select count(*)::int from public.sp_write_execution_requests where plan_id=${planId}) as outbox,(select count(*)::int from public.sp_write_provider_call_intents where plan_id=${planId}) as calls`;
    expect(counts).toEqual({outbox:0,calls:0});
  } finally {
    try {await db.sql`delete from public.ads_connections where org_id=${orgId} and id=${connectionId}`;}
    finally {await db.close();}
  }
});
