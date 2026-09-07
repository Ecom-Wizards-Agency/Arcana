import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';

// Only the Next request container is substituted. Page functions, authentication,
// database transactions, queries and framework redirect/notFound errors are real.
const request = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: () => undefined }),
}));

import ExperimentsPage from '../app/experiments/page';
import NewExperimentPage from '../app/experiments/new/page';
import ExperimentPage from '../app/experiments/[experimentId]/page';
import FeedbackPage from '../app/feedback/page';
import NewFeedbackPage from '../app/feedback/new/page';
import BugsPage from '../app/bugs/page';
import RoadmapPage from '../app/roadmap/page';
import TagsPage from '../app/tags/page';
import NgramsPage from '../app/ngrams/page';
import RecommendationsPage from '../app/recommendations/page';
import TimeMachinePage from '../app/time-machine/page';
import CampaignsPage from '../app/campaigns/page';
import { authenticatedPageRead } from './server/authenticated-page-read';
import * as requestContext from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-legacy-page-bridge';
const applicationName = 'synthetic-page-requests-' + randomUUID();
const date = '2026-08-29';
const pages = ['experiments', 'newExperiment', 'experiment', 'feedback', 'newFeedback', 'bugs', 'roadmap', 'tags', 'ngrams', 'recommendations', 'history', 'campaigns'] as const;
type Page = typeof pages[number];
interface Agency { orgId: string; userId: string; profileId: string; experimentId: string; itemId: string; marker: string }

