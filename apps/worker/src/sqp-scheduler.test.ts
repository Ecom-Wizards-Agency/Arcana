import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSpApiConnection, setSpApiBindingReporting, storeSpApiRefreshToken, upsertSpApiProfileBinding,
} from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { completedSqpWeek, PostgresWeeklySqpScheduler } from './sqp-scheduler.js';
import type { SqpRequestJob } from '@wizard-ads/shared';

describe('completedSqpWeek', () => {
  it('selects yesterday-ended week on Sunday and the prior week on Saturday', () => {
    expect(completedSqpWeek('Asia/Bangkok', new Date('2026-08-29T20:00:00Z'))).toEqual({
      weekStart: '2026-08-23',
      weekEnd: '2026-08-29',
    });
    expect(completedSqpWeek('Asia/Bangkok', new Date('2026-08-29T04:00:00Z'))).toEqual({
      weekStart: '2026-08-16',
      weekEnd: '2026-08-22',
    });
  });

  it('uses the profile calendar across a daylight-saving boundary', () => {
    expect(completedSqpWeek('America/New_York', new Date('2026-03-08T16:00:00Z'))).toEqual({
      weekStart: '2026-03-01',
      weekEnd: '2026-03-07',
    });
  });

  it('fails closed on an invalid timezone', () => {
    expect(() => completedSqpWeek('Not/A-Timezone', new Date('2026-08-29T00:00:00Z')))
      .toThrow(/time zone/i);
  });
});

describe('PostgresWeeklySqpScheduler', () => {
  it('reconciles every ASIN row and produces one stable weekly queue identity', async () => {
    const rows = [
      {
        org_id: '00000000-0000-4000-8000-000000000001',
        profile_id: '00000000-0000-4000-8000-000000000011',
        connection_id: '00000000-0000-4000-8000-000000000021',
        marketplace_id: 'synthetic-marketplace',
        region: 'NA',
        timezone: 'UTC',
        asins: ['B000000001'],
        source_rows: '4',
        valid_rows: '2',
        refused_rows: '2',
      },
      {
        org_id: '00000000-0000-4000-8000-000000000001',
        profile_id: '00000000-0000-4000-8000-000000000012',
        connection_id: '00000000-0000-4000-8000-000000000022',
        marketplace_id: 'empty-marketplace',
        region: 'EU',
        timezone: 'UTC',
        asins: [],
        source_rows: '0',
        valid_rows: '0',
        refused_rows: '0',
      },
      {
        org_id: '00000000-0000-4000-8000-000000000001',
        profile_id: '00000000-0000-4000-8000-000000000013',
        connection_id: '00000000-0000-4000-8000-000000000023',
        marketplace_id: 'invalid-timezone-marketplace',
        region: 'FE',
        timezone: 'Invalid/Timezone',
        asins: ['B000000002'],
        source_rows: '1',
        valid_rows: '1',
        refused_rows: '0',
      },
    ];
    const sql = async () => rows;
    const seen = new Set<string>();
    const offered: Array<{ payload: SqpRequestJob; dedupeKey: string }> = [];
    const jobs = {
      enqueue: async (payload: SqpRequestJob, _runAt: Date, dedupeKey: string) => {
        offered.push({ payload, dedupeKey });
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
      },
    };
    const scheduler = new PostgresWeeklySqpScheduler(
      { sql } as never,
      jobs,
      () => new Date('2026-08-30T12:00:00Z'),
    );

    await expect(scheduler.enqueueDueSqpRequests()).resolves.toEqual({
      scopes: 3,
      scopesWithAsins: 1,
      scopesWithoutAsins: 1,
      refusedScopes: 1,
      sourceAsinRows: 5,
      uniqueAsins: 2,
      duplicateAsinRows: 1,
      refusedAsinRows: 2,
      offeredJobs: 1,
      enqueuedJobs: 1,
      alreadyPresentJobs: 0,
    });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1,
      enqueuedJobs: 0,
      alreadyPresentJobs: 1,
    });
    expect(new Set(offered.map((row) => row.dedupeKey))).toEqual(new Set([
      'sqp.request:00000000-0000-4000-8000-000000000011:synthetic-marketplace:2026-08-23',
    ]));
    expect(offered[0]?.payload).toMatchObject({
      type: 'sqp.request',
      marketplaceId: 'synthetic-marketplace',
      asins: ['B000000001'],
      weekStart: '2026-08-23',
      weekEnd: '2026-08-29',
    });
  });
});

