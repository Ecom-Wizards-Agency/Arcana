import { upsertReportCoverage } from './queries/report-coverage.js';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { CORE_REPORT_FAMILIES, CoreFeatureReportType, type CoreReportConfiguration, type CoreReportPromotion } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { asActor } from './testing/rls.js';
import { promoteCoreReportWindow, readCoreReportFacts, readCoreReportEvidence, coreReportGrain, coreReportFactTable } from './queries/report-families.js';

describe('WP-310 partitioned family persistence', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  const owner = randomUUID();
  beforeAll(async () => {
    database = await createTestDatabase('wp310_families');
    const [org] = await database.sql`select app.seed_tenant_fixture('synthetic-wp310',${owner},'owner') as id`;
    orgId = org!['id'] as string;
    const [profile] = await database.sql`select id from public.ad_profiles where org_id=${orgId} limit 1`;
    profileId = profile!['id'] as string;
  }, 120_000);
  afterAll(async () => { await database?.drop(); });

  async function prepare(family: CoreFeatureReportType, timeUnit: 'DAILY' | 'SUMMARY'): Promise<CoreReportPromotion> {
    const spec = CORE_REPORT_FAMILIES[family];
    const configuration: CoreReportConfiguration = { version: 1, family, timeUnit, format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: [...(timeUnit === 'DAILY' ? ['date'] : ['startDate', 'endDate']), ...spec.required, ...spec.defaultMetrics] };
    const reportRequestId = randomUUID();
    const requestedAt = '2026-09-03T00:00:00.000Z';
    await database.sql`insert into public.report_requests (id,org_id,profile_id,report_type,start_date,end_date,requested_at,family_configuration) values (${reportRequestId},${orgId},${profileId},${family}::public.report_type,'2026-09-01','2026-09-02',${requestedAt},${JSON.stringify(configuration)}::jsonb)`;
    const rows = [1, 2].map((n) => ({ family, timeUnit, periodStart: '2026-09-01', periodEnd: timeUnit === 'SUMMARY' ? '2026-09-02' : '2026-09-01', attributionGeneration: 'legacy' as const, identityResolution: 'reported_unresolved' as const, dimensions: Object.fromEntries([...spec.required.map((key) => [key, key === 'campaignId' || key === 'adGroupId' || (family.includes('MatchedTarget') && key === 'targetingId') || ((family === 'sbSearchTerm' || family === 'spQueryMetrics') && key === 'keywordId') ? 'same-parent' : `synthetic-${key}-${n}`]), ...spec.optional.map((key) => [key, null])]), metrics: { [spec.defaultMetrics[0]!]: n === 1 ? null : 0 } }));
    // Campaign-only and ad-group-only grains need two distinct campaigns.
    if (JSON.stringify(rows[0]?.dimensions) === JSON.stringify(rows[1]?.dimensions)) rows[1]!.dimensions['campaignId'] = 'second-parent';
    return { orgId, profileId, reportRequestId, requestedAt, observedAt: '2026-09-03T01:00:00.000Z', startDate: '2026-09-01', endDate: '2026-09-02', parsed: { configuration, sourceRows: 2, parsedRows: 2, duplicateRows: 0, refusals: [], rows } };
  }
  for (const family of CoreFeatureReportType.options) for (const timeUnit of ['DAILY', 'SUMMARY'] as const) {
    it(`${family}/${timeUnit}: preserves two identities, values, replay and tenant isolation`, async () => {
      const input = await prepare(family, timeUnit);
      const result = await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, input));
      expect(result.loadedRows).toBe(2);
      const read = await readCoreReportFacts(database, { orgId, profileId, configuration: input.parsed.configuration, startDate: input.startDate, endDate: input.endDate });
      expect(read.rowCount).toBe(2);
      expect(read.rows.map((row) => row.dimensions)).toEqual(expect.arrayContaining(input.parsed.rows.map((row) => row.dimensions)));
      const replay = await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, { ...input, observedAt: '2026-09-10T00:00:00.000Z' }));
      expect(replay).toEqual(result);
      expect((await readCoreReportFacts(database, { orgId: randomUUID(), profileId, configuration: input.parsed.configuration, startDate: input.startDate, endDate: input.endDate })).rowCount).toBe(0);
      const hidden = await asActor(database, { role: 'authenticated', userId: randomUUID() }, (sql) => readCoreReportFacts({ sql }, { orgId, profileId, configuration: input.parsed.configuration, startDate: input.startDate, endDate: input.endDate }));
      expect(hidden.rowCount).toBe(0);
      const partition = `${coreReportFactTable(input.parsed.configuration)}_202609`;
      await expect(asActor(database, { role: 'authenticated', userId: randomUUID() }, (sql) => sql.unsafe(`select * from public.${partition}`))).rejects.toMatchObject({ code: '42501' });
    });
  }
  it('rolls back facts on downstream completion failure', async () => {
    const input = await prepare('spAdvertisedProduct', 'DAILY');
    input.requestedAt = '2026-09-04T00:00:00.000Z';
    await database.sql`update public.report_requests set requested_at=${input.requestedAt} where id=${input.reportRequestId}`;
    input.parsed.rows[0]!.metrics['impressions'] = 99;
    await expect(database.sql.begin(async (sql) => { await promoteCoreReportWindow({ sql }, input); throw new Error('completion failed'); })).rejects.toThrow('completion failed');
    const read = await readCoreReportFacts(database, { orgId, profileId, configuration: input.parsed.configuration, startDate: input.startDate, endDate: input.endDate });
    expect(read.rows.some((row) => row.metrics['impressions'] === 99)).toBe(false);
    expect(await database.sql`select * from public.report_family_attempts where report_request_id=${input.reportRequestId}`).toHaveLength(0);
  });
  it('publishes verified empty evidence, preserves observation on replay and refuses corruption', async () => {
    const input = await prepare('spPurchasedProduct', 'DAILY');
    input.requestedAt = '2026-09-05T00:00:00.000Z';
    await database.sql`update public.report_requests set requested_at=${input.requestedAt} where id=${input.reportRequestId}`;
    input.parsed = { ...input.parsed, sourceRows: 0, parsedRows: 0, rows: [] };
    await database.sql.begin(async (sql) => {
      const promoted = await promoteCoreReportWindow({ sql }, input);
      expect(promoted.loadedRows).toBe(0);
      await upsertReportCoverage({ sql }, { orgId, profileId, reportType: 'spPurchasedProduct', grain: coreReportGrain(input.parsed.configuration), source: 'amazon_reporting_v3', status: 'complete', earliestDate: input.startDate, coveredThrough: input.endDate, settledThrough: null, observedAt: promoted.observedAt, sourceRows: 0, parsedRows: 0, loadedRows: 0, refusedRows: 0, countsMatch: true }, 0);
    });
    const evidence = await readCoreReportEvidence(database, { orgId, profileId, families: ['spPurchasedProduct'], startDate: input.startDate, endDate: input.endDate });
    expect(evidence.find((e) => e.variant === coreReportGrain(input.parsed.configuration).slice('purchased_product:'.length))).toMatchObject({ status: 'measured', rowCount: 0, observedAt: input.observedAt });
    const replay = await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, { ...input, observedAt: '2026-09-10T00:00:00.000Z' }));
    expect(replay.observedAt).toBe(input.observedAt);
    expect((await readCoreReportEvidence(database, { orgId, profileId, families: ['spPurchasedProduct'], startDate: input.startDate, endDate: '2026-09-03' })).some((e) => e.status === 'stale')).toBe(true);
  });
  it('retains exact refusal accounting without replacing newer measured identities', async () => {
    const input = await prepare('sdTargetingMatchedTarget', 'DAILY');
    input.requestedAt = '2026-09-06T00:00:00.000Z';
    await database.sql`update public.report_requests set requested_at=${input.requestedAt} where id=${input.reportRequestId}`;
    input.parsed.sourceRows++;
    input.parsed.refusals.push({ index: 2, reason: 'invalid_dimension' });
    const promoted = await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, input));
    expect(promoted.loadedRows).toBe(0);
    const [attempt] = await database.sql`select source_rows,parsed_rows,refused_rows,canonical_rows,staged_rows,promoted_rows,verified_rows,refusals from public.report_family_attempts where report_request_id=${input.reportRequestId}`;
    expect([attempt?.['source_rows'],attempt?.['parsed_rows'],attempt?.['refused_rows'],attempt?.['canonical_rows'],attempt?.['verified_rows']].map(Number)).toEqual([3,2,1,2,0]);
    expect([attempt?.['staged_rows'], attempt?.['promoted_rows']].map(Number)).toEqual([2, 0]);
    expect(attempt?.['refusals']).toEqual([{ index: 2, reason: 'invalid_dimension' }]);
    expect((await readCoreReportFacts(database, { orgId, profileId, configuration: input.parsed.configuration, startDate: input.startDate, endDate: input.endDate })).rowCount).toBe(2);
  });
  it('refuses stale watermarks and independently detects changed persisted values on replay', async () => {
    const input = await prepare('sbTargeting', 'DAILY');
    const stale = await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, input));
    expect(stale).toMatchObject({ loadedRows: 0, superseded: true });
    input.requestedAt = '2026-09-07T00:00:00.000Z';
    // A distinct request gets a distinct immutable attempt.
    const next = await prepare('sbTargeting', 'DAILY');
    next.requestedAt = input.requestedAt;
    await database.sql`update public.report_requests set requested_at=${next.requestedAt} where id=${next.reportRequestId}`;
    expect((await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, next))).loadedRows).toBe(2);
    await database.sql`update public.fact_sb_target_daily set row_data=jsonb_set(row_data,'{metrics,impressions}','99') where report_request_id=${next.reportRequestId}`;
    await expect(database.sql.begin((sql) => promoteCoreReportWindow({ sql }, next))).rejects.toThrow('readback mismatch');
  });

  it('rolls back a partially inserted staging set before touching destination rows', async () => {
    const input = await prepare('sdAdvertisedProduct', 'DAILY');
    input.requestedAt = '2026-09-09T00:00:00.000Z';
    await database.sql`update public.report_requests set requested_at=${input.requestedAt} where id=${input.reportRequestId}`;
    input.parsed.rows[1] = structuredClone(input.parsed.rows[0]!);
    await expect(database.sql.begin((sql) => promoteCoreReportWindow({ sql }, input))).rejects.toThrow('duplicate key');
    expect(await database.sql`select * from public.report_family_attempts where report_request_id=${input.reportRequestId}`).toHaveLength(0);
    expect((await readCoreReportFacts(database, { orgId, profileId, configuration: input.parsed.configuration, startDate: input.startDate, endDate: input.endDate })).rowCount).toBe(2);
  });

});
