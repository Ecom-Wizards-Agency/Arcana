/**
 * WP-321 reproduction on the synthetic tenant fixture: the Campaigns summary
 * strip above the grid read "—" while the rows below it carried figures.
 *
 * The gate was the aggregate's measurement union. A campaign listed only for its
 * comparison-window facts has no fact row in the selected window, so its SQL
 * window sums are NULL and `measurementOf` marks all six bases missing. The
 * strip's `grandTotal` then unioned that row's `missing` list into the total, and
 * one silent campaign blanked every card. The comparison window had the mirror
 * gate: one campaign without comparison facts marked every comparison base
 * missing. Both totals below are asked of Postgres, not recomputed in TypeScript.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { resolveField, type SavedView } from '@wizard-ads/ui';
import { promoteCoreReportWindow, readGridSummaryEvidence } from '@wizard-ads/db';
import { CORE_REPORT_FAMILIES, type CoreReportConfiguration, type CoreReportPromotion } from '@wizard-ads/shared';
import { loadGridRows } from '../../../app/_lib/grid-data';
import { buildPerformanceModel } from './performance-model';
import { PerformanceSummary } from './performance-chrome';
import { formatDateWindow, formatShellDate } from '../../ui/date-format';

const PERIOD = { start: '2026-08-17', end: '2026-09-15' };
const COMPARISON = { start: '2026-07-18', end: '2026-08-16' };
/** Enabled campaigns: steady in both windows, stopped before the period, launched inside it. */
const CAMPAIGNS = [
  { id: 'wp321-steady', dates: ['2026-07-20', '2026-08-20', '2026-09-10'], cost: 12.5, sales: 50 },
  { id: 'wp321-stopped', dates: ['2026-07-25', '2026-08-01'], cost: 7.25, sales: 20 },
  { id: 'wp321-launched', dates: ['2026-09-01', '2026-09-14'], cost: 3.1, sales: 0 },
] as const;

let database: TestDatabase;
let orgId: string;
let profileId: string;

beforeAll(async () => {
  database = await createTestDatabase('wp321_summary');
  const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`synthetic-wp321-${randomUUID()}`}, ${randomUUID()}, 'owner') as id`;
  orgId = org!.id;
  const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId} limit 1`;
  profileId = profile!.id;
  await database.sql`select * from app.ensure_fact_partitions(${COMPARISON.start}::date, 2)`;
  for (const campaign of CAMPAIGNS) {
    await database.sql`insert into public.campaigns (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type, targeting_type)
      values (${orgId}, ${profileId}, ${campaign.id}, 'SP', ${`Synthetic ${campaign.id}`}, 'enabled', 40, 'daily', 'manual')`;
    for (const date of campaign.dates) {
      await database.sql`insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
        values (${orgId}, ${profileId}, ${date}, 'SP', ${campaign.id}, ${`${campaign.id}-ag`}, ${`${campaign.id}-kw`}, 'keyword', 'exact', 400, 9, ${campaign.cost}, 1, ${campaign.sales}, 1)`;
    }
  }
}, 120_000);

afterAll(async () => { await database?.drop(); });

/** The fixture seeds its own facts too, so the held span is asked of Postgres. */
async function sqlSpan(table: 'fact_sp_target_daily' | 'fact_search_term_daily' | 'fact_placement_daily'): Promise<[string, string]> {
  const [row] = await database.sql<{ held_from: string; held_through: string }[]>`select min(date)::text as held_from, max(date)::text as held_through
    from ${database.sql(`public.${table}`)} where org_id = ${orgId} and profile_id = ${profileId}`;
  return [row!.held_from, row!.held_through];
}

async function sqlSpend(window: { start: string; end: string }): Promise<number> {
  const [row] = await database.sql<{ spend: string }[]>`select sum(cost)::text as spend from public.fact_sp_target_daily
    where org_id = ${orgId} and profile_id = ${profileId} and date between ${window.start} and ${window.end}`;
  return Number(row!.spend);
}

const DEFAULT_VIEW: SavedView = {
  id: 'default', name: 'Default', entity: 'campaigns', columns: [], pinned: [], widths: {},
  filter: { groups: [{ filters: [{ key: 'CAMPAIGN_STATE', conditions: [{ operator: 'IN', values: ['enabled'] }] }] }] },
  sort: [{ columnId: 'spend', direction: 'desc' }], groupBy: [], dateRange: null, updatedAt: '2026-09-24T00:00:00.000Z',
};