const available = await databaseAvailable();
describe.skipIf(!available)('PostgresWeeklySqpScheduler over operator-enabled bindings', () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await createTestDatabase('wp327_sqp_scheduler'); }, 180_000);
  afterAll(async () => { await db?.drop(); });

  it('schedules an enabled binding and skips a disabled one, following the operator switch', async () => {
    const userId = randomUUID();
    await db.sql`insert into auth.users(id) values (${userId})`;
    const [org] = await db.sql<{ id: string }[]>`insert into public.orgs(slug,name) values (${randomUUID()},'Synthetic scheduler agency') returning id`;
    const actor = { orgId: org!.id, userId };
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${actor.orgId},${userId},'owner')`;
    const connection = await createSpApiConnection(db, { orgId: actor.orgId, label: 'Synthetic seller',
      sellingPartnerId: 'synthetic-seller', marketplaceIds: ['ATVPDKIKX0DER'] });
    await storeSpApiRefreshToken(db, { orgId: actor.orgId, connectionId: connection.id, refreshToken: ['synthetic', 'scheduler', 'refresh'].join('-') });
    const bindings: { profileId: string; bindingId: string }[] = [];
    for (const [index, asin] of ['B000000031', 'B000000032'].entries()) {
      const [profile] = await db.sql<{ id: string }[]>`insert into public.ad_profiles
        (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,amazon_account_id,sync_enabled)
        values (${actor.orgId},${randomUUID()},'NA','US','USD','UTC','seller','synthetic-seller',true) returning id`;
      await db.sql`insert into public.product_ads (org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin)
        values (${actor.orgId},${profile!.id},${`synthetic-scheduler-ad-${index}`},'SP','enabled','c-1','ag-1',${asin})`;
      await upsertSpApiProfileBinding(db, { orgId: actor.orgId, profileId: profile!.id, connectionId: connection.id, marketplaceId: 'ATVPDKIKX0DER' });
      const [binding] = await db.sql<{ id: string }[]>`select id from public.spapi_profile_bindings where profile_id=${profile!.id}`;
      bindings.push({ profileId: profile!.id, bindingId: binding!.id });
    }
    const offered: SqpRequestJob[] = [];
    const scheduler = new PostgresWeeklySqpScheduler(db, {
      enqueue: async (payload: SqpRequestJob) => { offered.push(payload); return true; },
    }, () => new Date('2026-09-27T12:00:00Z'));

    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({ scopes: 0, offeredJobs: 0, enqueuedJobs: 0 });
    expect(offered).toHaveLength(0);

    const [enabled, disabled] = bindings;
    await setSpApiBindingReporting(db, actor, { connectionId: connection.id, bindingId: enabled!.bindingId, enabled: true });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      scopes: 1, scopesWithAsins: 1, sourceAsinRows: 1, uniqueAsins: 1, offeredJobs: 1, enqueuedJobs: 1,
    });
    expect(offered).toHaveLength(1);
    expect(offered[0]).toMatchObject({ type: 'sqp.request', orgId: actor.orgId, profileId: enabled!.profileId,
      marketplaceId: 'ATVPDKIKX0DER', asins: ['B000000031'], weekStart: '2026-09-20', weekEnd: '2026-09-26' });
    expect(offered.some((payload) => payload.profileId === disabled!.profileId)).toBe(false);

    await setSpApiBindingReporting(db, actor, { connectionId: connection.id, bindingId: enabled!.bindingId, enabled: false });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({ scopes: 0, offeredJobs: 0 });
    expect(offered).toHaveLength(1);
  });
});
