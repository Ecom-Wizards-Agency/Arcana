import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CampaignBuilderRecipe, CampaignBuilderCheck, type CampaignDraft, type CampaignBuilderValidation } from '@wizard-ads/shared';
import { buildCampaignRecipe, campaignRecipeCreationPlan } from '@wizard-ads/campaigns';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { saveCampaignDraft, readCampaignDraft, recordCampaignDraftValidation } from './campaign-drafts.js';
import { saveCampaignNamingPreset, copyCampaignNamingPreset, listCampaignNamingPresets } from './naming-presets.js';
import { saveCampaignKeywordSet, listCampaignKeywordSets } from './keyword-sets.js';
import { createRequestDatabase, type RequestDatabase } from './request-client.js';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
describe.each(['orm', 'request'] as const)('campaign draft and convention persistence through %s client', (client) => {
  let db: TestDatabase; let profileId: string; let draft: CampaignDraft;
  let requestDb: RequestDatabase; let handle: Pick<RequestDatabase, 'sql'>;
  const actor = { orgId: '', userId: randomUUID() }; const other = { orgId: '', userId: randomUUID() };
  beforeAll(async () => {
    db = await createTestDatabase('campaign_drafts');
    requestDb = createRequestDatabase(db.connectionString);
    handle = client === 'request' ? requestDb : db;
    for (const [index, current] of [actor,other].entries()) { const rows = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'builder-' + index},${current.userId},'owner') as id`; current.orgId = rows[0]!.id; }
    const profiles = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${actor.orgId} limit 1`; profileId=profiles[0]!.id;
  }, 60_000);
  afterAll(async () => { await requestDb?.close(); await db?.drop(); });
  function validation(value: CampaignDraft, blocked = false): CampaignBuilderValidation {
    return { planFingerprint: value.plan.fingerprint, recipeFingerprint: digest(JSON.stringify(value.recipe)), checkedAt: new Date().toISOString(), checks: CampaignBuilderCheck.shape.id.options.map((id) => {
      const unmeasured = ['stock', 'buy-box', 'suppression', 'moderation'].includes(id);
      return { id, label: id, source: 'Synthetic evidence', status: unmeasured ? 'not_measured' : blocked && id === 'budget' ? 'blocked' : 'passed', blocking: blocked && id === 'budget', currentValue: 'Synthetic value', requiredAction: blocked && id === 'budget' ? 'Edit budget' : '', ...(id === 'exposure' ? { requiredValue: '$2.40' } : {}) };
    }) };
  }
  it('saves creator-bound plans and transitions draft → validated → blocked → draft on edit', async () => {
    const recipe = CampaignBuilderRecipe.parse({
      adType: 'SP', productKeys: ['synthetic-product'], play: 'rank',
      groupId: randomUUID(), dailyBudget: 7.25,
      keywords: [{ text: 'synthetic keyword', bid: 0.36, basis: 'manual' }],
      structure: 'keyword-product', topOfSearch: 140, audienceAdjustment: 0,
      naming: { variable_order: ['Goal', 'AdType', 'MatchType', 'Keyword', 'Custom1'], delimiter: ' / ', suffix: 'QA', custom1_value: 'QA' }, names: {},
    });
    const bulk = buildCampaignRecipe(recipe,{profile:{id:profileId,label:'Synthetic account',countryCode:'US',currencyCode:'USD',marketplace:null},products:[{key:'synthetic-product',asin:'B000000270',sku:'SKU-SYNTHETIC',name:'Synthetic product',state:'enabled',observedAt:null}],today:'2026-06-10'});
    const plan = campaignRecipeCreationPlan(bulk,{orgId:actor.orgId,profileId,marketplaceId:'synthetic-market',currencyCode:'USD',now:'2026-06-10T00:00:00Z',expiresAt:'2026-06-11T00:00:00Z',uuid:randomUUID,hasher:{algorithm:'sha256',digest}});
    draft=await withAuthenticatedOrgEditor(handle,actor,(tx)=>saveCampaignDraft(tx,{id:randomUUID(),expectedRevision:null,plan,recipe,rationale:[{keyword:'synthetic keyword',sentence:'Frozen synthetic rationale.',frozenAt:plan.frozenAt}]}));
    expect(draft.status).toBe('draft');
    draft=await withAuthenticatedOrgEditor(handle,actor,(tx)=>recordCampaignDraftValidation(tx,draft,validation(draft))); expect(draft.status).toBe('validated');
    draft=await withAuthenticatedOrgEditor(handle,actor,(tx)=>recordCampaignDraftValidation(tx,draft,validation(draft,true))); expect(draft.status).toBe('blocked');
    draft=await withAuthenticatedOrgEditor(handle,actor,(tx)=>saveCampaignDraft(tx,{id:draft.id,expectedRevision:draft.revision,plan:draft.plan,recipe:draft.recipe,rationale:draft.rationale}));
    expect(draft.status).toBe('draft'); expect(draft.validation).toBeNull(); expect(draft.revision).toBe(4);
  });
  it('refuses stale revisions, mismatched exact-plan checks and cross-actor reads', async () => {
    await expect(withAuthenticatedOrgEditor(handle,actor,(tx)=>recordCampaignDraftValidation(tx,{...draft,revision:1},validation(draft)))).rejects.toThrow('draft changed');
    await expect(withAuthenticatedOrgEditor(handle,actor,(tx)=>recordCampaignDraftValidation(tx,draft,{...validation(draft),planFingerprint:'a'.repeat(64)}))).rejects.toThrow();
    expect(await withAuthenticatedReadSnapshot(handle,other,(tx)=>readCampaignDraft(tx,profileId,draft.id))).toBeNull();
    const teammate={orgId:actor.orgId,userId:randomUUID()}; await db.sql`insert into auth.users(id) values (${teammate.userId})`; await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${teammate.userId},'admin')`;
    expect(await withAuthenticatedReadSnapshot(handle,teammate,(tx)=>readCampaignDraft(tx,profileId,draft.id))).toBeNull();
  });
  it('reads the frozen rationale unchanged after strategy changes', async () => {
    draft=await withAuthenticatedOrgEditor(handle,actor,(tx)=>recordCampaignDraftValidation(tx,draft,validation(draft)));
    await db.sql`update public.profile_strategy set doc=jsonb_set(doc,'{caps}',${JSON.stringify({campaign_exposure_ceiling:99})}::jsonb) where org_id=${actor.orgId}`;
    const saved = await withAuthenticatedReadSnapshot(handle,actor,(tx)=>readCampaignDraft(tx,profileId,draft.id));
    expect(saved?.rationale).toEqual(draft.rationale);
    expect(saved?.validation?.checks.find((check)=>check.id==='exposure')?.requiredValue).toBe('$2.40');
  });
  it('saves and copies a convention inside its org and derives usage', async () => {
    const preset=await withAuthenticatedOrgEditor(handle,actor,(tx)=>saveCampaignNamingPreset(tx,{name:'Synthetic convention',naming:draft.recipe.naming}));
    const [destination] = await db.sql<{ id: string }[]>`insert into public.ad_profiles(org_id,connection_id,amazon_profile_id,region,country_code,currency_code,timezone)
      select org_id,connection_id,'2702',region,country_code,currency_code,timezone from public.ad_profiles where id=${profileId} returning id`;
    expect(destination!.id).not.toBe(profileId);
    await withAuthenticatedOrgEditor(handle,actor,(tx)=>copyCampaignNamingPreset(tx,preset.id,destination!.id));
    const [copied] = await db.sql<{ naming: unknown }[]>`select doc->'naming' as naming from public.profile_strategy where org_id=${actor.orgId} and profile_id=${destination!.id}`;
    expect(copied!.naming).toEqual(draft.recipe.naming);
    const presets=await withAuthenticatedReadSnapshot(handle,actor,(tx)=>listCampaignNamingPresets(tx));
    expect(presets.find((item)=>item.id===preset.id)?.usageCount).toBeGreaterThanOrEqual(1);
    const [foreign]=await db.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${other.orgId} limit 1`;
    await expect(withAuthenticatedOrgEditor(handle,actor,(tx)=>copyCampaignNamingPreset(tx,preset.id,foreign!.id))).rejects.toThrow();
  });
  it('round-trips every keyword and refuses cross-org profile sets', async () => {
    const input={id:randomUUID(),profileId,name:'Synthetic set',keywords:['synthetic first','synthetic second']};
    expect(await withAuthenticatedOrgEditor(handle,actor,(tx)=>saveCampaignKeywordSet(tx,input))).toEqual(input);
    expect((await withAuthenticatedReadSnapshot(handle,actor,(tx)=>listCampaignKeywordSets(tx,profileId))).find((set)=>set.id===input.id)?.keywords).toEqual(input.keywords);
    await expect(withAuthenticatedOrgEditor(handle,other,(tx)=>saveCampaignKeywordSet(tx,{...input,id:randomUUID()}))).rejects.toThrow();
  });
});
