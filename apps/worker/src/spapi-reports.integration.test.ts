import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import {
  admitSpReportPlan, loadSpReportCheckpoint, promoteSpReport, previousSpListingReport, readSpListingHistory, readSpReportEvidence,
  resolveSpReportScope, revokeSpApiRefreshToken, saveSpReportCheckpoint,
  storeSpApiRefreshToken, upsertReportCoverage, verifySpReport, type ClaimedJob,
} from '@wizard-ads/db';
import { SpApiAmbiguousOutcome, SpApiClient, SP_REPORT_CONTRACT, SP_REPORT_TYPES, validateSpPlan } from '@wizard-ads/sp-api';
import type { SpReportFamily, SpReportPlan, SpReportScope } from '@wizard-ads/shared';
import { provisionSpApiReportJobs } from './spapi-report-scheduler.js';
import { IngestionRegistry, type CoverageProducer } from './ingestion-registry.js';
import { registerSpApiReportSources } from './spapi-report-sources.js';
import { PermanentJobError } from './permanent-job-error.js';
import { SqpWorkflowPendingError } from './sqp.js';
import { runSpReportWorkflow, type SpReportWorkflowDependencies } from './spapi-report-workflow.js';

const available = await databaseAvailable();
const owner = '81818181-8181-4181-8181-818181818181';
const observedAt = '2026-09-13T01:00:00.000Z';
const tables = { retail: 'fact_retail_sales_traffic_daily', aba: 'fact_aba_search_terms_periodic', catalogue: 'spapi_listing_observations' };
let serial = 0;

/** Synthetic values follow the pinned Amazon model; no seller data is recorded. */
function document(plan: SpReportPlan): string {
  if (plan.family === 'catalogue') return 'listing-id\tseller-sku\tasin1\titem-name\tquantity\nlisting-one\tsku-one\tB000000001\tSynthetic title\t2\n';
  const reportSpecification = { reportType: SP_REPORT_TYPES[plan.family], dataStartTime: plan.start, dataEndTime: plan.end,
    marketplaceIds: [plan.scope.marketplaceId], reportOptions: plan.family === 'retail'
      ? { dateGranularity: 'DAY', asinGranularity: 'CHILD' } : { reportPeriod: 'WEEK' } };
  if (plan.family === 'aba') return JSON.stringify({ reportSpecification,
    dataByDepartmentAndSearchTerm: [1, 2, 3].map(rank => ({ departmentName: 'All', searchTerm: 'synthetic query',
      searchFrequencyRank: 7, clickShareRank: rank, clickedAsin: `B00000000${rank}`, clickShare: 0.2, conversionShare: 0.1 })) });
  const sales = { orderedProductSales: { amount: 100, currencyCode: 'USD' }, unitsOrdered: 5, totalOrderItems: 4 };
  const traffic = { sessions: 20, pageViews: 30, unitSessionPercentage: 25 };
  return JSON.stringify({ reportSpecification,
    salesAndTrafficByDate: [{ date: plan.start, salesByDate: sales, trafficByDate: traffic }],
    salesAndTrafficByAsin: [{ parentAsin: 'B000000009', childAsin: 'B000000001', salesByAsin: sales, trafficByAsin: traffic }] });
}
function makePlan(scope: SpReportScope, family: SpReportFamily, suffix = '', requestedAt = observedAt): SpReportPlan {
  return { scope, family, requestId: `synthetic-${family}-${++serial}-${suffix}`,
    start: family === 'aba' ? '2026-09-06' : family === 'catalogue' ? requestedAt.slice(0, 10) : '2026-09-12',
    end: family === 'catalogue' ? requestedAt.slice(0, 10) : '2026-09-12',
    requestedAt, contractVersion: SP_REPORT_CONTRACT };
}
function fakeProvider(plan: SpReportPlan, options: { gzip?: boolean; expire?: boolean; create?: 'timeout' | 'server' | 'missing'; text?: string; observedAt?: string; pendingPolls?: number; processingStatus?: string } = {}) {
  let documentCalls = 0, statusPolls = 0;
  const reportId = `provider-${plan.requestId}`;
  const fetch = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (init?.method === 'POST') {
      if (options.create === 'timeout') throw new Error('Synthetic timeout');
      if (options.create === 'server') return json({}, 503);
      return json(options.create === 'missing' ? {} : { reportId });
    }
    if (url.pathname.endsWith(`/reports/${reportId}`)) {
      const pending = ++statusPolls <= (options.pendingPolls ?? 0);
      return json({ reportId, reportType: SP_REPORT_TYPES[plan.family], processingStatus: options.processingStatus ?? (pending ? 'IN_PROGRESS' : 'DONE'),
        reportDocumentId: pending ? null : 'synthetic-document', createdTime: options.observedAt ?? observedAt });
    }
    if (url.pathname.endsWith('/documents/synthetic-document')) {
      documentCalls++;
      return json({ url: `https://documents.example.test/${documentCalls}`,
        ...(options.gzip ? { compressionAlgorithm: 'GZIP' } : {}) });
    }
    if (url.host === 'documents.example.test') {
      expect(new Headers(init?.headers).has('x-amz-access-token')).toBe(false);
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      if (options.expire && url.pathname === '/1') return new Response('', { status: 403 });
      const text = options.text ?? document(plan);
      return new Response(options.gzip ? new Uint8Array(gzipSync(text)) : text);
    }
    throw new Error('Unexpected synthetic provider path');
  });
  const tokens = vi.fn(async () => 'synthetic');
  const client = new SpApiClient({ endpoint: 'https://sellingpartnerapi-na.amazon.com', userAgent: 'Synthetic test',
    accessTokenProvider: { getAccessToken: tokens }, fetch, maxRetries: 0 });
  return { client, fetch, tokens, documentCalls: () => documentCalls };
}

