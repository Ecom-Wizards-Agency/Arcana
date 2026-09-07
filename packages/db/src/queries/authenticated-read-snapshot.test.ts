import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { AgencyAccessDenied, withAuthenticatedActor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { loadContextualNegativeReview, loadContextualNegativeReviewSnapshot } from './contextual-negative-review.js';

const available = await databaseAvailable();
const actor = (agency: Agency) => ({ userId: agency.userId, orgId: agency.orgId });
interface Agency { userId: string; orgId: string; profileId: string; marketplaceId: string }

describe.skipIf(!available)('authenticated complete read snapshots', () => {
  let database: TestDatabase;
  let connection: DbHandle;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('authenticated_read_snapshot');
    connection = createDb({ connectionString: database.connectionString, max: 1, statementTimeoutSeconds: 15 });
    for (let index = 0; index < 3; index++) {
      const slug = randomUUID(); const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${slug},${userId},'owner') as id`;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
      agencies.push({ orgId, userId, profileId: profile!.id, marketplaceId: slug + '-market' });
    }
  }, 60_000);
  afterAll(async () => { await connection?.close(); await database?.drop(); });

  const identity = () => connection.sql`select current_user as role,auth.uid()::text as subject,current_setting('statement_timeout') as timeout`;

  it('matches complete legacy review bytes/counts for three agencies and restores pool identity', async () => {
    const before = await identity();
    for (const agency of agencies) {
      const expected = await loadContextualNegativeReview(database, agency);
      expect(expected.proposals).toHaveLength(1);
      const actual = await withAuthenticatedReadSnapshot(connection, actor(agency), async (snapshot) => {
        expect(await snapshot.sql`select current_user as role,auth.uid()::text as subject,
          current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only`)
          .toEqual([{ role: 'authenticated', subject: agency.userId, isolation: 'repeatable read', read_only: 'on' }]);
        const review = await loadContextualNegativeReviewSnapshot(snapshot, agency);
        expect(await snapshot.sql`select current_setting('statement_timeout') as timeout`).toEqual([{ timeout: '15s' }]);
        return review;
      });
      expect(actual).toEqual(expected);
      expect(await identity()).toEqual(before);
    }
  });

  it('rejects forged membership and database writes, retaining ordinary read-committed behavior', async () => {
    const agency = agencies[0]!; const foreign = agencies[1]!;
    await expect(withAuthenticatedReadSnapshot(connection, { userId: agency.userId, orgId: foreign.orgId }, async () => 'unreachable'))
      .rejects.toBeInstanceOf(AgencyAccessDenied);
    await expect(withAuthenticatedReadSnapshot(connection, actor(agency), (snapshot) =>
      snapshot.sql`delete from public.contextual_negative_proposals where org_id=${agency.orgId}`))
      .rejects.toMatchObject({ code: '25006' });
    const settings = await withAuthenticatedActor(connection, actor(agency), (sql) => sql`
      select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only
    `);
    expect(settings).toEqual([{ isolation: 'read committed', read_only: 'off' }]);
  });

  it('keeps one coherent authorized snapshot and refuses a new read after revocation', async () => {
    const agency = agencies[0]!;
    const before = await loadContextualNegativeReview(database, agency);
    try {
      const sameSnapshot = await withAuthenticatedReadSnapshot(connection, actor(agency), async (snapshot) => {
        await database.sql`update public.contextual_negative_proposals set reason='Synthetic later reason ☃' where org_id=${agency.orgId}`;
        await database.sql`delete from public.org_members where org_id=${agency.orgId} and user_id=${agency.userId}`;
        return loadContextualNegativeReviewSnapshot(snapshot, agency);
      });
      expect(sameSnapshot).toEqual(before);
      await expect(withAuthenticatedReadSnapshot(connection, actor(agency), (snapshot) => loadContextualNegativeReviewSnapshot(snapshot, agency)))
        .rejects.toBeInstanceOf(AgencyAccessDenied);
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${agency.orgId},${agency.userId},'owner')`;
      await database.sql`update public.contextual_negative_proposals set reason='fixture' where org_id=${agency.orgId}`;
    }
  });

  it.each(['statistics', 'proposals'] as const)('recovers an actual five-second %s timeout without losing the outer snapshot', async (stage) => {
    const agency = agencies[0]!;
    const before = await loadContextualNegativeReview(database, agency);
    await database.sql.unsafe(`create function public.review_snapshot_delay() returns boolean language plpgsql as $$
      begin
        if ${stage === 'statistics' ? 'true' : "position('select p.org_id, p.id' in current_query()) > 0"} then perform pg_sleep(6); end if;
        return true;
      end $$`);
    await database.sql`grant execute on function public.review_snapshot_delay() to authenticated`;
    await database.sql`create policy review_snapshot_delay on public.contextual_negative_proposals as restrictive for select to authenticated using(public.review_snapshot_delay())`;
    try {
      await withAuthenticatedReadSnapshot(connection, actor(agency), async (snapshot) => {
        const result = await loadContextualNegativeReviewSnapshot(snapshot, agency);
        expect(result).toMatchObject({ status: 'capacity_exceeded', reason: 'timeout', measurementsAvailable: stage === 'proposals', proposals: [] });
        expect(result.rowCount).toBe(stage === 'proposals' ? before.rowCount : 0);
        expect(result.reviewBytes).toBe(stage === 'proposals' ? before.reviewBytes : 0);
        expect(await snapshot.sql`select current_user as role,auth.uid()::text as subject,current_setting('statement_timeout') as timeout,
          current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only`)
          .toEqual([{ role: 'authenticated', subject: agency.userId, timeout: '15s', isolation: 'repeatable read', read_only: 'on' }]);
        expect(await snapshot.sql`select id from public.ad_profiles where org_id=${agency.orgId}`).toHaveLength(1);
      });
    } finally {
      await database.sql`drop policy review_snapshot_delay on public.contextual_negative_proposals`;
      await database.sql`drop function public.review_snapshot_delay()`;
    }
    expect((await identity())[0]).toMatchObject({ subject: null, timeout: '15s' });
  }, 15_000);

  it('returns complete row and byte capacity measurements and restores the prior timeout', async () => {
    const agency = agencies[2]!;
    const marketplaceId = 'synthetic-capacity-market';
    await database.sql`insert into public.contextual_negative_proposals
      (org_id,profile_id,marketplace_id,campaign_id,ad_group_id,search_term,normalized_query,category,source_group_role,match_type,reason)
      select ${agency.orgId},${agency.profileId},${marketplaceId},'c-1','ag-1','Synthetic '||i,'synthetic '||i,'excluded','discovery','negative_exact','fixture'
      from generate_series(1,5001) as i`;
    await withAuthenticatedReadSnapshot(connection, actor(agency), async (snapshot) => {
      const result = await loadContextualNegativeReviewSnapshot(snapshot, { profileId: agency.profileId, marketplaceId });
      expect(result).toMatchObject({ status: 'capacity_exceeded', reason: 'row_limit', rowCount: 5001, measurementsAvailable: true, proposals: [] });
      expect(await snapshot.sql`select current_setting('statement_timeout') as timeout`).toEqual([{ timeout: '15s' }]);
    });
    await database.sql`delete from public.contextual_negative_proposals where org_id=${agency.orgId} and marketplace_id=${marketplaceId} and normalized_query <> 'synthetic 1'`;
    await database.sql`update public.contextual_negative_proposals set reason=repeat('x',8*1024*1024) where org_id=${agency.orgId} and marketplace_id=${marketplaceId}`;
    await withAuthenticatedReadSnapshot(connection, actor(agency), async (snapshot) => {
      const result = await loadContextualNegativeReviewSnapshot(snapshot, { profileId: agency.profileId, marketplaceId });
      expect(result).toMatchObject({ status: 'capacity_exceeded', reason: 'byte_limit', rowCount: 1, measurementsAvailable: true, proposals: [] });
      expect(result.reviewBytes).toBeGreaterThan(8*1024*1024);
      expect(await snapshot.sql`select current_setting('statement_timeout') as timeout`).toEqual([{ timeout: '15s' }]);
    });
  });
});
