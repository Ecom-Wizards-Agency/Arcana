import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgencyAccessDenied, readCreativePerformance, readLatestCreativeSyncJobState, readLatestCreativeSyncSnapshot } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { listCrosscheckedProfiles, loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { withExistingDatabase } from '../app/_lib/db';
import { listProfiles } from '../app/_lib/profiles';
import { loadProfileDailyRows, loadProvisionalDates, loadReportLedger } from '../app/_lib/dashboard-data';
import { loadSyncStatus } from './data/sync-status';
import { readDashboardOperatingStatus } from './dashboard/operating-status';

const available = await databaseAvailable();
const date = '2026-08-29';
const period = { start: date, end: date };
interface Agency { orgId: string; userId: string; profileId: string; marker: string; cost: number }

describe.skipIf(!available)('page data under current-user database authority', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('agency_page_loaders');
    for (const [index, marker] of ['Synthetic agency A', 'Synthetic agency B', 'Synthetic staff workspace'].entries()) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`
        select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner', ${date}) as id
      `;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} order by id limit 1`;
      const profileId = profile!.id;
      const cost = 12.34 + index * 10;
      agencies.push({ orgId, userId, profileId, marker, cost });
      await database.sql`update public.ad_profiles set account_name=${marker} where id=${profileId}`;
      await database.sql`insert into public.fact_profile_daily(org_id,profile_id,date,currency_code,impressions,clicks,cost,sales_7d,purchases_7d,provisional)
        values (${orgId},${profileId},${date},'USD',100,5,${cost},44.56,2,true)
        on conflict(profile_id,date) do update set cost=excluded.cost,impressions=excluded.impressions,
          clicks=excluded.clicks,sales_7d=excluded.sales_7d,purchases_7d=excluded.purchases_7d,provisional=true`;
      await database.sql`insert into public.report_requests(org_id,profile_id,report_type,start_date,end_date,status,error)
        values (${orgId},${profileId},'spCampaigns',${date},${date},'failed',${'LWA invalid_client: ' + marker})`;
      await database.sql`insert into public.sync_jobs(org_id,profile_id,job_type,payload,status)
        values (${orgId},${profileId},'creative.sync','{}','queued')`;
      await database.sql`insert into public.fact_creative_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,ad_id,attribution_state,cost)
        values (${orgId},${profileId},${date},'SB','shared-campaign','shared-ad-group','shared-ad','unmapped',${cost})`;
      await database.sql`insert into public.crosscheck_results(org_id,profile_id,date,grain,metric,ours,theirs,delta_pct,tolerance,verdict,source)
        values (${orgId},${profileId},${date},'profile','ad_spend',${cost},${cost},0,0,'verified',${marker})`;
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function read(actor: Agency, scope: Agency = actor) {
    return withExistingDatabase(database, { orgId: actor.orgId, userId: actor.userId }, async (handle) => {
      const [identity] = await handle.sql<{ role: string; subject: string }[]>`select current_user as role,auth.uid()::text as subject`;
      const [profiles, days, provisional, ledger, sync, creative, latestJob, snapshot, crosschecked, crosscheck, operating] = await Promise.all([
        listProfiles(handle, scope.orgId),
        loadProfileDailyRows(handle, scope.orgId, scope.profileId, 'Synthetic account', period),
        loadProvisionalDates(handle, scope.orgId, scope.profileId, period),
        loadReportLedger(handle, scope.orgId, scope.profileId),
        loadSyncStatus(handle, scope.orgId, scope.profileId),
        readCreativePerformance(handle, { orgId: scope.orgId, profileId: scope.profileId, from: date, to: date }),
        readLatestCreativeSyncJobState(handle, scope),
        readLatestCreativeSyncSnapshot(handle, scope),
        listCrosscheckedProfiles(handle, scope.orgId),
        loadCrosscheckPanel(handle, { orgId: scope.orgId, profileId: scope.profileId, startDate: date, endDate: date }),
        readDashboardOperatingStatus(handle, scope),
      ]);
      return { identity, profiles, days, provisional, ledger, sync, creative, latestJob, snapshot, crosschecked, crosscheck, operating };
    });
  }

  it('preserves counted results for two unrelated agencies and a separate staff workspace', async () => {
    for (const actor of agencies) {
      const result = (await read(actor))!;
      expect(result.identity).toEqual({ role: 'authenticated', subject: actor.userId });
      const [expected] = await database.sql<{ n: number }[]>`select count(*)::int as n from public.ad_profiles where org_id=${actor.orgId}`;
      expect(result.profiles).toHaveLength(expected!.n);
      expect(result.profiles.find((profile) => profile.id === actor.profileId)?.label).toBe(actor.marker);
      expect(result.days).toHaveLength(1);
      expect(result.days[0]).toMatchObject({ date, spend: actor.cost, sales: 44.56, orders: 2, impressions: 100, clicks: 5 });
      expect(result.provisional).toEqual([date]);
      const [expectedReports] = await database.sql<{ n: number }[]>`select count(*)::int as n from public.report_requests where org_id=${actor.orgId} and profile_id=${actor.profileId}`;
      expect(result.ledger).toHaveLength(expectedReports!.n);
      expect(result.ledger.find((report) => report.status === 'failed')?.error).toBe('Amazon application authentication failed. Ask your installation operator to check the Amazon application settings.');
      expect(result.sync.freshness).toHaveLength(1);
      const [expectedJobs] = await database.sql<{ n: number }[]>`select count(*)::int as n from public.sync_jobs where org_id=${actor.orgId} and profile_id=${actor.profileId}`;
      expect(result.sync.jobs).toHaveLength(expectedJobs!.n);
      expect(result.sync.reports).toHaveLength(expectedReports!.n);
      const [expectedCreative] = await database.sql<{ n: number; cost: number }[]>`select
        count(distinct (attribution_state,amazon_asset_id))::int as n,sum(cost)::float8 as cost
        from public.fact_creative_daily where org_id=${actor.orgId} and profile_id=${actor.profileId} and date=${date}`;
      expect(result.creative).toHaveLength(expectedCreative!.n);
      expect(result.creative.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(expectedCreative!.cost, 8);
      expect(result.creative.find((row) => row.attributionState === 'unmapped')?.cost).toBe(actor.cost);
      expect(result.latestJob?.status).toBe('queued');
      expect(result.snapshot?.profileId).toBe(actor.profileId);
      expect(result.crosschecked.map((profile) => profile.profileId)).toEqual([actor.profileId]);
      expect(result.crosscheck.days).toHaveLength(1);
      expect(result.crosscheck.sources).toEqual([actor.marker]);
      for (const foreign of agencies.filter((value) => value !== actor)) {
        expect(JSON.stringify(result)).not.toContain(foreign.marker);
      }
    }
  });

  it('denies guessed organization and profile identifiers even when a loader receives them', async () => {
    for (const actor of agencies) {
      const foreign = agencies.find((value) => value !== actor)!;
      const result = (await read(actor, foreign))!;
      expect(result.profiles).toEqual([]);
      expect(result.days).toEqual([]);
      expect(result.provisional).toEqual([]);
      expect(result.ledger).toEqual([]);
      expect(result.sync).toEqual({ freshness: [], jobs: [], reports: [] });
      expect(result.creative).toEqual([]);
      expect(result.latestJob).toBeNull();
      expect(result.snapshot).toBeNull();
      expect(result.crosschecked).toEqual([]);
      expect(result.crosscheck.days).toEqual([]);
      expect(result.crosscheck.sources).toEqual([]);
      expect(result.operating.campaigns.total).toBe(0);
    }
  });

  it('keeps multi-agency reads explicitly scoped and refuses a removed membership', async () => {
    const a = agencies[0]!; const b = agencies[1]!;
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${b.orgId},${a.userId},'viewer')`;
    try {
      const result = (await read(a))!;
      expect(result.creative.find((row) => row.attributionState === 'unmapped')?.cost).toBe(a.cost);
      expect(result.crosschecked.map((profile) => profile.profileId)).toEqual([a.profileId]);
      expect(JSON.stringify(result)).not.toContain(b.marker);
      await database.sql`delete from public.org_members where org_id=${b.orgId} and user_id=${a.userId}`;
      await expect(read({ ...b, userId: a.userId })).rejects.toBeInstanceOf(AgencyAccessDenied);
    } finally {
      await database.sql`delete from public.org_members where org_id=${b.orgId} and user_id=${a.userId}`;
    }
    const [outside] = await database.sql<{ actor: string | null }[]>`select auth.uid()::text as actor`;
    expect(outside?.actor).toBeNull();
  });
});
