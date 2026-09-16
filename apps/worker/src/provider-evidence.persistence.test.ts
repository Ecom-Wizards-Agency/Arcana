import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderCollectionConfig } from '@wizard-ads/shared';
import { buildProviderEvidenceRequest, parseProviderEvidenceResponse, providerReadContract } from '@wizard-ads/ads-api';
import { upsertReportCoverage, type ClaimedJob } from '@wizard-ads/db';
import { prepareProviderEvidenceRun, authorizeProviderEvidencePage, persistProviderEvidencePage, failProviderEvidenceRun } from '@wizard-ads/db/worker';
import { createTestDatabase } from '@wizard-ads/db/testing';
import { IngestionRegistry } from './ingestion-registry.js';
import { registerProviderEvidence } from './provider-evidence.js';

it('publishes WP-256 coverage only after counted page persistence and keeps replay freshness', async () => {
  const db = await createTestDatabase('provider_collection');
  try {
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-provider-collection',${randomUUID()},'owner') as id`;
    const [profile] = await db.sql<{ id: string; amazon_profile_id: string }[]>`select id,amazon_profile_id from public.ad_profiles where org_id=${org!.id}`;
    const config = ProviderCollectionConfig.parse({ id: randomUUID(), scope: { orgId: org!.id, profileId: profile!.id, amazonProfileId: profile!.amazon_profile_id, marketplaceId: 'synthetic-market' }, family: 'tactical', operation: 'tactical.ListRecommendations', request: {}, enabled: true, maxPages: 2, maxRows: 10 });
    await db.sql`insert into public.provider_evidence_configs(id,org_id,profile_id,enabled,config) values(${config.id},${org!.id},${profile!.id},true,${JSON.stringify(config)}::jsonb)`;
    const at = '2026-06-01T00:00:00.000Z'; let calls = 0;
    const registry = new IngestionRegistry(async (observation, verified) => {
      const rows = await db.sql`select id from public.provider_recommendations where org_id=${org!.id} and provider_id='synthetic-collected'`;
      expect(rows).toHaveLength(verified);
      return upsertReportCoverage(db, observation, verified);
    });
    registerProviderEvidence(registry, {
      enabled: () => true,
      prepare: (scope) => prepareProviderEvidenceRun(db, scope),
      authorize: (run) => authorizeProviderEvidencePage(db, run),
      persist: (run, page) => persistProviderEvidencePage(db, run, page),
      fail: (run) => failProviderEvidenceRun(db, run),
      read: async (cfg, cursor) => {
        calls++;
        return parseProviderEvidenceResponse(cfg, { recommendations: [{ adProduct: 'SP', recommendationId: 'synthetic-collected', recommendationType: 'CAMPAIGN_BUDGET', status: 'PUBLISHED', campaignId: 'c-1', currentValue: '10', recommendedValue: '12' }], totalResults: 2, ...(cursor === null ? { nextToken: 'synthetic-second-page' } : {}) }, at);
      },
    });
    const payload = { type: 'provider.evidence.collect' as const, orgId: org!.id, profileId: profile!.id, configId: config.id };
    const job = { id: randomUUID(), orgId: org!.id, profileId: profile!.id, jobType: payload.type, payload } as ClaimedJob;
    const context = { job, payload, profile: { id: profile!.id, orgId: org!.id, amazonProfileId: profile!.amazon_profile_id, region: 'NA' as const, timezone: 'UTC', currencyCode: 'USD' } };
    await registry.dispatch(context);
    const [coverage] = await db.sql`select status,source_rows::int,parsed_rows::int,loaded_rows::int,refused_rows::int,observed_at from public.report_coverage where profile_id=${profile!.id} and source='amazon_provider_evidence'`;
    expect(coverage).toMatchObject({ status: 'complete', source_rows: 2, parsed_rows: 2, loaded_rows: 1, refused_rows: 0 });
    expect(new Date(coverage!['observed_at'] as string).toISOString()).toBe(at);
    expect(calls).toBe(2);
    await registry.dispatch(context);
    expect(calls).toBe(2);
    const [count] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.report_coverage where profile_id=${profile!.id} and source='amazon_provider_evidence'`;
    expect(count!.count).toBe(1);
  } finally { await db.drop(); }
}, 60000);


describe('provider parser through checkpoint persistence and coverage', () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  beforeAll(async () => { db = await createTestDatabase('provider_rework'); }, 60000);
  afterAll(async () => { await db?.drop(); }, 60000);

  async function collection(operation: string, request: Record<string, unknown>, responses: unknown[], interruptSecond = false) {
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`synthetic-provider-rework-${randomUUID()}`},${randomUUID()},'owner') as id`;
    const [profile] = await db.sql<{ id: string; amazon_profile_id: string }[]>`select id,amazon_profile_id from public.ad_profiles where org_id=${org!.id}`;
    const config = ProviderCollectionConfig.parse({ id: randomUUID(), scope: { orgId: org!.id, profileId: profile!.id, amazonProfileId: profile!.amazon_profile_id, marketplaceId: 'synthetic-market' }, family: providerReadContract(operation).family, operation, request, enabled: true, maxPages: 5, maxRows: 10 });
    await db.sql`insert into public.provider_evidence_configs(id,org_id,profile_id,enabled,config) values(${config.id},${org!.id},${profile!.id},true,${JSON.stringify(config)}::jsonb)`;
    const payload = { type: 'provider.evidence.collect' as const, orgId: org!.id, profileId: profile!.id, configId: config.id };
    const job = { id: randomUUID(), orgId: org!.id, profileId: profile!.id, jobType: payload.type, payload } as ClaimedJob;
    const context = { job, payload, profile: { id: profile!.id, orgId: org!.id, amazonProfileId: profile!.amazon_profile_id, region: 'NA' as const, timezone: 'UTC', currencyCode: 'USD' } };
    const requests: ReturnType<typeof buildProviderEvidenceRequest>[] = [];
    let responseIndex = 0; let interrupted = false;
    const createRegistry = () => {
      const registry = new IngestionRegistry((observation, verified) => upsertReportCoverage(db, observation, verified));
      registerProviderEvidence(registry, {
        enabled: () => true, prepare: (scope) => prepareProviderEvidenceRun(db, scope),
        authorize: (run) => authorizeProviderEvidencePage(db, run), persist: (run, page) => persistProviderEvidencePage(db, run, page), fail: (run) => failProviderEvidenceRun(db, run),
        read: async (cfg, cursor) => {
          requests.push(buildProviderEvidenceRequest(cfg, cursor));
          if (interruptSecond && responseIndex === 1 && !interrupted) { interrupted = true; throw new Error('Synthetic transport interruption'); }
          return parseProviderEvidenceResponse(cfg, responses[responseIndex++], '2026-06-01T00:00:00.000Z');
        },
      });
      return registry;
    };
    const state = async () => {
      const [stored] = await db.sql`select run from public.provider_recommendation_runs where id=${job.id}`;
      const rows = await db.sql`select e.id from public.provider_recommendation_run_rows m join public.provider_recommendations e on e.id=m.evidence_id where m.run_id=${job.id}`;
      const coverage = await db.sql`select status,source_rows::int,parsed_rows::int,loaded_rows::int,refused_rows::int from public.report_coverage where profile_id=${profile!.id} and source='amazon_provider_evidence'`;
      return { run: stored!['run'], rows, coverage };
    };
    return { createRegistry, context, state, requests, config };
  }

  it.each([
    { name: 'single-page omission', totals: [2], status: 'partial' },
    { name: 'last-page omission', totals: [3, 3], status: 'partial' },
    { name: 'changed advertised total', totals: [2, 3], status: 'partial' },
    { name: 'omitted later total retains earlier count', totals: [3, null], status: 'partial' },
    { name: 'reconciled pages', totals: [2, 2], status: 'complete' },
  ])('reconciles totalCount through persisted coverage: $name', async ({ totals, status }) => {
    const responses = totals.map((totalCount, i) => ({ optimizationRules: [{ optimizationRuleId: `synthetic-rule-${i}` }], ...(totalCount === null ? {} : { totalCount }), ...(i < totals.length - 1 ? { nextToken: 'synthetic-second' } : {}) }));
    const test = await collection('sb.ListSponsoredBrandsOptimizationRules', {}, responses);
    await test.createRegistry().dispatch(test.context);
    const { run, rows, coverage } = await test.state();
    expect(run).toMatchObject({ status, expectedTotal: totals[0], page: totals.length, counts: { source: totals.length, parsed: totals.length, refused: 0, canonical: totals.length, written: totals.length, readback: totals.length } });
    expect(rows).toHaveLength(totals.length);
    expect(coverage).toEqual([expect.objectContaining({ status, source_rows: totals.length, parsed_rows: totals.length, loaded_rows: totals.length, refused_rows: 0 })]);
  });

  it.each([false, true])('collects POST query-cursor pages with restart=%s', async (restart) => {
    const test = await collection('sb.SBInsightsCampaignInsights', { adGroups: [{ adFormat: 'VIDEO' }] }, [
      { insights: [{ keywordInsight: { keywordText: 'synthetic first', adGroupIndex: 0 } }], nextToken: 'synthetic+/second=' },
      { insights: [{ keywordInsight: { keywordText: 'synthetic second', adGroupIndex: 0 } }] },
    ], restart);
    if (restart) {
      await expect(test.createRegistry().dispatch(test.context)).rejects.toThrow('checkpoint retained');
      const interrupted = await test.state();
      expect(interrupted.run).toMatchObject({ status: 'failed', page: 1, nextToken: 'synthetic+/second=', counts: { source: 1, canonical: 1, readback: 1 } });
      expect(interrupted.rows).toHaveLength(1); expect(interrupted.coverage).toHaveLength(0);
    }
    await test.createRegistry().dispatch(test.context);
    const { run, rows, coverage } = await test.state();
    expect(run).toMatchObject({ status: restart ? 'partial' : 'complete', page: 2, nextToken: null, counts: { source: 2, parsed: 2, refused: 0, canonical: 2, written: 2, readback: 2 } });
    expect(rows).toHaveLength(2); expect(coverage).toEqual([expect.objectContaining({ status: restart ? 'partial' : 'complete', source_rows: 2, loaded_rows: 2 })]);
    expect(test.requests.map((r) => r.body)).toEqual(Array.from({ length: restart ? 3 : 2 }, () => test.config.request));
    expect(test.requests.map((r) => new URL(r.path, 'https://synthetic.invalid').searchParams.get('nextToken'))).toEqual(restart ? [null, 'synthetic+/second=', 'synthetic+/second='] : [null, 'synthetic+/second=']);
    await test.createRegistry().dispatch(test.context);
    expect(test.requests).toHaveLength(restart ? 3 : 2);
  });

  it('persists two campaign-filter pages without requiring every campaign on each page', async () => {
    const test = await collection('sp.getCampaignRecommendations', { campaignIds: ['synthetic-a', 'synthetic-b'] }, [
      { recommendations: [{ campaignId: 'synthetic-a' }], nextToken: 'synthetic-second' },
      { recommendations: [{ campaignId: 'synthetic-b' }] },
    ]);
    await test.createRegistry().dispatch(test.context);
    const { run, rows, coverage } = await test.state();
    expect(run).toMatchObject({ status: 'complete', counts: { source: 2, parsed: 2, canonical: 2, readback: 2 } });
    expect(rows).toHaveLength(2); expect(coverage).toEqual([expect.objectContaining({ status: 'complete', loaded_rows: 2 })]);
  });
});
