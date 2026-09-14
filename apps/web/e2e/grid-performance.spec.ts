/** Authenticated browser proof that Grid rows moved out of the initial document. */
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Response as PlaywrightResponse, Request as PlaywrightRequest } from '@playwright/test';
import { columnsFor } from '@wizard-ads/ui';
import { serializeGridView } from '@wizard-ads/shared';
import { createDb } from '@wizard-ads/db';
import { readState } from './support/fixture';
import { signIn } from './support/auth';

const EXPECTED_ROWS = 3_597;
const MARKER = 'WP142 transport row';
const REFERENCE_USABLE_LIMIT_MS = 2_000;
// The product acceptance target is measured on the documented reference
// development machine. GitHub's shared public runner is materially slower, so
// it gets a bounded regression ceiling rather than being mislabeled as that
// reference hardware. Exact rows, requests, bytes, and exports remain identical
// assertions in both environments.
const CI_USABLE_LIMIT_MS = 4_000;
const fixtureMonth = new Date(
  Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 15),
);
const DATE = fixtureMonth.toISOString().slice(0, 10);
const WARM_DATE = new Date(fixtureMonth.getTime() - 86_400_000).toISOString().slice(0, 10);

function gridUrl(profile: string, date: string, entity: 'targets' | 'search_terms'): string {
  const query = new URLSearchParams({
    profile,
    entity,
    from: date,
    to: date,
  });
  if (entity === 'targets') query.set('view', serializeGridView({ id: 'performance-full', name: 'All performance columns', entity, columns: columnsFor(entity).filter((column) => column.id !== 'translation').map((column) => column.id), pinned: ['targeting'], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '2026-09-14' }));
  return ['/grid', '?', query.toString()].join('');
}

async function seedRows(entity: 'targets' | 'search_terms'): Promise<string> {
  const state = await readState();
  const database = createDb({ connectionString: state.connectionString, max: 1 });
  try {
    if (entity === 'targets') {
      const inserted = await database.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
        select ${state.orgId},${state.fixtureProfileId},'perf-' || series::text,'SP','enabled','c-1','ag-1',${MARKER} || ' ' || lpad(series::text,4,'0'),'exact',0.9
        from generate_series(1,${EXPECTED_ROWS}) series returning amazon_id`;
      expect(inserted).toHaveLength(EXPECTED_ROWS);
      const facts = await database.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,match_type,impressions,clicks,cost,purchases_7d,sales_7d,units_sold_7d)
        select ${state.orgId},${state.fixtureProfileId},${DATE}::date,'SP','c-1','ag-1','perf-' || series::text,'keyword','exact',100+series,5+series%10,(series%100)::numeric/10,series%3,(series%200)::numeric/5,series%4
        from generate_series(1,${EXPECTED_ROWS}) series returning target_id`;
      expect(facts).toHaveLength(EXPECTED_ROWS);
      // Mix fully observed, never-ranked and wholly unobserved histories.
      await database.sql`insert into public.rank_observations(org_id,profile_id,asin,keyword,observed_on,organic_rank)
        select ${state.orgId},${state.fixtureProfileId},'B0TEST0001',${MARKER} || ' ' || lpad(series::text,4,'0'),${DATE}::date - day,
          case when series%3=0 then null else (series%50)+1 end
        from generate_series(1,${EXPECTED_ROWS}) series cross join generate_series(0,13) day where series%2=0`;
    } else {
    const [result] = await database.sql<{ count: number }[]>`
      with inserted as (
        insert into public.fact_search_term_daily
          (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
           search_term, match_type, impressions, clicks, cost, purchases_7d, sales_7d,
           units_sold_7d)
        select ${state.orgId}, ${state.fixtureProfileId}, ${DATE}::date, 'SP', 'c-1', 'ag-1',
               null, ${MARKER} || ' ' || lpad(series::text, 4, '0'),
               case when series % 2 = 0
                 then 'exact'::public.match_type else 'phrase'::public.match_type end,
               100 + series, 5 + series % 10, (series % 100)::numeric / 10,
               series % 3, (series % 200)::numeric / 5, series % 4
          from generate_series(1, ${EXPECTED_ROWS}) as series
        returning 1
      )
      select count(*)::int as count from inserted
    `;
    const count = result?.count ?? 0;
    if (count !== EXPECTED_ROWS) {
      throw new Error(`Seeded ${EXPECTED_ROWS} Grid rows, wrote ${count}`);
    }
    }
    // Model a loaded account with known planner statistics without waiting for
    // auto-analyze in this disposable database. The read/usable budgets remain
    // unchanged; this fixture does not claim cold-statistics latency.
    await database.sql`analyze public.fact_sp_target_daily, public.rank_observations, public.product_ads, public.fact_search_term_daily, public.keywords, public.targets,
      public.campaigns, public.ad_groups, public.org_members, public.orgs, public.ad_profiles`;
    return state.fixtureProfileId;
  } finally {
    await database.close();
  }
}

