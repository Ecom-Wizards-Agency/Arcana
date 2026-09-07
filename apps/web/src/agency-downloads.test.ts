import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideContextualNegativeProposals, exportAcceptedContextualNegatives, loadContextualNegativeReview } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { GET as recommendation } from '../app/api/recommendations/export/[batchId]/route';
import { GET as contextual } from '../app/api/query-intelligence/negatives/export/[exportId]/route';
import { GET as dayparting } from '../app/api/dayparting/export/route';
import { POST as campaign } from '../app/api/campaigns/build/route';

const available = await databaseAvailable();
const bridge = 'synthetic-download-route-bridge';
interface Agency { userId: string; orgId: string; profileId: string; batchId: string; exportId: string; proposalId: string }
const kinds = ['recommendation', 'contextual', 'dayparting', 'campaign'] as const;
type Kind = typeof kinds[number];

describe.skipIf(!available)('private agency downloads', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  const envNames = ['DATABASE_URL', 'WIZARD_ADS_E2E_AUTH_BRIDGE', 'WIZARD_ADS_AUTH_BRIDGE_SECRET'] as const;
  const previous = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  beforeAll(async () => {
    database = await createTestDatabase('agency_downloads');
    for (const slug of ['download-agency-a', 'download-agency-b', 'download-staff-workspace']) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${slug},${userId},'owner') as id`;
      const orgId = org!.id;
      const [scope] = await database.sql<{ profile_id: string; id: string }[]>`select profile_id,id from public.apply_batches where org_id=${orgId}`;
      const profileId = scope!.profile_id;
      await database.sql`insert into public.campaigns
        (org_id,profile_id,amazon_id,ad_product,name,state,portfolio_amazon_id,budget_amount,budget_type,targeting_type,bidding_strategy)
        values(${orgId},${profileId},'1001','SP',${slug},'enabled','9001',20,'daily','manual','legacy_for_sales')`;
      const [proposal] = await database.sql<{ id: string }[]>`select id from public.dayparting_schedule_proposals where org_id=${orgId}`;
      const input = { orgId, profileId, marketplaceId: slug + '-market' };
      const first = await loadContextualNegativeReview(database, input);
      expect(first.status).toBe('ready');
      expect(first.proposals).toHaveLength(1);
      await decideContextualNegativeProposals(database, { ...input, actorId: userId, decision: 'accepted',
        proposals: first.proposals.map((row) => ({ id: row.id, expectedFingerprint: row.reviewFingerprint })) });
      const accepted = await loadContextualNegativeReview(database, input);
      const exported = await exportAcceptedContextualNegatives(database, { ...input, actorId: userId, note: 'Synthetic offline evidence',
        proposals: accepted.proposals.map((row) => ({ id: row.id, expectedFingerprint: row.reviewFingerprint })) });
      expect(exported.stamped).toBe(1);
      agencies.push({ userId, orgId, profileId, batchId: scope!.id, proposalId: proposal!.id, exportId: exported.exportId });
    }
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = bridge;
  }, 60_000);
  afterAll(async () => {
    for (const name of envNames) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await database?.drop();
  });

  async function fetch(kind: Kind, actor: Agency, target: Agency, selectedOrg = actor.orgId): Promise<Response> {
    const headers = { 'content-type': 'application/json', 'x-wizard-ads-auth-bridge': bridge,
      'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': selectedOrg,
      'if-none-match': '"previous-account-file"', 'if-modified-since': 'Sun, 06 Sep 2026 00:00:00 GMT' };
    if (kind === 'recommendation') return recommendation(new Request(`http://localhost/api/recommendations/export/${target.batchId}?format=rows`, { headers }), { params: Promise.resolve({ batchId: target.batchId }) });
    if (kind === 'contextual') return contextual(new Request(`http://localhost/api/query-intelligence/negatives/export/${target.exportId}?format=json`, { headers }), { params: Promise.resolve({ exportId: target.exportId }) });
    if (kind === 'dayparting') return dayparting(new Request(`http://localhost/api/dayparting/export?id=${target.proposalId}&profileId=${target.profileId}&format=json`, { headers }));
    return campaign(new Request('http://localhost/api/campaigns/build', { method: 'POST', headers,
      body: JSON.stringify({ mode: 'update', output: 'preview', profileId: target.profileId,
        config: { changes: { campaigns: [{ campaignId: '1001', dailyBudget: 25 }] } } }) }));
  }
  function privateFile(response: Response): void {
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  }

  it.each(kinds)('%s isolates two agencies and the staff workspace on identical resource URLs', async (kind) => {
    let allowed = 0;
    let denied = 0;
    for (const target of agencies) {
      for (const actor of agencies) {
        const response = await fetch(kind, actor, target);
        privateFile(response);
        expect(response.status).toBe(actor === target ? 200 : 404);
        const body = await response.json() as unknown;
        if (actor === target) {
          allowed += 1;
          if (kind === 'recommendation') expect(body).toHaveLength(1);
          if (kind === 'contextual') expect((body as { proposals: unknown[] }).proposals).toHaveLength(1);
          if (kind === 'dayparting') expect(body).toMatchObject({ id: target.proposalId, profileId: target.profileId });
          if (kind === 'campaign') expect(body).toMatchObject({ counts: { update: 1, archive: 0, create: 0 } });
        } else {
          denied += 1;
          expect(body).toEqual({ error: 'Not found' });
          const forgedOrg = await fetch(kind, actor, target, target.orgId);
          privateFile(forgedOrg);
          expect(forgedOrg.status).toBe(403);
          expect(await forgedOrg.json()).toEqual({ error: 'Resource not found' });
        }
      }
    }
    expect({ allowed, denied }).toEqual({ allowed: 3, denied: 6 });
  });

  it('applies authenticated RLS to each artifact read, including the campaign roster', async () => {
    const actor = agencies[0]!;
    const tables: Record<Kind, string> = { recommendation: 'apply_batches', contextual: 'contextual_negative_exports', dayparting: 'dayparting_schedule_proposals', campaign: 'ad_profiles' };
    for (const kind of kinds) {
      const table = database.sql(tables[kind]);
      expect((await fetch(kind, actor, actor)).status).toBe(200);
      await database.sql`create policy download_test_refusal on public.${table} as restrictive for select to authenticated using (false)`;
      try {
        const response = await fetch(kind, actor, actor);
        expect(response.status).toBe(404);
        privateFile(response);
      } finally { await database.sql`drop policy download_test_refusal on public.${table}`; }
    }
  });

  it('refuses every previously accessible artifact after membership removal', async () => {
    const actor = agencies[0]!;
    await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    try {
      for (const kind of kinds) {
        const response = await fetch(kind, actor, actor);
        expect(response.status).toBe(403);
        privateFile(response);
        expect(await response.json()).toEqual({ error: 'Resource not found' });
      }
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`;
    }
  });
});
