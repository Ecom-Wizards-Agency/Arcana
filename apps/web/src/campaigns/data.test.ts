import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { withAuthenticatedReadSnapshot, withAuthenticatedOrgEditor, createRequestDatabase, type RequestDatabase } from '@wizard-ads/db';
import { loadCampaignBuilderContext } from './data';
import { saveBuilderDraft, validateSavedBuilderDraft, exportBuilderDraft } from './drafts';
describe('campaign builder authenticated evidence loader', () => {
  let db: TestDatabase; let requestDb: RequestDatabase; let profileId: string;
  const actor = { orgId: '', userId: randomUUID() };
  beforeAll(async () => {
    db = await createTestDatabase('builder_context');
    requestDb = createRequestDatabase(db.connectionString);
    const [tenant] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'builder-source-' + randomUUID()},${actor.userId},'owner') as id`;
    actor.orgId = tenant!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${actor.orgId} limit 1`; profileId = profile!.id;
  }, 60_000);
  afterAll(async () => { await requestDb?.close(); await db?.drop(); });
  it('loads every mirrored product, group and saved set and preserves missing CPC evidence', async () => {
    const context = await withAuthenticatedReadSnapshot(requestDb, actor, (snapshot) => loadCampaignBuilderContext(snapshot, profileId));
    expect(context.products).toHaveLength(1); expect(context.groups).toHaveLength(1);
    expect(context.keywordSets).toHaveLength(1); expect(context.presets).toHaveLength(1);
    expect(context.bidEvidence).toEqual([]); expect(context.canEdit).toBe(true);
  });
  it('uses only thirty fully promoted mature days and refuses a gap in source coverage', async () => {
    const end = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const start = new Date(Date.parse(end) - 29 * 86_400_000).toISOString().slice(0, 10);
    const [report] = await db.sql<{ id: string }[]>`insert into public.report_requests(org_id,profile_id,report_type,start_date,end_date,status,rows_parsed,rows_loaded)
      values(${actor.orgId},${profileId},'spTargeting',${start},${end},'completed',30,30) returning id`;
    await db.sql`update public.keywords set keyword_text='synthetic mature keyword' where org_id=${actor.orgId}`;
    await db.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,clicks,cost,report_request_id)
      select ${actor.orgId},${profileId},day::date,'SP','c-1','ag-1','kw-1','keyword',2,1,${report!.id}
      from generate_series(${start}::date,${end}::date,'1 day') as day`;
    await db.sql`insert into public.report_promotion_watermarks(org_id,profile_id,report_type,report_date,source,report_request_id,requested_at,source_rows,parsed_rows,refused_rows,promoted_rows,canonical_rows)
      select ${actor.orgId},${profileId},'spTargeting',day::date,'amazon_reporting_v3',${report!.id},now(),1,1,0,1,1
      from generate_series(${start}::date,${end}::date,'1 day') as day`;
    await db.sql`insert into public.report_coverage(org_id,profile_id,report_type,grain,source,status,earliest_requested_date,latest_loaded_date,latest_settled_date,source_rows,parsed_rows,loaded_rows,refused_rows,counts_match,observed_at)
      values(${actor.orgId},${profileId},'spTargeting','sp_target','amazon_reporting_v3','complete',${start},${end},${end},30,30,30,0,true,now())
      on conflict(profile_id,report_type,grain,source) do update set latest_settled_date=excluded.latest_settled_date,latest_loaded_date=excluded.latest_loaded_date,refused_rows=0,counts_match=true,status='complete'`;
    const read = () => withAuthenticatedReadSnapshot(requestDb, actor, (snapshot) => loadCampaignBuilderContext(snapshot, profileId));
    expect((await read()).bidEvidence).toEqual([{ keyword: 'synthetic mature keyword', clicks: 60, spend: 30, reportedCpc: null, days: 30, start, end, source: 'fact_sp_target_daily', sourceRows: 30, sales: 0 }]);
    await db.sql`delete from public.report_promotion_watermarks where org_id=${actor.orgId} and profile_id=${profileId} and report_type='spTargeting' and report_date=${start}`;
    expect((await read()).bidEvidence).toEqual([]);
  });
  it('saves, validates and exports the exact plan using real mirrored products and strategy', async () => {
    const naming = { variable_order: ['Goal', 'AdType', 'MatchType', 'Keyword', 'Custom1'], delimiter: ' / ', custom1_value: 'QA' };
    await db.sql`update public.profile_strategy set doc=jsonb_set(jsonb_set(doc,'{naming}',${JSON.stringify(naming)}::jsonb),'{caps}',${JSON.stringify({ campaign_exposure_ceiling: 2.4 })}::jsonb) where org_id=${actor.orgId}`;
    await db.sql`update public.optimization_groups set bid_floor=0.12,bid_ceiling=0.96 where org_id=${actor.orgId}`;
    const draft = await withAuthenticatedOrgEditor(requestDb, actor, async (transaction) => {
      const source = await loadCampaignBuilderContext(transaction, profileId);
      return saveBuilderDraft(transaction, { id: randomUUID(), profileId, expectedRevision: null, validate: false,
        recipe: { adType: 'SP', productKeys: source.products.map((product) => product.key), play: 'rank', groupId: source.groups[0]!.id,
          dailyBudget: 7.25, keywords: [{ text: 'synthetic draft keyword', bid: 0.36, basis: 'manual' }], structure: 'keyword-product',
          topOfSearch: 140, audienceAdjustment: 0, naming: source.naming, names: {} } });
    });
    expect(draft.plan.counts.irreversibleCreates).toBe(4);
    const validated = await withAuthenticatedOrgEditor(requestDb, actor, (transaction) => validateSavedBuilderDraft(transaction, profileId, draft.id, draft.revision));
    expect(validated.status).toBe('validated');
    const artifact = await withAuthenticatedReadSnapshot(requestDb, actor, (snapshot) => exportBuilderDraft(snapshot, profileId, draft.id));
    expect(artifact.sheet.rows).toHaveLength(5);
  });
});
