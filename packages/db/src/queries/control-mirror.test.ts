import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CampaignRow, TargetRow } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { mergeControlMirror } from './control-mirror.js';
import { readKeywordMirrorStart } from './keyword-mirror.js';

const owner = '31313131-3131-4131-8131-313131313131';
const completeControls = { strategy: 'manual', placements: { topOfSearch: 300, restOfSearch: 100, productPages: 0, amazonBusiness: null },
  shopperCohorts: [], offAmazonBudgetControlStrategy: null };

describe('ordinary control mirror read windows', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  beforeEach(async () => {
    database = await createTestDatabase('control_windows');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('control-window', ${owner}, 'owner') as id`;
    orgId = org!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} limit 1`;
    profileId = profile!.id;
  }, 60_000);
  afterEach(async () => { await database?.drop(); });
  const targetRow = (bid = 0.3): TargetRow => ({ entityType: 'target', profileId, amazonId: 'tg-1', adProduct: 'SP',
    name: 'Synthetic target', state: 'enabled', campaignId: 'c-1', adGroupId: 'ag-1',
    expression: [{ type: 'asin_same_as', value: 'B000000001' }], resolvedExpression: null, bid });
  const campaignRow = (topOfSearch = 300): CampaignRow => ({ entityType: 'campaign', profileId, amazonId: 'c-1', adProduct: 'SP',
    name: 'Synthetic campaign', state: 'enabled', portfolioId: null, budgetAmount: 25, budgetType: 'daily', targetingType: 'manual',
    biddingStrategy: 'manual', placementBidding: { topOfSearch, restOfSearch: 100, productPages: 0 }, startDate: null, endDate: null });
  const scope = (readStartedAt: string, full = false) => ({ orgId, profileId, adProduct: 'SP' as const, readStartedAt, full });

  async function promoted() {
    const at = await readKeywordMirrorStart(database);
    await database.sql.begin(async (sql) => {
      await sql`select set_config('app.target_bid_read_started_at',${at},true)`;
      await sql`update public.targets set bid=0.3,bid_observed_at=${at}::timestamptz
        where profile_id=${profileId} and amazon_id='tg-1'`;
      await sql`select set_config('app.campaign_control_read_started_at',${at},true)`;
      await sql`update public.campaigns set bidding_strategy='manual',
        placement_bidding='{"topOfSearch":300,"restOfSearch":100,"productPages":0}'::jsonb,
        bidding_control_state=${JSON.stringify(completeControls)}::text::jsonb,bidding_observed_at=${at}::timestamptz
        where profile_id=${profileId} and amazon_id='c-1'`;
    });
    return at;
  }
  async function current(kind: 'target' | 'campaign') {
    const [row] = await database.sql.unsafe<{ value: unknown }[]>(`select to_jsonb(t) as value from public.${kind === 'target' ? 'targets' : 'campaigns'} t
      where profile_id=$1::uuid and amazon_id=$2`, [profileId, kind === 'target' ? 'tg-1' : 'c-1']);
    return row!.value;
  }

  for (const kind of ['target', 'campaign'] as const) {
    const merge = async (at: string, changed = false, full = false, missing = false) => mergeControlMirror(database, kind === 'target'
      ? { ...scope(at, full), entityType: kind, rows: missing ? [] : [targetRow(changed ? 0.4 : 0.3)] }
      : { ...scope(at, full), entityType: kind, rows: missing ? [] : [campaignRow(changed ? 200 : 300)] });
    it(`${kind}: normal sync preserves a promoted control and complete campaign evidence`, async () => {
      const head = await promoted();
      expect(await merge(await readKeywordMirrorStart(database))).toMatchObject({ listed: 1, upserted: 1, staleControlInputs: 0,
        invalidatedCompleteControls: 0 });
      expect(await current(kind)).toMatchObject(kind === 'target' ? { bid: 0.3, deleted_at: null }
        : { bidding_control_state: completeControls, deleted_at: null });
      if (kind === 'campaign') {
        const [clock] = await database.sql<{ unchanged: boolean }[]>`select bidding_observed_at=${head}::timestamptz as unchanged
          from public.campaigns where profile_id=${profileId} and amazon_id='c-1'`;
        expect(clock!.unchanged).toBe(true);
      }
    });
    it(`${kind}: fresh changed values advance evidence and invalidate incompatible completeness`, async () => {
      await promoted();
      const fresh = await readKeywordMirrorStart(database);
      expect(await merge(fresh, true)).toMatchObject({ listed: 1, upserted: 1, currentControlInputs: 1,
        invalidatedCompleteControls: kind === 'campaign' ? 1 : 0 });
      expect(await current(kind)).toMatchObject(kind === 'target' ? { bid: 0.4 }
        : { bidding_control_state: null, placement_bidding: { topOfSearch: 200 } });
    });
    it(`${kind}: fresh deletion is recorded and an old listing cannot resurrect it`, async () => {
      const stale = await promoted();
      const fresh = await readKeywordMirrorStart(database);
      expect(await merge(fresh, false, true, true)).toMatchObject({ tombstonesOffered: 1, tombstoned: 1, staleTombstones: 0 });
      const deleted = await current(kind);
      expect(deleted).not.toMatchObject({ deleted_at: null });
      expect(await merge(stale)).toMatchObject({ staleControlInputs: 1, changes: 0 });
      expect(await current(kind)).toEqual(deleted);
    });
    it(`${kind}: stale changed values and deletion preserve the exact promoted evidence`, async () => {
      const stale = await readKeywordMirrorStart(database);
      await promoted();
      const baseline = await current(kind);
      expect(await merge(stale, true)).toMatchObject({ staleControlInputs: 1, changes: 0 });
      expect(await merge(stale, false, true, true)).toMatchObject({ tombstonesOffered: 1, staleTombstones: 1, tombstoned: 0, changes: 0 });
      expect(await current(kind)).toEqual(baseline);
    });
  }

  it('rejects foreign scope, future reads and precision loss without changing any mirror', async () => {
    const started = await promoted();
    const baseline = await current('target');
    await expect(mergeControlMirror(database, { ...scope(started), orgId: owner, entityType: 'target', rows: [targetRow()] }))
      .rejects.toThrow('scope unavailable');
    await expect(mergeControlMirror(database, { ...scope('9999-01-01T00:00:00.000Z'), entityType: 'target', rows: [targetRow()] }))
      .rejects.toThrow('future');
    await expect(mergeControlMirror(database, { ...scope(await readKeywordMirrorStart(database)), entityType: 'target', rows: [targetRow(0.30001)] }))
      .rejects.toThrow('storage precision');
    expect(await current('target')).toEqual(baseline);
  });
});
