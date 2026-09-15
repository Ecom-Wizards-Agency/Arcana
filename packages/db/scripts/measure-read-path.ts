/** Local synthetic benchmark. Imports the production loaders to avoid SQL drift. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import type { QuerySql } from '../src/client.js';
import { createTestDatabase, adminConnectionString } from '../src/testing/harness.js';
import { withAuthenticatedOrgEditor } from '../src/queries/authenticated-actor.js';
import { loadGridRows } from '../../../apps/web/app/_lib/grid-data.js';
import { loadProfileDailyRows, loadReportLedger } from '../../../apps/web/app/_lib/dashboard-data.js';
import { loadOptimizerPageData } from '../../../apps/web/app/_lib/optimizer-page-data.js';

import { aggregate } from './read-path-statistics.js';

type Statement = { query: string; parameters: postgres.ParameterOrJSON<never>[] };
type Plan = { 'Node Type': string; 'Actual Total Time': number; 'Actual Loops': number; 'Actual Rows': number; 'Relation Name'?: string; 'Index Name'?: string; Plans?: Plan[]; [key: string]: unknown };
const flatten = (p: Plan): Plan[] => [p, ...(p.Plans ?? []).flatMap(flatten)];

async function main() {
  const url = new URL(adminConnectionString());
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only a local disposable PostgreSQL is allowed');
  const admin = postgres(url.toString(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  const databases = async () => (await admin<{ datname: string }[]>`select datname from pg_database order by datname`).map((r) => r.datname);
  let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: ReturnType<typeof postgres> | undefined;
  let authenticated: ReturnType<typeof postgres> | undefined;
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let before: string[] = [];
  let report = '';
  let capture: Statement[] | undefined;
  const debug = (_connection: number, query: string, parameters: unknown[]) => {
    if (capture && /^\s*(select|with)\b/i.test(query) && !query.includes('set_config')) {
      capture.push({ query, parameters: [...parameters] as Statement['parameters'] });
    }
  };
  try {
    const [version] = await admin`select current_setting('server_version_num')::int as version`;
    assert(version && Number(version.version) >= 170000 && Number(version.version) < 180000, 'PostgreSQL 17 required');
    before = await databases();
    database = await createTestDatabase('read_path');
    const sql = database.sql;
    const userId = randomUUID();
    const [tenant] = await sql`select app.seed_tenant_fixture('synthetic-read-cost', ${userId}::uuid, 'analyst', current_date) as id`;
    const orgId = String(tenant!.id);
    const [profile] = await sql`select id from public.ad_profiles where org_id = ${orgId}`;
    const profileId = String(profile!.id);
    await sql`select app.ensure_fact_partitions((current_date - n * interval '1 month')::date, 0) from generate_series(0,3) n`;
    await sql`insert into public.campaigns (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      select ${orgId}, ${profileId}, 'synthetic-c-'||n, 'SP', 'Synthetic campaign '||n, 'enabled', 10, 'daily' from generate_series(1,200) n`;
    await sql`insert into public.ad_groups (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, default_bid)
      select ${orgId}, ${profileId}, 'synthetic-ag-'||n, 'SP', 'Synthetic group '||n, 'enabled', 'synthetic-c-'||n, 1 from generate_series(1,200) n`;
    await sql`insert into public.keywords (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, keyword_text, match_type, bid)
      select ${orgId}, ${profileId}, 'synthetic-kw-'||n, 'SP', 'enabled', 'synthetic-c-'||((n-1)/10+1), 'synthetic-ag-'||((n-1)/10+1), 'synthetic keyword '||n, 'exact', 1 from generate_series(1,2000) n`;
    await sql`insert into public.fact_sp_target_daily (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      select ${orgId}, ${profileId}, current_date-d, 'SP', 'synthetic-c-'||((n-1)/10+1), 'synthetic-ag-'||((n-1)/10+1), 'synthetic-kw-'||n, 'keyword', 'exact', 100+n%100, 5+n%5, 4+n%4, 1, 25, 1 from generate_series(1,2000) n cross join generate_series(1,90) d`;
    await sql`insert into public.fact_profile_daily (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      select org_id, profile_id, date, 'USD', sum(impressions), sum(clicks), sum(cost), sum(purchases_7d), sum(sales_7d), sum(units_sold_7d) from public.fact_sp_target_daily where org_id=${orgId} and date < current_date group by org_id, profile_id, date`;
    await sql`insert into public.rank_observations (org_id, profile_id, asin, keyword, observed_on, organic_rank)
      select ${orgId}, ${profileId}, 'B0TEST0001', 'synthetic keyword '||n, current_date-d, 1+n%50 from generate_series(1,2000) n cross join generate_series(1,90) d`;
    await sql`insert into public.bid_series_daily (org_id, profile_id, date, campaign_id, ad_group_id, target_id, is_keyword, bid)
      select ${orgId}, ${profileId}, current_date-d, 'synthetic-c-'||((n-1)/10+1), 'synthetic-ag-'||((n-1)/10+1), 'synthetic-kw-'||n, true, 1 from generate_series(1,2000) n cross join generate_series(1,90) d`;
    await sql`insert into public.report_requests (org_id, profile_id, report_type, start_date, end_date, status, rows_parsed, rows_loaded, requested_at)
      select ${orgId}, ${profileId}, 'spCampaigns', current_date-d, current_date-d, 'completed', 2000, 2000, now()-d*interval '1 day' from generate_series(1,90) d`;
    const [counts] = await sql`select (select count(*) from fact_sp_target_daily where org_id=${orgId})::int facts,
      (select count(distinct date) from fact_sp_target_daily where org_id=${orgId} and date<current_date)::int days,
      (select count(*) from keywords where org_id=${orgId})::int keywords,
      (select count(*) from campaigns where org_id=${orgId})::int campaigns,
      (select count(*) from rank_observations where org_id=${orgId})::int ranks,
      (select count(*) from bid_series_daily where org_id=${orgId})::int bids`;
    assert.equal(counts!.facts, 180001); assert.equal(counts!.days, 90);
    assert.equal(counts!.keywords, 2001); assert.equal(counts!.campaigns, 201);
    assert.equal(counts!.ranks, 180001); assert.equal(counts!.bids, 180001);
    await sql`analyze`;
    service = postgres(database.connectionString, { max: 4, prepare: false, connection: { role: 'service_role' }, debug });
    authenticated = postgres(database.connectionString, { max: 4, prepare: false, debug });
    const [dates] = await sql`select (current_date-1)::text as e, (current_date-30)::text as s, (current_date-60)::text as cs, (current_date-31)::text as ce`;
    const period = { start: String(dates!.s), end: String(dates!.e) };
    const comparison = { start: String(dates!.cs), end: String(dates!.ce) };
    const reads: { name: string; run: (sql: QuerySql) => Promise<unknown>; count: (value: unknown) => number }[] = [
      { name: 'Grid targets (30-day + comparison)', run: (sql) => loadGridRows({ sql }, 'targets', { orgId, profileId, currencyCode: 'USD', period, comparison }), count: (v) => (v as { rows: unknown[] }).rows.length },
      { name: 'Dashboard cockpit daily totals', run: (sql) => loadProfileDailyRows({ sql }, orgId, profileId, 'Synthetic', { start: comparison.start, end: period.end }), count: (v) => (v as unknown[]).length },
      { name: 'Optimizer page reads', run: (sql) => loadOptimizerPageData({ handle: { sql }, orgId, profile: { id: profileId, label: 'Synthetic' }, period, settledComparison: comparison }), count: (v) => (v as { campaignFacts: unknown[] }).campaignFacts.length },
      { name: 'Report-ledger freshness', run: (sql) => loadReportLedger({ sql }, orgId, profileId), count: (v) => (v as unknown[]).length },
      { name: 'Membership resolution alone', run: (sql) => sql`select exists (select 1 from public.org_members where org_id=${orgId} and user_id=${userId}) as present`, count: (v) => (v as unknown[]).length },
    ];
    const table = ['| Read | Service-role median ms | Authenticated median ms | Ratio | Rows | Dominant plan node (service / auth) | Index used or seq scan |', '|---|---:|---:|---:|---:|---|---|'];
    const excerpts: string[] = [];
    for (const read of reads) {
      assert(!interrupted, 'Measurement interrupted');
      const times: number[][] = [[], []];
      const plans: Plan[][] = [[], []];
      let expected: unknown;
      let rows = 0;
      for (let iteration = -1; iteration < 5; iteration++) {
        for (const path of iteration % 2 === 0 ? [1, 0] : [0, 1]) {
          assert(!interrupted, 'Measurement interrupted');
          const start = performance.now();
          const value = path === 0 ? await read.run(service) : await withAuthenticatedOrgEditor({ sql: authenticated }, { orgId, userId }, ({ sql }) => read.run(sql));
          if (iteration >= 0) times[path]!.push(performance.now() - start);
          rows = read.count(value);
          // Grid has no ORDER BY: compare by identity, not incidental plan order.
          const normalize = (v: unknown): unknown => Array.isArray(v) ? v.map(normalize).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k,x]) => [k, normalize(x)])) : v;
          const normalized = normalize(value);
          if (expected === undefined) expected = normalized;
          else assert.deepEqual(normalized, expected, `${read.name}: path result mismatch`);
        }
      }
      assert.equal(rows, [2000, 60, 201, 40, 1][reads.indexOf(read)]);
      for (const path of [0, 1]) {
        const explain = async (sql: QuerySql) => {
          capture = [];
          await read.run(sql);
          const statements = capture;
          capture = undefined;
          for (const statement of statements) {
            const result = await sql.unsafe('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement.query, statement.parameters);
            const document = result[0]!['QUERY PLAN'][0] as { Plan: Plan };
            plans[path]!.push(document.Plan);
          }
        };
        if (path === 0) await explain(service);
        else await withAuthenticatedOrgEditor({ sql: authenticated }, { orgId, userId }, ({ sql }) => explain(sql));
      }
      const stats = aggregate(times[0]!, times[1]!);
      const dominant = plans.map((list) => list.flatMap(flatten).sort((a,b) => b['Actual Total Time']*b['Actual Loops']-a['Actual Total Time']*a['Actual Loops'])[0]!);
      const scans = [...new Set(plans.flat(1).flatMap(flatten).filter((p) => p['Relation Name']).map((p) => p['Index Name'] ?? `${p['Node Type']} ${p['Relation Name']}`))];
      table.push(`| ${read.name} | ${stats.serviceMs.toFixed(3)} | ${stats.authenticatedMs.toFixed(3)} | ${stats.ratio?.toFixed(3)} | ${rows} | ${dominant.map((p) => p['Node Type']).join(' / ')} | ${scans.join(', ')} |`);
      excerpts.push(`### ${read.name}\n\nSamples ms (service/auth): ${JSON.stringify(times)}\n\n` + plans.map((list, path) => `${path === 0 ? 'Service role' : 'Authenticated'}: ${list.length} statements\n\n\`\`\`json\n${JSON.stringify(list, (_key, value: unknown) => typeof value === 'string' && value.length > 500 ? value.slice(0, 500) + ' [expression truncated]' : value, 2)}\n\`\`\``).join('\n\n'));
    }
    report = `# WP-257 read-path cost\n\nPostgreSQL ${version!.version}; synthetic fixture counts: ${JSON.stringify(counts)}.\n\nOne warm-up per path, then five alternating-order samples each; medians include loader mapping, connection checkout, and authenticated transaction begin, local claims/role, app.lock_org_editor and commit. Service role uses a four-connection BYPASSRLS pool; authenticated reads share one transaction connection. EXPLAIN runs separately once per loader SQL statement per path, excluding boundary setup; buffer evidence below. Plan expression strings longer than 500 characters are truncated; all plan nodes and numeric counters are retained. No indexes added. Warm local results are not production latency estimates. Other worktrees use this local PostgreSQL cluster concurrently (see changing database inventory); contention is uncontrolled, so treat these five-sample ratios as directional evidence, not isolated microbenchmarks.\n\nGrid uses the production loader's complete projection (column selection is UI-side); rank observations are seeded but this checkout joins bid series, not ranks. Dashboard reads the 60 daily rows underlying current/comparison cockpit totals; UI rendering excluded. Optimizer uses the fixture's legacy engine runs, so current-engine recommendation detail is empty; rows means campaign outputs, not summed intermediate SQL rows. All iterations assert equal results across paths and expected output counts.\n\n${table.join('\n')}\n\n## Proposed indexes\n\n- Candidate: \`create index report_requests_org_profile_requested on public.report_requests (org_id, profile_id, requested_at desc);\` The freshness plan scans report_requests then uses a top-N Sort before Limit. This index matches both equality predicates and the requested order. With only 91 rows the absolute benefit is small; validate at larger ledger sizes before migration.\n- Candidate: \`create index bid_series_daily_org_profile_target_latest on public.bid_series_daily (org_id, profile_id, target_id, date desc, loaded_at desc);\` The authenticated grid bid-series plan uses an external-merge Sort before Unique over 180,001 rows. This matches DISTINCT ON target_id and latest-date order within the tenant/profile. Existing target index starts with profile_id and has ascending date. RLS may still dominate and the planner may still prefer scans; this is an untested proposal, not a measured speedup.\n\n## Plans\n\n${excerpts.join('\n\n')}\n`;
    console.log(table.join('\n'));
  } finally {
    capture = undefined;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await Promise.all([service?.end({ timeout: 5 }), authenticated?.end({ timeout: 5 })]);
    } finally {
      try {
        await database?.drop();
        const after = await databases();
        if (database) assert(!after.includes(database.name), 'Disposable database leaked');
        if (report) {
          report += `\n## Database cleanup\n\nBefore: ${JSON.stringify(before)}\n\nAfter: ${JSON.stringify(after)}\n\nDisposable database absent after drop: ${database ? !after.includes(database.name) : true}. Other concurrent test databases may change independently.\n`;
          await writeFile(new URL('./measure-read-path.REPORT.md', import.meta.url), report.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<synthetic-uuid>'));
        }
      } finally { await admin.end({ timeout: 5 }); }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Measurement failed'); process.exitCode = 1; });
}
