import { readGridPerformance } from '@wizard-ads/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestDatabase,
  databaseAvailable,
  type TestDatabase,
} from '@wizard-ads/db/testing';
import {
  revokeSpApiRefreshToken,
  readSqpWeeklyFacts,
  upsertReportCoverage,
  type ClaimedJob,
  storeSpApiRefreshToken,
} from '@wizard-ads/db';
import { createSpApiSqpRequestHandler } from './spapi-sqp.js';
import { SqpWorkflowPermanentError } from './sqp.js';
import { PostgresWeeklySqpScheduler } from './sqp-scheduler.js';
import { IngestionRegistry, type CoverageProducer } from './ingestion-registry.js';
import { registerIntegrationSources } from './integration-sources.js';
import type { SqpRequestJob } from '@wizard-ads/shared';

const available = await databaseAvailable();
const OWNER = '88888888-8888-4888-8888-888888888888';
const value = (kind: string): string => ['synthetic', kind, 'value'].join('-');

function sqpRow(): Record<string, unknown> {
  return {
    startDate: '2026-08-16',
    endDate: '2026-08-22',
    asin: 'B0TEST0001',
    searchQueryData: {
      searchQuery: 'Synthetic Query',
      searchQueryScore: 1,
      searchQueryVolume: 100,
    },
    impressionData: {
      totalQueryImpressionCount: 80,
      asinImpressionCount: 8,
      asinImpressionShare: 0.1,
    },
    clickData: { totalClickCount: 20, asinClickCount: 4, asinClickShare: 0.2 },
    cartAddData: { totalCartAddCount: 10, asinCartAddCount: 2, asinCartAddShare: 0.2 },
    purchaseData: { totalPurchaseCount: 5, asinPurchaseCount: 2, asinPurchaseShare: 0.4 },
  };
}

