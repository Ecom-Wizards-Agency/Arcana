import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ProviderCollectionConfig, ProviderRecommendation } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { failProviderEvidenceRun, authorizeProviderEvidencePage, persistProviderEvidencePage, prepareProviderEvidenceRun, readProviderEvidence } from './provider-evidence.js';
let db: TestDatabase; let orgId: string; let profileId: string; let foreignProfile: string; let config: ProviderCollectionConfig;
const user = '00000000-0000-4000-8000-000000000091'; const other = '00000000-0000-4000-8000-000000000092';
const at = '2026-06-01T00:00:00.000Z';
const start = () => prepareProviderEvidenceRun(db, { orgId, profileId, configId: config.id, runId: randomUUID() });
function evidence(version = 'c'.repeat(64)) { return ProviderRecommendation.parse({ family: 'tactical', namespace: config.operation, providerId: 'synthetic-persisted', identityMethod: 'provider', version, apiVersion: 'synthetic-v1', contractHash: 'b'.repeat(64), transport: 'http', scope: config.scope, entity: { adProduct: 'SP', entityType: 'unknown', entityId: null, campaignId: null, adGroupId: null, mapping: 'unresolved' }, kind: 'synthetic', action: 'unknown', current: { value: null, units: null, currency: null }, proposed: { value: null, units: null, currency: null }, estimates: [], objective: null, horizon: null, attribution: null, eligibility: 'unknown', generatedAt: null, expiresAt: '2026-06-03T00:00:00.000Z', retrievedAt: at, observedAt: at, payload: { supplied: 'synthetic' } }); }
beforeAll(async () => {
  db = await createTestDatabase('provider_evidence');
  const [a] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-provider-a',${user},'owner') as id`; orgId = a!.id;
  const [b] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-provider-b',${other},'owner') as id`;
  const [p] = await db.sql<{ id: string; amazon_profile_id: string }[]>`select id,amazon_profile_id from public.ad_profiles where org_id=${orgId}`; profileId = p!.id;
  const [foreign] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${b!.id}`; foreignProfile = foreign!.id;
  config = ProviderCollectionConfig.parse({ id: randomUUID(), scope: { orgId, profileId, amazonProfileId: p!.amazon_profile_id, marketplaceId: 'synthetic-market' }, family: 'tactical', operation: 'tactical.ListRecommendations', request: {}, enabled: true, maxPages: 3, maxRows: 100 });
  await db.sql`insert into public.provider_evidence_configs(id,org_id,profile_id,enabled,config) values(${config.id},${orgId},${profileId},true,${JSON.stringify(config)}::jsonb)`;
}, 60000);
afterAll(async () => { await db?.drop(); });

it('persists duplicate input as one immutable version and independently reads back membership', async () => {
  const result = await persistProviderEvidencePage(db, await start(), { rows: [evidence(), evidence()], source: 3, refused: 1, nextToken: null, status: 'partial' });
  expect(result.counts).toEqual({ source: 3, parsed: 2, refused: 1, duplicates: 1, conflicts: 0, canonical: 1, written: 1, existing: 0, readback: 1 });
  expect(result.status).toBe('partial');
  const read = await asUser(db, user, (sql) => readProviderEvidence({ sql }, { orgId, profileId, consumer: 'recommendations' }));
  expect(read.rows.filter((r) => r.providerId === 'synthetic-persisted')).toHaveLength(1);
  expect(read.totalCount).toBe(read.rows.length);
});
it('replays old observations without renewing freshness, generated time or expiry', async () => {
  const row = evidence(); row.retrievedAt = '2026-06-08T00:00:00.000Z'; row.observedAt = row.retrievedAt;
  const result = await persistProviderEvidencePage(db, await start(), { rows: [row], source: 1, refused: 0, nextToken: null, status: 'complete' });
  expect(result.counts).toMatchObject({ written: 0, existing: 1, readback: 1 }); expect(result.observedAt).toBe(at);
  const [stored] = await db.sql<{ evidence: ProviderRecommendation }[]>`select evidence from public.provider_recommendations where org_id=${orgId} and provider_id='synthetic-persisted'`;
  expect(stored!.evidence.retrievedAt).toBe(at); expect(stored!.evidence.expiresAt).toBe(evidence().expiresAt);
});
it('retains conflicting provider ID versions and refuses changed same-version payloads', async () => {
  const second = evidence('d'.repeat(64)); second.payload = { supplied: 'different' };
  expect((await persistProviderEvidencePage(db, await start(), { rows: [second], source: 1, refused: 0, nextToken: null, status: 'complete' })).counts).toMatchObject({ conflicts: 1, written: 1, readback: 1 });
  const altered = evidence(); altered.proposed.value = 9;
  await expect(persistProviderEvidencePage(db, await start(), { rows: [altered], source: 1, refused: 0, nextToken: null, status: 'complete' })).rejects.toThrow('readback mismatch');
});
it('resumes a persisted checkpoint and never upgrades partial retrieval to complete', async () => {
  const run = await start();
  const page = await persistProviderEvidencePage(db, run, { rows: [], source: 0, refused: 0, nextToken: 'synthetic-cursor', status: 'partial' });
  const resumed = await prepareProviderEvidenceRun(db, { orgId, profileId, configId: config.id, runId: run.id });
  expect(resumed.nextToken).toBe('synthetic-cursor'); expect(resumed.page).toBe(1);
  const final = await persistProviderEvidencePage(db, resumed, { rows: [], source: 0, refused: 0, nextToken: null, status: 'complete' });
  expect(final.status).toBe('partial'); expect(final.incomplete).toBe(true);
  await expect(persistProviderEvidencePage(db, page, { rows: [], source: 0, refused: 0, nextToken: null, status: 'complete' })).rejects.toThrow('checkpoint conflict');
});
it('isolates agencies/profiles and denies modification of immutable versions', async () => {
  expect((await asUser(db, other, (sql) => readProviderEvidence({ sql }, { orgId, profileId, consumer: 'recommendations' }))).rows).toEqual([]);
  expect((await asUser(db, user, (sql) => readProviderEvidence({ sql }, { orgId, profileId: foreignProfile, consumer: 'recommendations' }))).rows).toEqual([]);
  await expect(db.sql`update public.provider_recommendations set provider_id='changed' where org_id=${orgId}`).rejects.toThrow('immutable');
  await expect(db.sql`delete from public.provider_recommendations where org_id=${orgId}`).rejects.toThrow('immutable');
  await expect(asUser(db, user, (sql) => sql`select config from public.provider_evidence_configs`)).rejects.toThrow('permission denied');
  await expect(asUser(db, user, (sql) => sql`select run from public.provider_recommendation_runs`)).rejects.toThrow('permission denied');
});
it('maps exact mirrored IDs, retains missing entities and rejects mismatched parents', async () => {
  const fixtures = [
    { entityType: 'campaign' as const, entityId: 'c-1', campaignId: 'c-1', adGroupId: null, expected: 'mapped' },
    { entityType: 'keyword' as const, entityId: 'kw-1', campaignId: 'other-campaign', adGroupId: 'ag-1', expected: 'scope-mismatch' },
    { entityType: 'target' as const, entityId: 'missing-target', campaignId: 'c-1', adGroupId: 'ag-1', expected: 'missing' },
  ];
  for (const [index,f] of fixtures.entries()) {
    const row = { ...evidence(), providerId: `synthetic-mapping-${index}`, entity: { adProduct: 'SP' as const, entityType: f.entityType, entityId: f.entityId, campaignId: f.campaignId, adGroupId: f.adGroupId, mapping: 'unresolved' as const } };
    await persistProviderEvidencePage(db, await start(), { rows: [row], source: 1, refused: 0, nextToken: null, status: 'complete' });
    const [saved] = await db.sql<{ evidence: ProviderRecommendation }[]>`select evidence from public.provider_recommendations where org_id=${orgId} and profile_id=${profileId} and provider_id=${row.providerId}`;
    expect(saved!.evidence.entity.mapping).toBe(f.expected);
  }
});
it('isolates profiles within one agency and serializes conflicting observations', async () => {
  const sibling = randomUUID();
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${sibling},${orgId},'synthetic-sibling','NA','US','USD','UTC')`;
  expect((await asUser(db, user, (sql) => readProviderEvidence({ sql }, { orgId, profileId: sibling, consumer: 'sync-status' }))).rows).toEqual([]);
  const [a,b] = await Promise.all([start(),start()]);
  const pages = ['e','f'].map((version) => ({ rows: [{ ...evidence(version.repeat(64)), providerId: 'synthetic-concurrent' }], source: 1, refused: 0, nextToken: null, status: 'complete' as const }));
  const result = await Promise.all([persistProviderEvidencePage(db,a,pages[0]!),persistProviderEvidencePage(db,b,pages[1]!)]);
  expect(result.map((r) => r.counts.conflicts).reduce((a,b) => a+b,0)).toBe(1);
  expect(result.map((r) => r.counts.written).reduce((a,b) => a+b,0)).toBe(2);
});
it('records failure, resumes the last page and preserves partial history', async () => {
  const run = await start();
  const checkpoint = await persistProviderEvidencePage(db, run, { rows: [], source: 0, refused: 0, nextToken: 'retained-cursor', status: 'complete' });
  await failProviderEvidenceRun(db, checkpoint);
  const [failed] = await db.sql<{ run: { status: string; nextToken: string } }[]>`select run from public.provider_recommendation_runs where id=${run.id}`;
  expect(failed!.run).toMatchObject({ status: 'failed', nextToken: 'retained-cursor' });
  const resumed = await prepareProviderEvidenceRun(db, { orgId, profileId, configId: config.id, runId: run.id });
  expect(resumed).toMatchObject({ status: 'running', page: 1, incomplete: true, nextToken: 'retained-cursor' });
});
it('refuses substituted checkpoints and incomplete advertised totals', async () => {
  const run = await start();
  const altered = structuredClone(run); altered.config.scope.marketplaceId = 'other-market';
  await expect(persistProviderEvidencePage(db, altered, { rows: [], source: 0, refused: 0, nextToken: null, status: 'complete' })).rejects.toThrow('checkpoint conflict');
  expect((await persistProviderEvidencePage(db, run, { rows: [], source: 0, refused: 0, expectedTotal: 2, nextToken: null, status: 'complete' })).status).toBe('partial');
});
it('persists and scopes every concrete family without creating execution authority', async () => {
  const authority = () => db.sql`select (select count(*) from public.sync_jobs) as jobs,(select count(*) from public.sync_schedules) as schedules,(select count(*) from public.sp_write_approval_requests) as approvals,(select count(*) from public.sp_write_authorization_receipts) as receipts,(select count(*) from public.sp_write_execution_cycles) as cycles,(select md5(coalesce(jsonb_agg(to_jsonb(r) order by id)::text,'')) from public.recommendations r) as recommendations`;
  const before = await authority();
  const families = ['tactical','sp-budget','sp-research','sp-bid','sb-research','sb-recommendations','sb-forecast','sd-recommendations','sd-forecast','rule-evidence'] as const;
  for (const [index, family] of families.entries()) {
    const cfg = { ...config, id: randomUUID(), family, operation: `synthetic.${family}` };
    await db.sql`insert into public.provider_evidence_configs(id,org_id,profile_id,enabled,config) values(${cfg.id},${orgId},${profileId},true,${JSON.stringify(cfg)}::jsonb)`;
    const run = await prepareProviderEvidenceRun(db, { orgId, profileId, configId: cfg.id, runId: randomUUID() });
    const row = { ...evidence(index.toString(16).repeat(64)), family, namespace: cfg.operation, providerId: `family-${family}` };
    const stored = await persistProviderEvidencePage(db, run, { rows: [row], source: 1, refused: 0, nextToken: null, status: 'complete' });
    expect(stored.counts).toMatchObject({ source: 1, parsed: 1, canonical: 1, written: 1, readback: 1 });
  }
  const read = await asUser(db, user, (sql) => readProviderEvidence({ sql }, { orgId, profileId, consumer: 'sync-status' }));
  expect(read.rows.filter((r) => r.providerId.startsWith('family-'))).toHaveLength(families.length);
  expect(await authority()).toEqual(before);
});
it('rejects source revocation and cross-profile evidence before persistence', async () => {
  const run = await start();
  const wrong = evidence(); wrong.scope.profileId = foreignProfile;
  await expect(persistProviderEvidencePage(db, run, { rows: [wrong], source: 1, refused: 0, nextToken: null, status: 'complete' })).rejects.toThrow('scope mismatch');
  await db.sql`update public.provider_evidence_configs set enabled=false where id=${config.id}`;
  await expect(authorizeProviderEvidencePage(db, run)).rejects.toThrow('disabled');
  await expect(start()).rejects.toThrow('disabled');
});
