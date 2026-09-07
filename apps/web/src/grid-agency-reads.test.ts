import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { GridRow } from '@wizard-ads/ui';
import { createGridRowsGet, GET } from '../app/api/grid/rows/route';
import { loadGridRows } from '../app/_lib/grid-data';
import { enforceGridAssurance, gridRequestSubject, resolveGridReadReceipt } from './grid/request-context';
import { openWebDatabase } from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-grid-agency-bridge';
const applicationName = 'synthetic-grid-requests-' + randomUUID();
const date = '2026-08-29';
const levels = ['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements'] as const;
type Level = typeof levels[number];
interface Agency { orgId: string; userId: string; profileId: string; marker: string }
interface Payload { rows: GridRow[]; rowCount: number; truncated: boolean }

describe.skipIf(!available)('Grid authenticated data reads', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('grid_agency_reads');
    for (const marker of ['Synthetic Grid alpha', 'Synthetic Grid bravo', 'Synthetic Grid staff']) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner',${date}) as id`;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`update public.ad_profiles set account_name=${marker} where org_id=${orgId} returning id`;
      await database.sql`update public.campaigns set name=${marker} where org_id=${orgId}`;
      await database.sql`update public.ad_groups set name=${marker} where org_id=${orgId}`;
      agencies.push({ orgId, userId, profileId: profile!.id, marker });
    }
    const requestDatabase = new URL(database.connectionString);
    requestDatabase.searchParams.set('application_name', applicationName);
    vi.stubEnv('DATABASE_URL', requestDatabase.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  function request(level: Level, actor: Agency, target = actor, orgId = actor.orgId): Request {
    const query = new URLSearchParams({ profile: target.profileId, entity: level, from: date, to: date });
    return new Request('http://localhost/api/grid/rows?' + query, { headers: {
      'x-wizard-ads-auth-bridge': bridge,
      'x-wizard-ads-user-id': actor.userId,
      'x-wizard-ads-org-id': orgId,
      'if-none-match': '"prior-agency"',
    } });
  }
  function read(level: Level, actor: Agency, target = actor, orgId = actor.orgId): Promise<Response> {
    return GET(request(level, actor, target, orgId));
  }

  it.each(levels)('%s refuses foreign scope and honors authenticated fact policies', async (level) => {
    let responses = 0;
    for (const actor of agencies) {
      for (const target of agencies) {
        const response = await read(level, actor, target);
        responses++;
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        expect(response.status).toBe(actor === target ? 200 : 404);
        const text = await response.text();
        for (const other of agencies.filter((agency) => agency !== actor)) expect(text).not.toContain(other.marker);
        if (actor === target) {
          const payload = JSON.parse(text) as Payload;
          expect(payload.rowCount).toBe(1);
          expect(payload.rows).toHaveLength(1);
          expect(payload.truncated).toBe(false);
          expect(text).toContain(actor.marker);
        }
      }
    }
    expect(responses).toBe(9);
    const table = level === 'search_terms' ? 'fact_search_term_daily' : level === 'placements' ? 'fact_placement_daily' : 'fact_sp_target_daily';
    await database.sql`create policy grid_fact_denial on public.${database.sql(table)} as restrictive for select to authenticated using(false)`;
    try {
      for (const actor of agencies) {
        const response = await read(level, actor);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ rows: [], rowCount: 0, truncated: false });
      }
    } finally {
      await database.sql`drop policy grid_fact_denial on public.${database.sql(table)}`;
    }
  });

  it('keeps target bid enrichment inside the authenticated read', async () => {
    const actor = agencies[0]!;
    const baseline = await (await read('targets', actor)).json() as Payload;
    expect(baseline.rows[0]!.dimensions['suggested_bid']).toBeTypeOf('number');
    await database.sql`create policy grid_bid_denial on public.bid_series_daily as restrictive for select to authenticated using(false)`;
    try {
      const payload = await (await read('targets', actor)).json() as Payload;
      expect(payload.rows).toHaveLength(1);
      expect(payload.rows[0]!.dimensions['suggested_bid']).toBeNull();
      expect(payload.rows[0]!.dimensions['suggested_bid_low']).toBeNull();
      expect(payload.rows[0]!.dimensions['suggested_bid_high']).toBeNull();
    } finally {
      await database.sql`drop policy grid_bid_denial on public.bid_series_daily`;
    }
  });

  it('resolves the profile receipt with authenticated RLS', async () => {
    await database.sql`create policy grid_profile_denial on public.ad_profiles as restrictive for select to authenticated using(false)`;
    try {
      for (const actor of agencies) expect((await read('targets', actor)).status).toBe(404);
    } finally {
      await database.sql`drop policy grid_profile_denial on public.ad_profiles`;
    }
  });

  it('selects only the requested agency for a multi-membership user and rechecks removal', async () => {
    const actor = agencies[0]!;
    const other = agencies[1]!;
    expect((await read('targets', actor, other, other.orgId)).status).toBe(403);
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${other.orgId},${actor.userId},'viewer')`;
    try {
      for (const level of levels) {
        const response = await read(level, actor, other, other.orgId);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain(other.marker);
        expect(text).not.toContain(actor.marker);
        expect((await read(level, actor, actor, other.orgId)).status).toBe(404);
      }
    } finally {
      await database.sql`delete from public.org_members where org_id=${other.orgId} and user_id=${actor.userId}`;
    }
    expect((await read('targets', actor, other, other.orgId)).status).toBe(403);
  });

  it('enforces a membership removed after the receipt on the next data statement', async () => {
    const actor = agencies[0]!;
    const get = createGridRowsGet({
      identify: gridRequestSubject,
      openDatabase: openWebDatabase,
      resolveReceipt: async (handle, subject, candidate) => {
        const receipt = await resolveGridReadReceipt(handle, subject, candidate);
        const [identity] = await handle.sql<{ role: string; label: string }[]>`
          select current_user as role,current_setting('application_name') as label
        `;
        expect(identity).toEqual({ role: 'authenticated', label: applicationName });
        await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
        return receipt;
      },
      enforceAssurance: enforceGridAssurance,
      loadRows: loadGridRows,
    });
    try {
      const response = await get(request('targets', actor));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ rows: [], rowCount: 0, truncated: false });
      expect((await read('targets', actor)).status).toBe(403);
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`;
    }
  });

  it('redacts actual receipt and leaf SQL failures and releases every request session', async () => {
    const marker = 'synthetic-private-grid-' + randomUUID();
    await database.sql.unsafe(`create function public.grid_read_failure() returns boolean language plpgsql as $$ begin raise exception '${marker}'; end $$`);
    await database.sql`grant execute on function public.grid_read_failure() to authenticated`;
    await expect(database.sql`select public.grid_read_failure()`).rejects.toThrow(marker);
    const cases: [string, Level][] = [
      ['org_members', 'targets'], ['ad_profiles', 'targets'],
      ['fact_sp_target_daily', 'targets'], ['fact_search_term_daily', 'search_terms'],
      ['fact_placement_daily', 'placements'], ['bid_series_daily', 'targets'],
    ];
    try {
      for (const [table, level] of cases) {
        await database.sql`create policy grid_read_failure on public.${database.sql(table)} as restrictive for select to authenticated using(public.grid_read_failure())`;
        try {
          const response = await read(level, agencies[0]!);
          expect(response.status).toBe(500);
          expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
          expect(response.headers.has('server-timing')).toBe(false);
          expect(await response.json()).toEqual({ error: 'Could not load Grid rows' });
        } finally {
          await database.sql`drop policy grid_read_failure on public.${database.sql(table)}`;
        }
        expect((await read(level, agencies[0]!)).status).toBe(200);
      }
    } finally {
      await database.sql`drop function public.grid_read_failure()`;
    }
    const sessions = await database.sql`select pid from pg_stat_activity
      where datname=current_database() and application_name=${applicationName}`;
    expect(sessions).toEqual([]);
  });
});
