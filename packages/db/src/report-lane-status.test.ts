import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { loadReportLaneStatus } from './queries/report-lifecycle.js';
import { withAuthenticatedActor } from './queries/authenticated-actor.js';

const LEGACY_MISLABEL = 'report download exceeded decompressed_bytes limit';

describe('WP-323 report lane status', () => {
  let db: TestDatabase;
  let orgId: string;
  let profileId: string;
  let otherProfileId: string;
  let idleProfileId: string;
  const userId = randomUUID();
  const at = (hoursAgo: number) => new Date(Date.parse('2026-09-24T10:10:00Z') - hoursAgo * 3_600_000).toISOString();

  async function job(values: {
    profile?: string; type: 'report.request' | 'report.poll' | 'report.fetch' | 'entity.sync';
    status: 'queued' | 'running' | 'succeeded' | 'dead'; hoursAgo: number; error?: string | null;
    attempts?: number; result?: Record<string, unknown> | null; id?: string;
  }): Promise<string> {
    const id = values.id ?? randomUUID();
    const time = at(values.hoursAgo);
    await db.sql`
      insert into public.sync_jobs (id, org_id, profile_id, job_type, payload, status, attempts, last_error,
        result, finished_at, created_at, updated_at)
      values (${id}, ${orgId}, ${values.profile ?? profileId}, ${values.type}::public.sync_job_type,
        ${JSON.stringify({ synthetic: true })}::jsonb, ${values.status}::public.sync_job_status,
        ${values.attempts ?? 1}, ${values.error ?? null}, ${values.result === undefined ? null : JSON.stringify(values.result)}::jsonb,
        ${values.status === 'succeeded' || values.status === 'dead' ? time : null}::timestamptz, ${time}::timestamptz, ${time}::timestamptz)`;
    return id;
  }

  beforeAll(async () => {
    db = await createTestDatabase('report_lane_status');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner', '2026-08-29') as id`;
    orgId = org!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    const clone = async (suffix: string) => (await db.sql<{ id: string }[]>`
      insert into public.ad_profiles (org_id, connection_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      select org_id, connection_id, amazon_profile_id || ${suffix}, region, country_code, currency_code, timezone, true
        from public.ad_profiles where id = ${profileId}
      returning id`)[0]!.id;
    otherProfileId = await clone('-synthetic-2');
    idleProfileId = await clone('-synthetic-3');
    await db.sql`delete from public.unified_report_runs where org_id = ${orgId}`;
    await db.sql`delete from public.recommendation_preview_batches where org_id = ${orgId}`;
    await db.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
    await db.sql`delete from public.sync_jobs where org_id = ${orgId}`;

    // The production shape: requests and polls keep working, fetches die.
    await job({ type: 'report.request', status: 'succeeded', hoursAgo: 2.6 });
    const abandoned = await job({ type: 'report.request', status: 'dead', hoursAgo: 9 * 24, error: 'covered by the weekly restatement' });
    await db.sql`insert into public.report_requests (id, org_id, profile_id, report_type, start_date, end_date, status, reconciliation)
      values (${abandoned}, ${orgId}, ${profileId}, 'spCampaigns', '2026-09-03', '2026-09-05', 'failed',
        '{"version":1,"state":"abandoned"}'::jsonb)`;
    await job({ type: 'report.poll', status: 'succeeded', hoursAgo: 2.5 });
    await job({ type: 'report.fetch', status: 'succeeded', hoursAgo: 4 * 24 });
    // A fetch that re-requested its report downloaded nothing and is not a success.
    await job({ type: 'report.fetch', status: 'succeeded', hoursAgo: 0.2, result: { downloadExpired: true, reRequested: true } });
    await job({ type: 'report.fetch', status: 'dead', hoursAgo: 2, error: LEGACY_MISLABEL });
    await job({ type: 'report.fetch', status: 'dead', hoursAgo: 3, error: LEGACY_MISLABEL, result: { recovery: { state: 're-requested' } } });
    await job({ type: 'report.fetch', status: 'dead', hoursAgo: 28 * 24, error: 'Failed query: insert into fact_search_term_daily (synthetic)' });
    await job({ type: 'report.fetch', status: 'queued', hoursAgo: 5, error: 'report download failed with 503', attempts: 2 });
    // Released on shutdown is not a failure; a fresh queued job is not retrying.
    await job({ type: 'report.poll', status: 'queued', hoursAgo: 0.1, error: 'released during graceful shutdown' });
    await job({ type: 'report.request', status: 'queued', hoursAgo: 0.1, attempts: 0 });
    await job({ type: 'entity.sync', status: 'dead', hoursAgo: 1, error: 'synthetic entity failure' });
    await job({ profile: otherProfileId, type: 'report.fetch', status: 'dead', hoursAgo: 1, error: 'report download URL expired' });
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  it('names the blocking stage and its last error class, with measured counts and an organisation-wide dead summary', async () => {
    const status = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadReportLaneStatus({ sql }, orgId, null));
    expect(status.scope).toBe('organisation');
    expect(status.blocking).toEqual({
      stage: 'fetch', errorClass: 'download_url_expired', since: at(1), lastSucceededAt: at(4 * 24),
    });
    expect(status.stages).toEqual([
      { stage: 'request', lastSucceededAt: at(2.6), lastFailedAt: at(9 * 24), lastErrorClass: 'unclassified', retrying: 0, dead: 1 },
      { stage: 'poll', lastSucceededAt: at(2.5), lastFailedAt: null, lastErrorClass: null, retrying: 0, dead: 0 },
      { stage: 'fetch', lastSucceededAt: at(4 * 24), lastFailedAt: at(1), lastErrorClass: 'download_url_expired', retrying: 1, dead: 3 },
      { stage: 'load', lastSucceededAt: at(4 * 24), lastFailedAt: at(28 * 24), lastErrorClass: 'load_failed', retrying: 0, dead: 1 },
    ]);
    expect(status.organisationDead).toEqual({
      total: 5, byStage: { request: 1, poll: 0, fetch: 3, load: 1 }, reRequested: 1, resolved: 1,
    });
    expect(status.profiles).toEqual([
      { profileId, retrying: 1, dead: 5 },
      { profileId: otherProfileId, retrying: 0, dead: 1 },
      { profileId: idleProfileId, retrying: 0, dead: 0 },
    ].sort((left, right) => left.profileId.localeCompare(right.profileId)));
  });

  it('scopes stages and profile counts to the selected profile but keeps the dead summary organisation-wide', async () => {
    const status = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadReportLaneStatus({ sql }, orgId, profileId));
    expect(status.scope).toBe('profile');
    expect(status.blocking).toEqual({
      stage: 'fetch', errorClass: 'download_inflate_limit', since: at(2), lastSucceededAt: at(4 * 24),
    });
    expect(status.stages.find((row) => row.stage === 'fetch')).toMatchObject({ dead: 2, retrying: 1 });
    expect(status.organisationDead.total).toBe(5);
    expect(status.profiles).toEqual([{ profileId, retrying: 1, dead: 5 }]);
  });

  it('shows another organisation nothing', async () => {
    const status = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadReportLaneStatus({ sql }, randomUUID(), null));
    expect(status.blocking).toBeNull();
    expect(status.organisationDead.total).toBe(0);
    expect(status.profiles).toEqual([]);
    expect(status.stages.every((row) => row.lastSucceededAt === null && row.lastFailedAt === null)).toBe(true);
  });
});