for (const entity of ['search_terms', 'targets'] as const) test(`${entity}: one counted request powers all 3,597 rows and the complete export`, async ({
  page,
}, testInfo) => {
  const profile = await seedRows(entity);
  await signIn(page, 'admin');

  // Compile the Grid page and route against an empty neighboring date. This
  // keeps the timing measurement about payload delivery rather than Next dev's
  // one-time module compilation.
  await page.goto(gridUrl(profile, WARM_DATE, entity));
  await expect(page.getByRole('button', { name: 'Export CSV (0 of 0)' })).toBeVisible();

  const rowResponses: PlaywrightResponse[] = [];
  const shellRequests: PlaywrightRequest[] = [];
  const pageDataRequests: PlaywrightRequest[] = [];
  page.on('request', (request) => {
    if (request.headers()['next-action'] !== undefined) shellRequests.push(request);
    else if (['fetch', 'xhr'].includes(request.resourceType())) pageDataRequests.push(request);
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/grid/rows') rowResponses.push(response);
  });

  const startedAt = performance.now();
  const documentResponse = await page.goto(gridUrl(profile, DATE, entity), {
    waitUntil: 'domcontentloaded',
  });
  expect(documentResponse).not.toBeNull();
  const initialDocument = await documentResponse!.body();
  await expect(
    page.getByRole('button', {
      name: `Export CSV (${EXPECTED_ROWS.toLocaleString('en-US')} of ${EXPECTED_ROWS.toLocaleString('en-US')})`,
    }),
  ).toBeVisible();
  if (entity === 'targets') await expect(page.getByRole('button', { name: `Columns (${columnsFor(entity).length - 1})`, exact: true })).toBeVisible();
  const usableMs = performance.now() - startedAt;
  // A development Strict Mode replay happens immediately after mount. Waiting
  // one short task makes the request-count assertion catch a duplicate rather
  // than racing it.
  await page.waitForTimeout(100);

  expect(initialDocument.byteLength).toBeLessThanOrEqual(256 * 1_024);
  expect(initialDocument.toString('utf8')).not.toContain(MARKER);
  expect(rowResponses).toHaveLength(1);

  const gridResponse = rowResponses[0]!;
  expect(gridResponse.status()).toBe(200);
  expect(gridResponse.headers()['cache-control']).toContain('no-store');
  const responseBody = await gridResponse.body();
  const payload = JSON.parse(responseBody.toString('utf8')) as {
    rows: Array<{ dimensions: Record<string, unknown> }>;
    rowCount: number;
    truncated: boolean;
  };
  expect(payload.rowCount).toBe(EXPECTED_ROWS);
  expect(payload.rows).toHaveLength(EXPECTED_ROWS);
  expect(payload.truncated).toBe(false);
  expect(payload.rows.every((row) => String(row.dimensions[entity === 'targets' ? 'targeting' : 'search_term']).startsWith(MARKER))).toBe(true);
  expect(responseBody.byteLength).toBeLessThanOrEqual(4_000_000);

  // This check runs after usableMs is captured. Shell evidence must settle
  // independently, without becoming a counted Grid request or competing with page data.
  await expect(page.locator('.wa-shell-chips')).toHaveAttribute('aria-busy', 'false');
  const loadEndedAt = await page.evaluate(() => {
    const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    return performance.timeOrigin + navigation.loadEventEnd;
  });
  const measuredShellRequests = shellRequests.filter((request) => new URL(request.url()).searchParams.get('from') === DATE);
  expect(measuredShellRequests).toHaveLength(1);
  expect(measuredShellRequests[0]!.timing().startTime).toBeGreaterThanOrEqual(loadEndedAt);
  const shellStartedAt = measuredShellRequests[0]?.timing().startTime;
  const pageReads = pageDataRequests.map((request) => request.timing()).filter((timing) =>
    timing.startTime >= documentResponse!.request().timing().startTime && timing.startTime < (shellStartedAt ?? Infinity));
  const shellAfterPageDataMs = shellStartedAt === undefined ? null : shellStartedAt
    - Math.max(...pageReads.map((timing) => timing.startTime + timing.responseEnd));
  expect(rowResponses).toHaveLength(1);

  const exportButton = page.getByRole('button', { name: /Export CSV/ });
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  const csv = await readFile(downloadPath!, 'utf8');
  const csvLines = csv.trimEnd().split('\n');
  expect(csvLines[0]).toContain(`${EXPECTED_ROWS} of ${EXPECTED_ROWS} source rows`);
  // One provenance line plus the CSV header precede the exact source rows.
  expect(csvLines).toHaveLength(EXPECTED_ROWS + 2);
  if (entity === 'targets') expect(csvLines[1]!.split(',')).toHaveLength(columnsFor(entity).length - 1);

  const measurements = {
    entity,
    usableMs: Math.round(usableMs * 100) / 100,
    usableLimitMs: process.env['CI'] ? CI_USABLE_LIMIT_MS : REFERENCE_USABLE_LIMIT_MS,
    referenceUsableLimitMs: REFERENCE_USABLE_LIMIT_MS,
    initialDocumentBytes: initialDocument.byteLength,
    rowResponseBytes: responseBody.byteLength,
    rows: payload.rowCount,
    requests: rowResponses.length,
    shellRequests: measuredShellRequests.length,
    gridRequestStartMs: gridResponse.request().timing().startTime - documentResponse!.request().timing().startTime,
    gridRequestDurationMs: gridResponse.request().timing().responseEnd,
    documentDurationMs: documentResponse!.request().timing().responseEnd,
    gridServerTiming: gridResponse.headers()['server-timing'],
    shellAfterGridMs: measuredShellRequests.length === 0 ? null : measuredShellRequests[0]!.timing().startTime - (gridResponse.request().timing().startTime + gridResponse.request().timing().responseEnd),
    shellAfterPageDataMs,
    pageDataRequests: pageReads.length,
    shellRequestDurationMs: measuredShellRequests[0]?.timing().responseEnd ?? null,
    browser: await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return { domContentLoadedMs: navigation.domContentLoadedEventEnd, loadMs: navigation.loadEventEnd,
        scriptsBytes: performance.getEntriesByType('resource').filter((entry) => (entry as PerformanceResourceTiming).initiatorType === 'script').reduce((bytes, entry) => bytes + (entry as PerformanceResourceTiming).decodedBodySize, 0) };
    }),
    shellAfterLoadMs: Math.round((measuredShellRequests[0]!.timing().startTime - loadEndedAt) * 100) / 100,
  };
  console.info(JSON.stringify({ event: 'openspell.grid_boundary_e2e', ...measurements }));
  await testInfo.attach('grid-boundary-measurements.json', {
    body: Buffer.from(JSON.stringify(measurements, null, 2)),
    contentType: 'application/json',
  });

  expect(measurements.shellAfterGridMs).toBeGreaterThanOrEqual(500);
  expect(pageReads.every((timing) => timing.responseEnd >= 0)).toBe(true);
  expect(shellAfterPageDataMs).toBeGreaterThanOrEqual(500);
  expect(usableMs).toBeLessThan(
    process.env['CI'] ? CI_USABLE_LIMIT_MS : REFERENCE_USABLE_LIMIT_MS,
  );
});