describe.skipIf(!available)('registered SP-API report families with disposable persistence', () => {
  let database: TestDatabase;
  const familiesByProfile = new Map<string, SpReportFamily>();
  beforeAll(async () => { database = await createTestDatabase('wp301_reports'); }, 60_000);
  afterAll(async () => { await database?.drop(); });
  async function seed(family: SpReportFamily): Promise<SpReportScope> {
    const slug = `wp301-${family}-${++serial}`;
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${slug}, ${owner}, 'owner') as id`;
    const [row] = await database.sql<{ org_id: string; profile_id: string; connection_id: string; marketplace_id: string; selling_partner_id: string }[]>`
      select b.org_id,b.profile_id,b.connection_id,b.marketplace_id,c.selling_partner_id
      from public.spapi_profile_bindings b join public.spapi_connections c on c.id=b.connection_id where b.org_id=${org!.id}`;
    const scope: SpReportScope = { orgId: row!.org_id, profileId: row!.profile_id, connectionId: row!.connection_id,
      marketplaceId: row!.marketplace_id, sellingPartnerId: row!.selling_partner_id, region: 'NA' };
    await storeSpApiRefreshToken(database, { orgId: scope.orgId, connectionId: scope.connectionId, refreshToken: 'fake-refresh-token' });
    await database.sql`update public.spapi_profile_bindings set enabled=true where org_id=${scope.orgId}`;
    await database.sql`insert into public.spapi_report_sources(org_id,profile_id,connection_id,family)
      values (${scope.orgId},${scope.profileId},${scope.connectionId},${family}) on conflict (org_id,profile_id,family) do nothing`;
    familiesByProfile.set(scope.profileId, family);
    return scope;
  }
  function dependencies(client: SpApiClient): SpReportWorkflowDependencies {
    return { admit: plan => admitSpReportPlan(database, plan), load: plan => loadSpReportCheckpoint(database, plan),
      save: (next, expected) => saveSpReportCheckpoint(database, next, expected), promote: report => promoteSpReport(database, report),
      verify: report => verifySpReport(database, report), previousListing: (plan, at) => previousSpListingReport(database, plan, at), api: async () => client, now: () => new Date('2026-09-14T01:00:00.000Z') };
  }
  async function enable(scope: SpReportScope) {
    await database.sql`update public.spapi_report_sources set enabled=true where org_id=${scope.orgId} and family=${familiesByProfile.get(scope.profileId)!}`;
  }

  it.each(['retail', 'aba', 'catalogue'] as const)('%s reaches its exact destination and coverage; replay preserves observation time', async family => {
    const scope = await seed(family), plan = makePlan(scope, family), provider = fakeProvider(plan, { gzip: family === 'aba' });
    const deps = dependencies(provider.client);
    const produce = vi.fn<CoverageProducer>((observation, count) => upsertReportCoverage(database, observation, count));
    const registry = new IngestionRegistry(produce);
    registerSpApiReportSources(registry, deps);
    const payload = { type: `${family}.report.request` as const, orgId: scope.orgId, profileId: scope.profileId, plan };
    const job: ClaimedJob = { id: '91919191-9191-4191-8191-919191919191', orgId: scope.orgId, profileId: scope.profileId,
      jobType: payload.type, payload, attempts: 1, maxAttempts: 3, claim: null, claimedBy: 'synthetic', dedupeKey: plan.requestId };
    const context = { job, payload, profile: { id: scope.profileId, orgId: scope.orgId, amazonProfileId: 'synthetic',
      region: scope.region, timezone: 'UTC', currencyCode: 'USD' } };
    await expect(registry.dispatch(context)).rejects.toThrow('disabled');
    expect(provider.fetch).not.toHaveBeenCalled();
    expect(provider.tokens).not.toHaveBeenCalled();
    expect(await resolveSpReportScope(database, { ...scope, family })).toBeNull();
    const [settings] = await database.sql`select enabled,schedule_enabled,policy_accepted from public.spapi_report_sources where org_id=${scope.orgId}`;
    expect(settings).toMatchObject({ enabled: false, schedule_enabled: false, policy_accepted: false });
    await enable(scope);
    const expected = family === 'retail' ? 2 : family === 'aba' ? 4 : 1;
    await expect(registry.dispatch(context)).resolves.toMatchObject({ receipt: { writtenRows: expected, verifiedLoadedRows: expected,
      report: { counts: { sourceRows: family === 'aba' ? 3 : expected, parsedRows: family === 'aba' ? 3 : expected,
        refusedRows: 0, addedRows: family === 'aba' ? 1 : 0, canonicalRows: expected } } } });
    const counts = await database.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from public.${tables[family]} where org_id=$1 and date between $2 and $3`, [scope.orgId, plan.start, plan.end]);
    expect(counts[0]?.n).toBe(expected);
    expect(produce).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sourceRows: family === 'aba' ? 3 : expected,
      parsedRows: family === 'aba' ? 3 : expected, loadedRows: expected, observedAt, status: 'complete' }), expected);
    const beforeReplay = provider.fetch.mock.calls.length;
    await expect(registry.dispatch(context)).resolves.toMatchObject({ receipt: { writtenRows: 0, verifiedLoadedRows: expected, report: { observedAt } } });
    expect(provider.fetch).toHaveBeenCalledTimes(beforeReplay);
    await expect(produce.mock.results[1]?.value).resolves.toEqual({ offered: 1, written: 0, unchanged: 1 });
    expect(await readSpReportEvidence(database, { ...scope, family, start: plan.start, end: plan.end, now: new Date(observedAt) }))
      .toMatchObject({ state: 'measured', report: { rows: expect.any(Array), observedAt } });
    expect(await readSpReportEvidence(database, { ...scope, family, start: plan.start, end: plan.end, now: new Date('2026-10-15T00:00:00Z') }))
      .toMatchObject({ state: 'stale' });
    await revokeSpApiRefreshToken(database, { orgId: scope.orgId, connectionId: scope.connectionId });
    await expect(registry.dispatch(context)).rejects.toThrow('disabled');
    expect(provider.fetch).toHaveBeenCalledTimes(beforeReplay);
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('refuses mismatched seller, marketplace, region and tenant without provider calls', async () => {
    const scope = await seed('retail'); await enable(scope);
    const plan = makePlan(scope, 'retail'), provider = fakeProvider(plan), deps = dependencies(provider.client);
    for (const mismatch of [{ sellingPartnerId: 'other-seller' }, { marketplaceId: 'other-marketplace' }, { region: 'EU' as const },
      { orgId: '77777777-7777-4777-8777-777777777777' }, { connectionId: '77777777-7777-4777-8777-777777777777' }]) {
      await expect(runSpReportWorkflow({ ...plan, scope: { ...scope, ...mismatch } }, deps)).rejects.toThrow('disabled');
    }
    expect(provider.fetch).not.toHaveBeenCalled(); expect(provider.tokens).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'server', 'missing'] as const)('keeps uncertain %s create across restart with exactly one POST', async create => {
    const scope = await seed('retail'); await enable(scope);
    const plan = makePlan(scope, 'retail'), provider = fakeProvider(plan, { create });
    await expect(runSpReportWorkflow(plan, dependencies(provider.client))).rejects.toBeInstanceOf(SpApiAmbiguousOutcome);
    await expect(runSpReportWorkflow(plan, dependencies(provider.client))).rejects.toBeInstanceOf(SpApiAmbiguousOutcome);
    expect(provider.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(await loadSpReportCheckpoint(database, plan)).toMatchObject({ state: 'creating', reportId: null });
  });

  it('defers repeated pending reports across registry restarts without creating another report or premature coverage', async () => {
    const scope = await seed('retail'); await enable(scope);
    const plan = makePlan(scope, 'retail'), provider = fakeProvider(plan, { pendingPolls: 4 });
    const produce = vi.fn<CoverageProducer>((observation, count) => upsertReportCoverage(database, observation, count));
    const payload = { type: 'retail.report.request' as const, orgId: scope.orgId, profileId: scope.profileId, plan };
    const job: ClaimedJob = { id: '91919191-9191-4191-8191-919191919191', orgId: scope.orgId, profileId: scope.profileId,
      jobType: payload.type, payload, attempts: 1, maxAttempts: 3, claim: null, claimedBy: 'synthetic', dedupeKey: plan.requestId };
    const context = { job, payload, profile: { id: scope.profileId, orgId: scope.orgId, amazonProfileId: 'synthetic',
      region: scope.region, timezone: 'UTC', currencyCode: 'USD' } };
    const restartRegistry = () => {
      const registry = new IngestionRegistry(produce);
      registerSpApiReportSources(registry, dependencies(provider.client));
      return registry;
    };
    // Four provider polls exceed the ordinary three-attempt error budget; this error uses queue deferral.
    for (let poll = 0; poll < 4; poll++) {
      const result = await restartRegistry().dispatch(context).catch((error: unknown) => error);
      expect(result).toBeInstanceOf(SqpWorkflowPendingError);
      expect(result).toMatchObject({ name: 'SpReportPendingError', retryAfterSeconds: 60 });
      expect(await loadSpReportCheckpoint(database, plan)).toMatchObject({ state: 'requested', reportId: `provider-${plan.requestId}`, receipt: null });
      expect(produce).not.toHaveBeenCalled();
      expect(provider.documentCalls()).toBe(0);
      const [rows] = await database.sql`select count(*)::int as n from public.fact_retail_sales_traffic_daily
        where org_id=${scope.orgId} and date=${plan.start}`;
      expect(rows!['n']).toBe(0);
    }
    expect(await restartRegistry().dispatch(context)).toMatchObject({ receipt: { writtenRows: 2, verifiedLoadedRows: 2 } });
    expect(produce).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ loadedRows: 2, observedAt, status: 'complete' }), 2);
    expect(provider.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(provider.fetch.mock.calls.filter(([url]) => url.endsWith(`/reports/provider-${plan.requestId}`))).toHaveLength(5);
    const unknownPlan = makePlan(scope, 'retail', 'unknown-status');
    const unknownProvider = fakeProvider(unknownPlan, { processingStatus: 'SYNTHETIC_UNKNOWN' });
    const unknownCoverage = vi.fn<CoverageProducer>((observation, count) => upsertReportCoverage(database, observation, count));
    const unknownRegistry = new IngestionRegistry(unknownCoverage);
    registerSpApiReportSources(unknownRegistry, dependencies(unknownProvider.client));
    const unknownPayload = { ...payload, plan: unknownPlan };
    const unknown = await unknownRegistry.dispatch({ ...context, payload: unknownPayload,
      job: { ...job, payload: unknownPayload, dedupeKey: unknownPlan.requestId } }).catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(PermanentJobError);
    expect(unknown).not.toBeInstanceOf(SqpWorkflowPendingError);
    expect(unknownCoverage).not.toHaveBeenCalled();
    expect(unknownProvider.documentCalls()).toBe(0);
    const [unknownReceipts] = await database.sql`select count(*)::int as n from public.spapi_report_receipts
      where org_id=${scope.orgId} and request_id=${unknownPlan.requestId}`;
    expect(unknownReceipts!['n']).toBe(0);

    const [rows] = await database.sql`select count(*)::int as n from public.fact_retail_sales_traffic_daily
      where org_id=${scope.orgId} and date=${plan.start}`;
    expect(rows!['n']).toBe(2);
  });

  it('replaces an expired document URL without creating another report and refuses truncated JSON', async () => {
    const scope = await seed('retail'); await enable(scope);
    const plan = makePlan(scope, 'retail'), provider = fakeProvider(plan, { expire: true, gzip: true });
    expect(await runSpReportWorkflow(plan, dependencies(provider.client))).toMatchObject({ verifiedLoadedRows: 2 });
    expect(provider.documentCalls()).toBe(2);
    expect(provider.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    const invalid = makePlan(scope, 'retail'), bad = fakeProvider(invalid, { text: '{"reportSpecification":' });
    await expect(runSpReportWorkflow(invalid, dependencies(bad.client))).rejects.toThrow('Truncated');
    const [receipt] = await database.sql`select count(*)::int as n from public.spapi_report_receipts where org_id=${scope.orgId} and request_id=${invalid.requestId}`;
    expect(receipt!['n']).toBe(0);
  });

  it('provisions only enabled schedules with accepted policy and bounds recent retail restatements', async () => {
    const scopes = await Promise.all((['retail', 'aba', 'catalogue'] as const).map(async family => ({ family, scope: await seed(family) })));
    const now = new Date('2026-09-13T01:00:00.000Z');
    expect(await provisionSpApiReportJobs(database, now)).toEqual({ offered: 0, enqueued: 0, duplicates: 0, disabledScopes: 0 });
    for (const { family, scope } of scopes) {
      await enable(scope);
      await database.sql`update public.spapi_report_sources set policy_accepted=true, next_run_at=${now.toISOString()},
        restatement_days=${family === 'retail' ? 2 : 0} where org_id=${scope.orgId}`;
    }
    expect(await provisionSpApiReportJobs(database, now)).toMatchObject({ offered: 0, enqueued: 0 });
    for (const { scope } of scopes) await database.sql`update public.spapi_report_sources set schedule_enabled=true where org_id=${scope.orgId}`;
    expect(await provisionSpApiReportJobs(database, now)).toEqual({ offered: 5, enqueued: 5, duplicates: 0, disabledScopes: 0 });
    const queued = await database.sql<{ payload: { plan: SpReportPlan } }[]>`select payload from public.sync_jobs
      where org_id=any(${scopes.map(s => s.scope.orgId)}::uuid[]) and job_type::text in ('retail.report.request','aba.report.request','catalogue.report.request')`;
    expect(queued).toHaveLength(5);
    expect(queued.map(q => [q.payload.plan.family, q.payload.plan.start, q.payload.plan.end]).sort()).toEqual([
      ['aba', '2026-09-06', '2026-09-12'], ['catalogue', '2026-09-13', '2026-09-13'],
      ['retail', '2026-09-10', '2026-09-10'], ['retail', '2026-09-11', '2026-09-11'], ['retail', '2026-09-12', '2026-09-12'],
    ]);
    for (const { scope } of scopes) await database.sql`update public.spapi_report_sources set next_run_at=${now.toISOString()} where org_id=${scope.orgId}`;
    expect(await provisionSpApiReportJobs(database, now)).toEqual({ offered: 5, enqueued: 0, duplicates: 5, disabledScopes: 0 });
    const revoked = scopes[0]!.scope;
    await revokeSpApiRefreshToken(database, { orgId: revoked.orgId, connectionId: revoked.connectionId });
    await database.sql`update public.spapi_report_sources set next_run_at=${now.toISOString()} where org_id=${revoked.orgId}`;
    expect(await provisionSpApiReportJobs(database, now)).toEqual({ offered: 0, enqueued: 0, duplicates: 0, disabledScopes: 1 });
    const [disabled] = await database.sql`select schedule_enabled from public.spapi_report_sources where org_id=${revoked.orgId}`;
    expect(disabled!['schedule_enabled']).toBe(false);

    const abaScope = scopes.find(s => s.family === 'aba')!.scope;
    const utcSaturday = new Date('2026-09-12T23:00:00.000Z');
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'long' }).format(utcSaturday)).toBe('Sunday');
    await database.sql`update public.ad_profiles set timezone='Asia/Tokyo' where id=${abaScope.profileId}`;
    await database.sql`update public.spapi_report_sources set next_run_at=${utcSaturday.toISOString()}
      where org_id=${abaScope.orgId} and family='aba'`;
    expect(await provisionSpApiReportJobs(database, utcSaturday)).toEqual({ offered: 1, enqueued: 1, duplicates: 0, disabledScopes: 0 });
    const abaJobs = await database.sql<{ payload: { plan: SpReportPlan } }[]>`select payload from public.sync_jobs
      where org_id=${abaScope.orgId} and job_type='aba.report.request' order by payload->'plan'->>'requestedAt'`;
    expect(abaJobs).toHaveLength(2);
    expect(abaJobs[0]?.payload.plan).toMatchObject({ start: '2026-08-30', end: '2026-09-05', requestedAt: utcSaturday.toISOString() });
    expect(abaJobs[1]?.payload.plan).toMatchObject({ start: '2026-09-06', end: '2026-09-12', requestedAt: now.toISOString() });
    for (const queuedAba of abaJobs) expect(validateSpPlan(queuedAba.payload.plan)).toEqual(queuedAba.payload.plan);

  });

  it('refuses a corrupted completed checkpoint receipt identity before provider or destination calls', async () => {
    const scope = await seed('retail'); await enable(scope);
    const plan = makePlan(scope, 'retail'), provider = fakeProvider(plan), deps = dependencies(provider.client);
    await runSpReportWorkflow(plan, deps);
    await database.sql`update public.spapi_report_runs
      set checkpoint=jsonb_set(checkpoint,'{receipt,report,reportId}','"wrong-report"'::jsonb)
      where org_id=${scope.orgId} and request_id=${plan.requestId}`;
    const calls = provider.fetch.mock.calls.length, verify = vi.fn(deps.verify);
    await expect(runSpReportWorkflow(plan, { ...deps, verify })).rejects.toThrow('mismatched completed report receipt');
    expect(verify).not.toHaveBeenCalled(); expect(provider.fetch).toHaveBeenCalledTimes(calls);
  });

  it('freezes listing certainty from adjacent persisted observations and refuses stale predecessor assumptions', async () => {
    const scope = await seed('catalogue'); await enable(scope);
    const firstPlan = makePlan(scope, 'catalogue'), firstProvider = fakeProvider(firstPlan);
    const first = await runSpReportWorkflow(firstPlan, dependencies(firstProvider.client));
    expect(first.report.listingPreviousReportId).toBeNull();
    expect(first.report.listingChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'title', before: null, after: 'Synthetic title', certainty: expect.objectContaining({ kind: 'first' }) }),
    ]));
    const secondPlan = makePlan(scope, 'catalogue', 'second', '2026-09-14T00:00:00.000Z');
    const secondProvider = fakeProvider(secondPlan, { observedAt: '2026-09-14T00:00:00.000Z',
      text: document(secondPlan).replace('Synthetic title', 'Revised synthetic title') });
    const second = await runSpReportWorkflow(secondPlan, dependencies(secondProvider.client));
    expect(second.report.listingPreviousReportId).toBe(first.report.reportId);
    expect(second.report.listingChanges).toHaveLength(1);
    expect(second.report.listingChanges?.[0]).toMatchObject({ field: 'title', before: 'Synthetic title', after: 'Revised synthetic title',
      certainty: { kind: 'exact', from: observedAt, to: '2026-09-14T00:00:00.000Z', widthDays: 1 } });
    const history = await readSpListingHistory(database, { ...scope, start: firstPlan.start, end: secondPlan.end });
    expect(history).toHaveLength(2);
    expect(history[1]?.listingChanges).toEqual(second.report.listingChanges);
    expect(await runSpReportWorkflow(firstPlan, dependencies(firstProvider.client))).toMatchObject({ writtenRows: 0, report: { listingChanges: first.report.listingChanges } });
    const stalePlan = makePlan(scope, 'catalogue', 'stale', '2026-09-14T01:00:00.000Z'), staleProvider = fakeProvider(stalePlan, { observedAt: '2026-09-14T01:00:00.000Z' });
    await expect(runSpReportWorkflow(stalePlan, { ...dependencies(staleProvider.client), previousListing: async () => first.report }))
      .rejects.toThrow('Listing adjacency changed');
    const [receipts] = await database.sql`select count(*)::int as n from public.spapi_report_receipts where org_id=${scope.orgId} and family='catalogue'`;
    expect(receipts!['n']).toBe(2);
  });

  it.each([
    ['delayed next-day document', '2026-09-14T00:00:00.000Z'],
    ['cached prior-day document', '2026-09-12T00:00:00.000Z'],
  ])('refuses catalogue %s without relabeling the plan or publishing coverage', async (_label, sourceTime) => {
    const scope = await seed('catalogue'); await enable(scope);
    const plan = makePlan(scope, 'catalogue'), provider = fakeProvider(plan, { observedAt: sourceTime });
    const produce = vi.fn<CoverageProducer>((observation, count) => upsertReportCoverage(database, observation, count));
    const registry = new IngestionRegistry(produce);
    registerSpApiReportSources(registry, dependencies(provider.client));
    const payload = { type: 'catalogue.report.request' as const, orgId: scope.orgId, profileId: scope.profileId, plan };
    const job: ClaimedJob = { id: '91919191-9191-4191-8191-919191919191', orgId: scope.orgId, profileId: scope.profileId,
      jobType: payload.type, payload, attempts: 1, maxAttempts: 3, claim: null, claimedBy: 'synthetic', dedupeKey: plan.requestId };
    const context = { job, payload, profile: { id: scope.profileId, orgId: scope.orgId, amazonProfileId: 'synthetic',
      region: scope.region, timezone: 'UTC', currencyCode: 'USD' } };
    await expect(registry.dispatch(context)).rejects.toThrow(/catalogue|snapshot|observation/i);
    await expect(registry.dispatch(context)).rejects.toThrow(/catalogue|snapshot|observation/i);
    expect(produce).not.toHaveBeenCalled();
    expect(provider.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(await loadSpReportCheckpoint(database, plan)).toMatchObject({ plan, state: 'requested', receipt: null });
    const [receipts] = await database.sql`select count(*)::int as n from public.spapi_report_receipts
      where org_id=${scope.orgId} and family='catalogue' and request_id=${plan.requestId}`;
    expect(receipts!['n']).toBe(0);
  });

  it('blocks completed replay and reader after a same-count destination mutation', async () => {
    const scope = await seed('retail'); await enable(scope);
    const plan = makePlan(scope, 'retail'), provider = fakeProvider(plan), deps = dependencies(provider.client);
    await runSpReportWorkflow(plan, deps);
    await database.sql`update public.fact_retail_sales_traffic_daily set payload=jsonb_set(payload,'{sales}','101') where org_id=${scope.orgId} and date=${plan.start}`;
    const calls = provider.fetch.mock.calls.length;
    await expect(runSpReportWorkflow(plan, deps)).rejects.toThrow('readback mismatch');
    expect(provider.fetch).toHaveBeenCalledTimes(calls);
    expect(await readSpReportEvidence(database, { ...scope, family: 'retail', start: plan.start, end: plan.end }))
      .toMatchObject({ state: 'unavailable', report: null });
  });
});
