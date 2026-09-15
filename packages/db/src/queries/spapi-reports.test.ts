import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpParsedReport, type SpReportScope } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { storeSpApiRefreshToken } from './spapi.js';
import { promoteSpReport, readSpReportEvidence, readSpRetailSpendEvidence, resolveSpReportScope, verifySpReport,
  saveSpReportCheckpoint, loadSpReportCheckpoint } from './spapi-reports.js';

const available = await databaseAvailable();
const owner = '62626262-6262-4262-8262-626262626262';
const outsider = '63636363-6363-4363-8363-636363636363';
const date = '2026-09-12';
let serial = 0;
function retail(scope: SpReportScope, requestId: string, observedAt = '2026-09-13T01:00:00.000Z', sales = 100): SpParsedReport {
  return SpParsedReport.parse({ plan: { scope, family: 'retail', requestId, start: date, end: date,
    requestedAt: observedAt, contractVersion: 'synthetic-storage-contract' }, reportId: `provider-${requestId}`,
    documentId: `document-${requestId}`, observedAt, payloadFingerprint: 'a'.repeat(64), complete: true,
    rows: [{ kind: 'retail', key: 'total-USD', date, grain: 'total', asin: null, parentAsin: null,
      sales, currency: 'USD', units: 5, orderItems: 4, sessions: 20, pageViews: 30, reportedUnitSessionPercentage: 25 }],
    counts: { sourceRows: 1, parsedRows: 1, refusedRows: 0, duplicateRows: 0, addedRows: 0, canonicalRows: 1 } });
}

