import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetUsageConfig } from '@wizard-ads/shared';
import { ensureBudgetUsageSchedules } from './schedules.js';
import { PostgresWorkerStore } from '../store.js';

describe('budget usage schedule activation on a local test database', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  beforeAll(async () => {
    database = await createTestDatabase('budget_usage_schedule');
    const [fixture] = await database.sql<{ org_id: string }[]>`select app.seed_tenant_fixture('budget-usage-schedules', '40404040-4040-4040-8040-404040404040', 'owner') as org_id`;
    orgId = fixture!.org_id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} order by id limit 1`;
    profileId = profile!.id;
  }, 120000);
  beforeEach(async () => {
    await database.sql`delete from public.budget_usage_settings where org_id=${orgId} and profile_id=${profileId}`;
    await database.sql`delete from public.sync_schedules where org_id=${orgId} and profile_id=${profileId}`;
  });
  afterAll(async () => { await database?.drop(); });
  it('requires separate deployment and profile enablement, and never schedules Stream or reporting', async () => {
    expect(await ensureBudgetUsageSchedules(database, true)).toBe(0);
    const config = BudgetUsageConfig.parse({ apiEnabled: true, streamEnabled: true, cadenceMinutes: 23 });
    await database.sql`insert into public.budget_usage_settings(org_id,profile_id,config) values (${orgId},${profileId},${JSON.stringify(config)}::jsonb)`;
    expect(await ensureBudgetUsageSchedules(database, false)).toBe(0);
    expect(await ensureBudgetUsageSchedules(database, true)).toBe(1);
    expect(await ensureBudgetUsageSchedules(database, true)).toBe(0);
    await new PostgresWorkerStore(database).ensureIntegrationSchedules();
    const rows = await database.sql<{ job_type: string; enabled: boolean; cadence: string }[]>`select job_type::text,enabled,cadence::text from public.sync_schedules where profile_id=${profileId} order by job_type::text`;
    // Integration reconciliation also provisions the default daily Creative schedule; nothing for Stream or reporting.
    expect(rows).toEqual([
      { job_type: 'budget_usage.collect', enabled: true, cadence: '00:23:00' },
      { job_type: 'creative.sync', enabled: true, cadence: '1 day' },
    ]);
    expect(await ensureBudgetUsageSchedules(database, false)).toBe(1);
    expect(await ensureBudgetUsageSchedules(database, false)).toBe(0);
    const [disabled] = await database.sql<{ enabled: boolean }[]>`select enabled from public.sync_schedules where profile_id=${profileId} and job_type='budget_usage.collect'`;
    expect(disabled!.enabled).toBe(false);
  });
  it('disables prior schedules when profile configuration is revoked', async () => {
    await database.sql`insert into public.budget_usage_settings(org_id,profile_id,config) values (${orgId},${profileId},'{"apiEnabled":true}'::jsonb)`;
    expect(await ensureBudgetUsageSchedules(database, true)).toBe(1);
    await database.sql`update public.budget_usage_settings set config=jsonb_set(config,'{apiEnabled}','false') where profile_id=${profileId}`;
    expect(await ensureBudgetUsageSchedules(database, true)).toBe(1);
    const [row] = await database.sql<{ enabled: boolean }[]>`select enabled from public.sync_schedules where profile_id=${profileId}`;
    expect(row!.enabled).toBe(false);
  });
});
