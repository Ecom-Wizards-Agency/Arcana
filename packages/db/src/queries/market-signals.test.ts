import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySqlFile, createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asServiceRole, asUser } from '../testing/rls.js';
import { latestKeepaObservations, listHomeInsights } from './keepa.js';
import { readMarketRankSeries } from './market-position.js';
import {
  MarketSignalsMapError,
  ensureMarketSignalsTags,
  insertInsightTagMarks,
  mapMarketSignalsProfile,
  marketSignalsTagSlug,
  readMarketSignalsFileStates,
  readMarketSignalsImportStatus,
  recordMarketSignalsBatch,
  recordMarketSignalsOrphanLines,
  upsertMarketSignalsInsights,
  upsertMarketSignalsObservations,
} from './market-signals.js';

const available = await databaseAvailable();
const MIGRATION = '20260926110000_market_signals_import.sql';
const BEFORE = '20260926100000_spapi_binding_reporting.sql';
const migrationPath = fileURLToPath(new URL(`../../../../supabase/migrations/${MIGRATION}`, import.meta.url));

const USER_A = '31111111-1111-4111-8111-111111111111';
const USER_B = '32222222-2222-4222-8222-222222222222';
const uuid5ish = () => { const id = randomUUID(); return `${id.slice(0, 14)}5${id.slice(15)}`; };

function observation(marketplace: string, asin: string, observedAt: string, bsr: number) {
  return {
    kind: 'observation' as const, id: uuid5ish(), org_key: 'synthetic-org', profile_key: null, marketplace, asin,
    role: 'competitor' as const, observed_at: observedAt, category: '11', bsr, price: 10, rating: null,
    review_count: null, buy_box_price: 9.5, offer_count: 2,
  };
}

