import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { abandonDeadLegacyCandidates, listQuarantinedReports } from './queries/report-reconciliation.js';

describe('WP-323 abandon-dead bookkeeping', () => {
  let db: TestDatabase;
  let orgId: string;
  let profileId: string;
  let yesterday: string;
  const input = () => ({ orgId, before: '2999-01-01', actor: 'synthetic operator',
    reason: 'covered by the weekly restatement', workerStopped: true as const });

  async function candidate(start: string, end: string): Promise<string> {
    const id = randomUUID();
    const payload = { type: 'report.request', orgId, profileId, reportType: 'spCampaigns', startDate: start, endDate: end };
    await db.sql`insert into public.sync_jobs (id, org_id, profile_id, job_type, payload, status, attempts, last_error, finished_at)
      values (${id}, ${orgId}, ${profileId}, 'report.request', ${JSON.stringify(payload)}::jsonb, 'dead', 5,
        'Reporting v3 create outcome is unknown after server-response', now())`;
    await db.sql`insert into public.report_requests (id, org_id, profile_id, report_type, start_date, end_date, requested_at)
      values (${id}, ${orgId}, ${profileId}, 'spCampaigns', ${start}, ${end}, now() - interval '2 days')`;
    return id;
  }

  beforeAll(async () => {
    db = await createTestDatabase('report_abandon_dead');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${randomUUID()}, 'owner') as id`;
    orgId = org!.id;
    const [profile] = await db.sql<{ id: string; yesterday: string }[]>`
      select id, ((now() at time zone timezone)::date - 1)::text as yesterday from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    yesterday = profile!.yesterday;
    await db.sql`insert into public.sync_schedules (org_id, profile_id, job_type, report_type, variant, cadence, lookback_days, window_offset_days)
      values (${orgId}, ${profileId}, 'report.request', 'spCampaigns', 'restatement', '7 days', 32, 0)`;
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  it('refuses a malformed cut-off or a missing attestation before touching the database', async () => {
    await expect(abandonDeadLegacyCandidates(db, { ...input(), before: '24-09-2026' })).rejects.toThrow('YYYY-MM-DD');
    await expect(abandonDeadLegacyCandidates(db, { ...input(), actor: ' ' })).rejects.toThrow('attestation');
    await expect(abandonDeadLegacyCandidates(db, { ...input(), workerStopped: false as unknown as true })).rejects.toThrow('attestation');
  });

  it('abandons covered candidates, refuses one outside the restatement window, and repeats as a no-op', async () => {
    const day = (offset: number) => new Date(Date.parse(`${yesterday}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const covered = [await candidate(day(-2), day(0)), await candidate(day(-31), day(-29))];
    const outside = await candidate(day(-32), day(-30));

    expect(await abandonDeadLegacyCandidates(db, input())).toEqual({
      action: 'abandon-dead', before: '2999-01-01', candidates: 3, abandoned: 2,
      refusedOutsideRestatement: 1, refusedWithoutRestatement: 0, refusedDownstream: 0, running: 0,
    });
    const rows = await db.sql<{ id: string; state: string | null; window: { startDate: string; endDate: string } | null }[]>`
      select id, reconciliation ->> 'state' as state, reconciliation -> 'resolution' -> 'restatement' as window
        from public.report_requests where org_id = ${orgId}`;
    for (const id of covered) {
      expect(rows.find((row) => row.id === id)).toMatchObject({ state: 'abandoned', window: { startDate: day(-31), endDate: day(0) } });
    }
    expect(rows.find((row) => row.id === outside)).toMatchObject({ state: null });
    expect((await listQuarantinedReports(db, orgId)).map((row) => row.id)).toEqual([outside]);
    expect(await abandonDeadLegacyCandidates(db, input())).toMatchObject({ candidates: 1, abandoned: 0, refusedOutsideRestatement: 1 });
  });
});
