import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAuthenticatedActor } from '@wizard-ads/db';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { loadSyncStatus } from '../../src/data/sync-status';
import { ReportLifecycleTables } from './report-lifecycle-tables';

describe('sync status authenticated loader and lifecycle tables', () => {
  let db: TestDatabase;
  let orgId: string;
  let profileId: string;
  const userId = randomUUID();
  beforeAll(async () => {
    db = await createTestDatabase('sync_status_lifecycle');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner', '2026-08-29') as id`;
    orgId = org!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    profileId = profile!.id;
    await db.sql`update public.ad_profiles set account_name = 'Synthetic profile' where id = ${profileId}`;
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  it('loads exact fixture counts and renders all lifecycle columns and dead-letter details', async () => {
    const requestId = randomUUID();
    await db.sql`insert into public.report_requests
      (id, org_id, profile_id, report_type, start_date, end_date, reconciliation)
      values (${requestId}, ${orgId}, ${profileId}, 'sdCampaigns', '2026-08-28', '2026-08-29',
        '{"version":1,"state":"quarantined"}'::jsonb)`;
    for (const type of ['report.request', 'report.fetch']) {
      await db.sql`insert into public.sync_jobs
        (org_id, profile_id, job_type, payload, status, attempts, last_error)
        values (${orgId}, ${profileId}, ${type}::public.sync_job_type,
          ${JSON.stringify({ reportRequestId: requestId })}::jsonb, 'dead', 1,
          'report create outcome unknown; attended reconciliation required')`;
    }
    const status = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadSyncStatus({ sql }, orgId, profileId));
    expect(status.reports).toHaveLength(2); // one seed report + one inserted request
    expect(status.deadLetters).toHaveLength(2);
    expect(status.lifecycle).toEqual([
      { reportType: 'spCampaigns', requested: 1, created: 0, polled: 0, fetched: 0,
        parsed: 1, loaded: 1, promoted: 1, refused: 0, dead: 0, quarantined: 0 },
      { reportType: 'sdCampaigns', requested: 1, created: 0, polled: 0, fetched: 0,
        parsed: 0, loaded: 0, promoted: 0, refused: 0, dead: 1, quarantined: 1 },
    ]);
    const markup = renderToStaticMarkup(createElement(ReportLifecycleTables, status));
    expect(markup.match(/data-testid="dead-letter-row"/g)).toHaveLength(status.deadLetters.length);
    expect(markup.match(/data-testid="lifecycle-row"/g)).toHaveLength(status.lifecycle.length);
    expect(markup).toContain('Synthetic profile');
    expect(markup).toContain('report.request');
    expect(markup).toContain('report.fetch');
    expect(markup).toContain('Amazon may have received this report request.');
    for (const label of ['requested', 'created', 'polled', 'fetched', 'parsed', 'loaded', 'promoted', 'refused', 'dead', 'quarantined']) {
      expect(markup).toContain(`>${label}</th>`);
    }
    for (const row of status.deadLetters) {
      expect(row.attempts).toBe(1);
      expect(markup).toContain(row.firstSeen);
      expect(markup).toContain(row.lastSeen);
    }
    const hidden = await withAuthenticatedActor(db, { orgId, userId }, (sql) => loadSyncStatus({ sql }, orgId, randomUUID()));
    expect(hidden).toEqual({ freshness: [], jobs: [], reports: [], deadLetters: [], lifecycle: [], catalogue: [] });
  });
});
