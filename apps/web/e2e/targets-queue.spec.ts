import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';

test('target stages an immutable change and review records approval without outbox work',async({page},testInfo)=>{
  await signIn(page,'admin');
  const {fixtureProfileId,orgId,connectionString}=await readState();
  const db=createDb({connectionString,max:1});
  let date:string;
  let from:string;
  try {
    const [day]=await db.sql<{date:string;from:string}[]>`select current_date::text as date,(current_date-12)::text as "from"`; date=day!.date; from=day!.from;
    await db.sql`update public.keywords set bid=5,synced_at=now(),bid_observed_at=null where org_id=${orgId} and profile_id=${fixtureProfileId} and amazon_id='kw-1'`;
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":100,"restOfSearch":0,"productPages":0}' where org_id=${orgId} and profile_id=${fixtureProfileId} and amazon_id='c-1'`;
    await db.sql`update public.optimization_groups set bid_floor=1,bid_ceiling=12,bid_increase_cap=1,bid_decrease_cap=0.5 where org_id=${orgId} and profile_id=${fixtureProfileId}`;
    const seeded = await db.sql`insert into public.bid_series_daily(org_id,profile_id,target_id,campaign_id,ad_group_id,is_keyword,date,bid,suggested_bid_low,suggested_bid_median,suggested_bid_high,max_potential_cpc,modifier_components)
      select ${orgId},${fixtureProfileId},'kw-1','c-1','ag-1',true,current_date-12+n,5,case when n<3 then 4 else 6 end,case when n<3 then 5.85 else 8.4 end,11,10,
        '[{"name":"top_of_search","pct":100,"fullyObserved":true},{"name":"rest_of_search","pct":0,"fullyObserved":true},{"name":"product_pages","pct":0,"fullyObserved":true}]'::jsonb from generate_series(0,12) n
      on conflict(profile_id,date,campaign_id,ad_group_id,target_id) do update set bid=excluded.bid,suggested_bid_low=excluded.suggested_bid_low,suggested_bid_median=excluded.suggested_bid_median,suggested_bid_high=excluded.suggested_bid_high,max_potential_cpc=excluded.max_potential_cpc,modifier_components=excluded.modifier_components returning target_id`;
    expect(seeded).toHaveLength(13);
    const facts = await db.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,match_type,impressions,clicks,cost,sales_7d,purchases_7d,units_sold_7d)
      select ${orgId},${fixtureProfileId},current_date-12+n,'SP','c-1','ag-1','kw-1','keyword','exact',100,10,20+n,100,2,2 from generate_series(0,12) n
      on conflict(profile_id,date,ad_product,campaign_id,ad_group_id,target_id) do update set impressions=excluded.impressions,clicks=excluded.clicks,cost=excluded.cost,sales_7d=excluded.sales_7d,purchases_7d=excluded.purchases_7d,units_sold_7d=excluded.units_sold_7d returning target_id`;
    expect(facts).toHaveLength(13);
    await db.sql`update public.profile_strategy set doc=doc||'{"rank_protection":{"protection_rank":2}}'::jsonb where org_id=${orgId} and (profile_id=${fixtureProfileId} or profile_id is null)`;
    await db.sql`insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank) values(${orgId},${fixtureProfileId},'SYNTHETIC2','widget',current_date,1) on conflict do nothing returning id`;
    const ranks = await db.sql`select organic_rank from public.rank_observations where org_id=${orgId} and profile_id=${fixtureProfileId} and asin='SYNTHETIC2' and keyword='widget' and observed_on=current_date`;
    expect(ranks).toEqual([{organic_rank:1}]);
    const changes = await db.sql`insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source) values(${orgId},${fixtureProfileId},'keyword','kw-1','bid','4','5','sync') returning id`;
    expect(changes).toHaveLength(1);
    const [before]=await db.sql`select count(*)::int as count from public.sp_write_execution_requests`;
    const targetUrl = '/targets/kw-1?' + new URLSearchParams({profile:fixtureProfileId,from,to:date});
    await page.setViewportSize({width:1440,height:1024});
    await page.goto(targetUrl);
    await page.getByRole('button',{name:'Match suggested $8.40'}).click();
    const captureThemes = async (state: string) => {
      for (const theme of ['light','dark']) {
        await page.evaluate((value) => document.documentElement.setAttribute('data-theme',value),theme);
        if (['populated','empty-series','rank-gated'].includes(state)) {
          const regions = await page.locator('article').evaluate((article) => {
            const selectors = ['header','header + div','nav','#target-Corridor > aside','[aria-label="Bid corridor chart"]','[aria-label="Target metrics"]','#target-Corridor > aside:last-child','footer'];
            return selectors.map((selector) => { const r=article.querySelector(selector)!.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; });
          });
          // Canonical 42:2 frame geometry; fixture values change marks, not regions.
          const reference = [[240,56,1200,102],[240,158,1200,74],[240,232,1200,55],[264,287,212,327],[492,287,622,294],[492,581,622,144],[1130,287,286,403],[240,733,1200,62]];
          expect(regions).toHaveLength(reference.length);
          for (const [index,region] of regions.entries()) for (const [coordinate,value] of region.entries()) {
            expect(Math.abs(value-reference[index]![coordinate]!), `${state}/${theme}: region ${index}, coordinate ${coordinate}`).toBeLessThanOrEqual(2);
          }
          await writeFile(testInfo.outputPath(`target-${state}-${theme}-layout.json`),JSON.stringify(regions));
        }
        await page.screenshot({path:testInfo.outputPath(`target-${state}-${theme}.png`),animations:'disabled',style:'nextjs-portal { display: none; }'});
      }
    };
    await captureThemes('populated');
    await page.getByRole('tab',{name:'Performance',exact:true}).click();
    await expect(page.locator('article tbody tr')).toHaveCount(13);
    await page.getByRole('tab',{name:'Changes',exact:true}).click();
    const [changeCount] = await db.sql`select count(*)::int as count from public.entity_changes where org_id=${orgId} and profile_id=${fixtureProfileId} and amazon_id='kw-1' and entity_type in ('keyword','target') and observed_at>=${from}::date and observed_at<${date}::date+interval '1 day'`;
    await expect(page.locator('article tbody tr')).toHaveCount(changeCount!.count);
    await expect(page.locator('article tbody')).toContainText('bid');
    await page.getByRole('tab',{name:'Rank',exact:true}).click();
    await expect(page.locator('article tbody tr')).toHaveCount(1);
    await page.getByRole('tab',{name:'Corridor',exact:true}).click();
    const geometry = await page.locator('article').evaluate((article) => {
      const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { x:r.x,y:r.y,width:r.width,height:r.height } : null; };
      return { header:box(article.querySelector('header')),signals:box(article.querySelector('header + div')),tabs:box(article.querySelector('nav')),
        series:box(article.querySelector('#target-Corridor > aside')),plot:box(article.querySelector('[aria-label="Bid corridor chart"]')),
        lane:box(article.querySelector('[aria-label="Target metrics"]')),summary:box(article.querySelector('#target-Corridor > aside:last-child')),footer:box(article.querySelector('footer')) };
    });
    await writeFile(testInfo.outputPath('target-layout-measurements.json'),JSON.stringify(geometry,null,2));
    await testInfo.attach('target-layout-measurements', { body: JSON.stringify(geometry,null,2),contentType:'application/json' });
    await page.getByLabel('Proposed bid').fill('4');
    await expect(page.getByRole('button',{name:'Add to change queue'})).toBeDisabled();
    await captureThemes('rank-gated');
    await page.getByRole('button',{name:'Match suggested $8.40'}).click();
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/targets/kw-1/queue' && response.request().method()==='POST');
    await page.getByRole('button',{name:'Add to change queue'}).click();
    const response = await responsePromise;
    expect(response.status(),await response.text()).toBe(201);
    const staged = await response.json() as { id: string };
    expect(staged.id).toEqual(expect.any(String));
    const approvalPath = '/api/targets/kw-1/queue/' + encodeURIComponent(staged.id);
    await expect(page.getByRole('status')).toContainText('Change added to queue');
    await page.screenshot({path:testInfo.outputPath('target-queued.png')});
    await page.getByRole('link',{name:'Review queued change'}).click();
    await expect(page.getByRole('heading',{name:'Review queued change'})).toBeVisible();
    await expect(page.locator('main li')).toHaveCount(5);
    await expect(page.getByRole('button',{name:'Approve after checks pass'})).toBeEnabled();
    await page.screenshot({path:testInfo.outputPath('target-review-ready.png'),style:'nextjs-portal { display: none; }'});
    await expect(page.getByRole('status')).toBeEmpty();
    const approvalResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === approvalPath);
    await page.getByRole('button',{name:'Approve after checks pass'}).click();
    await expect(page.getByRole('status')).toContainText('Approval was recorded');
    const approval = await approvalResponse;
    expect(approval.ok()).toBe(true);
    const timing = approval.headers()['server-timing'];
    expect(timing).toContain('total;dur=');
    console.log(`Target approval Server-Timing: ${timing}`);
    await testInfo.attach('approval-server-timing', {body:timing!,contentType:'text/plain'});
    expect((await approval.json()).approval.approvedAt).toBeTruthy();
    await page.screenshot({path:testInfo.outputPath('target-approved.png')});
    const [after]=await db.sql`select count(*)::int as count from public.sp_write_execution_requests`;
    expect(after).toEqual(before);
    await page.goto(targetUrl);
    await page.getByLabel('Proposed bid').fill('12');
    await page.getByRole('button',{name:'Add to change queue'}).click();
    await page.getByRole('link',{name:'Review queued change'}).click();
    await expect(page.getByRole('button',{name:'Approve after checks pass'})).toBeDisabled();
    await expect(page.locator('main li').filter({hasText:'Fail'})).toHaveCount(2);
    await page.screenshot({path:testInfo.outputPath('target-review-blocked.png'),style:'nextjs-portal { display: none; }'});
    await page.getByRole('link',{name:'View target and limits'}).click();
    const limits = page.getByRole('region',{name:'Current bid limits'});
    await expect(limits).toContainText('Minimum bid$1.00');
    await expect(limits).toContainText('Maximum bid$12.00');
    await expect(limits).toContainText('Maximum increase100.0%');
    await page.screenshot({path:testInfo.outputPath('target-limits.png'),style:'nextjs-portal { display: none; }'});
    await db.sql`delete from public.bid_series_daily where org_id=${orgId} and profile_id=${fixtureProfileId} and target_id='kw-1' and date between ${from} and ${date}`;
    await page.goto(targetUrl);
    await expect(page.getByText('The bid series is empty.',{exact:false})).toBeVisible();
    await captureThemes('empty-series');
    await page.getByRole('tab',{name:'Shelf',exact:true}).click();
    await expect(page.getByText("Product evidence is missing for this target's advertised ASINs.")).toBeVisible();
    await captureThemes('not-measured');
  } finally { await db.close(); }
});