describe.skipIf(!available)('SP-API source persistence on disposable PostgreSQL', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('wp301_sp_db'); }, 60_000);
  afterAll(async () => { await database?.drop(); });
  async function seed(): Promise<SpReportScope> {
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${`sp-storage-${++serial}`}, ${owner}, 'owner') as id`;
    const [row] = await database.sql<{ org_id: string; profile_id: string; connection_id: string; marketplace_id: string; selling_partner_id: string }[]>`
      select b.org_id,b.profile_id,b.connection_id,b.marketplace_id,c.selling_partner_id
      from public.spapi_profile_bindings b join public.spapi_connections c on c.id=b.connection_id where b.org_id=${org!.id}`;
    const scope: SpReportScope = { orgId: row!.org_id, profileId: row!.profile_id, connectionId: row!.connection_id,
      marketplaceId: row!.marketplace_id, sellingPartnerId: row!.selling_partner_id, region: 'NA' };
    await storeSpApiRefreshToken(database, { orgId: scope.orgId, connectionId: scope.connectionId, refreshToken: 'fake-refresh-token' });
    await database.sql`update public.spapi_profile_bindings set enabled=true where org_id=${scope.orgId}`;
    await database.sql`insert into public.spapi_report_sources(org_id,profile_id,connection_id,family,enabled)
      values (${scope.orgId},${scope.profileId},${scope.connectionId},'retail',true)
      on conflict (org_id,profile_id,family) do update set enabled=true`;
    return scope;
  }

  it('deduplicates retail totals across two Ads profiles bound to one seller and rejects old restatements', async () => {
    const scope = await seed(), first = retail(scope, 'retail-original');
    expect(await promoteSpReport(database, first)).toMatchObject({ writtenRows: 1, verifiedLoadedRows: 1 });
    const [profile] = await database.sql<{ id: string }[]>`insert into public.ad_profiles
      (org_id,connection_id,amazon_profile_id,region,country_code,currency_code,timezone,sync_enabled)
      select org_id,connection_id,'synthetic-second-profile',region,country_code,currency_code,timezone,true
      from public.ad_profiles where id=${scope.profileId} returning id`;
    const secondScope = { ...scope, profileId: profile!.id };
    await database.sql`insert into public.spapi_profile_bindings(org_id,profile_id,connection_id,marketplace_id,enabled)
      values (${scope.orgId},${profile!.id},${scope.connectionId},${scope.marketplaceId},true)`;
    await database.sql`insert into public.spapi_report_sources(org_id,profile_id,connection_id,family,enabled)
      values (${scope.orgId},${profile!.id},${scope.connectionId},'retail',true)`;
    expect(await resolveSpReportScope(database, { ...secondScope, family: 'retail' })).toEqual(secondScope);
    const revised = retail(secondScope, 'retail-restated', '2026-09-14T01:00:00.000Z', 120);
    await promoteSpReport(database, revised);
    const [count] = await database.sql`select count(*)::int as n,sum((payload->>'sales')::numeric)::text as sales
      from public.fact_retail_sales_traffic_daily where org_id=${scope.orgId} and date=${date}`;
    expect(count).toMatchObject({ n: 1, sales: '120' });
    expect(await verifySpReport(database, revised)).toBe(1);
    await expect(promoteSpReport(database, first)).rejects.toThrow(/superseded/i);
    await expect(promoteSpReport(database, retail(scope, 'retail-stale', '2026-09-13T02:00:00.000Z')))
      .rejects.toThrow('Superseded');
    await expect(database.sql`delete from public.ad_profiles where id=${secondScope.profileId}`)
      .rejects.toMatchObject({ code: '23503' });
    expect(await verifySpReport(database, revised)).toBe(1);
    const evidence = await readSpReportEvidence(database, { ...scope, family: 'retail', start: date, end: date, now: new Date('2026-09-14T02:00:00Z') });
    expect(evidence).toMatchObject({ state: 'measured', report: { rows: [{ sales: 120 }], observedAt: revised.observedAt } });
  });

  it('rolls back scope replacement and earlier writes when a later row lies outside its period', async () => {
    const scope = await seed(), original = retail(scope, 'before-rollback');
    await promoteSpReport(database, original);
    const malformed = retail(scope, 'rollback', '2026-09-14T01:00:00.000Z', 200);
    malformed.rows.push({ ...malformed.rows[0]!, key: 'outside', date: '2026-09-11' });
    malformed.counts = { sourceRows: 2, parsedRows: 2, refusedRows: 0, duplicateRows: 0, addedRows: 0, canonicalRows: 2 };
    await expect(promoteSpReport(database, malformed)).rejects.toThrow('outside period');
    expect(await verifySpReport(database, original)).toBe(1);
    const [receipts] = await database.sql`select count(*)::int as n from public.spapi_report_receipts where org_id=${scope.orgId} and start_date=${date}`;
    expect(receipts!['n']).toBe(1);
  });

  it('publishes valid empty restatements while keeping missing traffic partial', async () => {
    const scope = await seed(), partial = retail(scope, 'partial');
    if (partial.rows[0]?.kind !== 'retail') throw new Error('Expected retail fixture');
    partial.rows[0].sessions = null; partial.complete = false;
    await promoteSpReport(database, partial);
    expect(await readSpReportEvidence(database, { ...scope, family: 'retail', start: date, end: date, now: new Date(partial.observedAt) }))
      .toMatchObject({ state: 'partial', report: { rows: [{ sessions: null }] } });
    const empty = retail(scope, 'empty', '2026-09-14T01:00:00.000Z');
    empty.rows = []; empty.counts = { sourceRows: 0, parsedRows: 0, refusedRows: 0, duplicateRows: 0, addedRows: 0, canonicalRows: 0 };
    expect(await promoteSpReport(database, empty)).toMatchObject({ writtenRows: 0, verifiedLoadedRows: 0 });
    expect(await verifySpReport(database, empty)).toBe(0);
    const [remaining] = await database.sql`select count(*)::int as n from public.fact_retail_sales_traffic_daily where org_id=${scope.orgId} and date=${date}`;
    expect(remaining!['n']).toBe(0);
  });

  it('creates maintained monthly partitions and enforces tenant reads and writes', async () => {
    const scope = await seed(); await promoteSpReport(database, retail(scope, 'tenant-report'));
    const partitions = await database.sql`select p.relname, count(c.oid)::int as children
      from pg_class p join pg_inherits i on i.inhparent=p.oid join pg_class c on c.oid=i.inhrelid
      where p.relname in ('fact_retail_sales_traffic_daily','fact_aba_search_terms_periodic') group by p.relname`;
    expect(partitions).toHaveLength(2);
    expect(partitions.every(p => Number(p['children']) > 0)).toBe(true);
    const maintained = await database.sql`select table_name from app.fact_partitions
      where table_name in ('fact_retail_sales_traffic_daily','fact_aba_search_terms_periodic')`;
    expect(maintained).toHaveLength(2);
    await database.sql`select app.seed_tenant_fixture('sp-storage-outsider',${outsider},'owner')`;
    await asUser(database, outsider, async sql => {
      expect(await sql`select row_key from public.fact_retail_sales_traffic_daily where org_id=${scope.orgId} and date=${date}`).toHaveLength(0);
      expect(await sql`select request_id from public.spapi_report_receipts where org_id=${scope.orgId}`).toHaveLength(0);
      expect(await sql`select family from public.spapi_report_sources where org_id=${scope.orgId}`).toHaveLength(0);
      await expect(sql`insert into public.spapi_report_sources(org_id,profile_id,connection_id,family)
        values (${scope.orgId},${scope.profileId},${scope.connectionId},'aba')`).rejects.toThrow();
    });
    await asUser(database, owner, async sql => {
      expect(await sql`select row_key from public.fact_retail_sales_traffic_daily where org_id=${scope.orgId} and date=${date}`).toHaveLength(1);
    });
  });

  it('refuses extra rows in complete scopes and older empty replay after a newer nonempty restatement', async () => {
    const scope = await seed(), original = retail(scope, 'exact-complete');
    await promoteSpReport(database, original);
    await database.sql`insert into public.fact_retail_sales_traffic_daily
      (org_id,selling_partner_id,marketplace_id,date,row_key,profile_id,connection_id,grain,observed_at,report_request_id,payload)
      select org_id,selling_partner_id,marketplace_id,date,'extra-row',profile_id,connection_id,grain,observed_at,report_request_id,
        jsonb_set(payload,'{key}','"extra-row"'::jsonb)
      from public.fact_retail_sales_traffic_daily where org_id=${scope.orgId} and date=${date}`;
    await expect(verifySpReport(database, original)).rejects.toThrow('readback mismatch');
    const empty = retail(scope, 'empty-before-newer', '2026-09-14T01:00:00.000Z');
    empty.rows = []; empty.counts = { sourceRows: 0, parsedRows: 0, refusedRows: 0, duplicateRows: 0, addedRows: 0, canonicalRows: 0 };
    await promoteSpReport(database, empty);
    const newer = retail(scope, 'newer-nonempty', '2026-09-15T01:00:00.000Z');
    await promoteSpReport(database, newer);
    await expect(verifySpReport(database, empty)).rejects.toThrow(/superseded/i);
    await expect(promoteSpReport(database, empty)).rejects.toThrow(/superseded/i);
    expect(await verifySpReport(database, newer)).toBe(1);
  });

  it('refuses equal-time conflicting document fingerprints before replacing canonical data', async () => {
    const scope = await seed(), original = retail(scope, 'equal-time-first');
    await promoteSpReport(database, original);
    const conflict = retail(scope, 'equal-time-second', original.observedAt, 999);
    conflict.payloadFingerprint = 'b'.repeat(64);
    await expect(promoteSpReport(database, conflict)).rejects.toThrow('Conflicting equal-time');
    expect(await verifySpReport(database, original)).toBe(1);
  });

  it('counts seller-wide spend across bound profiles and all ad products, refusing incomplete evidence', async () => {
    const scope = await seed();
    const [second] = await database.sql<{ id: string }[]>`insert into public.ad_profiles
      (org_id,connection_id,amazon_profile_id,region,country_code,currency_code,timezone,sync_enabled)
      select org_id,connection_id,'synthetic-spend-second',region,country_code,currency_code,timezone,true
      from public.ad_profiles where id=${scope.profileId} returning id`;
    await database.sql`insert into public.spapi_profile_bindings(org_id,profile_id,connection_id,marketplace_id,enabled)
      values (${scope.orgId},${second!.id},${scope.connectionId},${scope.marketplaceId},true)`;
    const input = { ...scope, start: date, end: date };
    expect(await readSpRetailSpendEvidence(database, input)).toBeNull();
    let lastRequest = '';
    for (const profileId of [scope.profileId, second!.id]) {
      for (const [reportType, table, cost] of [['spCampaigns', 'fact_profile_daily', 10], ['sbCampaigns', 'fact_sb_daily', 20], ['sdCampaigns', 'fact_sd_daily', 30]] as const) {
        const [report] = await database.sql<{ id: string }[]>`insert into public.report_requests
          (org_id,profile_id,report_type,start_date,end_date,status,completed_at,rows_parsed,rows_loaded,source_rows,refused_rows)
          values (${scope.orgId},${profileId},${reportType}::public.report_type,${date},${date},'completed',now(),1,1,1,0) returning id`;
        lastRequest = report!.id;
        if (reportType === 'spCampaigns') await database.sql`insert into public.fact_profile_daily
          (org_id,profile_id,date,currency_code,cost,report_request_id) values (${scope.orgId},${profileId},${date},'USD',${cost},${lastRequest})`;
        else await database.sql.unsafe(`insert into public.${table} (org_id,profile_id,date,campaign_id,cost,report_request_id) values ($1,$2,$3,$4,$5,$6)`,
          [scope.orgId,profileId,date,'synthetic-spend',cost,lastRequest]);
      }
    }
    expect(await readSpRetailSpendEvidence(database, input)).toMatchObject({ complete: true, scope: 'seller', currency: 'USD', rows: [{ date, spend: 120 }] });
    await expect(database.sql`update public.ad_profiles set region='EU' where id=${second!.id}`)
      .rejects.toMatchObject({ code: '23514' });
    expect(await resolveSpReportScope(database, { ...scope, family: 'retail' })).toEqual(scope);
    expect(await readSpRetailSpendEvidence(database, input)).toMatchObject({ currency: 'USD', rows: [{ date, spend: 120 }] });
    await database.sql`update public.ad_profiles set currency_code='EUR' where id=${second!.id}`;
    expect(await readSpRetailSpendEvidence(database, input)).toBeNull();
    await database.sql`update public.ad_profiles set currency_code='USD' where id=${second!.id}`;
    await database.sql`update public.report_requests set refused_rows=1 where id=${lastRequest}`;
    expect(await readSpRetailSpendEvidence(database, input)).toBeNull();
    await database.sql`update public.report_requests set refused_rows=0 where id=${lastRequest}`;
    await database.sql`delete from public.fact_sd_daily where report_request_id=${lastRequest}`;
    expect(await readSpRetailSpendEvidence(database, input)).toBeNull();
    // An explicitly verified empty product report contributes zero, rather than an unmeasured gap.
    await database.sql`update public.report_requests set rows_loaded=0,rows_parsed=0,source_rows=0 where id=${lastRequest}`;
    expect(await readSpRetailSpendEvidence(database, input)).toMatchObject({ rows: [{ date, spend: 90 }] });
    await database.sql`delete from public.report_requests where id=${lastRequest}`;
    expect(await readSpRetailSpendEvidence(database, input)).toBeNull();
  });

  it('keeps checkpoint compare-and-swap and report receipts immutable', async () => {
    const scope = await seed(), report = retail(scope, 'checkpoint');
    const initial = { plan: report.plan, revision: 0, state: 'creating' as const, reportId: null, documentId: null, observedAt: null, receipt: null };
    expect(await saveSpReportCheckpoint(database, initial, null)).toEqual(initial);
    await expect(saveSpReportCheckpoint(database, initial, null)).rejects.toThrow('compare-and-swap');
    expect(await loadSpReportCheckpoint(database, report.plan)).toEqual(initial);
    await promoteSpReport(database, report);
    await expect(database.sql`update public.spapi_report_receipts set observed_at=now() where org_id=${scope.orgId}`)
      .rejects.toThrow('immutable');
    await database.sql`delete from public.orgs where id=${scope.orgId}`;
    expect(await database.sql`select request_id from public.spapi_report_receipts where org_id=${scope.orgId}`).toHaveLength(0);
    expect(await database.sql`select row_key from public.fact_retail_sales_traffic_daily where org_id=${scope.orgId}`).toHaveLength(0);

  });
});
