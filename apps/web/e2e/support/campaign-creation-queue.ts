import { expect, type Page, type TestInfo } from '@playwright/test';
import { type DbHandle } from '@wizard-ads/db';
import { CampaignCreationDraftRouteData } from '@wizard-ads/shared';
import { join } from 'node:path';
import type { CampaignRouteCase } from './campaign-route-cases';

/** Persist synthetic ledger evidence only; no write gates or outbox jobs are enabled. */
export async function captureCreationQueue(page: Page, testInfo: TestInfo, db: DbHandle, cases: CampaignRouteCase[]) {
  const states = ['needs-attention','adopted'] as const;
  for (const key of states) {
    const data = CampaignCreationDraftRouteData.parse(cases.find(item=>item.key===key)!.payload);
    if (data.view !== 'ready' || !data.creationBatch) throw new Error('Missing creation queue fixture');
    const batch = data.creationBatch; const draft = data.draft;
    await db.sql`insert into public.campaign_drafts(id,org_id,profile_id,created_by,plan,recipe,rationale,validation,status,revision)
      values(${draft.id},${draft.orgId},${draft.profileId},${draft.createdBy},${JSON.stringify(draft.plan)}::jsonb,
      ${JSON.stringify(draft.recipe)}::jsonb,${JSON.stringify(draft.rationale)}::jsonb,${JSON.stringify(draft.validation)}::jsonb,'validated',${draft.revision}) on conflict(id) do nothing`;
    await db.sql`insert into public.campaign_creation_batches(id,org_id,profile_id,draft_id,actor_id,parent_batch_id,admission_key,artifact,node_count,admitted_at)
      values(${batch.id},${draft.orgId},${draft.profileId},${draft.id},${draft.createdBy},${batch.lineage?.parentBatchId??null},${'queue-fixture-'+batch.id},${JSON.stringify(batch)}::jsonb,${batch.nodes.length},${batch.admittedAt})`;
    for (const [ordinal,node] of batch.nodes.entries()) {
      await db.sql`insert into public.campaign_creation_batch_nodes(org_id,profile_id,batch_id,node_id,ordinal,node_fingerprint,intent,result,observation,refusal)
        values(${draft.orgId},${draft.profileId},${batch.id},${node.nodeId},${ordinal},${node.nodeFingerprint},${node.intent?JSON.stringify(node.intent):null}::jsonb,
        ${node.result?JSON.stringify(node.result):null}::jsonb,${node.observation?JSON.stringify(node.observation):null}::jsonb,${node.refusal})`;
    }
  }
  await page.setViewportSize({width:1680,height:1024});
  const sourceCases=[['campaign_creation','Campaign creation','needs attention'],['campaign_creation_retry','Campaign creation retry','observed']] as const;
  for (const [source,label,state] of sourceCases) {
    const data=CampaignCreationDraftRouteData.parse(cases.find(item=>item.key==='adopted')!.payload);
    if(data.view!=='ready') throw new Error('Missing profile');
    await page.goto(`/change-queue?${new URLSearchParams({profile:data.draft.profileId,source,from:'2026-06-01',to:'2026-07-01'})}`);
    const rows=page.getByTestId('timeline-entry');await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-source',source);
    await expect(rows.first().getByTestId('entry-source')).toHaveText(label);
    await expect(rows.first()).toContainText(state);
    await expect(rows.first().locator('td').last()).toBeInViewport({ratio:1});
    await expect(rows.first().getByTestId('entry-source')).toBeInViewport({ratio:1});
    await expect(rows.first()).toContainText('4 resources');
    await expect(rows.first().getByRole('link')).toHaveAttribute('href',/\/campaigns\/draft\?profile=.+&draft=.+&batch=.+&step=result/);
    await page.screenshot({path:join(testInfo.outputDir,`change-queue--${source}.png`),animations:'disabled',style:'nextjs-portal { display:none; }'});
  }
  const [counts]=await db.sql<{batches:number;nodes:number;outbox:number}[]>`select
    (select count(*)::int from public.campaign_creation_batches where admission_key like 'queue-fixture-%') as batches,
    (select count(*)::int from public.campaign_creation_batch_nodes n join public.campaign_creation_batches b on b.id=n.batch_id where b.admission_key like 'queue-fixture-%') as nodes,
    (select count(*)::int from public.campaign_creation_outbox o join public.campaign_creation_batches b on b.id=o.batch_id where b.admission_key like 'queue-fixture-%') as outbox`;
  expect(counts).toEqual({batches:2,nodes:8,outbox:0});
}
