import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { ProviderCollectionConfig } from '@wizard-ads/shared';
import { parseProviderEvidenceResponse } from '@wizard-ads/ads-api';
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