describe.skipIf(!available)('market signals migration upgrade', () => {
  let database: TestDatabase;
  const orgs = { single: randomUUID(), mixed: randomUUID(), bare: randomUUID() };

  beforeAll(async () => {
    database = await createTestDatabase('ms_upgrade', { throughMigration: BEFORE, applyFixture: false });
    for (const [slug, id] of Object.entries(orgs)) {
      await database.sql`insert into public.orgs (id, slug, name) values (${id}, ${`ms-${slug}`}, 'Synthetic upgrade org')`;
    }
    const [connection] = await database.sql<{ id: string }[]>`
      insert into public.ads_connections (org_id, label) values (${orgs.mixed}, 'Synthetic') returning id`;
    const [single] = await database.sql<{ id: string }[]>`
      insert into public.ads_connections (org_id, label) values (${orgs.single}, 'Synthetic') returning id`;
    // One country twice; two countries with the German profile created first.
    await database.sql`insert into public.ad_profiles
      (org_id, connection_id, amazon_profile_id, region, country_code, currency_code, timezone, created_at) values
      (${orgs.single}, ${single!.id}, 'ms-single-1', 'NA', 'US', 'USD', 'UTC', '2026-01-02'),
      (${orgs.single}, ${single!.id}, 'ms-single-2', 'NA', 'US', 'USD', 'UTC', '2026-01-01'),
      (${orgs.mixed}, ${connection!.id}, 'ms-mixed-de', 'EU', 'DE', 'EUR', 'UTC', '2026-01-01'),
      (${orgs.mixed}, ${connection!.id}, 'ms-mixed-us', 'NA', 'US', 'USD', 'UTC', '2026-01-02')`;
    const inserted = await database.sql`insert into public.keepa_bsr_observations (org_id, asin, observed_at, category, bsr, lightning_deal, coupon) values
      (${orgs.single}, 'B0SYNUPG01', '2026-09-01T00:00:00Z', '11', 10, true, '[500, 0]'::jsonb),
      (${orgs.mixed}, 'B0SYNUPG01', '2026-09-01T00:00:00Z', '11', 20, null, null),
      (${orgs.bare}, 'B0SYNUPG01', '2026-09-01T00:00:00Z', '11', 30, null, null) returning id`;
    expect(inserted).toHaveLength(3);
    await database.sql`insert into public.competitor_price_events (org_id, asin, event_kind, detected_at)
      values (${orgs.single}, 'B0SYNUPG02', 'price_drop', '2026-09-01T00:00:00Z')`;
    await applySqlFile(database, migrationPath);
  }, 120_000);
  afterAll(async () => { await database?.drop(); });

  it('backfills the marketplace by the stated rule and marks every existing row as Arcana', async () => {
    const rows = await database.sql<{ org_id: string; marketplace: string | null; source: string; offer_count: number | null }[]>`
      select org_id, marketplace, source, offer_count from public.keepa_bsr_observations order by bsr`;
    expect(rows).toEqual([
      { org_id: orgs.single, marketplace: 'US', source: 'arcana', offer_count: null },
      { org_id: orgs.mixed, marketplace: 'DE', source: 'arcana', offer_count: null },
      { org_id: orgs.bare, marketplace: null, source: 'arcana', offer_count: null },
    ]);
    const events = await database.sql<{ source: string }[]>`select source from public.competitor_price_events`;
    expect(events).toEqual([{ source: 'arcana' }]);
  });

  it('keys observations by marketplace and keeps the ASIN lookup index', async () => {
    const indexes = await database.sql<{ indexname: string; indexdef: string }[]>`
      select indexname, indexdef from pg_catalog.pg_indexes
       where schemaname = 'public' and tablename = 'keepa_bsr_observations' order by indexname`;
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));
    expect(byName.get('keepa_bsr_observations_key')).toContain('UNIQUE');
    expect(byName.get('keepa_bsr_observations_key')).toContain('(org_id, marketplace, asin, category, observed_at) NULLS NOT DISTINCT');
    expect(byName.get('keepa_bsr_observations_asin_idx')).toContain('(org_id, asin, category, observed_at)');
    const load = await upsertMarketSignalsObservations(database, orgs.single, [
      observation('US', 'B0SYNUPG01', '2026-09-01T00:00:00Z', 11),
      observation('DE', 'B0SYNUPG01', '2026-09-01T00:00:00Z', 12),
    ]);
    // keepa.sync's backfilled US row keeps its key, values, source and deal state; the German listing is new.
    expect(load).toEqual({ offered: 2, written: 1, unchanged: 1 });
    const rows = await database.sql<{ marketplace: string; bsr: number; source: string; lightning_deal: boolean | null; coupon: unknown }[]>`
      select marketplace, bsr, source, lightning_deal, coupon from public.keepa_bsr_observations where org_id = ${orgs.single} order by marketplace`;
    expect(rows).toEqual([
      { marketplace: 'DE', bsr: 12, source: 'wizards-ai', lightning_deal: null, coupon: null },
      { marketplace: 'US', bsr: 10, source: 'arcana', lightning_deal: true, coupon: [500, 0] },
    ]);
    // keepa.sync's previous-row lookup still finds its own row, and never the German one.
    const previous = await latestKeepaObservations(database, orgs.single, ['B0SYNUPG01'], 'US');
    expect(previous).toHaveLength(1);
    expect(previous[0]).toMatchObject({ lightningDeal: true, coupon: [500, 0], observedAt: new Date('2026-09-01T00:00:00Z') });
    expect(await latestKeepaObservations(database, orgs.single, ['B0SYNUPG01'], 'DE')).toEqual([]);
  });
});

