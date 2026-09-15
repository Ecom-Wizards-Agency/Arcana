/**
 * The acceptance check that needs a real database: **group-by ACOS and CVR are
 * verified against SQL aggregates**, not against another copy of the same
 * TypeScript.
 *
 * `packages/ui`'s own suite proves the arithmetic in isolation. This one proves
 * the whole path — Postgres sums, the two-window query, the row mapping, the
 * grid pipeline — lands on the number Postgres itself computes from the same
 * rows. If the query ever starts averaging, or the mapper drops a row, or the
 * comparison window leaks into the selected one, only a test that asks the
 * database for the truth catches it.
 *
 * Skipped, not failed, without a Postgres: the suite has to stay honest on a
 * machine that has none, the same way the `packages/db` suites do.
 */
import { decodeGridRowColumns, decodeGridPerformance } from '@wizard-ads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { ensureFactPartitions, withAuthenticatedActor, storeSpApiRefreshToken, promoteSqpWeeklyFacts } from '@wizard-ads/db';
import { buildGridModel, groupRows, resolveField } from '@wizard-ads/ui';
import type { GridRow } from '@wizard-ads/ui';
import { serializeGridPayloadWithinBudget } from '../app/api/grid/rows/serialize';
import { loadGridRows } from '../app/_lib/grid-data.js';
import { loadBidHistory } from '../app/_lib/bid-corridor.js';
import { listProfiles } from '../app/_lib/profiles.js';
import type { Period } from '../app/_lib/periods.js';

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

const PERIOD: Period = { start: '2026-07-01', end: '2026-07-14' };
const COMPARISON: Period = { start: '2026-06-17', end: '2026-06-30' };

/** Two campaigns whose ACOS is wildly different, so avg-of-ratios ≠ sum/sum. */
const CAMPAIGNS = [
  { id: 'c-skew-a', name: 'Dev | SP | Rank | Widget', spendPerDay: 40, salesPerDay: 40, clicks: 4, orders: 2 },
  { id: 'c-skew-b', name: 'Dev | SP | Profit | Widget', spendPerDay: 10, salesPerDay: 500, clicks: 200, orders: 20 },
];