it('shows the Campaigns strip as the aggregate of the rows it summarises when one campaign did not report in each window', async () => {
  const payload = await loadGridRows(database, 'campaigns', { orgId, profileId, currencyCode: 'USD', period: PERIOD, comparison: COMPARISON });
  // Rule 4: every seeded campaign reaches the grid, and the rows carry figures.
  expect(payload.rowCount).toBe(CAMPAIGNS.length);
  expect(payload.rows).toHaveLength(CAMPAIGNS.length);
  const { model } = buildPerformanceModel(payload.rows, { filter: DEFAULT_VIEW.filter });
  expect(model.matchedRows).toHaveLength(CAMPAIGNS.length);
  const steady = model.matchedRows.find((row) => row.id === 'campaign:wp321-steady')!;
  expect(resolveField(steady, 'spend')).toBe(25);
  // The gate, named: the stopped campaign has no selected-window fact row. It is
  // now marked unreported, so the total skips it instead of adopting its blanks.
  const stopped = model.matchedRows.find((row) => row.id === 'campaign:wp321-stopped')!;
  expect(stopped.measurement).toEqual({ missing: ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'], comparisonMissing: [], unreported: true });
  expect(resolveField(stopped, 'spend')).toBeNull();
  expect(model.matchedRows.find((row) => row.id === 'campaign:wp321-launched')!.comparison).toBeNull();
  const [heldFrom, heldThrough] = await sqlSpan('fact_sp_target_daily');
  expect(heldFrom).toBe('2026-07-20');
  expect(payload.performance?.summary).toEqual({ source: 'sp_target', heldFrom, heldThrough, period: PERIOD, comparison: COMPARISON });
  // The table's pinned total follows the same rule as the strip.
  expect(resolveField(model.totalsRow!, 'spend')).toBeCloseTo(31.2, 9);
  expect(resolveField(model.totalsRow!, 'spend_comparison')).toBeCloseTo(27, 9);

  const current = await sqlSpend(PERIOD);
  const prior = await sqlSpend(COMPARISON);
  expect(current).toBe(12.5 * 2 + 3.1 * 2);
  expect(prior).toBe(12.5 + 7.25 * 2);

  // Node environment: the database harness resolves migrations from a file URL.
  const host = new JSDOM('<div></div>').window.document.body;
  host.innerHTML = renderToStaticMarkup(createElement(PerformanceSummary, {
    rows: model.matchedRows, ...(payload.performance ? { performance: { ...payload.performance, unattributed: null } } : {}),
    view: DEFAULT_VIEW, onChange: () => {}, currencyCode: 'USD', profileId,
  }));
  const spend = host.querySelector('[aria-label="Chart spend"]');
  expect(spend?.querySelector('strong')?.textContent).toBe(`$${current.toFixed(2)}`);
  const delta = ((current - prior) / prior * 100).toFixed(1);
  expect(spend?.textContent).toBe(`Spend$${current.toFixed(2)}$${prior.toFixed(2)} · +${delta}%`);
  // Every card shows a figure: no base is missing from a campaign that reported.
  expect([...host.querySelectorAll('[data-testid="grid-kpis"] button strong')].map((node) => node.textContent)).not.toContain('—');
});

it('explains a comparison window the source does not reach, with the source and the date it starts', async () => {
  const early = { start: '2026-06-01', end: '2026-06-30' };
  const payload = await loadGridRows(database, 'campaigns', { orgId, profileId, currencyCode: 'USD', period: PERIOD, comparison: early });
  expect(payload.rowCount).toBe(2);
  const { model } = buildPerformanceModel(payload.rows, { filter: DEFAULT_VIEW.filter });
  const host = new JSDOM('<div></div>').window.document.body;
  host.innerHTML = renderToStaticMarkup(createElement(PerformanceSummary, {
    rows: model.matchedRows, performance: { ...payload.performance!, unattributed: null }, view: DEFAULT_VIEW, onChange: () => {}, currencyCode: 'USD', profileId,
  }));
  const spend = host.querySelector('[aria-label="Chart spend"]')!;
  expect(spend.querySelector('strong')?.textContent).toBe('$31.20');
  const detail = spend.querySelector('strong + span')!;
  expect(detail.textContent).toBe('Not measured · —');
  expect(detail.getAttribute('title')).toBe(`Sponsored Products target facts are held from ${formatShellDate('2026-07-20')}, after the comparison range (${formatDateWindow(early.start, early.end)}) ends.`);
});

it('reads the held fact span of every preset source and marks catalogue-only products unreported', async () => {
  const asin = 'B000WP321A';
  await database.sql`insert into public.fact_search_term_daily (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, search_term, impressions)
    values (${orgId}, ${profileId}, '2026-08-03', 'SP', 'wp321-steady', 'wp321-steady-ag', 'synthetic wp321 term', 10)`;
  await database.sql`insert into public.fact_placement_daily (org_id, profile_id, date, ad_product, campaign_id, placement, impressions)
    values (${orgId}, ${profileId}, '2026-08-05', 'SP', 'wp321-steady', 'top_of_search', 10), (${orgId}, ${profileId}, '2026-09-02', 'SP', 'wp321-steady', 'top_of_search', 12)`;
  // Advertised-product facts arrive only through promotion, as in product-coverage.test.ts.
  const spec = CORE_REPORT_FAMILIES.spAdvertisedProduct;
  const configuration: CoreReportConfiguration = { family: 'spAdvertisedProduct', version: 1, timeUnit: 'DAILY', format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: ['date', ...spec.required, ...spec.optional, ...spec.defaultMetrics] };
  const requestId = randomUUID();
  const observedAt = '2026-09-20T00:00:00.000Z';
  await database.sql`insert into public.report_requests (id, org_id, profile_id, report_type, start_date, end_date, requested_at, family_configuration)
    values (${requestId}, ${orgId}, ${profileId}, 'spAdvertisedProduct', '2026-08-09', '2026-08-09', ${observedAt}, ${JSON.stringify(configuration)}::jsonb)`;
  const promotion: CoreReportPromotion = { orgId, profileId, reportRequestId: requestId, requestedAt: observedAt, observedAt, startDate: '2026-08-09', endDate: '2026-08-09',
    parsed: { configuration, sourceRows: 1, parsedRows: 1, duplicateRows: 0, refusals: [], rows: [{ family: 'spAdvertisedProduct', periodStart: '2026-08-09', periodEnd: '2026-08-09', timeUnit: 'DAILY', attributionGeneration: 'legacy',
      identityResolution: 'reported_unresolved', dimensions: { campaignId: 'wp321-steady', adGroupId: 'wp321-steady-ag', advertisedAsin: asin, advertisedSku: null, adId: null }, metrics: { cost: 2 } }] } };
  expect((await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, promotion))).loadedRows).toBe(1);
  await database.sql`insert into public.product_ads (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id, asin)
    values (${orgId}, ${profileId}, 'wp321-catalogue-ad', 'SP', 'Synthetic catalogue product', 'enabled', 'wp321-steady', 'wp321-steady-ag', 'B000WP321B')`;
  const spans = await Promise.all((['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements', 'products', 'unknown'] as const).map(async (level) =>
    [level, await readGridSummaryEvidence(database, { orgId, profileId, level, period: PERIOD, comparison: COMPARISON })] as const));
  const sp = ['sp_target', ...await sqlSpan('fact_sp_target_daily')];
  // Our seeded dates bound each span from below; the fixture's own facts may extend it.
  expect((await sqlSpan('fact_search_term_daily'))[0] <= '2026-08-03' && (await sqlSpan('fact_placement_daily'))[0] <= '2026-08-05').toBe(true);
  expect(Object.fromEntries(spans.map(([level, span]) => [level, span === undefined ? null : [span.source, span.heldFrom, span.heldThrough]]))).toEqual({
    campaigns: sp, ad_groups: sp, targets: sp,
    search_terms: ['search_term', ...await sqlSpan('fact_search_term_daily')], placements: ['placement', ...await sqlSpan('fact_placement_daily')],
    products: ['advertised_product', '2026-08-09', '2026-08-09'],
    unknown: null,
  });
  const products = await loadGridRows(database, 'products', { orgId, profileId, currencyCode: 'USD', period: PERIOD, comparison: COMPARISON });
  const [catalogue] = await database.sql<{ n: number }[]>`select count(*)::int as n from (
      select asin from public.product_ads where org_id = ${orgId} and profile_id = ${profileId} and asin is not null and deleted_at is null
      union select dimensions->>'advertisedAsin' from public.fact_advertised_product_daily where org_id = ${orgId} and profile_id = ${profileId}
        and family = 'spAdvertisedProduct' and variant = 'DAILY:legacy:v1' and date between ${COMPARISON.start} and ${PERIOD.end}) listed`;
  expect(products.rowCount).toBe(catalogue!.n);
  expect(products.rows).toHaveLength(catalogue!.n);
  // No product reported in the selected window, so every row is unreported rather than zero.
  expect(products.rows.every((row) => row.measurement?.unreported === true)).toBe(true);
  expect(products.rows.find((row) => row.dimensions['asin'] === 'B000WP321B')?.measurement).toMatchObject({ unreported: true });
  expect(products.rows.find((row) => row.dimensions['asin'] === asin)?.measurement).toMatchObject({ unreported: true });
  expect(products.rows.find((row) => row.dimensions['asin'] === asin)?.comparison).toMatchObject({ spend: 2 });
  const placements = await loadGridRows(database, 'placements', { orgId, profileId, currencyCode: 'USD', period: PERIOD, comparison: COMPARISON });
  expect(placements.rowCount).toBe(1);
  expect(placements.rows[0]!.measurement?.unreported).toBeUndefined();
  expect(placements.rows[0]!.totals.impressions).toBe(12);
});