describe.skipIf(!available)('market signals persistence', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;

  beforeAll(async () => {
    database = await createTestDatabase('ms_persist');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`select app.seed_tenant_fixture('msalpha', ${USER_A}, 'analyst')`;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`select app.seed_tenant_fixture('msbravo', ${USER_B}, 'owner')`;
    orgA = a!.seed_tenant_fixture;
    orgB = b!.seed_tenant_fixture;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgA} order by created_at limit 1`;
    profileA = profile!.id;
  }, 120_000);
  afterAll(async () => { await database?.drop(); });

  async function signalInsight(orgId: string, id: string, generatedAt: string, status = 'open', profileKey = 'synthetic-us') {
    return upsertMarketSignalsInsights(database, orgId, [{
      id, profileId: null, date: '2026-09-24', kind: 'market_signal.buybox_lost',
      title: 'Buy Box held by another seller', body: 'Buy Box held by another seller',
      figures: { status, profile_key: profileKey, batch_generated_at: generatedAt },
    }]);
  }

  it('upserts a signal insight only from a strictly newer batch and never lets an older one back', async () => {
    const id = randomUUID();
    const outcome = (written: number, advanced: number, blocked: number, unchanged: number) => ({ offered: 1, written, advanced, blocked, unchanged });
    expect(await signalInsight(orgA, id, '2026-09-25T02:00:00Z')).toEqual(outcome(1, 0, 0, 0));
    // The same batch again touches nothing.
    expect(await signalInsight(orgA, id, '2026-09-25T02:00:00Z')).toEqual(outcome(0, 0, 0, 1));
    const [first] = await database.sql<{ xmin: string }[]>`select xmin::text from public.insights where id = ${id}`;
    // A later batch with the same content only moves the batch time forward...
    expect(await signalInsight(orgA, id, '2026-09-25T03:00:00Z')).toEqual(outcome(0, 1, 0, 0));
    const [second] = await database.sql<{ xmin: string }[]>`select xmin::text from public.insights where id = ${id}`;
    expect(second?.xmin).not.toBe(first?.xmin);
    // ...so a snapshot taken between the two, read afterwards, cannot bring back its state.
    expect(await signalInsight(orgA, id, '2026-09-25T02:30:00Z', 'resolved')).toEqual(outcome(0, 0, 1, 0));
    expect(await signalInsight(orgA, id, '2026-09-25T04:00:00Z', 'resolved')).toEqual(outcome(1, 0, 0, 0));
    expect(await signalInsight(orgA, id, '2026-09-25T03:30:00Z', 'open')).toEqual(outcome(0, 0, 1, 0));
    const [row] = await database.sql<{ status: string; batch: string; source: string }[]>`
      select figures ->> 'status' as status, figures ->> 'batch_generated_at' as batch, source from public.insights where id = ${id}`;
    expect(row).toEqual({ status: 'resolved', batch: '2026-09-25T04:00:00Z', source: 'wizards-ai' });
  });

  it('folds tag marks into current tags, remove winning a tie, and keeps marks append-only', async () => {
    const insight = randomUUID();
    await signalInsight(orgA, insight, '2026-09-25T02:00:00Z');
    const tags = await ensureMarketSignalsTags(database, orgA, ['signal/family/buybox', 'signal/route/now', 'signal/jev/confirmed', 'signal/band/4']);
    expect(tags.size).toBe(4);
    const again = await ensureMarketSignalsTags(database, orgA, ['signal/family/buybox']);
    expect(again.get('signal/family/buybox')).toBe(tags.get('signal/family/buybox'));
    const tree = await database.sql<{ path: string }[]>`
      select concat_ws('/', r.slug, n.slug, l.slug) as path
        from public.tags l join public.tags n on n.id = l.parent_id join public.tags r on r.id = n.parent_id
       where l.org_id = ${orgA} and r.parent_id is null and r.slug = 'signal' order by 1`;
    expect(tree.map((row) => row.path)).toEqual(['signal/band/4', 'signal/family/buybox', 'signal/jev/confirmed', 'signal/route/now']);
    const mark = (path: string, op: 'add' | 'remove', at: string, stage: 'live' | 'shadow' = 'live') => ({
      id: randomUUID(), tag_id: randomUUID(), path, op, at, source: 'rule' as const, stage, rules: '3.off',
      insightId: insight, arcanaTagId: tags.get(path)!,
    });
    const marks = [
      mark('signal/family/buybox', 'add', '2026-09-25T01:00:00Z'),
      mark('signal/route/now', 'add', '2026-09-25T01:00:00Z'),
      mark('signal/route/now', 'remove', '2026-09-25T02:00:00Z'),
      mark('signal/jev/confirmed', 'add', '2026-09-25T01:00:00Z', 'shadow'),
      mark('signal/band/4', 'add', '2026-09-25T01:00:00Z'),
      mark('signal/band/4', 'remove', '2026-09-25T01:00:00Z'),
    ];
    expect(await insertInsightTagMarks(database, orgA, marks)).toEqual({ offered: 6, written: 6, unchanged: 0 });
    expect(await insertInsightTagMarks(database, orgA, marks)).toEqual({ offered: 6, written: 0, unchanged: 6 });
    const current = await database.sql<{ path: string; stage: string; rules: unknown }[]>`
      select c.path, c.stage, m.rules from public.insight_tags_current c
        join public.insight_tag_marks m on m.insight_id = c.insight_id and m.tag_id = c.tag_id and m.op = 'add'
       where c.insight_id = ${insight} order by c.path`;
    expect(current).toEqual([
      { path: 'signal/family/buybox', stage: 'live', rules: '3.off' },
      { path: 'signal/jev/confirmed', stage: 'shadow', rules: '3.off' },
    ]);
    await expect(database.sql`update public.insight_tag_marks set op = 'remove' where insight_id = ${insight}`)
      .rejects.toMatchObject({ code: '23514' });
    await expect(database.sql`delete from public.insight_tag_marks where insight_id = ${insight}`)
      .rejects.toMatchObject({ code: '23514' });
    await database.sql`delete from public.insights where id = ${insight}`;
    const [left] = await database.sql<{ n: number }[]>`select count(*)::integer as n from public.insight_tag_marks where insight_id = ${insight}`;
    expect(left?.n).toBe(0);
  });

  it('keeps the profile map owner/admin-written and marks, state and the view tenant-scoped', async () => {
    await asUser(database, USER_A, async (sql) => {
      const maps = await sql<{ org_id: string }[]>`select org_id from public.market_signals_profile_map`;
      expect(maps.map((row) => row.org_id)).toEqual([orgA]);
      const marks = await sql<{ org_id: string }[]>`select distinct org_id from public.insight_tag_marks`;
      expect(marks.map((row) => row.org_id)).toEqual([orgA]);
      const view = await sql<{ org_id: string }[]>`select distinct org_id from public.insight_tags_current`;
      expect(view.map((row) => row.org_id)).toEqual([orgA]);
      const state = await sql<{ org_id: string }[]>`select org_id from public.market_signals_import_state`;
      expect(state.map((row) => row.org_id)).toEqual([orgA]);
    });
    // The analyst may not map a profile, nor write the worker's position.
    await expect(asUser(database, USER_A, (sql) => sql`insert into public.market_signals_profile_map (org_id, profile_key, profile_id)
      values (${orgA}, 'analyst-key', ${profileA})`)).rejects.toMatchObject({ code: '42501' });
    await expect(asUser(database, USER_A, (sql) => sql`insert into public.market_signals_import_state (org_id, file_name, file_bytes, last_generated_at)
      values (${orgA}, 'analyst.ndjson', 0, now())`)).rejects.toMatchObject({ code: '42501' });
    // The analyst may add a mark in their organisation, never in another.
    const [[insightA], [tagA], [insightB], [tagB]] = await Promise.all([
      database.sql<{ id: string }[]>`select id from public.insights where org_id = ${orgA} limit 1`,
      database.sql<{ id: string }[]>`select id from public.tags where org_id = ${orgA} limit 1`,
      database.sql<{ id: string }[]>`select id from public.insights where org_id = ${orgB} limit 1`,
      database.sql<{ id: string }[]>`select id from public.tags where org_id = ${orgB} limit 1`,
    ]);
    const added = await asUser(database, USER_A, (sql) => sql`insert into public.insight_tag_marks
      (id, org_id, insight_id, tag_id, path, op, at, source, stage)
      values (${randomUUID()}, ${orgA}, ${insightA!.id}, ${tagA!.id}, 'signal/label/checked', 'add', now(), 'human', 'live') returning id`);
    expect(added).toHaveLength(1);
    await expect(asUser(database, USER_A, (sql) => sql`insert into public.insight_tag_marks
      (id, org_id, insight_id, tag_id, path, op, at, source, stage)
      values (${randomUUID()}, ${orgB}, ${insightB!.id}, ${tagB!.id}, 'signal/label/checked', 'add', now(), 'human', 'live')`))
      .rejects.toMatchObject({ code: '42501' });
    // The owner of B maps a key in B; the service role sees both organisations.
    const [profileB] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgB} limit 1`;
    const mapped = await asUser(database, USER_B, (sql) => sql`insert into public.market_signals_profile_map (org_id, profile_key, profile_id)
      values (${orgB}, 'owner-key', ${profileB!.id}) returning id`);
    expect(mapped).toHaveLength(1);
    const all = await asServiceRole(database, (sql) => sql<{ n: number }[]>`
      select count(distinct org_id)::integer as n from public.market_signals_profile_map`);
    expect(all[0]?.n).toBe(2);
  });

  it('maps a profile key by label, attaches its imported signals and audits the change', async () => {
    const [org] = await database.sql<{ slug: string }[]>`select slug from public.orgs where id = ${orgA}`;
    const [profile] = await database.sql<{ label: string }[]>`
      select coalesce(account_name, amazon_profile_id) as label from public.ad_profiles where id = ${profileA}`;
    const waiting = randomUUID();
    await signalInsight(orgA, waiting, '2026-09-25T02:00:00Z', 'open', 'synthetic-map');
    const result = await mapMarketSignalsProfile(database, { orgSlug: org!.slug, profileKey: 'synthetic-map', profile: profile!.label });
    expect(result.row).toMatchObject({ orgId: orgA, profileKey: 'synthetic-map', profileId: profileA });
    expect(result.insightsAttached).toBe(1);
    const [insight] = await database.sql<{ profile_id: string }[]>`select profile_id from public.insights where id = ${waiting}`;
    expect(insight?.profile_id).toBe(profileA);
    const again = await mapMarketSignalsProfile(database, { orgSlug: org!.slug, profileKey: 'synthetic-map', profile: profileA });
    expect(again.insightsAttached).toBe(0);
    const audits = await database.sql<{ n: number }[]>`select count(*)::integer as n from public.audit_log
      where org_id = ${orgA} and action = 'market_signals.profile_mapped'`;
    expect(audits[0]?.n).toBe(2);
    await expect(mapMarketSignalsProfile(database, { orgSlug: 'no-such-org', profileKey: 'k', profile: 'p' }))
      .rejects.toMatchObject({ reason: 'org_not_found' });
    await expect(mapMarketSignalsProfile(database, { orgSlug: org!.slug, profileKey: 'k', profile: 'no-such-profile' }))
      .rejects.toBeInstanceOf(MarketSignalsMapError);
  });

  it('records invalid lines outside batches once per file and organisation', async () => {
    const orgD = randomUUID();
    await database.sql`insert into public.orgs (id, slug, name) values (${orgD}, 'ms-orphans', 'Synthetic orphan org')`;
    const record = (orphanLines: number) => recordMarketSignalsOrphanLines(database, { orgId: orgD, fileName: '2026-09-22.ndjson', orphanLines });
    expect(await record(3)).toBe(3);
    expect(await record(3)).toBe(0);
    expect(await record(5)).toBe(2);
    expect(await record(4)).toBe(0);
    const states = await readMarketSignalsFileStates(database, '2026-09-22.ndjson');
    expect(states).toEqual([{ orgId: orgD, fileBytes: 0, lastGeneratedAt: null, orphanLines: 5 }]);
    expect(await readMarketSignalsImportStatus(database, orgD)).toMatchObject({ files: 1, batchesImported: 0, invalidRecords: 5, dataAsOf: null });
    // A batch landing later keeps the orphan count and gains a position.
    await recordMarketSignalsBatch(database, { orgId: orgD, fileName: '2026-09-22.ndjson', fileBytes: 10, generatedAt: '2026-09-22T01:00:00Z',
      stateGeneratedAt: '2026-09-22T00:00:00Z', observations: 1, changePoints: 0, signals: 0, tagMarks: 0, invalidRecords: 1, unmappedSignals: 0 });
    expect(await readMarketSignalsImportStatus(database, orgD)).toMatchObject({ batchesImported: 1, invalidRecords: 6, dataAsOf: '2026-09-22T00:00:00.000Z' });
  });

  it('reports import totals and data-as-of only after an import', async () => {
    const orgC = randomUUID();
    await database.sql`insert into public.orgs (id, slug, name) values (${orgC}, 'ms-status', 'Synthetic status org')`;
    expect(await readMarketSignalsImportStatus(database, orgC)).toBeNull();
    const base = { orgId: orgC, fileBytes: 10, observations: 3, changePoints: 4, signals: 2, tagMarks: 5, invalidRecords: 1, unmappedSignals: 1 };
    await recordMarketSignalsBatch(database, { ...base, fileName: '2026-09-25.ndjson', generatedAt: '2026-09-25T02:00:00Z', stateGeneratedAt: '2026-09-25T01:00:00Z' });
    await recordMarketSignalsBatch(database, { ...base, fileName: '2026-09-25.ndjson', generatedAt: '2026-09-25T03:00:00Z', stateGeneratedAt: '2026-09-25T02:00:00Z' });
    await recordMarketSignalsBatch(database, { ...base, fileName: 'full-2026-09-24.ndjson', generatedAt: '2026-09-24T09:00:00Z', stateGeneratedAt: null });
    const status = await readMarketSignalsImportStatus(database, orgC);
    expect(status).toMatchObject({
      files: 2, batchesImported: 3, observations: 9, changePoints: 12, signals: 6, tagMarks: 15,
      invalidRecords: 3, unmappedSignals: 3, dataAsOf: '2026-09-25T02:00:00.000Z',
    });
    expect(status?.lastImportedAt).not.toBeNull();
  });

  it('includes imported rows in the Home insights and Market position reads', async () => {
    const id = randomUUID();
    await upsertMarketSignalsInsights(database, orgA, [{
      id, profileId: profileA, date: '2026-06-14', kind: 'market_signal.out_of_stock', title: 'Out of stock',
      body: 'Out of stock', figures: { status: 'open', batch_generated_at: '2026-06-14T02:00:00Z' },
    }]);
    const home = await listHomeInsights(database, { orgId: orgA, profileId: profileA, start: '2026-06-14', end: '2026-06-14' });
    expect(home.filter((row) => row.source === 'wizards-ai').map((row) => row.id)).toEqual([id]);

    await upsertMarketSignalsObservations(database, orgA, [
      observation('US', 'B0SYNREAD1', '2026-06-14T05:00:00Z', 700),
      observation('DE', 'B0SYNREAD1', '2026-06-14T06:00:00Z', 900),
    ]);
    const all = await readMarketRankSeries(database, orgA, ['B0SYNREAD1'], '2026-06-14', '2026-06-14');
    expect(all.flatMap((series) => series.points.map((point) => point.bsr))).toEqual([900]);
    const us = await readMarketRankSeries(database, orgA, ['B0SYNREAD1'], '2026-06-14', '2026-06-14', 'US');
    expect(us.flatMap((series) => series.points.map((point) => point.bsr))).toEqual([700]);
  });

  it('gives a value whose slug a differently named sibling holds its own tag', async () => {
    const first = await ensureMarketSignalsTags(database, orgA, ['signal/label/a_b']);
    const [parent] = await database.sql<{ parent_id: string }[]>`select parent_id from public.tags where id = ${first.get('signal/label/a_b')!}`;
    await database.sql`insert into public.tags (org_id, parent_id, name, slug) values (${orgA}, ${parent!.parent_id}, 'Operator note', 'x_y')`;
    const second = await ensureMarketSignalsTags(database, orgA, ['signal/label/x_y', 'signal/label/a_b']);
    expect(second.get('signal/label/a_b')).toBe(first.get('signal/label/a_b'));
    const [leaf] = await database.sql<{ name: string; slug: string }[]>`select name, slug from public.tags where id = ${second.get('signal/label/x_y')!}`;
    expect(leaf?.name).toBe('x_y');
    expect(leaf?.slug).toMatch(/^x_y-[0-9a-f]{8}$/);
    // Both slugs held by other names: refused rather than reusing a foreign tag.
    const suffixed = `p_q-${createHash('sha1').update('p_q', 'utf8').digest('hex').slice(0, 8)}`;
    await database.sql`insert into public.tags (org_id, parent_id, name, slug) values
      (${orgA}, ${parent!.parent_id}, 'Operator note', 'p_q'),
      (${orgA}, ${parent!.parent_id}, 'Another note', ${suffixed})`;
    await expect(ensureMarketSignalsTags(database, orgA, ['signal/label/p_q'])).rejects.toThrow('taken twice');
  });

  it('slugs path segments without collapsing underscores', () => {
    expect(['buybox', 'hero_holder_not_ours', 'Hero Holder', '4', '---'].map(marketSignalsTagSlug))
      .toEqual(['buybox', 'hero_holder_not_ours', 'hero-holder', '4', expect.stringMatching(/^x-[0-9a-f]{12}$/)]);
  });
});
