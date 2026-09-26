import { appendFile, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { MarketSignalsImportCounts } from '@wizard-ads/shared';
import { DirectoryBatchSource, MarketSignalsImporter } from './market-signals-import.js';
import { readMarketSignalsImportStatus } from '@wizard-ads/db';
import { marketSignalsImportExitCode, runMarketSignalsImportCli } from './market-signals-import-cli.js';
import {
  FIXTURE_HERO_SIGNAL_ID,
  FIXTURE_ORG_KEY,
  FIXTURE_PROFILE_US,
  FIXTURE_RANK_SIGNAL_ID,
  firstBatch,
  secondBatch,
  toNdjson,
  uuid5,
} from './market-signals-import.fixture.js';

const available = await databaseAvailable();
const USER = '41111111-1111-4111-8111-111111111111';

describe.skipIf(!available)('market signals import against the database', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let directory: string;
  const importer = (dir = directory, keys: ReadonlyMap<string, string> = new Map([[FIXTURE_ORG_KEY, orgId]])) =>
    new MarketSignalsImporter(database, new DirectoryBatchSource(dir), keys);

  beforeAll(async () => {
    database = await createTestDatabase('ms_import');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`select app.seed_tenant_fixture('msimport', ${USER}, 'owner')`;
    orgId = org!.seed_tenant_fixture;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId} limit 1`;
    profileId = profile!.id;
    await database.sql`insert into public.market_signals_profile_map (org_id, profile_key, profile_id)
      values (${orgId}, ${FIXTURE_PROFILE_US}, ${profileId})`;
    directory = await mkdtemp(join(tmpdir(), 'wp331-market-signals-'));
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** Every imported row with its row version: equal snapshots mean no row changed. */
  async function snapshot() {
    return database.sql`
      select 'observation' as kind, id::text, xmin::text, concat_ws('|', marketplace, asin, observed_at, bsr, buy_box_price, source) as body
        from public.keepa_bsr_observations where org_id = ${orgId} and source = 'wizards-ai'
      union all select 'event', id::text, xmin::text, concat_ws('|', asin, event_kind, detected_at, price, baseline_price, source)
        from public.competitor_price_events where org_id = ${orgId} and source = 'wizards-ai'
      union all select 'insight', id::text, xmin::text, concat_ws('|', profile_id, date, kind, figures::text)
        from public.insights where org_id = ${orgId} and source = 'wizards-ai'
      union all select 'mark', id::text, xmin::text, concat_ws('|', path, op, at, stage) from public.insight_tag_marks
        where org_id = ${orgId} and source_tag_id is not null
      union all select 'tag', t.id::text, t.xmin::text, t.slug from public.tags t where t.org_id = ${orgId}
      order by 1, 2`;
  }

  it('imports every kind, maps the profile and counts the unmapped signal', async () => {
    await writeFile(join(directory, '2026-09-25.ndjson'), toNdjson(firstBatch()));
    const counts = await importer().run();
    expect(counts).toEqual({
      filesSeen: 1, filesSkippedUnchanged: 0, filesFailed: 0, batchesSeen: 1, batchesImported: 1, batchesAlreadyImported: 0,
      batchesIncomplete: 0, batchesCountMismatch: 0, batchesUnmappedOrg: 0, batchesFailed: 0,
      observations: 6, observationsWritten: 6, observationsUnchanged: 0,
      changePoints: 7, changePointsWithoutObservation: 1, priceEventsWritten: 2, priceEventsExisting: 0,
      signals: 2, signalsWritten: 2, signalsAdvanced: 0, signalsBlocked: 0, signalsUnchanged: 0, unmappedSignals: 1,
      tagMarks: 7, tagMarksWritten: 7, tagMarksExisting: 0, invalidRecords: 0,
      stateGeneratedAt: '2026-09-25T01:00:00Z',
    });
    const observations = await database.sql<{ marketplace: string; n: number }[]>`
      select marketplace, count(*)::integer as n from public.keepa_bsr_observations
       where org_id = ${orgId} and source = 'wizards-ai' group by marketplace order by marketplace`;
    expect(observations).toEqual([{ marketplace: 'DE', n: 1 }, { marketplace: 'US', n: 5 }]);
    const offers = await database.sql<{ offer_count: number }[]>`select offer_count from public.keepa_bsr_observations
      where org_id = ${orgId} and marketplace = 'DE'`;
    expect(offers).toEqual([{ offer_count: 2 }]);
    const events = await database.sql<{ event_kind: string; price: string; baseline_price: string; marketplace: string }[]>`
      select event_kind, price::text, baseline_price::text, details ->> 'marketplace' as marketplace
        from public.competitor_price_events where org_id = ${orgId} and source = 'wizards-ai' order by detected_at`;
    expect(events).toEqual([
      { event_kind: 'price_drop', price: '15.0000', baseline_price: '20.0000', marketplace: 'US' },
      { event_kind: 'price_restore', price: '20.0000', baseline_price: '17.5000', marketplace: 'US' },
    ]);
    const insights = await database.sql<{ id: string; profile_id: string | null; date: string; kind: string; route: string }[]>`
      select id, profile_id, date::text, kind, figures ->> 'route' as route from public.insights
       where org_id = ${orgId} and source = 'wizards-ai' order by kind`;
    expect(insights).toEqual([
      { id: FIXTURE_RANK_SIGNAL_ID, profile_id: null, date: '2026-09-24', kind: 'market_signal.bsr_degradation', route: 'weekly' },
      { id: FIXTURE_HERO_SIGNAL_ID, profile_id: profileId, date: '2026-09-24', kind: 'market_signal.buybox_lost', route: 'now' },
    ]);
    const marks = await database.sql<{ path: string; rules: unknown; source_tag_id: string }[]>`
      select path, rules, source_tag_id from public.insight_tag_marks where org_id = ${orgId} and source_tag_id is not null`;
    expect(marks).toHaveLength(7);
    expect(marks.every((mark) => mark.source_tag_id === uuid5(mark.path))).toBe(true);
    expect(new Set(marks.map((mark) => mark.rules))).toEqual(new Set(['3.off', '3.shadow']));
    const current = await database.sql<{ insight_id: string; path: string; stage: string }[]>`
      select insight_id, path, stage from public.insight_tags_current where org_id = ${orgId} and source_tag_id is not null order by path`;
    expect(current).toEqual([
      { insight_id: FIXTURE_HERO_SIGNAL_ID, path: 'signal/family/buybox', stage: 'live' },
      { insight_id: FIXTURE_HERO_SIGNAL_ID, path: 'signal/jev/confirmed', stage: 'shadow' },
      { insight_id: FIXTURE_HERO_SIGNAL_ID, path: 'signal/route/now', stage: 'live' },
    ]);
    const tags = await database.sql<{ n: number }[]>`
      with recursive tree as (
        select id from public.tags where org_id = ${orgId} and parent_id is null and slug = 'signal'
        union all select t.id from public.tags t join tree on t.parent_id = tree.id)
      select count(*)::integer as n from tree`;
    // Root, four namespaces (family, route, jev, band), five values.
    expect(tags[0]?.n).toBe(10);
  });

  it('changes no row when a file is skipped, re-read, or replayed after losing its position', async () => {
    const before = await snapshot();
    // Observations, events, insights, marks, the ten signal tags and the fixture's own tag.
    expect(before.length).toBe(6 + 2 + 2 + 7 + 10 + 1);
    // A fresh importer re-reads the file; the recorded position skips the batch.
    const same = importer();
    expect(await same.run()).toMatchObject({ filesSeen: 1, filesSkippedUnchanged: 0, batchesSeen: 1, batchesAlreadyImported: 1, batchesImported: 0 });
    // The same importer skips a file it read cleanly at the same size and time.
    expect(await same.run()).toMatchObject({ filesSeen: 1, filesSkippedUnchanged: 1, batchesSeen: 0 });
    expect(await same.run({ rescan: true })).toMatchObject({ batchesSeen: 1, batchesAlreadyImported: 1, batchesImported: 0 });
    // A rewrite of the same size is read again.
    const path = join(directory, '2026-09-25.ndjson');
    await utimes(path, new Date('2026-09-26T00:00:00Z'), new Date('2026-09-26T00:00:00Z'));
    expect(await same.run()).toMatchObject({ filesSkippedUnchanged: 0, batchesSeen: 1, batchesAlreadyImported: 1 });
    expect(await snapshot()).toEqual(before);

    await database.sql`delete from public.market_signals_import_state where org_id = ${orgId} and file_name = '2026-09-25.ndjson'`;
    const replay = await importer().run();
    expect(replay).toMatchObject({
      batchesImported: 1, observations: 6, observationsWritten: 0, observationsUnchanged: 6,
      priceEventsWritten: 0, priceEventsExisting: 2, signalsWritten: 0, signalsUnchanged: 2,
      tagMarksWritten: 0, tagMarksExisting: 7,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('lets the latest batch win and never lets an older snapshot overwrite it', async () => {
    await appendFile(join(directory, '2026-09-25.ndjson'), toNdjson(secondBatch()));
    const delta = await importer().run();
    expect(delta).toMatchObject({
      batchesSeen: 2, batchesAlreadyImported: 1, batchesImported: 1, signals: 1, signalsWritten: 1,
      tagMarks: 6, tagMarksWritten: 3, tagMarksExisting: 3, stateGeneratedAt: '2026-09-25T02:00:00Z',
    });
    const status = async () => (await database.sql<{ status: string; resolved_at: string | null }[]>`
      select figures ->> 'status' as status, figures ->> 'resolved_at' as resolved_at from public.insights where id = ${FIXTURE_HERO_SIGNAL_ID}`)[0];
    expect(await status()).toEqual({ status: 'resolved', resolved_at: '2026-09-25T03:00:00Z' });
    const current = await database.sql`select 1 from public.insight_tags_current where insight_id = ${FIXTURE_HERO_SIGNAL_ID}`;
    expect(current).toHaveLength(0);

    await writeFile(join(directory, 'full-2026-09-25.ndjson'), toNdjson(firstBatch()));
    const older = await importer().run();
    // The hero signal is newer in the store (blocked); the rank signal is the same batch time (unchanged).
    expect(older).toMatchObject({ filesSeen: 2, batchesAlreadyImported: 2, batchesImported: 1, signalsWritten: 0, signalsBlocked: 1, signalsUnchanged: 1, observationsWritten: 0 });
    expect(await status()).toEqual({ status: 'resolved', resolved_at: '2026-09-25T03:00:00Z' });
    const [position] = await database.sql<{ files: number; newest: boolean }[]>`
      select count(*)::integer as files, max(last_state_generated_at) = '2026-09-25T02:00:00Z'::timestamptz as newest
        from public.market_signals_import_state where org_id = ${orgId} and file_name like '%2026-09-25.ndjson'`;
    expect(position).toEqual({ files: 2, newest: true });
  });

  it('counts and skips invalid records, waits for an unfinished batch and refuses an unknown organisation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wp331-market-signals-invalid-'));
    try {
      const [header, ...records] = firstBatch();
      const broken = records.map((record, index) => index === 1 ? { ...record, bsr: -1 } : record);
      const lines = [JSON.stringify(header), '{not json', ...broken.slice(1).map((record) => JSON.stringify(record))];
      const [pending, ...pendingRecords] = secondBatch();
      const unfinished = `${JSON.stringify(pending)}\n`;
      await writeFile(join(dir, '2026-09-26.ndjson'), `${lines.join('\n')}\n${unfinished}`);
      await writeFile(join(dir, '2026-09-27.ndjson'), toNdjson(firstBatch('unknown-org')));
      const counts = await importer(dir).run();
      expect(counts).toMatchObject({
        filesSeen: 2, batchesSeen: 3, batchesImported: 1, batchesIncomplete: 1, batchesUnmappedOrg: 1,
        batchesCountMismatch: 0, invalidRecords: 2, observations: 4, signals: 2,
      });
      await appendFile(join(dir, '2026-09-26.ndjson'), toNdjson(pendingRecords));
      expect(await importer(dir).run()).toMatchObject({ batchesImported: 1, batchesAlreadyImported: 1, batchesIncomplete: 0, signals: 1 });
      // Without a map the single organisation takes only wizards-ai's default key.
      await writeFile(join(dir, '2026-09-28.ndjson'), toNdjson(firstBatch('ecom-wizards')));
      // Its other keys (two synthetic-org batches, one unknown-org batch) stay unmapped.
      const fallback = importer(dir, new Map());
      expect(await fallback.run()).toMatchObject({ batchesImported: 1, batchesUnmappedOrg: 3 });
      // Files with an unmapped batch are read again on every pass; the clean one is skipped.
      expect(await fallback.run()).toMatchObject({ filesSkippedUnchanged: 1, batchesUnmappedOrg: 3, batchesImported: 0 });
      // Once the key is mapped, its batch lands.
      const mapped = new Map([[FIXTURE_ORG_KEY, orgId], ['unknown-org', orgId]]);
      expect(await importer(dir, mapped).run()).toMatchObject({ batchesImported: 1, batchesAlreadyImported: 2, batchesUnmappedOrg: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs the --once CLI against a directory and prints counts only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wp331-market-signals-cli-'));
    try {
      // Positions are per file name: a name this organisation has not read yet.
      await writeFile(join(dir, '2026-09-29.ndjson'), toNdjson([...firstBatch(), ...secondBatch()]));
      const write = vi.fn();
      const error = vi.fn();
      const env = {
        OPENSPELL_MARKET_SIGNALS_DIR: dir, OPENSPELL_MARKET_SIGNALS_ORG_KEYS: `${FIXTURE_ORG_KEY}=${orgId}`,
        DATABASE_URL: database.connectionString,
      };
      // The real composition: its own pool from DATABASE_URL, closed afterwards.
      const code = await runMarketSignalsImportCli(['--once'], env, { write, error });
      expect(code).toBe(0);
      expect(error).not.toHaveBeenCalled();
      const printed = JSON.parse(String(write.mock.calls[0]![0])) as Record<string, unknown>;
      expect(printed).toMatchObject({ batchesImported: 2, invalidRecords: 0 });
      expect(Object.values(printed).every((value) => typeof value === 'number' || value === null || typeof value === 'string' && /^\d{4}-/.test(value))).toBe(true);
      expect(marketSignalsImportExitCode({ ...(printed as unknown as MarketSignalsImportCounts), invalidRecords: 1 })).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('holds back the rest of a file after a refused batch, goes on with other files and retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wp331-market-signals-refused-'));
    try {
      // Another organisation already owns an insight under the signal id: the batch cannot land.
      const otherOrg = randomUUID();
      const signalId = uuid5('Synthetic Store|DE|ASIN:B0SYNCLASH|bsr_degradation|2026-09-20T00:00Z');
      await database.sql`insert into public.orgs (id, slug, name) values (${otherOrg}, 'ms-other', 'Synthetic other org')`;
      await database.sql`insert into public.insights (id, org_id, date, kind, title, body)
        values (${signalId}, ${otherOrg}, '2026-09-20', 'daily', 'Synthetic', 'Synthetic')`;
      const [header, ...records] = firstBatch();
      const clash = records.map((record) => record['id'] === FIXTURE_RANK_SIGNAL_ID ? {
        ...record, id: signalId,
        tag_marks: (record['tag_marks'] as Record<string, unknown>[]).map((mark) => ({ ...mark, id: randomUUID().replace(/^(.{14})./, '$15') })),
      } : record);
      await writeFile(join(dir, '2026-09-20.ndjson'), toNdjson([
        { ...header, generated_at: '2026-09-20T02:00:00Z' }, ...clash,
        ...secondBatch().map((record) => record['kind'] === 'header' ? { ...record, generated_at: '2026-09-20T03:00:00Z' } : record),
      ]));
      await writeFile(join(dir, '2026-09-21.ndjson'), toNdjson(firstBatch().map((record) => record['kind'] === 'header' ? { ...record, generated_at: '2026-09-21T02:00:00Z' } : record)));
      const error = vi.fn();
      const run = new MarketSignalsImporter(database, new DirectoryBatchSource(dir), new Map([[FIXTURE_ORG_KEY, orgId]]), { error });
      expect(await run.run()).toMatchObject({ batchesFailed: 1, batchesImported: 1, batchesSeen: 2 });
      expect(error).toHaveBeenCalledExactlyOnceWith('Market signals batch failed', expect.objectContaining({ file: '2026-09-20.ndjson', code: '23503' }));
      const positions = await database.sql<{ file_name: string }[]>`select file_name from public.market_signals_import_state
        where org_id = ${orgId} and file_name in ('2026-09-20.ndjson', '2026-09-21.ndjson') order by 1`;
      expect(positions.map((row) => row.file_name)).toEqual(['2026-09-21.ndjson']);
      const kept = await database.sql`select 1 from public.insights where id = ${signalId} and org_id = ${orgId}`;
      expect(kept).toHaveLength(0);
      // Once the conflict is gone the same importer retries the file and takes both batches.
      await database.sql`delete from public.insights where id = ${signalId}`;
      expect(await run.run()).toMatchObject({ batchesFailed: 0, batchesImported: 2, filesSkippedUnchanged: 1 });
      expect(await database.sql`select 1 from public.insights where id = ${signalId} and org_id = ${orgId}`).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('counts an unreadable file and one of garbage, and still imports the next file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wp331-market-signals-corrupt-'));
    try {
      const orgE = randomUUID();
      await database.sql`insert into public.orgs (id, slug, name) values (${orgE}, 'ms-corrupt', 'Synthetic corrupt org')`;
      const restamp = (records: ReturnType<typeof firstBatch>) => records.map((record) => record['kind'] === 'header' ? { ...record, generated_at: '2026-09-23T02:00:00Z' } : record);
      await writeFile(join(dir, '2026-09-21.ndjson'), toNdjson(firstBatch()));
      await writeFile(join(dir, '2026-09-22.ndjson'), '\u0000\u0001 not json\n{"kind":"observation"}\n[1,2]\n');
      await writeFile(join(dir, '2026-09-23.ndjson'), toNdjson(restamp(firstBatch())));
      const directorySource = new DirectoryBatchSource(dir);
      const source = {
        list: () => directorySource.list(),
        read: (name: string) => name === '2026-09-21.ndjson' ? Promise.reject(Object.assign(new Error('synthetic read failure'), { code: 'EIO' })) : directorySource.read(name),
      };
      const error = vi.fn();
      const importer = new MarketSignalsImporter(database, source, new Map([[FIXTURE_ORG_KEY, orgE]]), { error });
      const counts = await importer.run();
      expect(counts).toMatchObject({ filesSeen: 3, filesFailed: 1, batchesImported: 1, invalidRecords: 3, observations: 6, signals: 2 });
      expect(error).toHaveBeenCalledExactlyOnceWith('Market signals file failed', expect.objectContaining({ file: '2026-09-21.ndjson', code: 'EIO' }));
      // The garbage lines reach /sync-status once; a re-read adds nothing, the failed file is retried.
      expect(await readMarketSignalsImportStatus(database, orgE)).toMatchObject({ files: 2, batchesImported: 1, invalidRecords: 3 });
      expect(await importer.run()).toMatchObject({ filesFailed: 1, filesSkippedUnchanged: 2, invalidRecords: 0 });
      expect(await importer.run({ rescan: true })).toMatchObject({ filesFailed: 1, invalidRecords: 0, batchesAlreadyImported: 1 });
      expect((await readMarketSignalsImportStatus(database, orgE))?.invalidRecords).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
