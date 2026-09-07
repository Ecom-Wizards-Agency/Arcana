import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { decideContextualNegativeProposals, exportAcceptedContextualNegatives, loadContextualNegativeReview } from '@wizard-ads/db';

const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => request.headers, cookies: async () => ({ get: () => undefined }) }));
import QueryIntelligencePage from '../../app/query-intelligence/page';
import * as requestContext from '../server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-query-page-bridge';
const application = 'synthetic-query-page-' + randomUUID();
const date = '2026-08-29';
interface Agency { userId: string; orgId: string; profileId: string; marketplace: string; marker: string }

describe.skipIf(!available)('actual Query Intelligence agency page', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('query_agency_page');
    for (const marker of ['Synthetic query alpha', 'Synthetic query bravo', 'Synthetic query staff']) {
      const userId = randomUUID();
      const slug = randomUUID();
      const marketplace = slug + '-market';
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${slug},${userId},'owner',${date}) as id`;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`update public.ad_profiles set account_name=${marker} where org_id=${orgId} returning id`;
      const profileId = profile!.id;
      await database.sql`update public.fact_sqp_weekly set marketplace_id=${marketplace},normalized_query=${marker},search_query=${marker},
        total_impressions=10,asin_impressions=1,impression_share=0.1,total_clicks=10,asin_clicks=1,click_share=0.1,
        total_cart_adds=10,asin_cart_adds=1,asin_cart_add_share=0.1,total_purchases=10,asin_purchases=1,purchase_share=0.1
        where org_id=${orgId}`;
      await database.sql`update public.contextual_negative_proposals set search_term=${marker},reason=${marker} where org_id=${orgId}`;
      const scope = { orgId, profileId, marketplaceId: marketplace };
      const review = await loadContextualNegativeReview(database, scope);
      if (review.status !== 'ready') throw new Error('Synthetic review must be complete');
      const expectation = review.proposals.map((row) => ({ id: row.id, expectedFingerprint: row.reviewFingerprint }));
      expect(expectation).toHaveLength(1);
      await decideContextualNegativeProposals(database, { ...scope, proposals: expectation, actorId: userId, decision: 'accepted', note: marker });
      const accepted = await loadContextualNegativeReview(database, scope);
      if (accepted.status !== 'ready') throw new Error('Synthetic accepted review must be complete');
      await exportAcceptedContextualNegatives(database, { ...scope, actorId: userId, note: marker,
        proposals: accepted.proposals.map((row) => ({ id: row.id, expectedFingerprint: row.reviewFingerprint })) });
      agencies.push({ userId, orgId, profileId, marketplace, marker });
    }
    const url = new URL(database.connectionString);
    url.searchParams.set('application_name', application);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database?.drop(); });

  async function read(actor: Agency, target = actor, orgId = actor.orgId): Promise<string> {
    request.headers = new Headers({ 'x-wizard-ads-auth-bridge': bridge, 'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': orgId });
    const page = await QueryIntelligencePage({ searchParams: Promise.resolve({ profile: target.profileId, scope: target.marketplace + '|2026-08-23' }) });
    expect(await database.sql`select pid from pg_stat_activity where datname=current_database() and application_name=${application}`).toEqual([]);
    return JSON.stringify(page);
  }

  it('keeps all source, review and export props within the selected agency', async () => {
    let reads = 0;
    for (const actor of agencies) {
      for (const target of agencies) {
        const page = await read(actor, target); reads++;
        expect(page).toContain(actor.marker);
        expect(page).toContain('"rowCount":1');
        expect(page).toContain('"exported":1');
        for (const other of agencies.filter((agency) => agency !== actor)) {
          expect(page).not.toContain(other.marker);
          expect(page).not.toContain(other.profileId);
          expect(page).not.toContain(other.marketplace);
        }
      }
      const forged = await read(actor, actor, agencies.find((agency) => agency !== actor)!.orgId); reads++;
      expect(forged).toContain('Resource not found');
      expect(forged).not.toContain(actor.marker);
    }
    expect(reads).toBe(12);
  });

  it.each(['org_members', 'ad_profiles', 'fact_sqp_weekly', 'fact_search_term_daily', 'query_vocabulary', 'sqp_promotion_runs', 'contextual_negative_proposals', 'audit_log', 'contextual_negative_exports'])('uses authenticated RLS for %s and hides real SQL errors', async (table) => {
    const secretDetail = 'synthetic-private-query-detail-' + randomUUID();
    await database.sql.unsafe(`create function public.query_page_failure() returns boolean language plpgsql as $$ begin raise exception '${secretDetail}'; end $$`);
    await database.sql`grant execute on function public.query_page_failure() to authenticated`;
    await database.sql.unsafe(`create policy query_page_failure on public.${table} as restrictive for select to authenticated using(public.query_page_failure())`);
    try {
      await expect(database.sql`select public.query_page_failure()`).rejects.toThrow(secretDetail);
      const page = await read(agencies[0]!);
      expect(page).toContain('Query Intelligence is unavailable');
      expect(page).not.toContain(secretDetail);
      expect(page).not.toContain(agencies[0]!.marker);
    } finally {
      await database.sql.unsafe(`drop policy query_page_failure on public.${table}`);
      await database.sql`drop function public.query_page_failure()`;
    }
    expect(await read(agencies[0]!)).toContain(agencies[0]!.marker);
  });

  it('rechecks selected membership and current role on every navigation', async () => {
    const actor = agencies[0]!; const selected = agencies[1]!;
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${selected.orgId},${actor.userId},'viewer')`;
    try {
      const page = await read(actor, selected, selected.orgId);
      expect(page).toContain(selected.marker);
      expect(page).not.toContain(actor.marker);
      expect(page).toContain('"role":"viewer"');
    } finally { await database.sql`delete from public.org_members where org_id=${selected.orgId} and user_id=${actor.userId}`; }
    expect(await read(actor, selected, selected.orgId)).toContain('Resource not found');
  });

  it('preserves no-profile and no-weekly-scope states under authenticated visibility', async () => {
    for (const [table, message] of [
      ['ad_profiles', 'This organisation has no advertising profiles yet.'],
      ['fact_sqp_weekly', 'No authoritative weekly SQP data'],
    ]) {
      await database.sql.unsafe(`create policy query_page_empty on public.${table} as restrictive for select to authenticated using(false)`);
      try {
        const page = await read(agencies[0]!);
        expect(page).toContain(message);
        expect(page).not.toContain('"negativeReview"');
      } finally { await database.sql.unsafe(`drop policy query_page_empty on public.${table}`); }
    }
  });

  it('shows timeout capacity while preserving the source model and export history', async () => {
    await database.sql`create function public.query_page_timeout() returns boolean language plpgsql as $$ begin perform pg_sleep(6); return true; end $$`;
    await database.sql`grant execute on function public.query_page_timeout() to authenticated`;
    await database.sql`create policy query_page_timeout on public.contextual_negative_proposals as restrictive for select to authenticated using(public.query_page_timeout())`;
    try {
      const page = await read(agencies[0]!);
      expect(page).toContain('"status":"capacity_exceeded"');
      expect(page).toContain('"measurementsAvailable":false');
      expect(page).toContain('"sourceFacts":1');
      expect(page).toContain('"displayedFactRows":1');
      expect(page).toContain('"exports":[{"id":');
      expect(page).toContain(agencies[0]!.marker);
      expect(page).not.toContain('Query Intelligence is unavailable');
    } finally {
      await database.sql`drop policy query_page_timeout on public.contextual_negative_proposals`;
      await database.sql`drop function public.query_page_timeout()`;
    }
    expect(await read(agencies[0]!)).toContain('"status":"ready"');
  }, 15_000);

  it('refuses a prepared page if its owned connection teardown fails', async () => {
    const originalOpen = requestContext.openWebDatabase;
    let closes = 0;
    const open = vi.spyOn(requestContext, 'openWebDatabase').mockImplementation(() => {
      const handle = originalOpen();
      return { ...handle, close: async () => { closes++; await handle.close(); throw new Error('Synthetic private close failure'); } };
    });
    try {
      const page = await read(agencies[0]!);
      expect(page).toContain('Query Intelligence is unavailable');
      expect(page).not.toContain('Synthetic private close failure');
      expect(page).not.toContain(agencies[0]!.marker);
      expect(open).toHaveBeenCalledTimes(1);
      expect(closes).toBe(1);
    } finally { open.mockRestore(); }
  });

  it('preserves exact authentication continuation before acquiring the page database', async () => {
    const location = '/mfa?next=' + encodeURIComponent('/query-intelligence');
    const identify = vi.spyOn(requestContext, 'requestActor').mockRejectedValue(new requestContext.RequestAuthError('Challenge required', 403, 'additional_authentication_required', location));
    const open = vi.spyOn(requestContext, 'openWebDatabase');
    try {
      await expect(read(agencies[0]!)).rejects.toMatchObject({ digest: ['NEXT_REDIRECT', 'replace', location, '307', ''].join(';') });
      expect(open).not.toHaveBeenCalled();
    } finally { identify.mockRestore(); open.mockRestore(); }
  });
});
