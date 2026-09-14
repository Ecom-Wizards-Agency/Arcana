import { expect, test } from '@playwright/test';
import { createDb } from '@wizard-ads/db';
import { signIn } from './support/auth';
import { readState } from './support/fixture';
test('timeline measures facts, filters and zooms events, records revisions and preserves rank gaps', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    await page.setViewportSize({ width: 1440, height: 1024 });
    const state = await readState();
    const db = createDb({ connectionString: state.connectionString });
    try {
        await db.sql`select app.ensure_fact_partitions('2026-07-01'::date, 1)`;
        await db.sql`delete from public.fact_profile_daily where org_id=${state.orgId} and profile_id=${state.fixtureProfileId}`;
        await db.sql `insert into public.fact_profile_daily(org_id,profile_id,date,currency_code,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
      select ${state.orgId},${state.fixtureProfileId},d::date,'USD',1000,100,1000-5*(d::date-'2026-07-11'::date),10,2000-8*(d::date-'2026-07-11'::date),10 from generate_series('2026-07-11'::date,'2026-08-28'::date,'1 day') d`;
        const [product] = await db.sql<{
            asin: string;
        }[]> `select asin from public.product_ads where org_id=${state.orgId} and profile_id=${state.fixtureProfileId} and asin is not null limit 1`;
        if (!product)
            throw new Error('Synthetic advertised product required');
        await db.sql `insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank) values
      (${state.orgId},${state.fixtureProfileId},${product.asin},'Synthetic tracked keyword','2026-08-18',12),
      (${state.orgId},${state.fixtureProfileId},${product.asin},'Synthetic tracked keyword','2026-09-06',1)`;
        await db.sql `insert into public.keepa_bsr_observations(org_id,asin,category,observed_at,bsr) values
      (${state.orgId},${product.asin},'Timeline category','2026-08-18T12:00:00Z',1500),
      (${state.orgId},${product.asin},'Timeline category','2026-09-06T12:00:00Z',900)`;
        await db.sql`insert into public.apply_batches(org_id,profile_id,tag,opt_group,lever,note,status,applied_on)
          values(${state.orgId},${state.fixtureProfileId},'Synthetic bid adjustment','Synthetic group','bid','Observed application','applied','2026-08-24')`;
        await db.sql`insert into public.timeline_events(org_id,profile_id,name,kind,start_on,end_on,scope_text,note,created_by)
          select ${state.orgId},${state.fixtureProfileId},e.name,e.kind,e.start_on::date,e.end_on::date,'Recorded scope','Synthetic observation',u.user_id
          from (values ('Synthetic listing revision','listing','2026-07-18','2026-08-01'),
            ('Synthetic seasonal market','market','2026-07-08','2026-07-12'),
            ('Synthetic stock interruption','supply','2026-08-03','2026-08-06'),
            ('Seasonal promotion','promotion','2026-08-09','2026-08-30')) e(name,kind,start_on,end_on)
          cross join lateral (select user_id from public.org_members where org_id=${state.orgId} and role in ('owner','admin') order by user_id limit 1) u`;
        await signIn(page, 'admin');
        const params = new URLSearchParams({ profile: state.fixtureProfileId, from: '2026-07-11', to: '2026-09-07' });
        await page.goto(`/timeline?${params}`);
        await expect(page.getByRole('main', { name: 'Timeline details' })).toBeVisible();
        await expect(page.getByText(/49 days of facts.*no facts after 28 Aug/)).toBeVisible();
        await expect(page.getByTestId('timeline-measure')).toHaveCount(6);
        await page.getByRole('button', { name: 'Record event', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Record event' });
        await dialog.getByLabel('Name', { exact: true }).fill('Synthetic promotion');
        await dialog.getByLabel('Starts', { exact: true }).fill('2026-08-01');
        await dialog.getByLabel('Ends', { exact: true }).fill('2026-08-15');
        await dialog.getByRole('button', { name: 'Save event' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Synthetic promotion', exact: true })).toBeVisible();
        await expect(page.getByTestId('timeline-event')).toHaveCount(7);
        await page.getByRole('button', {name:'market', exact:true}).click();
        await page.getByRole('button', {name:'listing', exact:true}).click();
        await expect(page.getByText('2 kinds hidden · 5 of 7 events shown')).toBeVisible();
        await page.getByTestId('timeline-measure').nth(2).click();
        await page.getByTestId('timeline-measure').nth(3).click();
        await expect(page.getByText('4 of 4 selected')).toBeVisible();
        await page.reload();
        await expect(page.getByText('4 of 4 selected')).toBeVisible();
        const screenshot = async (name: string) => { for (const theme of ['light', 'dark']) {
            await page.mouse.move(0,0);
            await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' });
            const toggle = page.getByTestId('theme-toggle');
            await expect(toggle).toHaveText(/(?:Light|Dark)$/);
            if (await toggle.getAttribute('aria-label') === `Switch to ${theme} mode`) await toggle.click();
            await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
            await page.evaluate(() => { window.scrollTo(0,0); (document.activeElement as HTMLElement | null)?.blur(); });
            const path = testInfo.outputPath(`${name}-${theme}-1440x1024.png`);
            await page.screenshot({ path, animations: 'disabled', style: 'nextjs-portal { display: none; }' });
            await testInfo.attach(`${name} ${theme}`, { path, contentType: 'image/png' });
        } };
        const markerBoxes = await page.getByTestId('event-marker-label').evaluateAll((labels) => labels.map((label) => { const box=label.getBoundingClientRect(); return {left:box.left,right:box.right,top:box.top,bottom:box.bottom}; }));
        for (let i=0;i<markerBoxes.length;i++) for(let j=i+1;j<markerBoxes.length;j++) {
            const a=markerBoxes[i]!,b=markerBoxes[j]!;
            expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
        }
        const readRight = await page.locator('.tl-table th').last().evaluate((cell)=>cell.getBoundingClientRect().right);
        expect(readRight).toBeLessThanOrEqual(1336);
        await screenshot('overview');
        await page.getByRole('button', { name: 'Synthetic promotion', exact: true }).click();
        await expect(page.getByTestId('outside-event-window')).toHaveCount(2);
        await expect(page.getByText('Spend was already falling before this experiment started')).toBeVisible();
        await screenshot('zoom');
        await page.getByRole('button', { name: /Back to/ }).click();
        await page.getByRole('button', { name: 'Organic rank', exact: true }).click();
        await expect(page.getByText(/Last observation 6 Sep/)).toBeVisible();
        expect(await page.locator('[data-series-mark="line"] path').count()).toBe(0);
        await expect(page.getByRole('heading', {name:'Timeline',exact:true})).toHaveCount(0);
        await expect(page.getByRole('link', {name:'Create experiment'})).toHaveCount(0);
        await expect(page.getByRole('button', {name:'Record event',exact:true})).toHaveCount(0);
        expect(await page.locator('.tl-rank-heading').boundingBox()).toMatchObject({height: expect.any(Number)});
        await screenshot('organic');
        await page.getByRole('button', {name:'Rank information', exact:true}).click();
        await expect(page.getByRole('dialog', {name:'Rank information'})).toContainText('Missing rank is not rank zero');
        await page.getByRole('dialog', {name:'Rank information'}).getByRole('button', {name:'Close',exact:true}).click();
        await page.getByRole('button', {name:'Change keyword or product'}).click();
        await expect(page.getByRole('dialog', {name:'Rank scope'}).getByLabel('Keyword')).toBeVisible();
        await page.getByRole('dialog', {name:'Rank scope'}).getByRole('button', {name:'Done',exact:true}).click();
        await page.getByTestId('timeline-event').filter({hasText:'Synthetic promotion'}).getByRole('button',{name:'View event'}).click();
        await page.getByRole('button',{name:'Supersede event',exact:true}).click();
        const revision = page.getByRole('dialog',{name:'Supersede event'});
        await revision.getByLabel('Name',{exact:true}).fill('Revised synthetic promotion');
        await revision.getByRole('button',{name:'Save event'}).click();
        await expect(revision).toHaveCount(0);
        await expect(page.getByTestId('timeline-event').filter({hasText:'Revised synthetic promotion'})).toHaveCount(1);
        const historyResponse = await page.request.get(`/api/timeline?profile=${state.fixtureProfileId}`);
        expect(historyResponse.ok()).toBe(true);
        const history = await historyResponse.json() as {items:{name:string}[];count:number};
        expect(history.items).toHaveLength(history.count);
        expect(history.items.filter((item)=>['Synthetic promotion','Revised synthetic promotion'].includes(item.name))).toHaveLength(2);
        await page.getByRole('button', { name: 'BSR', exact: true }).click();
        await expect(page.getByText(/Best Sellers Rank/)).toBeVisible();
        await screenshot('bsr');
        // A selected range without observations retains the same rank controls.
        const rankUrl = page.url();
        const missing = new URL(rankUrl);
        missing.searchParams.set('from','2026-09-08');
        missing.searchParams.set('to','2026-09-10');
        await page.goto(missing.pathname+missing.search);
        await page.getByRole('button',{name:'Organic rank',exact:true}).click();
        await expect(page.getByText('Rank not measured for this selection')).toBeVisible();
        await expect(page.getByRole('heading',{name:'Timeline',exact:true})).toHaveCount(0);
        await screenshot('rank-missing');
        await page.goto(new URL(rankUrl).pathname+new URL(rankUrl).search);
        await page.getByRole('button', {name:'Performance',exact:true}).click();
        await page.getByRole('link', { name: 'Create experiment' }).click();
        await expect(page.locator('main.tl-create[data-interactive="true"]')).toBeVisible();
        await expect(page.getByTestId('experiment-name')).toBeVisible();
        await page.getByTestId('experiment-name').fill('Timeline synthetic experiment');
        await expect(page.getByTestId('shell-title')).toHaveText('New experiment');
        await page.getByTestId('experiment-hypothesis').fill('A recorded prediction');
        await page.getByLabel('Starts',{exact:true}).fill('2026-08-01');
        await page.getByLabel('Ends',{exact:true}).fill('2026-08-15');
        await expect(page.getByText('Left open while an experiment is still running.')).toBeVisible();
        await page.getByTestId('scope-targets').fill('timeline-inferred-target');
        const [linked] = await db.sql<{id:string}[]>`insert into public.apply_batches(org_id,profile_id,tag,opt_group,lever,note,status,applied_on)
          values(${state.orgId},${state.fixtureProfileId},'1038','Synthetic group','bid','Observed application','applied','2026-08-09') returning id`;
        await db.sql`insert into public.apply_rows(batch_id,org_id,profile_id,entity_type,entity_id,field,new_value)
          values(${linked!.id},${state.orgId},${state.fixtureProfileId},'target','timeline-inferred-target','bid','3.4'::jsonb)`;
        await screenshot('create');
        await page.getByRole('button', { name: 'Save as planned', exact: true }).click();
        await expect(page.locator('main.tl-experiment-detail[data-interactive="true"]')).toBeVisible();
        await expect(page.getByTestId('shell-title')).toHaveText('Experiment');
        await expect(page.getByTestId('experiment-status')).toContainText('Planned');
        const readback = await page.request.get(`/api/experiments/${new URL(page.url()).pathname.split('/').at(-1)}`);
        expect((await readback.json()).item.endAt).toBe('2026-08-15T00:00:00.000Z');
        await page.getByTestId('transition-running').click();
        await expect(page.getByTestId('experiment-status')).toContainText('Running');
        await expect(page.getByTestId('inferred-batch-note')).toContainText('Inferred: Bid moved to $3.40 in batch 1038');
        await page.getByTestId('result-note').fill('Synthetic observed result');
        await page.getByTestId('transition-ended').click();
        await expect(page.getByTestId('experiment-status')).toContainText('Ended');
        await page.getByTestId('transition-analyzed').click();
        await expect(page.getByTestId('experiment-status')).toContainText('Analyzed');
        await screenshot('status-trail');
    }
    finally {
        await db.close();
    }
});
