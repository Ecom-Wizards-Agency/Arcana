import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgencyAccessDenied, readCreativePerformance, readLatestCreativeSyncJobState, readLatestCreativeSyncSnapshot, withAuthenticatedActor, withAuthenticatedIdentity } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { listCrosscheckedProfiles, loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { withExistingDatabase } from '../app/_lib/db';
import { listProfiles } from '../app/_lib/profiles';
import { loadProfileDailyRows, loadProvisionalDates, loadReportLedger } from '../app/_lib/dashboard-data';
import { loadSyncStatus } from './data/sync-status';
import { readDashboardOperatingStatus } from './dashboard/operating-status';
import { listCompetitorLinks, listIntegrationConnections, listRecommendationRuns, listRecommendations, readOptimizationWorkspace } from '@wizard-ads/db';
import { readDaypartingWorkspace } from './dayparting/data';
import { issueMcpKey, listMcpKeys, revokeMcpKey } from './data/mcp-keys';
import { loadOptimizerPageData } from '../app/_lib/optimizer-page-data';

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
      await issueMcpKey(database, { orgId, label: marker, profileIds: [profileId], createdBy: userId });
      const revoked = await issueMcpKey(database, { orgId, label: marker + ' revoked', profileIds: [profileId], createdBy: userId });
      expect(await revokeMcpKey(database, { orgId, userId }, revoked.record.id)).toBe(true);
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

  async function settled<T>(read: Promise<T>): Promise<PromiseSettledResult<T>> {
    return (await Promise.allSettled([read]))[0]!;
  }
  function value<T>(result: PromiseSettledResult<T>): T {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  }
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
      const [runs, recommendations, groups, dayparting, integrations, competitors, keys, optimizer] = await Promise.all([
        listRecommendationRuns(handle, scope),
        listRecommendations(handle, scope),
        settled(readOptimizationWorkspace(handle, scope)),
        readDaypartingWorkspace(handle, scope),
        listIntegrationConnections(handle, scope.orgId),
        listCompetitorLinks(handle, scope.orgId, scope.profileId),
        listMcpKeys(handle, scope.orgId),
        settled(loadOptimizerPageData({ handle, orgId: scope.orgId, profile: { id: scope.profileId, label: scope.marker }, period, settledComparison: null })),
      ]);
      return { identity, profiles, days, provisional, ledger, sync, creative, latestJob, snapshot, crosschecked, crosscheck, operating,
        runs, recommendations, groups, dayparting, integrations, competitors, keys, optimizer };
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
      expect(result.runs.length).toBeGreaterThan(0);
      expect(result.runs.every((run) => run.orgId === actor.orgId && run.profileId === actor.profileId)).toBe(true);
      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations.every((row) => row.orgId === actor.orgId && row.profileId === actor.profileId)).toBe(true);
      expect(value(result.groups).groups.length).toBeGreaterThan(0);
      expect(value(result.optimizer).optimizationWorkspace).toEqual(value(result.groups));
      expect(result.dayparting.facts.length).toBeGreaterThan(0);
      expect(result.dayparting.proposals.length).toBeGreaterThan(0);
      expect(result.integrations.every((row) => row.orgId === actor.orgId)).toBe(true);
      expect(result.competitors.every((row) => row.orgId === actor.orgId)).toBe(true);
      const [expectedKeys] = await database.sql<{ n: number }[]>`select count(*)::int as n from mcp.api_keys where org_id=${actor.orgId}`;
      expect(expectedKeys!.n).toBeGreaterThan(0);
      expect(result.keys).toHaveLength(expectedKeys!.n);
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
      expect(result.runs).toEqual([]);
      expect(result.recommendations).toEqual([]);
      expect(result.groups).toMatchObject({ status: 'rejected', reason: { message: 'profile not found in organisation' } });
      expect(result.dayparting.facts).toEqual([]);
      expect(result.dayparting.proposals).toEqual([]);
      expect(result.dayparting.coverage.ledgerMessages).toBe(0);
      expect(result.integrations).toEqual([]);
      expect(result.competitors).toEqual([]);
      expect(result.keys).toEqual([]);
      expect(result.optimizer).toMatchObject({ status: 'rejected', reason: { message: 'profile not found in organisation' } });
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

  it('reads only safe MCP metadata and rechecks membership without exposing the credential schema', async () => {
    const actor = agencies[0]!; const other = agencies[1]!;
    const metadata = await withAuthenticatedActor(database, { orgId: actor.orgId, userId: actor.userId }, (sql) => listMcpKeys({ sql }, actor.orgId));
    expect(metadata.length).toBeGreaterThan(0);
    for (const row of metadata) expect(Object.keys(row).sort()).toEqual([
      'createdAt', 'expiresAt', 'id', 'keyPrefix', 'label', 'lastUsedAt', 'profileIds', 'revokedAt', 'scope',
    ]);
    await expect(withAuthenticatedActor(database, { orgId: actor.orgId, userId: actor.userId }, (sql) => sql`select token_hash from mcp.api_keys`))
      .rejects.toMatchObject({ code: '42501' });
    await expect(database.sql.begin(async (sql) => {
      await sql`set local role anon`;
      return sql`select * from public.list_mcp_key_metadata(${actor.orgId}::uuid)`;
    })).rejects.toMatchObject({ code: '42501' });
    expect(await withAuthenticatedIdentity(database, { userId: randomUUID() }, (sql) => listMcpKeys({ sql }, actor.orgId))).toEqual([]);

    await database.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${other.userId},'viewer')`;
    try {
      const rows = await withAuthenticatedActor(database, { orgId: actor.orgId, userId: other.userId }, async (sql) => {
        expect(await listMcpKeys({ sql }, actor.orgId)).toHaveLength(metadata.length);
        await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${other.userId}`;
        return listMcpKeys({ sql }, actor.orgId);
      });
      expect(rows).toEqual([]);
    } finally {
      await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${other.userId}`;
    }
  });
});
