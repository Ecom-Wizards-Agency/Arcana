import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { readCreativeWorkspace } from './creative-workspace.js';
import { readCreativeChangeHistory } from './creative-change-history.js';
import { recordEntityChanges } from './entities.js';

describe('creative workspace and recorded observation certainty', () => {
  let db: TestDatabase;
  const owner = randomUUID(), outsider = randomUUID();
  let orgId: string, profileId: string;
  const filter = () => ({ orgId, profileId, from: '2026-08-01', to: '2026-08-31' });
  beforeAll(async () => {
    db = await createTestDatabase('creative_workspace', { throughMigration: '20260915220000_sponsored_prompts.sql' });
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('creative-workspace',${owner},'owner','2026-08-25') as id`;
    orgId = org!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} order by id limit 1`;
    profileId = profile!.id;
    await db.sql`update public.ad_profiles set timezone='UTC' where id=${profileId}`;
    await db.sql`insert into auth.users(id) values(${outsider}) on conflict do nothing`;
    await db.sql`insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,observed_at)
      values(${orgId},${profileId},'campaign','historic-campaign','entity',null,'{}','sync','2026-06-01'),
      (${orgId},${profileId},'campaign','historic-campaign','placementBidding','{}','{"topOfSearch":7}','sync','2026-06-07')`;
    await applySqlFile(db, fileURLToPath(new URL([
      '../../../../supabase/migrations/', '20260915230000', '_creative_completion_and_change_certainty.sql',
    ].join(''), import.meta.url)));
    // Keep the generic fixture observation inside this test's historical window,
    // so the newer synthetic mappings below exercise latest-observation selection.
    await db.sql`update public.ad_creative_asset_mappings set observed_at='2026-08-25'
      where org_id=${orgId} and profile_id=${profileId}`;
    await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type,placement_bidding,synced_at)
      values(${orgId},${profileId},'creative-synced','SB','Synthetic synced campaign','enabled',91,'daily','{"topOfSearch":17,"restOfSearch":0,"productPages":null}','2026-08-01T12:00:00Z'),
      (${orgId},${profileId},'creative-parsed','SB','Explore | SB | Exact | synthetic parsed term | SYN','enabled',91,'daily',null,'2026-08-01T12:00:00Z'),
      (${orgId},${profileId},'creative-unresolved','SB','unstructured synthetic campaign','enabled',91,'daily',null,'2026-08-01T12:00:00Z')`;
    await db.sql`insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,synced_at)
      values(${orgId},${profileId},'creative-group-one','SB','Synthetic group one','enabled','creative-synced','2026-08-01T12:00:00Z'),
      (${orgId},${profileId},'creative-group-two','SB','Synthetic group two','enabled','creative-parsed','2026-08-01T12:00:00Z'),
      (${orgId},${profileId},'creative-group-three','SB','Synthetic group three','enabled','creative-unresolved','2026-08-01T12:00:00Z')`;
    await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
      values(${orgId},${profileId},'creative-keyword-one','SB','enabled','creative-synced','creative-group-one','synthetic synced term','exact',0.73,'2026-08-01T12:00:00Z'),
      (${orgId},${profileId},'creative-keyword-two','SB','enabled','creative-synced','creative-group-one','synthetic synced term','phrase',0.73,'2026-08-01T12:00:00Z')`;
    await db.sql`insert into public.profile_strategy(org_id,profile_id,schema_version,doc)
      values(${orgId},${profileId},'synthetic','{"naming":{"variable_order":["Goal","AdType","MatchType","Keyword","EW"],"delimiter":" | ","suffix":"SYN"}}')
      on conflict(org_id,profile_id) do update set doc=excluded.doc`;
    await db.sql`insert into public.creative_assets(org_id,profile_id,amazon_asset_id,kind,name,first_seen_at,metrics)
      values(${orgId},${profileId},'creative-asset-one','VIDEO','Synthetic measured video','2026-08-01','{"advertisedAsin":"B000000011","width":1440,"height":900,"durationSeconds":19}'),
      (${orgId},${profileId},'creative-asset-two','VIDEO','Synthetic unmeasured video','2026-08-01','{}')`;
    await db.sql`insert into public.creative_placements(org_id,profile_id,asset_id,campaign_id,ad_group_id,ad_id,started_at)
      select ${orgId},${profileId},id,'creative-synced','creative-group-one','creative-ad-one','2026-08-01T12:00:00Z'
      from public.creative_assets where profile_id=${profileId} and amazon_asset_id='creative-asset-one'`;
    await db.sql`insert into public.creative_placements(org_id,profile_id,asset_id,campaign_id,ad_group_id,ad_id,started_at)
      select ${orgId},${profileId},id,link.campaign,link.ad_group,link.ad,'2026-08-01T12:00:00Z'
      from public.creative_assets cross join(values('creative-parsed','creative-group-two','creative-ad-two'),('creative-unresolved','creative-group-three','creative-ad-three')) link(campaign,ad_group,ad)
      where profile_id=${profileId} and amazon_asset_id='creative-asset-two'`;
    await db.sql`insert into public.creative_placements(org_id,profile_id,asset_id,campaign_id,ad_group_id,ad_id,started_at,ended_at)
      select ${orgId},${profileId},id,'creative-synced','creative-group-one','retired-creative-ad','2026-07-01','2026-07-20'
      from public.creative_assets where profile_id=${profileId} and amazon_asset_id='creative-asset-two'`;
    await db.sql`insert into public.ad_creative_asset_mappings(org_id,profile_id,source_mapping_key,ad_product,campaign_id,ad_group_id,ad_id,creative_id,creative_asset_id,amazon_asset_id,attribution_state,observed_at)
      select ${orgId},${profileId},link.source,'SB','creative-synced','creative-group-one','creative-current-ad',link.version,a.id,a.amazon_asset_id,'mapped',link.observed::timestamptz
      from(values('creative-old-observation','creative-old-version','creative-asset-two','2026-08-27'),
        ('creative-new-observation','creative-new-version','creative-asset-one','2026-08-28')) link(source,version,asset,observed)
      join public.creative_assets a on a.org_id=${orgId} and a.profile_id=${profileId} and a.amazon_asset_id=link.asset`;
    await db.sql`insert into public.fact_creative_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,ad_id,creative_id,amazon_asset_id,attribution_state,
      impressions,clicks,cost,purchases,sales,video_first_quartile_views,video_midpoint_views,video_third_quartile_views,video_complete_views)
      values(${orgId},${profileId},'2026-08-20','SB','creative-synced','creative-group-one','creative-ad-one','creative-version-one','creative-asset-one','mapped',730,61,43,7,211,440,330,220,110),
      (${orgId},${profileId},'2026-08-21','SB','creative-synced','creative-group-one','creative-ad-one','creative-version-one','creative-asset-one','mapped',270,19,17,3,89,null,null,null,null)`;
    await db.sql`insert into public.fact_placement_daily(org_id,profile_id,date,ad_product,campaign_id,placement,impressions,clicks,cost,purchases_7d,sales_7d)
      values(${orgId},${profileId},'2026-08-20','SB','creative-synced','top_of_search',1000,100,83,12,377)`;
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  it('backfills old history conservatively without inferring observation cadence from diffs', async () => {
    const rows = await db.sql<{ field: string; certainty: { kind: string; from: string | null; widthDays: number | null } }[]>`
      select field,certainty from public.entity_changes where profile_id=${profileId} and amazon_id='historic-campaign' order by observed_at`;
    expect(rows).toHaveLength(2); expect(rows[0]?.certainty.kind).toBe('first');
    expect(rows[1]?.certainty).toMatchObject({ kind: 'window', from: null, widthDays: null });
  });
  it('resolves synced, explicitly named, and unresolved campaigns without keyword join multiplication', async () => {
    const result = await asUser(db, owner, (sql) => readCreativeWorkspace({ sql }, filter()));
    const campaigns = result.campaigns.filter((row) => row.campaignId.startsWith('creative-'));
    expect(campaigns).toHaveLength(3);
    expect(campaigns.find((row) => row.campaignId === 'creative-synced')).toMatchObject({ keywordText: 'synthetic synced term', keywordProvenance: 'synced', keywordCount: 1 });
    expect(campaigns.find((row) => row.campaignId === 'creative-parsed')).toMatchObject({ keywordText: 'synthetic parsed term', keywordProvenance: 'from_campaign_name' });
    expect(campaigns.find((row) => row.campaignId === 'creative-unresolved')).toMatchObject({ keywordText: null, keywordProvenance: 'unresolved' });
    const asset = result.assets.find((row) => row.assetId === 'creative-asset-one')!;
    expect(asset.performance).toMatchObject({ impressions: 1000, clicks: 80, cost: 60, sales: 300, videoCompleteViews: null });
    expect(asset.advertisedAsin).toBe('B000000011');
    expect(result.assets.find((row) => row.assetId === 'creative-asset-two')).toMatchObject({ performance: null, moderation: null, advertisedAsin: null });
    expect(result.placements.find((row) => row.campaignId === 'creative-synced')).toMatchObject({ cost: 83, modifier: 17 });
    expect(result.campaigns.find((row) => row.campaignId === 'creative-synced')?.adGroups[0]?.assetIds).toEqual(['creative-asset-one']);
  });
  it('keeps the roster in a factless date window and does not supply a missing preset', async () => {
    await db.sql`update public.profile_strategy set doc='{"naming":{}}' where org_id=${orgId} and profile_id=${profileId}`;
    const result = await readCreativeWorkspace(db, { ...filter(), from: '2026-08-02', to: '2026-08-03' });
    expect(result.assets.filter((row) => row.assetId?.startsWith('creative-asset'))).toHaveLength(2);
    expect(result.assets.filter((row) => row.assetId?.startsWith('creative-asset')).every((row) => row.performance === null)).toBe(true);
    expect(result.campaigns.find((row) => row.campaignId === 'creative-parsed')?.keywordText).toBeNull();
  });
  it('stores exact and gap certainty once, preserving it after new observations', async () => {
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":23}',synced_at='2026-08-02T12:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-synced'`;
    await db.sql`insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,observed_at)
      values(${orgId},${profileId},'campaign','creative-synced','placementBidding','{"topOfSearch":17,"restOfSearch":0,"productPages":null}','{"topOfSearch":23}','sync','2026-08-02T12:00:00Z')`;
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":29}',synced_at='2026-08-06T12:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-synced'`;
    await db.sql`insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,observed_at)
      values(${orgId},${profileId},'campaign','creative-synced','placementBidding','{"topOfSearch":23}','{"topOfSearch":29}','sync','2026-08-06T12:00:00Z')`;
    const firstRead = await readCreativeChangeHistory(db, filter());
    const changes = firstRead.filter((row) => row.kind === 'Placement' && row.campaignId === 'creative-synced');
    expect(changes).toHaveLength(2);
    expect(changes[0]?.certainty).toMatchObject({ kind: 'window', widthDays: 4 });
    expect(changes[1]?.certainty).toMatchObject({ kind: 'exact', widthDays: 1 });
    expect(firstRead.filter((row) => row.kind === 'Creative')).toHaveLength(3);
    await db.sql`update public.campaigns set synced_at='2026-08-07T12:00:00Z' where profile_id=${profileId} and amazon_id='creative-synced'`;
    expect(await readCreativeChangeHistory(db, filter())).toEqual(firstRead);
    await expect(db.sql`update public.entity_changes set certainty=jsonb_set(certainty,'{kind}','"first"')
      where profile_id=${profileId} and amazon_id='creative-synced'`).rejects.toThrow('immutable');
  });
  it('isolates tenant reads and denies direct observation ledger writes', async () => {
    expect(await asUser(db, outsider, (sql) => readCreativeChangeHistory({ sql }, filter()))).toEqual([]);
    await expect(asUser(db, outsider, (sql) => readCreativeWorkspace({ sql }, filter()))).rejects.toThrow('not found');
    await expect(asUser(db, owner, (sql) => sql`update public.creative_entity_observations set snapshot='{}' where profile_id=${profileId}`))
      .rejects.toMatchObject({ code: '42501' });
  });
  it('does not skip an intervening observation to find an older matching value', async () => {
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":31}',synced_at='2026-08-08T00:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-synced'`;
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":37}',synced_at='2026-08-08T12:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-synced'`;
    await db.sql`update public.campaigns set placement_bidding='{"topOfSearch":41}',synced_at='2026-08-09T00:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-synced'`;
    const [result] = await db.sql<{ certainty: { kind: string; from: string } }[]>`
      insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,observed_at)
      values(${orgId},${profileId},'campaign','creative-synced','placementBidding','{"topOfSearch":31}','{"topOfSearch":41}','sync','2026-08-09T00:00:00Z') returning certainty`;
    expect(result?.certainty).toMatchObject({ kind: 'window', from: '2026-08-08T12:00:00.000Z' });
  });
  it('does not record a discarded mirror insert as a successful observation', async () => {
    const [before] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.creative_entity_observations where profile_id=${profileId}`;
    await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type,placement_bidding,synced_at)
      values(${orgId},${profileId},'creative-synced','SB','Discarded candidate','enabled',91,'daily','{"topOfSearch":53}','2026-08-10T12:00:00Z')
      on conflict(profile_id,amazon_id) do nothing`;
    const [after] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.creative_entity_observations where profile_id=${profileId}`;
    expect(after?.count).toBe(before?.count);
  });
  it('records consecutive ad-group bid observations as exact when the diff uses a later database timestamp', async () => {
    const current = new Date(Date.now() - 1000);
    const previous = new Date(current.getTime() - 86400000);
    await db.sql`insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,state,campaign_id,default_bid,synced_at)
      values(${orgId},${profileId},'creative-delayed-group','SB','enabled','creative-synced',0.43,${previous.toISOString()}::timestamptz)`;
    await db.sql`update public.ad_groups set default_bid=0.59,synced_at=${current.toISOString()}::timestamptz
      where profile_id=${profileId} and amazon_id='creative-delayed-group'`;
    // This is the generic worker path: observedAt is omitted, so the database
    // records its own time after upsertMirrorRows has stamped the observation.
    expect(await recordEntityChanges(db, [{ orgId, profileId, entityType: 'ad_group', amazonId: 'creative-delayed-group',
      field: 'defaultBid', oldValue: 0.43, newValue: 0.59, source: 'sync' }])).toBe(1);
    const [record] = await db.sql<{ id: string; observed_at: string; certainty: { kind: string; from: string; to: string; widthDays: number } }[]>`
      select id::text,observed_at::text,certainty from public.entity_changes where profile_id=${profileId} and amazon_id='creative-delayed-group'`;
    const recordedAt = new Date(record!.observed_at);
    expect(recordedAt.getTime()).toBeGreaterThan(current.getTime());
    expect(record!.certainty).toEqual({ kind: 'exact', from: previous.toISOString(), to: recordedAt.toISOString(), widthDays: 1 });
    await db.sql`update public.ad_groups set default_bid=0.71,synced_at=clock_timestamp()
      where profile_id=${profileId} and amazon_id='creative-delayed-group'`;
    const [after] = await db.sql<{ certainty: unknown }[]>`select certainty from public.entity_changes where id=${record!.id}`;
    expect(after!.certainty).toEqual(record!.certainty);
  });
  it('keeps an old matching observation pair a window when its change is recorded much later', async () => {
    await db.sql`insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,state,campaign_id,default_bid,synced_at)
      values(${orgId},${profileId},'creative-stale-group','SB','enabled','creative-synced',0.17,'2026-06-01T12:00:00Z')`;
    await db.sql`update public.ad_groups set default_bid=0.23,synced_at='2026-06-02T12:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-stale-group'`;
    const [record] = await db.sql<{ certainty: { kind: string; widthDays: number } }[]>`
      insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,observed_at)
      values(${orgId},${profileId},'ad_group','creative-stale-group','defaultBid','0.17','0.23','sync','2026-06-08T12:00:00Z') returning certainty`;
    expect(record!.certainty).toMatchObject({ kind: 'window', widthDays: 7 });
  });
  it('does not search past a newer mismatching current observation to make a delayed diff exact', async () => {
    await db.sql`insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,state,campaign_id,default_bid,synced_at)
      values(${orgId},${profileId},'creative-mismatched-group','SB','enabled','creative-synced',0.17,'2026-06-01T12:00:00Z')`;
    await db.sql`update public.ad_groups set default_bid=0.23,synced_at='2026-06-02T12:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-mismatched-group'`;
    await db.sql`update public.ad_groups set default_bid=0.29,synced_at='2026-06-02T13:00:00Z'
      where profile_id=${profileId} and amazon_id='creative-mismatched-group'`;
    const [record] = await db.sql<{ certainty: { kind: string; from: string } }[]>`
      insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,observed_at)
      values(${orgId},${profileId},'ad_group','creative-mismatched-group','defaultBid','0.17','0.23','sync','2026-06-02T14:00:00Z') returning certainty`;
    expect(record!.certainty).toMatchObject({ kind: 'window', from: '2026-06-02T12:00:00.000Z' });
  });
  it('counts eligibility campaigns only from placements overlapping the window', async () => {
    await db.sql`insert into public.ad_creative_asset_mappings(org_id,profile_id,source_mapping_key,ad_product,campaign_id,ad_group_id,ad_id,creative_id,
      creative_asset_id,amazon_asset_id,attribution_state,observed_at)
      select ${orgId},${profileId},'creative-eligibility-mapping','SB','creative-parsed','creative-group-two','creative-eligibility-map-ad','creative-map-version',
        id,amazon_asset_id,'mapped','2026-08-28' from public.creative_assets
      where profile_id=${profileId} and amazon_asset_id='creative-asset-one'`;
    await db.sql`insert into public.fact_creative_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,ad_id,creative_id,amazon_asset_id,
      attribution_state,impressions,clicks,cost,purchases,sales)
      values(${orgId},${profileId},'2026-08-22','SB','creative-unresolved','creative-group-three','creative-eligibility-fact-ad','creative-fact-version',
        'creative-asset-one','mapped',11,2,3,1,7)`;
    const result = await readCreativeWorkspace(db, filter());
    const measured = result.assets.find((asset) => asset.assetId === 'creative-asset-one')!;
    expect(measured.campaignIds).toEqual(['creative-parsed', 'creative-synced', 'creative-unresolved']);
    expect(measured.placementCampaignIds).toEqual(['creative-synced']);
    // The retired placement in creative-synced ended before this window.
    expect(result.assets.find((asset) => asset.assetId === 'creative-asset-two')?.placementCampaignIds)
      .toEqual(['creative-parsed', 'creative-unresolved']);
  });
});