describe.skipIf(!available)('actual legacy pages under authenticated agency reads', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('agency_legacy_pages');
    for (const marker of ['Synthetic page alpha', 'Synthetic page bravo', 'Synthetic page staff']) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner',${date}) as id`;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`update public.ad_profiles set account_name=${marker} where org_id=${orgId} returning id`;
      const [experiment] = await database.sql<{ id: string }[]>`update public.experiments set name=${marker} where org_id=${orgId} returning id`;
      const [item] = await database.sql<{ id: string }[]>`update public.feedback_items set title=${marker} where org_id=${orgId} returning id`;
      await database.sql`insert into public.feedback_items(org_id,author_id,type,title,body) values(${orgId},${userId},'feature',${marker},'Synthetic feature')`;
      await database.sql`update public.campaigns set name=${marker} where org_id=${orgId}`;
      await database.sql`update public.tags set name=${marker} where org_id=${orgId}`;
      await database.sql`update public.entity_changes set entity_name=${marker} where org_id=${orgId}`;
      await database.sql`update public.fact_search_term_daily set search_term=${marker} where org_id=${orgId}`;
      agencies.push({ orgId, userId, profileId: profile!.id, experimentId: experiment!.id, itemId: item!.id, marker });
    }
    const pageDatabase = new URL(database.connectionString);
    pageDatabase.searchParams.set('application_name', applicationName);
    vi.stubEnv('DATABASE_URL', pageDatabase.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  function select(actor: Agency, orgId = actor.orgId): void {
    request.headers = new Headers({
      'x-wizard-ads-auth-bridge': bridge,
      'x-wizard-ads-user-id': actor.userId,
      'x-wizard-ads-org-id': orgId,
    });
  }

  async function read(page: Page, actor: Agency, target = actor, orgId = actor.orgId): Promise<string> {
    select(actor, orgId);
    const input = { searchParams: Promise.resolve({ profile: target.profileId, from: date, to: date }) };
    try {
      const element = await (() => {
        switch (page) {
          case 'experiments': return ExperimentsPage(input);
          case 'newExperiment': return NewExperimentPage(input);
          case 'experiment': return ExperimentPage({ params: Promise.resolve({ experimentId: target.experimentId }) });
          case 'feedback': return FeedbackPage({ searchParams: Promise.resolve({ item: target.itemId }) });
          case 'newFeedback': return NewFeedbackPage({ searchParams: Promise.resolve({ type: 'bug' }) });
          case 'bugs': return BugsPage();
          case 'roadmap': return RoadmapPage();
          case 'tags': return TagsPage(input);
          case 'ngrams': return NgramsPage(input);
          case 'recommendations': return RecommendationsPage(input);
          case 'history': return TimeMachinePage(input);
          case 'campaigns': return CampaignsPage(input);
        }
      })();
      // Inspect the actual server element's serialized props, without executing
      // presentation components or replacing any loader with a mock.
      return JSON.stringify(element);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'digest' in error) return String(error.digest);
      throw error;
    }
  }

  it.each(pages)('%s never includes another agency in page props or redirects', async (page) => {
    let reads = 0;
    for (const actor of agencies) {
      for (const target of agencies) {
        const result = await read(page, actor, target);
        reads++;
        for (const other of agencies.filter((agency) => agency !== actor)) {
          expect(result).not.toContain(other.marker);
          expect(result).not.toContain(other.profileId);
          expect(result).not.toContain(other.experimentId);
          expect(result).not.toContain(other.itemId);
        }
        if (target === actor) {
          expect(result).not.toMatch(/unavailable|Resource not found/);
          if (page === 'feedback') expect(result).toContain(`/bugs#bug-${actor.itemId}`);
          else if (page === 'newFeedback') expect(result).toContain('preselectedType');
          else expect(result).toContain(actor.marker);
        }
        if (page === 'experiment' && actor !== target) expect(result).toBe('NEXT_HTTP_ERROR_FALLBACK;404');
      }
      const forged = await read(page, actor, actor, agencies.find((agency) => agency !== actor)!.orgId);
      reads++;
      expect(forged).not.toContain(actor.marker);
      expect(forged).toContain(page === 'feedback' ? 'NEXT_REDIRECT;replace;/bugs;' : 'Resource not found');
    }
    expect(reads).toBe(12);
  });

  it('uses authenticated claims and current membership on each navigation', async () => {
    const actor = agencies[0]!;
    select(actor);
    expect(await authenticatedPageRead(request.headers, async (handle) => {
      const [row] = await handle.sql<{ role: string; subject: string; application: string }[]>`
        select current_user as role,auth.uid()::text as subject,current_setting('application_name') as application
      `;
      return row;
    })).toEqual({ role: 'authenticated', subject: actor.userId, application: applicationName });
    await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    try {
      for (const page of pages) {
        const result = await read(page, actor);
        expect(result).not.toContain(actor.marker);
        expect(result).toContain(page === 'feedback' ? 'NEXT_REDIRECT;replace;/bugs;' : 'Resource not found');
      }
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`;
    }
  });

  it('does not expose PostgreSQL error text and still serves the next navigation', async () => {
    const marker = 'synthetic-private-page-sql-' + randomUUID();
    await database.sql.unsafe(`create function public.page_read_failure() returns boolean language plpgsql as $$ begin raise exception '${marker}'; end $$`);
    await database.sql`grant execute on function public.page_read_failure() to authenticated`;
    await database.sql`create policy page_read_failure on public.org_members as restrictive for select to authenticated using(public.page_read_failure())`;
    try {
      await expect(database.sql`select public.page_read_failure()`).rejects.toThrow(marker);
      for (const page of pages) {
        const result = await read(page, agencies[0]!);
        expect(result).not.toContain(marker);
        expect(result).not.toContain(agencies[0]!.marker);
        expect(result).toContain(page === 'feedback' ? 'NEXT_REDIRECT;replace;/bugs;' : 'unavailable');
      }
    } finally {
      await database.sql`drop policy page_read_failure on public.org_members`;
      await database.sql`drop function public.page_read_failure()`;
    }
    expect(await read('bugs', agencies[0]!)).toContain(agencies[0]!.marker);
    // The fixture owns a separate pool. Count only the labeled page sessions,
    // not that pool's idle connections or PostgreSQL maintenance workers.
    const sessions = await database.sql<{ pid: number; state: string }[]>`
      select pid,state from pg_stat_activity where datname=current_database() and application_name=${applicationName}
    `;
    expect(sessions).toEqual([]);
  });

  it('honors selected membership and current role when the user belongs to two agencies', async () => {
    const actor = agencies[0]!;
    const selected = agencies[1]!;
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${selected.orgId},${actor.userId},'owner')`;
    try {
      for (const page of pages) {
        const result = await read(page, actor, selected, selected.orgId);
        expect(result).not.toContain(actor.marker);
        if (page !== 'feedback' && page !== 'newFeedback') expect(result).toContain(selected.marker);
      }
      await database.sql`update public.org_members set role='viewer' where org_id=${selected.orgId} and user_id=${actor.userId}`;
      expect(await read('newExperiment', actor, selected, selected.orgId)).toContain('role viewer is not permitted');
      expect(await read('bugs', actor, selected, selected.orgId)).toContain('"canTriage":false');
      expect(await read('experiments', actor, selected, selected.orgId)).toContain('"canManage":false');
    } finally {
      await database.sql`delete from public.org_members where org_id=${selected.orgId} and user_id=${actor.userId}`;
    }
  });

  it('preserves real login redirects on every protected page', async () => {
    const actor = { ...agencies[0]!, userId: 'not-a-user' };
    for (const page of pages) expect(await read(page, actor)).toContain('NEXT_REDIRECT;replace;/login;');
  });

  it('preserves the exact MFA continuation before acquiring a page database', async () => {
    const destination = '/auth/mfa/challenge?next=%2Fdashboard';
    const identity = vi.spyOn(requestContext, 'requestActor').mockRejectedValue(
      new requestContext.RequestAuthError('Additional authentication required', 403, 'additional_authentication_required', destination),
    );
    const open = vi.spyOn(requestContext, 'openWebDatabase');
    try {
      for (const page of pages) {
        expect((await read(page, agencies[0]!)).split(';')).toEqual(['NEXT_REDIRECT', 'replace', destination, '307', '']);
      }
      expect(identity).toHaveBeenCalledTimes(pages.length);
      expect(open).not.toHaveBeenCalled();
    } finally {
      identity.mockRestore();
      open.mockRestore();
    }
  });
});
