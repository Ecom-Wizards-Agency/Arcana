import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { readWorkbook } from '@wizard-ads/campaigns';
import { listRecommendations } from '@wizard-ads/db';
import { GET } from '../app/api/recommendations/export/[batchId]/route';

const available = await databaseAvailable();
describe.skipIf(!available)('complete saved recommendation downloads', () => {
  let database: TestDatabase;
  let orgId: string;
  let batchId: string;
  const userId = randomUUID();
  const count = 20_001;
  const bridge = 'synthetic-large-download-bridge';
  const envNames = ['DATABASE_URL', 'WIZARD_ADS_E2E_AUTH_BRIDGE', 'WIZARD_ADS_AUTH_BRIDGE_SECRET'] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  beforeAll(async () => {
    database = await createTestDatabase('large_recommendation_download');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('large-download',${userId},'owner') as id`;
    orgId = org!.id;
    const [run] = await database.sql<{ id: string; profile_id: string }[]>`select id,profile_id from public.recommendation_runs where org_id=${orgId}`;
    const [batch] = await database.sql<{ id: string }[]>`insert into public.apply_batches
      (org_id,profile_id,tag,opt_group,lever,note,status,exported_proposals,reversible_rows,unsupported_rows)
      values(${orgId},${run!.profile_id},'synthetic-large-batch','rank','bid-down','Synthetic count proof','staged',${count},${count},0) returning id`;
    batchId = batch!.id;
    const rows = await database.sql<{ inserted: number }[]>`with proposals as (
      insert into public.recommendations
        (org_id,profile_id,run_id,reason,entity_type,entity_id,entity_name,ad_product,campaign_id,ad_group_id,field,current_value,proposed_value,inputs,status,export_batch_id)
      select ${orgId},${run!.profile_id},${run!.id},'high_acos','keyword',n::text,'Synthetic keyword '||n,'SP','1001','2001','bid','0.9'::jsonb,'0.7'::jsonb,'{}'::jsonb,'exported',${batchId}
        from generate_series(1,${count}) n returning id,org_id,profile_id,entity_id,entity_name
    ), ledger as (
      insert into public.apply_rows(batch_id,org_id,profile_id,recommendation_id,entity_type,entity_id,entity_name,field,old_value,new_value,lever)
      select ${batchId},org_id,profile_id,id,'keyword',entity_id,entity_name,'bid','0.9'::jsonb,'0.7'::jsonb,'bid-down' from proposals returning id
    ) select count(*)::int as inserted from ledger`;
    expect(rows).toEqual([{ inserted: count }]);
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = bridge;
  }, 60_000);
  afterAll(async () => {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await database?.drop();
  });

  it('returns all 20,001 persisted rows in JSON and XLSX while preserving the ordinary list bound', async () => {
    expect(await listRecommendations(database, { orgId, exportBatchId: batchId })).toHaveLength(20_000);
    const headers = { 'x-wizard-ads-auth-bridge': bridge, 'x-wizard-ads-user-id': userId, 'x-wizard-ads-org-id': orgId };
    const request = (format: string) => GET(new Request(`http://localhost/api/recommendations/export/${batchId}?format=${format}`, { headers }), { params: Promise.resolve({ batchId }) });
    const json = await request('rows');
    expect(json.status).toBe(200);
    const rows = await json.json() as { entity_id: string }[];
    expect(rows).toHaveLength(count);
    expect(new Set(rows.map((row) => row.entity_id)).size).toBe(count);
    const xlsx = await request('xlsx');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get('x-wizard-ads-skipped-rows')).toBe('0');
    expect(xlsx.headers.get('x-wizard-ads-exported-rows')).toBe(String(count));
    const sheet = readWorkbook(new Uint8Array(await xlsx.arrayBuffer()));
    expect(sheet.rows).toHaveLength(count);
    const idColumn = sheet.header.indexOf('Keyword ID');
    expect(idColumn).toBeGreaterThan(-1);
    expect(new Set(sheet.rows.map((row) => String(row[idColumn])))).toEqual(new Set(rows.map((row) => row.entity_id)));
  }, 30_000);
});