describe.skipIf(!available)('tenant-scoped SP-API SQP runtime', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let connectionId: string;
  const marketplaceId = 'ATVPDKIKX0DER';

  beforeAll(async () => {
    database = await createTestDatabase('spapi_runtime');
    const [tenant] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('spapi-runtime', ${OWNER}, 'owner')
    `;
    orgId = tenant?.seed_tenant_fixture ?? '';
    const [binding] = await database.sql<{ profile_id: string; connection_id: string }[]>`
      select profile_id, connection_id
        from public.spapi_profile_bindings
       where org_id = ${orgId}
    `;
    profileId = binding?.profile_id ?? '';
    connectionId = binding?.connection_id ?? '';
    await storeSpApiRefreshToken(database, {
      orgId,
      connectionId,
      refreshToken: value('refresh'),
    });
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('schedules an enabled scope through registration, verifies persisted replay, and refuses revoked or damaged evidence', async () => {
    const payload = {
      type: 'sqp.request' as const,
      orgId,
      profileId,
      marketplaceId,
      asins: ['B0TEST0001'],
      weekStart: '2026-08-16',
      weekEnd: '2026-08-22',
    };


    const calls: Array<{ host: string; path: string; method: string }> = [];
    const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(input);
      calls.push({ host: url.host, path: url.pathname, method: init?.method ?? 'GET' });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
      if (url.host === 'api.amazon.com') {
        return json({ access_token: value('access'), expires_in: 3_600 });
      }
      if (url.host === 'sellingpartnerapi-na.amazon.com' && init?.method === 'POST') {
        return json({ reportId: 'synthetic-report-id' });
      }
      if (url.pathname.endsWith('/reports/synthetic-report-id')) {
        return json({
          reportId: 'synthetic-report-id',
          reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT',
          processingStatus: 'DONE',
          reportDocumentId: 'synthetic-document-id',
          createdTime: '2026-08-23T00:00:00.000Z',
        });
      }
      if (url.pathname.endsWith('/documents/synthetic-document-id')) {
        return json({
          url: 'https://documents.example.test/synthetic-document-id',
        });
      }
      if (url.host === 'documents.example.test') {
        return json({ dataByAsin: [sqpRow()] });
      }
      return json({ errors: [{ code: 'UnexpectedRoute' }] }, 404);
    };
    const handler = createSpApiSqpRequestHandler({
      handle: database,
      lwaClientId: value('app-id'),
      lwaClientSecret: value('app-key'),
      fetch,
      providerGate: { beforeCall: async () => {} },
      now: () => new Date('2026-08-23T01:00:00.000Z'),
    });

    await database.sql`update public.spapi_profile_bindings set enabled = false where org_id = ${orgId}`;
    await expect(handler(payload, { jobId: 'disabled-job' })).rejects.toBeInstanceOf(SqpWorkflowPermanentError);
    await expect(handler({ ...payload, marketplaceId: 'unbound-marketplace' }, { jobId: 'unbound-job' }))
      .rejects.toBeInstanceOf(SqpWorkflowPermanentError);
    expect(calls).toHaveLength(0);

    const offered: SqpRequestJob[] = [];
    let job: ClaimedJob | undefined;
    const scheduler = new PostgresWeeklySqpScheduler(database, {
      enqueue: async (scheduled, _runAt, dedupeKey) => {
        offered.push(scheduled);
        if (job) return false;
        const [inserted] = await database.sql<{ id: string }[]>`
          insert into public.sync_jobs
            (org_id, profile_id, job_type, payload, status, claimed_by, claimed_at, dedupe_key)
          values (${orgId}, ${profileId}, 'sqp.request', ${JSON.stringify(scheduled)}::jsonb,
            'running', 'synthetic-worker', now(), ${dedupeKey}) returning id
        `;
        if (!inserted) throw new Error('Synthetic scheduler lost its queued job');
        job = { id: inserted.id, orgId, profileId, jobType: 'sqp.request', payload: scheduled,
          attempts: 1, maxAttempts: 3, claim: null, claimedBy: 'synthetic-worker', dedupeKey };
        return true;
      },
    }, () => new Date('2026-08-23T01:00:00.000Z'));
    expect(await scheduler.enqueueDueSqpRequests()).toMatchObject({ scopes: 0, offeredJobs: 0 });
    await database.sql`update public.spapi_profile_bindings set enabled = true where org_id = ${orgId}`;
    expect(await scheduler.enqueueDueSqpRequests()).toMatchObject({
      scopes: 1, sourceAsinRows: 1, uniqueAsins: 1, duplicateAsinRows: 0, refusedAsinRows: 0,
      offeredJobs: 1, enqueuedJobs: 1, alreadyPresentJobs: 0,
    });
    expect(await scheduler.enqueueDueSqpRequests()).toMatchObject({ enqueuedJobs: 0, alreadyPresentJobs: 1 });
    expect(offered).toEqual([payload, payload]);
    if (!job) throw new Error('Synthetic scheduler did not enqueue');
    const context = { job, payload: offered[0]!, profile: {
      id: profileId, orgId, amazonProfileId: 'synthetic', region: 'NA' as const,
      timezone: 'UTC', currencyCode: 'USD',
    } };
    const produce = vi.fn<CoverageProducer>((observation, verifiedRows) =>
      upsertReportCoverage(database, observation, verifiedRows));
    const registry = new IngestionRegistry(produce);
    registerIntegrationSources(registry, { sqpRequest: handler });
    const result = await registry.dispatch(context);
    expect(result).toMatchObject({
      status: 'completed',
      reports: { total: 1, created: 1 },
      ingestion: { sourceRows: 1, parsedRows: 1, promotedRows: 1, canonicalRows: 1 },
    });
    expect(calls.map((call) => `${call.method} ${call.host}${call.path}`)).toEqual([
      'POST api.amazon.com/auth/o2/token',
      'POST sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports',
      'GET sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports/synthetic-report-id',
      'GET sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/synthetic-document-id',
      'GET documents.example.test/synthetic-document-id',
    ]);
    expect(calls.every((call) => !call.host.includes('advertising-api'))).toBe(true);

    const [canonical] = await database.sql<{ rows: string }[]>`
      select count(*)::text as rows
        from public.fact_sqp_weekly
       where profile_id = ${profileId}
         and week_start = '2026-08-16'
         and asin = 'B0TEST0001'
    `;
    expect(Number(canonical?.rows)).toBe(1);

    const reader = await readSqpWeeklyFacts(database, {
      orgId, profileId, marketplaceId, weekStart: payload.weekStart, asins: payload.asins,
    });
    expect(reader).toHaveLength(1);
    expect(reader[0]).toMatchObject({ searchQuery: 'Synthetic Query', searchQueryVolume: 100,
      asinClicks: 4, asinClickShare: 0.2, asinPurchases: 2, asinPurchaseShare: 0.4 });
    const [coverage] = await database.sql<{ source_rows: string; loaded_rows: string; observed_at: string }[]>`
      select source_rows, loaded_rows, observed_at from public.report_coverage
       where org_id = ${orgId} and profile_id = ${profileId}
         and report_type = 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT'
    `;
    expect(coverage).toMatchObject({ source_rows: '1', loaded_rows: '1' });
    expect(new Date(coverage?.observed_at ?? '').toISOString()).toBe('2026-08-23T01:00:00.000Z');
    expect((await readGridPerformance(database,orgId,profileId,payload.weekStart,payload.weekEnd)).feeds.find(feed=>feed.feed==='SQP'))
      .toMatchObject({status:'complete',daysHeld:7,daysRequested:7});
    const providerCalls = calls.length;
    expect(await registry.dispatch(context)).toMatchObject({ status: 'completed', reused: true,
      observedAt: '2026-08-23T01:00:00.000Z' });
    expect(calls).toHaveLength(providerCalls);
    expect(produce).toHaveBeenCalledTimes(2);
    await expect(produce.mock.results[1]?.value).resolves.toEqual({ offered: 1, written: 0, unchanged: 1 });

    // A changed metric with the same row count must also fail the fingerprint readback.
    await database.sql`update public.fact_sqp_weekly set search_volume = 101
      where org_id = ${orgId} and profile_id = ${profileId} and week_start = ${payload.weekStart}
        and marketplace_id = ${marketplaceId} and asin = 'B0TEST0001'`;
    await expect(registry.dispatch(context)).rejects.toThrow('different evidence');
    await database.sql`delete from public.fact_sqp_weekly
      where org_id = ${orgId} and profile_id = ${profileId} and week_start = ${payload.weekStart}
        and marketplace_id = ${marketplaceId} and asin = 'B0TEST0001'`;
    await expect(registry.dispatch(context)).rejects.toThrow('counts do not match offered rows');
    expect(calls).toHaveLength(providerCalls);
    expect(produce).toHaveBeenCalledTimes(2);

    await revokeSpApiRefreshToken(database, { orgId, connectionId });
    const callsBeforeRevokedAttempt = calls.length;
    const revokedPayload = {
      ...payload,
      weekStart: '2026-08-09',
      weekEnd: '2026-08-15',
    };
    await expect(handler(revokedPayload, { jobId: job?.id ?? '' }))
      .rejects.toBeInstanceOf(SqpWorkflowPermanentError);
    expect(calls).toHaveLength(callsBeforeRevokedAttempt);
  });
});