suite('grid and roster reads against SQL aggregates', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp06_grid');
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06', '00000000-0000-4000-8000-0000000006a1'::uuid) as id
    `;
    orgId = (org as { id: string }).id;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = (profile as { id: string }).id;

    // Facts are partitioned by month; both windows need their partitions to exist.
    await ensureFactPartitions(database, COMPARISON.start, 3);
    await ensureFactPartitions(database, '2020-01-01', 1);

    for (const campaign of CAMPAIGNS) {
      await database.sql`
        insert into public.campaigns
          (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type, targeting_type)
        values (${orgId}, ${profileId}, ${campaign.id}, 'SP', ${campaign.name}, 'enabled', 50, 'daily', 'manual')
        on conflict (profile_id, amazon_id) do nothing
      `;
      await database.sql`
        insert into public.ad_groups
          (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, default_bid)
        values (${orgId}, ${profileId}, ${`${campaign.id}-ag`}, 'SP', 'ad group', 'enabled', ${campaign.id}, 0.8)
        on conflict (profile_id, amazon_id) do nothing
      `;
    }

    // Both windows, so every row has a real comparison figure.
    for (const window of [PERIOD, COMPARISON]) {
      const comparisonFactor = window === COMPARISON ? 0.5 : 1;
      for (let day = 0; day < 14; day += 1) {
        const date = addDays(window.start, day);
        for (const campaign of CAMPAIGNS) {
          for (let target = 0; target < 3; target += 1) {
            await database.sql`
              insert into public.fact_sp_target_daily
                (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
                 match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
              values (${orgId}, ${profileId}, ${date}, 'SP', ${campaign.id}, ${`${campaign.id}-ag`},
                      ${`${campaign.id}-kw${target}`}, 'keyword', 'exact',
                      ${(1000 + target * 10) * comparisonFactor},
                      ${campaign.clicks * comparisonFactor},
                      ${campaign.spendPerDay * comparisonFactor},
                      ${campaign.orders * comparisonFactor},
                      ${campaign.salesPerDay * comparisonFactor},
                      ${campaign.orders * comparisonFactor})
            `;
          }
        }
      }
    }

    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid)
      values
        (${orgId}, ${profileId}, 'c-skew-a-kw0', 'SP', 'widget exact', 'enabled',
         'c-skew-a', 'c-skew-a-ag', 'widget', 'exact', 1.10)
      on conflict (profile_id, amazon_id) do update set bid = excluded.bid
    `;
    await database.sql`
      insert into public.bid_series_daily
        (org_id, profile_id, date, campaign_id, ad_group_id, target_id, is_keyword,
         suggested_bid_low, suggested_bid_median, suggested_bid_high, bid, cpc,
         max_potential_cpc)
      values
        (${orgId}, ${profileId}, '2026-07-13', 'c-skew-a', 'c-skew-a-ag',
         'c-skew-a-kw0', true, 0.60, 0.80, 1.00, 1.00, 0.70, 1.25),
        (${orgId}, ${profileId}, '2026-07-14', 'c-skew-a', 'c-skew-a-ag',
         'c-skew-a-kw0', true, 0.70, 0.90, 1.20, 1.10, 0.75, 1.40)
    `;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('returns one row per target, matching the distinct grain count in SQL', async () => {
    const { rows, rowCount, truncated } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    const [counted] = await database.sql<{ n: string }[]>`
      select count(distinct (campaign_id, ad_group_id, target_id, target_kind, ad_product))::text as n
        from public.fact_sp_target_daily
       where profile_id = ${profileId}
         and date between ${COMPARISON.start} and ${PERIOD.end}
    `;

    expect(truncated).toBe(false);
    // Rule 4: outputs counted against inputs, as an assertion.
    expect(rowCount).toBe(rows.length);
    expect(rows.length).toBe(Number((counted as { n: string }).n));
  });

  it('marks the grid truncated only when a sentinel row exists beyond the limit', async () => {
    const exact = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
      limit: 6,
    });
    const overflow = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
      limit: 5,
    });

    expect(exact.rows).toHaveLength(6);
    expect(exact.rowCount).toBe(exact.rows.length);
    expect(exact.truncated).toBe(false);
    expect(overflow.rows).toHaveLength(5);
    expect(overflow.rowCount).toBe(overflow.rows.length);
    expect(overflow.truncated).toBe(true);
  });

  it('enriches targets with the latest bid series and campaign RPC category', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    const target = rows.find((row) => row.dimensions['target_id'] === 'c-skew-a-kw0');
    expect(target?.dimensions).toMatchObject({
      suggested_bid: 0.9,
      suggested_bid_low: 0.7,
      suggested_bid_high: 1.2,
      bid_corridor_position: 'Within range',
      max_potential_cpc: 1.4,
      rpc_category: 'Rank',
    });
    expect(target?.dimensions['diff_from_suggested_bid']).toBeCloseTo(0.2, 10);
  });

  it('loads one org-scoped target history payload with same-window KPI bases', async () => {
    const history = await loadBidHistory(database, {
      orgId,
      profileId,
      targetId: 'c-skew-a-kw0',
      from: PERIOD.start,
      to: PERIOD.end,
    });
    expect(history?.target).toMatchObject({
      targeting: 'widget',
      matchType: 'exact',
      adProduct: 'SP',
      targetKind: 'keyword',
      campaignId: 'c-skew-a',
    });
    expect(history?.points).toHaveLength(2);
    expect(history?.totals.impressions).toBeGreaterThan(0);
    expect(history?.totals.spend).toBeGreaterThan(0);

    await expect(
      loadBidHistory(database, {
        orgId: '00000000-0000-4000-8000-000000000000',
        profileId,
        targetId: 'c-skew-a-kw0',
        from: PERIOD.start,
        to: PERIOD.end,
      }),
    ).resolves.toBeNull();
  });

  it('computes a grouped ACOS equal to sum(cost)/sum(sales) in Postgres', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    const grouped = groupRows(rows, ['campaign_name']);
    expect(grouped.length).toBe(CAMPAIGNS.length);

    const sqlAggregates = await database.sql<
      { campaign_name: string; acos: string; cvr: string; ctr: string; roas: string; avg_of_acos: string }[]
    >`
      select c.name as campaign_name,
             (sum(f.cost) / nullif(sum(f.sales_7d), 0))::text as acos,
             (sum(f.purchases_7d)::numeric / nullif(sum(f.clicks), 0))::text as cvr,
             (sum(f.clicks)::numeric / nullif(sum(f.impressions), 0))::text as ctr,
             (sum(f.sales_7d) / nullif(sum(f.cost), 0))::text as roas,
             -- The wrong answer, computed on purpose: the mean of the daily
             -- ACOSes. The assertions below require our figure to match the
             -- first column and NOT this one.
             avg(f.cost / nullif(f.sales_7d, 0))::text as avg_of_acos
        from public.fact_sp_target_daily f
        join public.campaigns c
          on c.profile_id = f.profile_id and c.amazon_id = f.campaign_id
       where f.profile_id = ${profileId}
         and f.date between ${PERIOD.start} and ${PERIOD.end}
       group by c.name
    `;

    expect(sqlAggregates).toHaveLength(CAMPAIGNS.length);

    for (const expected of sqlAggregates) {
      const row = grouped.find((candidate) => candidate.dimensions['campaign_name'] === expected.campaign_name);
      expect(row, `no grouped row for ${expected.campaign_name}`).toBeDefined();

      expect(resolveField(row as GridRow, 'acos')).toBeCloseTo(Number(expected.acos), 9);
      expect(resolveField(row as GridRow, 'cvr')).toBeCloseTo(Number(expected.cvr), 9);
      expect(resolveField(row as GridRow, 'ctr')).toBeCloseTo(Number(expected.ctr), 9);
      expect(resolveField(row as GridRow, 'roas')).toBeCloseTo(Number(expected.roas), 9);
    }
  });

  it('is measurably different from averaging the ratios, on this fixture', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    // Everything, across both campaigns: 100% ACOS on one, 2% on the other.
    const [all] = groupRows(rows, ['ad_product']);
    const correct = resolveField(all as GridRow, 'acos') as number;

    const [wrong] = await database.sql<{ avg_of_acos: string }[]>`
      select avg(f.cost / nullif(f.sales_7d, 0))::text as avg_of_acos
        from public.fact_sp_target_daily f
       where f.profile_id = ${profileId}
         and f.date between ${PERIOD.start} and ${PERIOD.end}
    `;

    const averaged = Number((wrong as { avg_of_acos: string }).avg_of_acos);
    expect(correct).toBeGreaterThan(0);
    // If these were close, this whole test would prove nothing.
    expect(Math.abs(correct - averaged)).toBeGreaterThan(0.2);
  });

  it('totals the whole filtered set, not the grouped rows', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    const flat = buildGridModel(rows);
    const grouped = buildGridModel(rows, { groupBy: ['campaign_name'] });

    const [total] = await database.sql<{ spend: string; sales: string }[]>`
      select sum(cost)::text as spend, sum(sales_7d)::text as sales
        from public.fact_sp_target_daily
       where profile_id = ${profileId} and date between ${PERIOD.start} and ${PERIOD.end}
    `;

    expect(flat.totalsRow?.totals.spend).toBeCloseTo(Number((total as { spend: string }).spend), 6);
    expect(grouped.totalsRow?.totals.spend).toBeCloseTo(flat.totalsRow?.totals.spend ?? -1, 6);
    expect(grouped.shown).toBe(CAMPAIGNS.length);
    expect(grouped.matched).toBe(flat.shown);
  });

  it('reads the comparison window separately, and nulls it where nothing reported', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    expect(rows.every((row) => row.comparison !== null)).toBe(true);
    const first = rows[0] as GridRow;
    expect(resolveField(first, 'spend_comparison')).toBeCloseTo(first.totals.spend / 2, 9);
    expect(resolveField(first, 'spend_delta_absolute')).toBeCloseTo(first.totals.spend / 2, 9);
    expect(resolveField(first, 'spend_delta_percent')).toBeCloseTo(1, 9);

    // A comparison window with no facts in it must produce null deltas, not zeroes.
    const empty = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: { start: '2020-01-01', end: '2020-01-14' },
    });
    expect(empty.rows.length).toBeGreaterThan(0);
    expect(empty.rows.every((row) => row.comparison === null)).toBe(true);
    expect(resolveField(empty.rows[0] as GridRow, 'acos_delta_percent')).toBeNull();
  });

  it('never mixes the two windows: the selected period sums exclude comparison days', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    const model = buildGridModel(rows);

    const [selected] = await database.sql<{ spend: string }[]>`
      select sum(cost)::text as spend from public.fact_sp_target_daily
       where profile_id = ${profileId} and date between ${PERIOD.start} and ${PERIOD.end}
    `;
    const [both] = await database.sql<{ spend: string }[]>`
      select sum(cost)::text as spend from public.fact_sp_target_daily
       where profile_id = ${profileId} and date between ${COMPARISON.start} and ${PERIOD.end}
    `;

    expect(model.totalsRow?.totals.spend).toBeCloseTo(Number((selected as { spend: string }).spend), 6);
    expect(Number((both as { spend: string }).spend)).toBeGreaterThan(
      Number((selected as { spend: string }).spend),
    );
  });

  it('marks a search term as harvested when a keyword with that text exists', async () => {
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid, deleted_at)
      values
        (${orgId}, ${profileId}, 'case-duplicate-keyword', 'SP', 'case duplicate', 'enabled',
         'c-skew-a', 'c-skew-a-ag', 'WIDGET', 'exact', 1.00, null),
        (${orgId}, ${profileId}, 'deleted-keyword', 'SP', 'deleted keyword', 'archived',
         'c-skew-a', 'c-skew-a-ag', 'never harvested widget', 'exact', 1.00, now())
      on conflict (profile_id, amazon_id) do nothing
    `;
    await database.sql`
      insert into public.fact_search_term_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, search_term,
         match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      values
        (${orgId}, ${profileId}, ${PERIOD.end}, 'SP', 'c-skew-a', 'c-skew-a-ag', 'c-skew-a-kw0',
         'widget', 'exact', 100, 5, 5, 1, 25, 1),
        (${orgId}, ${profileId}, ${PERIOD.end}, 'SP', 'c-skew-a', 'c-skew-a-ag', 'c-skew-a-kw0',
         'never harvested widget', 'exact', 100, 5, 5, 1, 25, 1)
    `;

    const { rows } = await loadGridRows(database, 'search_terms', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    // The fixture seeds a keyword whose text is exactly "widget".
    const harvested = rows.find((row) => row.dimensions['search_term'] === 'widget');
    const fresh = rows.find((row) => row.dimensions['search_term'] === 'never harvested widget');
    // Two current keywords normalize to "widget"; the precomputed vocabulary
    // must not duplicate the corresponding performance row.
    expect(rows.filter((row) => row.dimensions['search_term'] === 'widget')).toHaveLength(1);
    expect(harvested?.dimensions['harvested']).toBe(true);
    expect(fresh?.dimensions['harvested']).toBe(false);
  });

  it('loads the 3,597-row fixture with authenticated RLS within the server budget', async () => {
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid)
      select ${orgId}, ${profileId}, 'perf-keyword-' || value::text, 'SP',
             'synthetic performance keyword', 'enabled', 'c-skew-a', 'c-skew-a-ag',
             'performance term ' || value::text, 'exact', 1.00
        from generate_series(1, 3597) value
      on conflict (profile_id, amazon_id) do nothing
    `;
    await database.sql`
      insert into public.fact_search_term_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, search_term,
         match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      select ${orgId}, ${profileId}, ${PERIOD.end}, 'SP', 'c-skew-a', 'c-skew-a-ag',
             'c-skew-a-kw0', 'performance term ' || value::text, 'exact',
             100 + value, 5, 5, 1, 25, 1
        from generate_series(1, 3597) value
    `;

    // Fresh test tables otherwise depend on the timing of auto-analyze and can
    // choose a nested-loop plan from one-row estimates. Establish statistics
    // explicitly; this measures the first full read, not a cold-statistics plan.
    await database.sql`analyze public.fact_search_term_daily, public.keywords, public.targets,
      public.campaigns, public.ad_groups, public.org_members, public.orgs, public.ad_profiles`;
    const startedAt = performance.now();
    const { rows, rowCount, truncated } = await withAuthenticatedActor(database, {
      orgId, userId: '00000000-0000-4000-8000-0000000006a1',
    }, (sql) => loadGridRows({ sql }, 'search_terms', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    }));
    const elapsedMs = performance.now() - startedAt;
    const fixtureRows = rows.filter((row) =>
      String(row.dimensions['search_term']).startsWith('performance term '),
    );

    expect(truncated).toBe(false);
    expect(rowCount).toBe(rows.length);
    expect(fixtureRows).toHaveLength(3597);
    expect(fixtureRows.every((row) => row.dimensions['harvested'] === true)).toBe(true);
    expect(elapsedMs).toBeLessThan(process.env['CI'] === undefined ? 2_000 : 5_000);
  }, 20_000);

  it('renders one profile in one currency, and refuses to aggregate across two', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    expect(new Set(rows.map((row) => row.currencyCode))).toEqual(new Set(['USD']));

    const mixed = [...rows, { ...(rows[0] as GridRow), id: 'eur', currencyCode: 'EUR' }];
    expect(() => groupRows(mixed, ['campaign_name'])).toThrow(/refusing to aggregate across currencies/);
  });

  /**
   * The org predicate, checked the only way that means anything: a profile id
   * that really exists, asked for by an org that does not own it. Before the
   * predicate this returned the whole profile, because the web tier connects as
   * the service role and nothing else was standing between the two tenants.
   */
  it('returns nothing for a profile another org owns, at every entity level', async () => {
    const [other] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06-other', '00000000-0000-4000-8000-0000000006b2'::uuid) as id
    `;
    const otherOrgId = (other as { id: string }).id;
    expect(otherOrgId).not.toBe(orgId);

    for (const level of ['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements'] as const) {
      const own = await loadGridRows(database, level, {
        orgId,
        profileId,
        currencyCode: 'USD',
        period: PERIOD,
        comparison: COMPARISON,
      });
      const stolen = await loadGridRows(database, level, {
        orgId: otherOrgId,
        profileId,
        currencyCode: 'USD',
        period: PERIOD,
        comparison: COMPARISON,
      });
      expect(stolen.rows).toEqual([]);
      expect(stolen.rowCount).toBe(0);
      // And the level is one that actually has rows to leak, or the assertion
      // above proves nothing.
      if (level !== 'placements') expect(own.rows.length).toBeGreaterThan(0);
    }
  });

  it('preserves absent current bases from SQL through transport and totals', async () => {
    const payload = await loadGridRows(database, 'targets', { orgId, profileId, currencyCode: 'USD', period: { start: '2026-08-01', end: '2026-08-14' }, comparison: PERIOD });
    expect(payload.rowCount).toBeGreaterThan(0);
    const transported = JSON.parse(serializeGridPayloadWithinBudget(payload).body) as { rows: GridRow[]; rowCount: number };
    expect(transported.rows).toHaveLength(payload.rowCount);
    const model = buildGridModel(transported.rows);
    for (const row of [...transported.rows, model.totalsRow!]) {
      for (const key of ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units', 'acos', 'cpc']) expect(resolveField(row, key)).toBeNull();
    }
    expect(resolveField(model.totalsRow!, 'spend_comparison')).toBeGreaterThan(0);
  });

  it('fits 3597 production-shaped targets with measured comparisons and all fourteen rank days', async () => {
    const source = await loadGridRows(database, 'targets', { orgId, profileId, currencyCode: 'USD', period: PERIOD, comparison: COMPARISON });
    expect(source.rows.length).toBeGreaterThan(0);
    expect(source.rows.every((row) => row.comparison !== null)).toBe(true);
    const rows = Array.from({ length: 3597 }, (_, index) => ({ ...source.rows[index % source.rows.length]!, id: `target:synthetic-${index}` }));
    const rankDays = Object.fromEntries(rows.map((row, index) => [row.id, Array.from({ length: 14 }, (_, day) => ({ date: addDays(PERIOD.start, day), observed: true, rank: index + day + 1 }))]));
    const performance = { ...source.performance!, rankDays };
    const serialized = serializeGridPayloadWithinBudget({ rows, performance, rowCount: rows.length, truncated: false });
    const wire = JSON.parse(serialized.body);
    expect(serialized.byteLength).toBeLessThanOrEqual(4_000_000);
    expect(wire.truncated).toBe(false);
    expect(wire.rowCount).toBe(3597);
    expect(wire.rowColumns).toBeDefined();
    expect(decodeGridRowColumns(wire.rowColumns)).toEqual(rows);
    expect(decodeGridPerformance(wire.performance)).toEqual(performance);
  });

  it('reads early current ranks when the custom comparison follows the current period', async () => {
    const asin = 'B000SYN003';
    try {
      await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,asin)
        values(${orgId},${profileId},'synthetic-rank-window','SP','Synthetic product','enabled','c-skew-a','c-skew-a-ag',${asin})`;
      await database.sql`insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank)
        values(${orgId},${profileId},${asin},'widget','2026-07-10',8),(${orgId},${profileId},${asin},'widget','2026-08-10',12)`;
      const payload = await loadGridRows(database, 'targets', { orgId, profileId, currencyCode: 'USD', period: { start: '2026-07-01', end: '2026-07-31' }, comparison: { start: '2026-08-01', end: '2026-08-31' } });
      const target = payload.rows.find((row) => row.id === 'target:c-skew-a-kw0')!;
      expect(target.dimensions).toMatchObject({ organic_rank: 8, rank_change: 4 });
      expect(payload.performance?.rankDays[target.id]).toBeUndefined();
    } finally {
      await database.sql`delete from public.rank_observations where org_id=${orgId} and asin=${asin}`;
      await database.sql`delete from public.product_ads where org_id=${orgId} and amazon_id='synthetic-rank-window'`;
    }
  });

  it('joins rank and whole SQP weeks, computes TOS ranges and counts unattributed spend from product mirrors', async () => {
    const asin = 'B000SYN001';
    const options = { orgId, profileId, currencyCode: 'USD', period: PERIOD, comparison: COMPARISON };
    const [binding] = await database.sql<{ connection_id: string; marketplace_id: string; enabled: boolean; status: string; vault_secret_id: string | null; sync_enabled: boolean }[]>`
      select b.connection_id,b.marketplace_id,b.enabled,c.status::text,c.vault_secret_id,p.sync_enabled
      from public.spapi_profile_bindings b join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id
      join public.ad_profiles p on p.org_id=b.org_id and p.id=b.profile_id where b.org_id=${orgId} and b.profile_id=${profileId}`;
    expect(binding).toBeDefined();
    let fixtureSecretId: string | null = null;
    try {
      fixtureSecretId = await storeSpApiRefreshToken(database, { orgId, connectionId: binding!.connection_id, refreshToken: 'fake-grid-sqp-refresh-token' });
      await database.sql`update public.spapi_profile_bindings set enabled=true where org_id=${orgId} and profile_id=${profileId}`;
      await database.sql`update public.ad_profiles set sync_enabled=true where org_id=${orgId} and id=${profileId}`;
      await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,asin)
        values(${orgId},${profileId},'synthetic-product-one','SP','Synthetic product','enabled','c-skew-a','c-skew-a-ag',${asin})`;
      await database.sql`insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank)
        values(${orgId},${profileId},${asin},'widget',${COMPARISON.end},12),
        (${orgId},${profileId},${asin},'widget',${PERIOD.start},8),(${orgId},${profileId},${asin},'widget',${PERIOD.end},4)`;
      await database.sql`update public.fact_sp_target_daily set top_of_search_impression_share=case when date=${PERIOD.start} then 0.2 else 0.4 end
        where org_id=${orgId} and profile_id=${profileId} and target_id='c-skew-a-kw0' and date in (${PERIOD.start},${PERIOD.end})`;
      for (const fixture of [
        { weekStart: '2026-07-05', totalImpressions: 1000, asinImpressions: 100, asinClicks: 20, asinPurchases: 4 },
        { weekStart: '2026-07-12', totalImpressions: 10000, asinImpressions: 9000, asinClicks: 100, asinPurchases: 20 },
      ]) {
        const weekEnd = addDays(fixture.weekStart, 6), requestIdentity = `synthetic-grid-sqp-${fixture.weekStart}`;
        const requestedAt = new Date(`${addDays(weekEnd, 1)}T00:00:00Z`), completedAt = new Date(requestedAt.getTime() + 60_000);
        const promoted = await promoteSqpWeeklyFacts(database, {
          orgId, profileId, marketplaceId: binding!.marketplace_id, weekStart: fixture.weekStart, weekEnd,
          requestedAsins: [asin], requestIdentity, requestedAt, completedAt,
          sourceReports: [{ requestKey: requestIdentity, reportId: `report-${requestIdentity}`, reportDocumentId: `document-${requestIdentity}`,
            requestedAt, completedAt, providerCreatedAt: requestedAt, requestedAsins: [asin] }],
          rows: [{ profileId, marketplaceId: binding!.marketplace_id, asin, weekStart: fixture.weekStart, weekEnd,
            searchQuery: 'widget', normalizedQuery: 'widget', category: 'unreviewed', searchQueryScore: null, searchQueryVolume: 100,
            totalImpressions: fixture.totalImpressions, asinImpressions: fixture.asinImpressions, asinImpressionShare: fixture.asinImpressions / fixture.totalImpressions,
            totalClicks: 200, asinClicks: fixture.asinClicks, asinClickShare: fixture.asinClicks / 200,
            totalCartAdds: 0, asinCartAdds: 0, asinCartAddShare: 0, totalPurchases: 20, asinPurchases: fixture.asinPurchases, asinPurchaseShare: fixture.asinPurchases / 20 }],
          counts: { sourceAsins: 1, sourceRows: 1, parsedRows: 1, deduplicatedRows: 1, refusedRows: 0, upserts: 1 },
        });
        expect(promoted).toMatchObject({ sourceRows: 1, parsedRows: 1, deduplicatedRows: 1, promotedRows: 1, canonicalRows: 1 });
      }
      const [stored] = await database.sql<{ rows: number }[]>`select count(*)::int as rows from public.fact_sqp_weekly where org_id=${orgId} and profile_id=${profileId} and marketplace_id=${binding!.marketplace_id} and asin=${asin}`;
      expect(stored?.rows).toBe(2);
      await database.sql`update public.spapi_profile_bindings set enabled=false where org_id=${orgId} and profile_id=${profileId}`;
      const disabled = await loadGridRows(database, 'targets', options);
      expect(disabled.rows.find(row => row.id === 'target:c-skew-a-kw0')?.dimensions['sqp_impression_share']).toBeNull();
      await database.sql`update public.spapi_profile_bindings set enabled=true where org_id=${orgId} and profile_id=${profileId}`;
      const targets = await loadGridRows(database, 'targets', options);
      const target = targets.rows.find((row) => row.dimensions['target_id'] === 'c-skew-a-kw0')!;
      expect(target.dimensions).toMatchObject({ asin, organic_rank: 4, rank_change: 8, top_of_search_range: '20.0–40.0%', break_even_bid: 10, sqp_impression_share: 0.1, sqp_purchase_share: 0.2, market_cvr: 0.1, asin_cvr: 0.2, conversion_points: 10 });
      expect(targets.performance?.rankDays[target.id]).toHaveLength(14);
      expect(targets.performance?.rankDays[target.id]?.filter((day) => day.observed)).toHaveLength(2);
      const products = await loadGridRows(database, 'products', options);
      // A mirrored ASIN and target spend do not establish measured product spend.
      expect(products.rows.find((row) => row.dimensions['asin'] === asin)?.measurement?.missing).toContain('spend');
      expect(products.rows.find((row) => row.dimensions['asin'] === asin)?.dimensions['gap']).toBeNull();
      await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,asin)
        values(${orgId},${profileId},'synthetic-product-two','SP','Synthetic second product','enabled','c-skew-a','c-skew-a-ag','B000SYN002')`;
      const ambiguous = await loadGridRows(database, 'targets', options);
      expect(ambiguous.performance?.unattributed).toEqual({ adGroups: 1, spend: 1680, days: 14 });
      expect(ambiguous.rows.find((row) => row.id === target.id)?.dimensions['organic_rank']).toBeNull();
    } finally {
      await database.sql`delete from public.product_ads where org_id=${orgId} and amazon_id in ('synthetic-product-one','synthetic-product-two')`;
      await database.sql`delete from public.rank_observations where org_id=${orgId} and asin=${asin}`;
      await database.sql`delete from public.fact_sqp_weekly where org_id=${orgId} and asin=${asin}`;
      await database.sql`delete from public.sqp_promotion_runs where org_id=${orgId} and profile_id=${profileId} and request_identity in ('synthetic-grid-sqp-2026-07-05','synthetic-grid-sqp-2026-07-12')`;
      await database.sql`update public.spapi_profile_bindings set enabled=${binding!.enabled} where org_id=${orgId} and profile_id=${profileId}`;
      await database.sql`update public.ad_profiles set sync_enabled=${binding!.sync_enabled} where org_id=${orgId} and id=${profileId}`;
      await database.sql`update public.spapi_connections set status=${binding!.status}::public.connection_status,vault_secret_id=${binding!.vault_secret_id} where org_id=${orgId} and id=${binding!.connection_id}`;
      if (fixtureSecretId !== null && fixtureSecretId !== binding!.vault_secret_id) await database.sql`delete from vault.secrets where id=${fixtureSecretId}`;
      await database.sql`update public.fact_sp_target_daily set top_of_search_impression_share=null where org_id=${orgId} and target_id='c-skew-a-kw0'`;
    }
  });

  it('lists only the asking org’s profiles', async () => {
    const [other] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06-roster', '00000000-0000-4000-8000-0000000006c3'::uuid) as id
    `;
    const otherOrgId = (other as { id: string }).id;

    const mine = await listProfiles(database, orgId);
    const theirs = await listProfiles(database, otherOrgId);
    const [total] = await database.sql<{ n: string }[]>`
      select count(*)::text as n from public.ad_profiles
    `;

    expect(mine.map((row) => row.id)).toContain(profileId);
    expect(theirs.map((row) => row.id)).not.toContain(profileId);
    // Counted against the input, as rule 4 asks: neither roster is the table.
    expect(mine.length).toBeLessThan(Number((total as { n: string }).n));
    expect(theirs.length).toBeGreaterThan(0);
  });
});

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}
