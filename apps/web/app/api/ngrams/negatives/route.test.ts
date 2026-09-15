import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { buildNgramNegativeReview } from '@wizard-ads/core';
import { POST } from './route';
const owner = '33333333-3333-4333-8333-333333333333';
let database: TestDatabase, profileId: string, orgId: string;
const previous = {
  database: process.env['DATABASE_URL'],
  bridge: process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'],
  secret: process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET']
};
beforeAll(async () => {
  database = await createTestDatabase('wp266_negative_route');
  const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('ngram-review-fixture',${owner},'owner','2026-06-01') as id`;
  orgId = org!.id;
  const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} order by id limit 1`;
  profileId = profile!.id;
  await database.sql`update public.ad_profiles set target_acos=0.37 where id=${profileId}`;
  await database.sql`delete from public.fact_search_term_daily where org_id=${orgId} and profile_id=${profileId}`;
  await database.sql`insert into public.fact_search_term_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,search_term,match_type,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
 values(${orgId},${profileId},'2026-06-01','SP','c-1','ag-1','kw-1','synthetic component','exact',170,17,37,0,0,0),
 (${orgId},${profileId},'2026-06-01','SP','c-1','ag-1','kw-1','converted component','exact',190,19,7,2,58,2)`;
  process.env['DATABASE_URL'] = database.connectionString;
  process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
  process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = 'synthetic-research-bridge';
}, 120000);
afterAll(async () => {
  for (const [key, value] of [['DATABASE_URL', previous.database], ['WIZARD_ADS_E2E_AUTH_BRIDGE', previous.bridge], ['WIZARD_ADS_AUTH_BRIDGE_SECRET', previous.secret]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await database?.drop();
});
function request(body: unknown) {
  return new Request('http://localhost/api/ngrams/negatives', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wizard-ads-auth-bridge': 'synthetic-research-bridge',
      'x-wizard-ads-user-id': owner,
      'x-wizard-ads-org-id': orgId
    },
    body: JSON.stringify(body)
  });
}
function proposalBody() {
  const review = buildNgramNegativeReview([{
    searchTerm: 'synthetic component',
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    impressions: 170,
    clicks: 17,
    cost: 37,
    purchases7d: 0,
    sales7d: 0
  }], 'synthetic component', 2, {
    targetAcos: 0.37,
    aov: 29
  })!;
  return {
    profileId,
    gram: review.gram,
    n: 2,
    window: {
      start: '2026-06-01',
      end: '2026-06-01'
    },
    selectedTerms: ['c-1|ag-1|synthetic component'],
    proposals: review.rows.map(row => ({
      ...row,
      matchType: 'negative_exact',
      searchTerm: review.gram,
      gramInputs: {
        ...review.options,
        spend: 37,
        sales: 0,
        orders: 0,
        reason: review.candidate.reason
      }
    }))
  };
}
it('creates exactly the reviewed rows with match types and engine inputs intact', async () => {
  const response = await POST(request(proposalBody()));
  expect(await response.clone().json()).toMatchObject({
    created: 1,
    offered: 1
  });
  expect(response.status).toBe(201);
  const rows = await database.sql<{ entity_type: string; proposed_value: string; inputs: { trace: { steps: { label: string; inputs: { name: string; value: unknown }[] }[] } } }[]>`select entity_type,proposed_value,inputs from public.recommendations where org_id=${orgId} and entity_type='negative' and entity_name='synthetic component'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.proposed_value).toBe('negative_exact');
  expect(rows[0]!.inputs.trace.steps[0]!.label).toBe('no_sales_over_target_cpa');
  expect(rows[0]!.inputs.trace.steps[0]!.inputs).toContainEqual({
    name: 'averageOrderValue',
    value: 29,
    unit: 'currency'
  });
});
it('refuses an altered match type or stale engine inputs before any proposal is stored', async () => {
  const body = proposalBody();
  body.proposals[0]!.matchType = 'invalid';
  expect((await POST(request(body))).status).toBe(400);
  const stale = proposalBody();
  stale.proposals[0]!.gramInputs.aov = 31;
  expect((await POST(request(stale))).status).toBe(400);
  const [count] = await database.sql<{ n: number }[]>`select count(*)::int as n from public.recommendations where org_id=${orgId} and entity_type='negative' and entity_name='synthetic component'`;
  expect(count!.n).toBe(1);
});
