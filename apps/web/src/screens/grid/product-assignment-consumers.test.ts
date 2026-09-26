import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { ensureFactPartitions, mutateProductAssignment, persistProductAssignments, withAuthenticatedOrgEditor } from '@wizard-ads/db';
import type { ProductAssignmentDerivation } from '@wizard-ads/shared';
import { loadGridRows } from '../../../app/_lib/grid-data';

// The fixture's ad group ag-1 advertises two synthetic children of one synthetic parent.
const owner = '00000000-0000-4000-8000-000000000315';
const [first, second, parent, competitor] = ['B0TEST0001', 'B0TEST0002', 'B000000099', 'B000000055'] as const;
const period = { start: '2026-07-01', end: '2026-07-14' }, comparison = { start: '2026-06-17', end: '2026-06-30' };
let database: TestDatabase, orgId: string, profileId: string;
const options = () => ({ orgId, profileId, currencyCode: 'USD', period, comparison });
const derivation = (source: ProductAssignmentDerivation['source'], assignedAsin: string | null): ProductAssignmentDerivation => ({
  adGroupId: 'ag-1', assignedAsin, source, ambiguous: source === 'proposed', reason: source === 'proposed' || source === 'unassigned' ? 'Synthetic reason.' : null,
  candidates: [first, second].map((asin) => ({ asin, skus: [], parentAsin: null, spend: null })),
});
let derivedAt = Date.parse('2026-07-15T00:00:00Z');
const persist = async (source: ProductAssignmentDerivation['source'], asin: string | null) => {
  derivedAt += 60_000;
  expect(await persistProductAssignments(database, { orgId, profileId }, [derivation(source, asin)], new Date(derivedAt).toISOString())).toMatchObject({ offered: 1 });
};
const target = async () => {
  const payload = await loadGridRows(database, 'targets', options());
  const rows = payload.rows.filter((row) => row.dimensions['target_id'] === 'kw-1');
  expect(rows).toHaveLength(1);
  return rows[0]!.dimensions;
};
const products = async () => (await loadGridRows(database, 'products', options())).rows;

beforeAll(async () => {
  database = await createTestDatabase('wp315_consumers');
  const [org] = await database.sql`select app.seed_tenant_fixture('synthetic-assignment-consumers',${owner},'owner') as id`;
  orgId = String(org!['id']);
  const [profile] = await database.sql`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  profileId = String(profile!['id']);
  await ensureFactPartitions(database, comparison.start, 3);
  // Start from the rule's own output, not the fixture's operator row.
  await database.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin)
    values(${orgId},${profileId},'synthetic-second-ad','SP','enabled','c-1','ag-1',${second})`;
  await database.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,match_type,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
    values(${orgId},${profileId},${period.end},'SP','c-1','ag-1','kw-1','keyword','exact',100,5,4,1,20,1)`;
  await database.sql`insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank)
    values(${orgId},${profileId},${first},'widget',${period.end},11),(${orgId},${profileId},${second},'widget',${period.end},22),(${orgId},${profileId},${parent},'widget',${period.end},33)`;
  await database.sql`insert into public.competitor_links(org_id,profile_id,our_asin,competitor_asin,category,enabled)
    values(${orgId},${profileId},${parent},${competitor},'Synthetic category',true)`;
  await database.sql`insert into public.keepa_bsr_observations(org_id,asin,category,observed_at,bsr)
    values(${orgId},${parent},'Synthetic category',${`${period.end}T12:00:00Z`},500),(${orgId},${competitor},'Synthetic category',${`${period.end}T12:00:00Z`},300)`;
}, 180_000);
afterAll(async () => { await database?.drop(); });

it('reads the target product from the effective assignment whatever its source', async () => {
  // No assignment row yet: the single-product fallback cannot choose between two products.
  expect(await target()).toMatchObject({ asin: null, organic_rank: null });
  await persist('proposed', second);
  expect(await target()).toMatchObject({ asin: second, organic_rank: 22 });
  await withAuthenticatedOrgEditor(database, { orgId, userId: owner }, (context) => mutateProductAssignment(context, { action: 'assign', profileId, adGroupId: 'ag-1', asin: first }));
  expect(await target()).toMatchObject({ asin: first, organic_rank: 11 });
  // A refreshed derivation stays beneath the manual choice until it is reverted.
  await persist('derived_parent', parent);
  expect(await target()).toMatchObject({ asin: first, organic_rank: 11 });
  await withAuthenticatedOrgEditor(database, { orgId, userId: owner }, (context) => mutateProductAssignment(context, { action: 'revert', profileId, adGroupId: 'ag-1' }));
  expect(await target()).toMatchObject({ asin: parent, organic_rank: 33 });
  await persist('derived', first);
  expect(await target()).toMatchObject({ asin: first, organic_rank: 11 });
});

it('lets a saved unassigned outcome win over the single-product fallback', async () => {
  await database.sql`update public.product_ads set deleted_at=now() where org_id=${orgId} and amazon_id='synthetic-second-ad'`;
  try {
    await database.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
    expect(await target()).toMatchObject({ asin: first, organic_rank: 11 });
    await persist('unassigned', null);
    expect(await target()).toMatchObject({ asin: null, organic_rank: null });
  } finally {
    await database.sql`update public.product_ads set deleted_at=null where org_id=${orgId} and amazon_id='synthetic-second-ad'`;
  }
});

it('lists every effectively assigned product in the products preset with its Market position gap', async () => {
  await persist('derived_parent', parent);
  const listed = await products();
  expect(listed.map((row) => row.dimensions['asin']).sort()).toEqual([parent, first, second].sort());
  const parentRow = listed.find((row) => row.dimensions['asin'] === parent)!;
  expect(parentRow.dimensions['gap']).toBe(-200);
  // Assignment lists the product; it never invents advertised-product spend.
  expect(parentRow.measurement?.missing).toContain('spend');
  await database.sql`update public.ad_groups set deleted_at=now() where org_id=${orgId} and amazon_id='ag-1'`;
  try {
    expect((await products()).map((row) => row.dimensions['asin'])).not.toContain(parent);
  } finally {
    await database.sql`update public.ad_groups set deleted_at=null where org_id=${orgId} and amazon_id='ag-1'`;
  }
  await persist('proposed', second);
  expect((await products()).map((row) => row.dimensions['asin']).sort()).toEqual([first, second].sort());
});
