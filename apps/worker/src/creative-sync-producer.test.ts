import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueDailyCreativeSyncJobs, enqueueDueSchedules, ensureCreativeSyncSchedules } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { JobPayload } from '@wizard-ads/shared';
import { createCreativeSyncProducer } from './creative-sync-producer.js';
import { PostgresWorkerStore } from './store.js';
import { defaultSchedules } from './schedules.js';

const available = await databaseAvailable();

describe.skipIf(!available)('default Creative schedules and report-lane production', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  beforeAll(async () => {
    database = await createTestDatabase('creative_default');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('creative-default', '11111111-2222-4333-8444-555555555555', 'owner') as id`;
    orgId = org!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
    profileId = profile!.id;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });
  beforeEach(async () => {
    await database.sql`delete from public.sync_jobs where org_id=${orgId} and job_type='creative.sync'`;
    await database.sql`delete from public.sync_schedules where org_id=${orgId}`;
    await database.sql`delete from public.ad_profiles where org_id=${orgId} and id <> ${profileId}`;
    await database.sql`update public.ad_profiles set sync_enabled=true where id=${profileId}`;
    // Only this disposable test database is reset between independent lane cases.
    await database.sql`update app.report_worker_claim_authority set protocol='legacy', epoch=0`;
  });

  it('provisions a fresh profile without env and backfills existing profiles exactly once', async () => {
    const store = new PostgresWorkerStore(database);
    expect(await store.provisionSchedules(orgId, profileId)).toBe(defaultSchedules().length);
    expect(await store.provisionSchedules(orgId, profileId)).toBe(0);
    const [fresh] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      values (${orgId}, 'synthetic-later-profile', 'NA', 'US', 'USD', 'UTC', true) returning id
    `;
    expect(await store.ensureIntegrationSchedules()).toBe(1);
    expect(await store.ensureIntegrationSchedules()).toBe(0);
    // Evo can backfill Creative before the normal provisioner sees a new profile.
    expect(await store.unscheduledProfiles()).toContainEqual({ orgId, profileId: fresh!.id });
    expect(await store.provisionSchedules(orgId, fresh!.id)).toBe(defaultSchedules().length - 1);
    expect(await store.unscheduledProfiles()).not.toContainEqual({ orgId, profileId: fresh!.id });
    const rows = await database.sql<{ profile_id: string; enabled: boolean }[]>`
      select profile_id, enabled from public.sync_schedules where org_id=${orgId} and job_type='creative.sync' order by profile_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.profile_id).sort()).toEqual([profileId, fresh!.id].sort());
    expect(rows.every((row) => row.enabled)).toBe(true);
    const produced = await enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'legacy');
    expect(produced).toMatchObject({ requestedProfiles: 2, enqueuedJobs: 2 });
    expect(produced.observations).toHaveLength(2);
    expect((await enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'legacy')).enqueuedJobs).toBe(0);
    expect(await database.sql`select id from public.sync_jobs where org_id=${orgId} and job_type='creative.sync'`).toHaveLength(2);
  });

  it('never provisions or produces Creative work for disabled profile sync', async () => {
    await database.sql`update public.ad_profiles set sync_enabled=false where id=${profileId}`;
    const store = new PostgresWorkerStore(database);
    expect(await store.provisionSchedules(orgId, profileId)).toBe(defaultSchedules().length - 1);
    expect(await ensureCreativeSyncSchedules(database)).toBe(0);
    expect(await database.sql`select id from public.sync_schedules where org_id=${orgId} and job_type='creative.sync'`).toHaveLength(0);
    expect((await enqueueDailyCreativeSyncJobs(database)).enqueuedJobs).toBe(0);
  });

  it('excludes Creative work from the generic scheduler and stops Evo production under the kill switch', async () => {
    expect(await ensureCreativeSyncSchedules(database)).toBe(1);
    expect(await enqueueDueSchedules(database)).toEqual([]);
    expect(createCreativeSyncProducer(database, 'general', () => ({}))).toBeUndefined();
    await database.sql`select * from public.activate_report_worker_fenced_claims()`;
    const loop = createCreativeSyncProducer(database, 'evo-report-lane', () => ({ OPENSPELL_CREATIVE_SYNC_DISABLED: '1' }))!;
    loop.start();
    try {
      await vi.waitFor(() => expect(loop.status().lastSuccessAt).not.toBeNull());
      expect(await database.sql`select id from public.sync_jobs where org_id=${orgId} and job_type='creative.sync'`).toHaveLength(0);
    } finally { await loop.stop(); }
  });

  it('rolls schedule advancement back when a deduplicated job fails payload reconciliation', async () => {
    expect(await ensureCreativeSyncSchedules(database)).toBe(1);
    const [clock] = await database.sql<{ date: string }[]>`
      select (now() at time zone timezone)::date::text as date from public.ad_profiles where id=${profileId}
    `;
    const key = ['creative.sync', 'SB', profileId, clock!.date].join(':');
    const payload = { type: 'creative.sync', orgId, profileId, adProduct: 'SB',
      startDate: '2000-01-01', endDate: '2000-01-01', allowObservedAttributionFacts: true };
    await database.sql`insert into public.sync_jobs (org_id, profile_id, job_type, payload, dedupe_key)
      values (${orgId}, ${profileId}, 'creative.sync', ${JSON.stringify(payload)}::jsonb, ${key})`;
    await expect(enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'legacy')).rejects.toThrow(/did not reconcile/);
    expect(await database.sql`select id from public.sync_schedules where org_id=${orgId}
      and job_type='creative.sync' and next_run_at <= now() and last_enqueued_at is null`).toHaveLength(1);
    expect(await database.sql`select id from public.sync_jobs where org_id=${orgId} and job_type='creative.sync'`).toHaveLength(1);
  });

  it('uses only the owning producer and lets Evo produce with no report-lane environment flag', async () => {
    expect(await ensureCreativeSyncSchedules(database)).toBe(1);
    expect((await enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'fenced')).enqueuedJobs).toBe(0);
    const first = await enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'legacy');
    expect(first.enqueuedJobs).toBe(1);
    const jobs = await database.sql<{ payload: unknown }[]>`select payload from public.sync_jobs where org_id=${orgId} and job_type='creative.sync'`;
    expect(jobs).toHaveLength(1);
    expect(JobPayload.parse(jobs[0]!.payload)).toMatchObject({ type: 'creative.sync', profileId, allowObservedAttributionFacts: true });
    expect(await database.sql`select id from public.sync_schedules where org_id=${orgId} and next_run_at > now() and last_enqueued_at is not null`).toHaveLength(1);
    const [activation] = await database.sql<{ decision: string }[]>`select * from public.activate_report_worker_fenced_claims()`;
    expect(activation!.decision).toBe('activated');
    const [fresh] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles (org_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      values (${orgId}, 'synthetic-after-handoff', 'NA', 'US', 'USD', 'UTC', true) returning id
    `;
    expect(await ensureCreativeSyncSchedules(database)).toBe(1);
    expect((await enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'legacy')).enqueuedJobs).toBe(0);
    const loop = createCreativeSyncProducer(database, 'evo-report-lane', () => ({}))!;
    loop.start();
    try {
      await vi.waitFor(async () => {
        expect(await database.sql`select id from public.sync_jobs where profile_id=${fresh!.id}`).toHaveLength(1);
      }, { timeout: 5_000 });
    } finally { await loop.stop(); }
    expect(await database.sql`select id from public.sync_jobs where org_id=${orgId} and job_type='creative.sync'`).toHaveLength(2);
    expect((await enqueueDailyCreativeSyncJobs(database, undefined, new Date(), 'fenced')).enqueuedJobs).toBe(0);
  });
});
