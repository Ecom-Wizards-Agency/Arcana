import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSpApiConnection, setSpApiBindingReporting, storeSpApiRefreshToken, upsertSpApiProfileBinding,
} from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import {
  completedSqpWeek,
  PostgresWeeklySqpScheduler,
  refusedParserVersion,
  sqpParserRetryDedupeKey,
  sqpWeekLockKey,
} from './sqp-scheduler.js';
import { SQP_PARSER_VERSION } from '@wizard-ads/sp-api';
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
    const sql = Object.assign(async (strings: TemplateStringsArray) => {
      const statement = strings.join(' ');
      if (statement.includes('pg_advisory_xact_lock')) return [{}];
      if (statement.includes('from public.sync_jobs')) {
        // The first week is present and succeeded; it is never re-offered.
        return [{ dedupe_key: offered[0]?.dedupeKey ?? null, status: 'succeeded', last_error: null, result: null }];
      }
      return rows;
    }, { begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql) });
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
      reofferedRefusedJobs: 0,
    });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1,
      enqueuedJobs: 0,
      alreadyPresentJobs: 1,
      reofferedRefusedJobs: 0,
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

describe('parser-version re-offer of a refused week', () => {
  const scope = {
    org_id: '00000000-0000-4000-8000-000000000001',
    profile_id: '00000000-0000-4000-8000-000000000011',
    connection_id: '00000000-0000-4000-8000-000000000021',
    marketplace_id: 'synthetic-marketplace',
    region: 'NA',
    timezone: 'UTC',
    asins: ['B000000001'],
    source_rows: '1',
    valid_rows: '1',
    refused_rows: '0',
  };
  const baseKey = 'sqp.request:00000000-0000-4000-8000-000000000011:synthetic-marketplace:2026-08-23';
  const retryKey = sqpParserRetryDedupeKey(baseKey, SQP_PARSER_VERSION);

  type Row = { dedupe_key: string; status: string; last_error: string | null; result: unknown };

  function harness() {
    const jobs = new Map<string, Row>();
    const statements: string[] = [];
    const lookups: unknown[][] = [];
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const statement = strings.join(' ');
      if (statement.includes('pg_advisory_xact_lock')) {
        statements.push(`lock ${String(values[0])}`);
        return [{}];
      }
      if (statement.includes('insert into public.sync_jobs')) {
        const key = String(values[4]);
        statements.push(`insert ${key}`);
        if (jobs.has(key)) return [];
        jobs.set(key, { dedupe_key: key, status: 'queued', last_error: null, result: null });
        return [{ id: key }];
      }
      if (statement.includes('from public.sync_jobs')) {
        lookups.push(values);
        return [...jobs.values()];
      }
      return [scope];
    }, {
      begin: async (run: (tx: unknown) => Promise<unknown>) => {
        statements.push('begin');
        return run(sql);
      },
    });
    const offered: string[] = [];
    const enqueuer = {
      enqueue: async (_payload: SqpRequestJob, _runAt: Date, dedupeKey: string) => {
        offered.push(dedupeKey);
        if (jobs.has(dedupeKey)) return false;
        jobs.set(dedupeKey, { dedupe_key: dedupeKey, status: 'queued', last_error: null, result: null });
        return true;
      },
    };
    const scheduler = new PostgresWeeklySqpScheduler(
      { sql } as never,
      enqueuer,
      () => new Date('2026-08-30T12:00:00Z'),
    );
    return { jobs, lookups, offered, scheduler, statements };
  }

  it('re-offers a week refused by an older parser exactly once, under a versioned key', async () => {
    const { jobs, lookups, offered, scheduler, statements } = harness();
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1, enqueuedJobs: 1, alreadyPresentJobs: 0, reofferedRefusedJobs: 0,
    });
    expect(lookups).toHaveLength(0);

    jobs.set(baseKey, {
      dedupe_key: baseKey,
      status: 'dead',
      last_error: 'SQP report refused 616 rows; canonical promotion is blocked',
      result: { kind: 'sqp_workflow_checkpoint', version: 1, checkpoint: { batches: [] } },
    });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1, enqueuedJobs: 1, alreadyPresentJobs: 0, reofferedRefusedJobs: 1,
    });
    // The versioned job dies too; no further offer is possible for this parser version.
    jobs.set(retryKey, {
      dedupe_key: retryKey, status: 'dead',
      last_error: 'SQP report refused 1 rows; canonical promotion is blocked', result: null,
    });
    for (let run = 0; run < 3; run += 1) {
      await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
        offeredJobs: 1, enqueuedJobs: 0, alreadyPresentJobs: 1, reofferedRefusedJobs: 0,
      });
    }
    expect(offered).toEqual([baseKey, baseKey, baseKey, baseKey, baseKey]);
    const lockKey = `lock ${sqpWeekLockKey(scope.profile_id, '2026-08-23')}`;
    expect(statements).toEqual([
      'begin', lockKey, `insert ${retryKey}`,
      'begin', lockKey, `insert ${retryKey}`,
      'begin', lockKey, `insert ${retryKey}`,
      'begin', lockKey, `insert ${retryKey}`,
    ]);
    expect(lookups).toHaveLength(4);
    expect(lookups.every((values) => values[0] === scope.org_id && values[3] === '2026-08-23')).toBe(true);
    expect([...jobs.keys()]).toEqual([baseKey, retryKey]);
  });

  it('re-offers a week parser v2 refused under the parser-v3 key', async () => {
    const { jobs, offered, scheduler, statements } = harness();
    jobs.set(baseKey, {
      dedupe_key: baseKey,
      status: 'dead',
      last_error: 'SQP report refused 190 rows; canonical promotion is blocked; parser v2 refused 190 of 844 rows: ' +
        'SQP row has invalid asinPurchaseShare x98; SQP row has invalid asinCartAddShare x92',
      result: { checkpoint: { refusalSummary: { parserVersion: 2 } } },
    });
    expect(SQP_PARSER_VERSION).toBe(3);
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1, enqueuedJobs: 1, alreadyPresentJobs: 0, reofferedRefusedJobs: 1,
    });
    expect(offered).toEqual([baseKey]);
    expect(statements).toEqual([
      'begin', `lock ${sqpWeekLockKey(scope.profile_id, '2026-08-23')}`, `insert ${baseKey}:parser-v3`,
    ]);
    expect([...jobs.keys()]).toEqual([baseKey, `${baseKey}:parser-v3`]);
  });

  it('inserts no re-offer while any job for the week is live', async () => {
    const { jobs, offered, scheduler, statements } = harness();
    jobs.set(baseKey, {
      dedupe_key: baseKey, status: 'dead',
      last_error: 'SQP report refused 616 rows; canonical promotion is blocked', result: null,
    });
    // For example a job an operator requeued a moment ago under another key.
    jobs.set('synthetic-live-key', { dedupe_key: 'synthetic-live-key', status: 'queued', last_error: null, result: null });
    await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
      offeredJobs: 1, enqueuedJobs: 0, alreadyPresentJobs: 1, reofferedRefusedJobs: 0,
    });
    expect(offered).toEqual([baseKey]);
    expect(statements).toEqual(['begin', `lock ${sqpWeekLockKey(scope.profile_id, '2026-08-23')}`]);
    expect(jobs.size).toBe(2);
  });

  it('does not re-offer a week refused by the current parser or dead for another reason', async () => {
    for (const dead of [
      {
        status: 'dead',
        last_error: 'SQP report refused 3 rows; canonical promotion is blocked; parser v2 refused 3 of 3 rows',
        result: { checkpoint: { refusalSummary: { parserVersion: SQP_PARSER_VERSION } } },
      },
      { status: 'dead', last_error: 'cancelled SQP report lacks authoritative no-data confirmation', result: null },
      { status: 'failed', last_error: 'SQP report refused 3 rows; canonical promotion is blocked', result: null },
    ]) {
      const { jobs, offered, scheduler, statements } = harness();
      jobs.set(baseKey, { dedupe_key: baseKey, ...dead });
      await expect(scheduler.enqueueDueSqpRequests()).resolves.toMatchObject({
        offeredJobs: 1, enqueuedJobs: 0, alreadyPresentJobs: 1, reofferedRefusedJobs: 0,
      });
      expect(offered).toEqual([baseKey]);
      expect(statements.filter((statement) => statement.startsWith('insert'))).toEqual([]);
    }
  });

  it('attributes a refusal to the version recorded on the checkpoint, else to version 1', () => {
    expect(refusedParserVersion({ status: 'dead', lastError: null,
      result: { checkpoint: { refusalSummary: { parserVersion: 7 } } } })).toBe(7);
    expect(refusedParserVersion({ status: 'dead',
      lastError: 'SQP report refused 616 rows; canonical promotion is blocked', result: null })).toBe(1);
    expect(refusedParserVersion({ status: 'dead', lastError: 'SQP report 1 failed fatally', result: null })).toBeNull();
    // The summary checkpoint write failed, but the error line still names the parser.
    expect(refusedParserVersion({ status: 'dead', lastError: 'SQP report refused 3 rows; canonical promotion is blocked; ' +
      'parser v2 refused 3 of 3 rows: row is not an object x3; refusal summary was not checkpointed', result: null })).toBe(2);
    expect(refusedParserVersion({ status: 'succeeded', lastError: null,
      result: { checkpoint: { refusalSummary: { parserVersion: 1 } } } })).toBeNull();
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
