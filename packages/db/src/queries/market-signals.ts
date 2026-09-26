/**
 * Persistence for the wizards-ai `market-signals/2` import (WP-331).
 *
 * Every write is an upsert keyed by the export's stable identity, so replaying
 * a file changes no row, and nothing here deletes a row because a later export
 * lacks it. The worker composes these inside one transaction per batch.
 */
import { createHash } from 'node:crypto';
import type {
  MarketSignalsImportStatus,
  MarketSignalsObservation,
  MarketSignalsProfileMapRow,
  MarketSignalsTagMark,
} from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';

export const MARKET_SIGNALS_ROW_SOURCE = 'wizards-ai' as const;
const CHUNK = 1_000;

export interface UpsertCounts {
  offered: number;
  written: number;
  unchanged: number;
}

function counted(offered: number, written: number): UpsertCounts {
  const unchanged = offered - written;
  if (unchanged < 0) throw new Error(`upsert accounting failed: offered ${offered}, written ${written}`);
  return { offered, written, unchanged };
}

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += CHUNK) out.push(rows.slice(index, index + CHUNK));
  return out;
}

/** At most two organisation ids, oldest first: enough to tell "exactly one". */
export async function marketSignalsOrgCandidates(handle: QueryHandle): Promise<string[]> {
  const rows = await handle.sql<{ id: string }[]>`select id from public.orgs order by created_at, id limit 2`;
  return rows.map((row) => row.id);
}

export async function marketSignalsOrgExists(handle: QueryHandle, orgId: string): Promise<boolean> {
  const rows = await handle.sql<{ id: string }[]>`select id from public.orgs where id = ${orgId}::uuid`;
  return rows.length === 1;
}

/**
 * Observations become `keepa_bsr_observations` rows with source `wizards-ai`.
 * A row keepa.sync already wrote under the same key is left alone and counted unchanged.
 */
export async function upsertMarketSignalsObservations(
  handle: QueryHandle,
  orgId: string,
  observations: readonly MarketSignalsObservation[],
): Promise<UpsertCounts> {
  let written = 0;
  for (const chunk of chunks(observations)) {
    const encoded = JSON.stringify(chunk.map((row) => ({
      marketplace: row.marketplace, asin: row.asin, observed_at: row.observed_at, category: row.category,
      bsr: row.bsr, price: row.price, buy_box_price: row.buy_box_price, rating: row.rating,
      review_count: row.review_count, offer_count: row.offer_count,
    })));
    const rows = await handle.sql<{ id: number }[]>`
      insert into public.keepa_bsr_observations as o
        (org_id, marketplace, asin, observed_at, category, bsr, price, buy_box_price, rating,
         review_count, offer_count, source)
      select ${orgId}::uuid, r.marketplace, r.asin, r.observed_at, r.category, r.bsr, r.price, r.buy_box_price,
             r.rating, r.review_count, r.offer_count, ${MARKET_SIGNALS_ROW_SOURCE}
        from jsonb_to_recordset(${encoded}::text::jsonb) as r(
          marketplace text, asin text, observed_at timestamptz, category text, bsr integer, price numeric,
          buy_box_price numeric, rating numeric, review_count integer, offer_count integer)
      on conflict (org_id, marketplace, asin, category, observed_at) do update
        set bsr = excluded.bsr, price = excluded.price, buy_box_price = excluded.buy_box_price,
            rating = excluded.rating, review_count = excluded.review_count, offer_count = excluded.offer_count,
            source = excluded.source
      -- A keepa.sync row at the same key stays keepa.sync's, with its deal and coupon state.
      where o.source = excluded.source
        and (o.bsr, o.price, o.buy_box_price, o.rating, o.review_count, o.offer_count, o.source)
        is distinct from (excluded.bsr, excluded.price, excluded.buy_box_price, excluded.rating,
          excluded.review_count, excluded.offer_count, excluded.source)
      returning o.id
    `;
    written += rows.length;
  }
  return counted(observations.length, written);
}

export interface MarketSignalsHistoryPoint {
  marketplace: string;
  asin: string;
  observedAt: Date;
  category: string;
  price: number | null;
  buyBoxPrice: number | null;
}

/** Imported observations of the given listings, oldest first. */
export async function loadMarketSignalsObservationHistory(
  handle: QueryHandle,
  orgId: string,
  listings: readonly { marketplace: string; asin: string }[],
): Promise<MarketSignalsHistoryPoint[]> {
  if (listings.length === 0) return [];
  const rows = await handle.sql<{
    marketplace: string; asin: string; observed_ms: string; category: string;
    price: string | null; buy_box_price: string | null;
  }[]>`
    select o.marketplace, o.asin, (extract(epoch from o.observed_at) * 1000)::bigint::text as observed_ms,
           o.category, o.price::text, o.buy_box_price::text
      from public.keepa_bsr_observations o
      join jsonb_to_recordset(${JSON.stringify(listings)}::text::jsonb) as l(marketplace text, asin text)
        on l.marketplace = o.marketplace and l.asin = o.asin
     where o.org_id = ${orgId}::uuid and o.source = ${MARKET_SIGNALS_ROW_SOURCE}
     order by o.marketplace, o.asin, o.observed_at, o.id
  `;
  return rows.map((row) => ({
    marketplace: row.marketplace,
    asin: row.asin,
    observedAt: new Date(Number(row.observed_ms)),
    category: row.category,
    price: row.price === null ? null : Number(row.price),
    buyBoxPrice: row.buy_box_price === null ? null : Number(row.buy_box_price),
  }));
}

export interface MarketSignalsPriceEvent {
  asin: string;
  eventKind: 'price_drop' | 'price_restore' | 'deal_start' | 'deal_end' | 'coupon_start' | 'coupon_end';
  detectedAt: Date;
  price: number | null;
  baselinePrice: number | null;
  details: Record<string, unknown>;
}

export async function insertMarketSignalsPriceEvents(
  handle: QueryHandle,
  orgId: string,
  events: readonly MarketSignalsPriceEvent[],
): Promise<UpsertCounts> {
  let written = 0;
  for (const chunk of chunks(events)) {
    const encoded = JSON.stringify(chunk.map((event) => ({
      asin: event.asin, event_kind: event.eventKind, detected_at: event.detectedAt.toISOString(),
      price: event.price, baseline_price: event.baselinePrice, details: event.details,
    })));
    const rows = await handle.sql<{ id: number }[]>`
      insert into public.competitor_price_events
        (org_id, asin, event_kind, detected_at, price, baseline_price, details, source)
      select ${orgId}::uuid, r.asin, r.event_kind, r.detected_at, r.price, r.baseline_price, r.details,
             ${MARKET_SIGNALS_ROW_SOURCE}
        from jsonb_to_recordset(${encoded}::text::jsonb) as r(
          asin text, event_kind text, detected_at timestamptz, price numeric, baseline_price numeric, details jsonb)
      on conflict (org_id, asin, event_kind, detected_at) do nothing
      returning id
    `;
    written += rows.length;
  }
  return counted(events.length, written);
}

/** wizards-ai profile keys mapped to this organisation's profiles. */
export async function lookupMarketSignalsProfiles(
  handle: QueryHandle,
  orgId: string,
  profileKeys: readonly string[],
): Promise<Map<string, string>> {
  if (profileKeys.length === 0) return new Map();
  const rows = await handle.sql<{ profile_key: string; profile_id: string }[]>`
    select profile_key, profile_id from public.market_signals_profile_map
     where org_id = ${orgId}::uuid and profile_key = any(${[...new Set(profileKeys)]}::text[])
  `;
  return new Map(rows.map((row) => [row.profile_key, row.profile_id]));
}

export interface MarketSignalsInsightRow {
  id: string;
  profileId: string | null;
  date: string;
  kind: string;
  title: string;
  body: string;
  /** Must carry `batch_generated_at`; an older batch never overwrites a newer one. */
  figures: Record<string, unknown> & { batch_generated_at: string };
}

export interface InsightUpsertCounts {
  offered: number;
  /** New, or content changed. */
  written: number;
  /** A newer batch with the same content: only the batch time moved. */
  advanced: number;
  /** Older than the stored batch: refused. */
  blocked: number;
  /** The stored batch itself again. */
  unchanged: number;
}

/**
 * Signals become `insights` rows (id = signal id). Only a strictly newer batch
 * touches a stored row, so replaying a batch changes nothing and an older
 * snapshot read later never overwrites a newer state.
 */
export async function upsertMarketSignalsInsights(
  handle: QueryHandle,
  orgId: string,
  insights: readonly MarketSignalsInsightRow[],
): Promise<InsightUpsertCounts> {
  const counts: InsightUpsertCounts = { offered: insights.length, written: 0, advanced: 0, blocked: 0, unchanged: 0 };
  for (const chunk of chunks(insights)) {
    const encoded = JSON.stringify(chunk.map((row) => ({
      id: row.id, profile_id: row.profileId, date: row.date, kind: row.kind,
      title: row.title, body: row.body, figures: row.figures,
    })));
    // Every sub-statement sees the rows as they were before the upsert.
    const rows = await handle.sql<{ outcome: 'written' | 'advanced' | 'blocked' | 'unchanged' }[]>`
      with incoming as (
        select * from jsonb_to_recordset(${encoded}::text::jsonb) as r(
          id uuid, profile_id uuid, date date, kind text, title text, body text, figures jsonb)
      ), previous as (
        select i.id, (i.figures ->> 'batch_generated_at')::timestamptz as batch,
               (i.profile_id, i.date, i.kind, i.title, i.body, i.figures - 'batch_generated_at') as content
          from public.insights i join incoming r on r.id = i.id
      ), upserted as (
        insert into public.insights as i (id, org_id, profile_id, date, kind, title, body, figures, source)
        select r.id, ${orgId}::uuid, r.profile_id, r.date, r.kind, r.title, r.body, r.figures, ${MARKET_SIGNALS_ROW_SOURCE}
          from incoming r
        on conflict (id) do update
          set profile_id = excluded.profile_id, date = excluded.date, kind = excluded.kind,
              title = excluded.title, body = excluded.body, figures = excluded.figures
        where i.source = excluded.source and i.org_id = excluded.org_id
          and coalesce((i.figures ->> 'batch_generated_at')::timestamptz, '-infinity')
            < (excluded.figures ->> 'batch_generated_at')::timestamptz
        returning i.id, (i.profile_id, i.date, i.kind, i.title, i.body, i.figures - 'batch_generated_at') as content
      )
      select case
               when u.id is not null and (p.id is null or p.content is distinct from u.content) then 'written'
               when u.id is not null then 'advanced'
               when p.batch > (r.figures ->> 'batch_generated_at')::timestamptz then 'blocked'
               else 'unchanged'
             end as outcome
        from incoming r left join previous p on p.id = r.id left join upserted u on u.id = r.id
    `;
    if (rows.length !== chunk.length) throw new Error(`insight upsert accounting failed: offered ${chunk.length}, classified ${rows.length}`);
    for (const row of rows) counts[row.outcome] += 1;
  }
  return counts;
}

/** `signal/<namespace>/<value>` to its three tag names, root first. */
export function marketSignalsTagLevels(path: string): [string, string, string] {
  const parts = path.split('/');
  if (parts.length !== 3 || parts[0] !== 'signal' || !parts[1] || !parts[2]) {
    throw new Error('A market signal tag path is signal/<namespace>/<value>');
  }
  return [parts[0], parts[1], parts[2]];
}

/** A stable slug from one path segment; underscores stay so values cannot collide. */
export function marketSignalsTagSlug(segment: string): string {
  const slug = segment.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `x-${createHash('sha1').update(segment, 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * Arcana tags for signal paths, keyed by (org, path): a `signal` root, one
 * child per namespace, one leaf per value. Existing tags are reused.
 */
export async function ensureMarketSignalsTags(
  handle: QueryHandle,
  orgId: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  async function ensure(parentId: string | null, name: string, key: string): Promise<string> {
    const known = ids.get(key);
    if (known) return known;
    // A sibling already holding the slug under another name gets a suffixed slug,
    // so two values never share one tag.
    const base = marketSignalsTagSlug(name);
    for (const slug of [base, `${base}-${createHash('sha1').update(name, 'utf8').digest('hex').slice(0, 8)}`]) {
      await handle.sql`
        insert into public.tags (org_id, parent_id, name, slug)
        values (${orgId}::uuid, ${parentId}::uuid, ${name}, ${slug})
        on conflict (org_id, parent_id, slug) do nothing
      `;
      const rows = await handle.sql<{ id: string; name: string }[]>`
        select id, name from public.tags
         where org_id = ${orgId}::uuid and parent_id is not distinct from ${parentId}::uuid and slug = ${slug}
      `;
      const row = rows[0];
      if (!row || rows.length !== 1) throw new Error('Market signal tag could not be resolved');
      if (row.name !== name) {
        if (slug === base) continue;
        throw new Error('Market signal tag slug is taken twice');
      }
      ids.set(key, row.id);
      return row.id;
    }
    throw new Error('Market signal tag could not be resolved');
  }
  const leaves = new Map<string, string>();
  for (const path of [...new Set(paths)].sort()) {
    const [root, namespace, value] = marketSignalsTagLevels(path);
    const rootId = await ensure(null, root, root);
    const namespaceId = await ensure(rootId, namespace, `${root}/${namespace}`);
    leaves.set(path, await ensure(namespaceId, value, path));
  }
  return leaves;
}

export interface MarketSignalsTagMarkRow extends MarketSignalsTagMark {
  insightId: string;
  arcanaTagId: string;
}

/** Append-only: a mark id already stored is left exactly as it is. */
export async function insertInsightTagMarks(
  handle: QueryHandle,
  orgId: string,
  marks: readonly MarketSignalsTagMarkRow[],
): Promise<UpsertCounts> {
  let written = 0;
  for (const chunk of chunks(marks)) {
    const encoded = JSON.stringify(chunk.map((mark) => ({
      id: mark.id, insight_id: mark.insightId, tag_id: mark.arcanaTagId, path: mark.path, op: mark.op,
      at: mark.at, source: mark.source, stage: mark.stage, rules: mark.rules, source_tag_id: mark.tag_id,
    })));
    const rows = await handle.sql<{ id: string }[]>`
      insert into public.insight_tag_marks
        (id, org_id, insight_id, tag_id, path, op, at, source, stage, rules, source_tag_id)
      select r.id, ${orgId}::uuid, r.insight_id, r.tag_id, r.path, r.op, r.at, r.source, r.stage, r.rules,
             r.source_tag_id
        from jsonb_to_recordset(${encoded}::text::jsonb) as r(
          id uuid, insight_id uuid, tag_id uuid, path text, op text, at timestamptz, source text, stage text,
          rules jsonb, source_tag_id text)
      on conflict (id) do nothing
      returning id
    `;
    written += rows.length;
  }
  return counted(marks.length, written);
}

export interface MarketSignalsFileState {
  orgId: string;
  fileBytes: number;
  /** Null when only invalid lines outside batches were recorded for the file. */
  lastGeneratedAt: Date | null;
  orphanLines: number;
}

export async function readMarketSignalsFileStates(
  handle: QueryHandle,
  fileName: string,
): Promise<MarketSignalsFileState[]> {
  const rows = await handle.sql<{ org_id: string; file_bytes: string; last_generated_ms: string | null; orphan_lines: string }[]>`
    select org_id, file_bytes::text, (extract(epoch from last_generated_at) * 1000)::bigint::text as last_generated_ms,
           orphan_lines::text
      from public.market_signals_import_state
     where file_name = ${fileName}
  `;
  return rows.map((row) => ({
    orgId: row.org_id,
    fileBytes: Number(row.file_bytes),
    lastGeneratedAt: row.last_generated_ms === null ? null : new Date(Number(row.last_generated_ms)),
    orphanLines: Number(row.orphan_lines),
  }));
}

/**
 * Invalid lines outside any batch belong to no organisation; each organisation
 * reading the file records them once. A re-read adds only lines not seen before.
 * Returns the lines newly added to this organisation's invalid count.
 */
export async function recordMarketSignalsOrphanLines(
  handle: QueryHandle,
  input: { orgId: string; fileName: string; orphanLines: number },
): Promise<number> {
  const [row] = await handle.sql<{ added: string }[]>`
    with before as (
      select orphan_lines from public.market_signals_import_state
       where org_id = ${input.orgId}::uuid and file_name = ${input.fileName}
    ), upserted as (
      insert into public.market_signals_import_state as s (org_id, file_name, file_bytes, invalid_records, orphan_lines)
      values (${input.orgId}::uuid, ${input.fileName}, 0, ${input.orphanLines}, ${input.orphanLines})
      on conflict (org_id, file_name) do update
        set invalid_records = s.invalid_records + (excluded.orphan_lines - s.orphan_lines),
            orphan_lines = excluded.orphan_lines
      where excluded.orphan_lines > s.orphan_lines
      returning orphan_lines
    )
    select coalesce((select u.orphan_lines from upserted u) - coalesce((select b.orphan_lines from before b), 0), 0)::text as added
  `;
  return Number(row?.added ?? 0);
}

export interface MarketSignalsBatchRecord {
  orgId: string;
  fileName: string;
  /** Bytes of the file up to the end of this batch. */
  fileBytes: number;
  generatedAt: string;
  stateGeneratedAt: string | null;
  observations: number;
  changePoints: number;
  signals: number;
  tagMarks: number;
  invalidRecords: number;
  unmappedSignals: number;
}

/** Advance one organisation's position in one file and add the batch's totals. */
export async function recordMarketSignalsBatch(handle: QueryHandle, batch: MarketSignalsBatchRecord): Promise<void> {
  const rows = await handle.sql<{ org_id: string }[]>`
    insert into public.market_signals_import_state as s
      (org_id, file_name, file_bytes, last_generated_at, last_state_generated_at, batches_imported,
       observations, change_points, signals, tag_marks, invalid_records, unmapped_signals)
    values (${batch.orgId}::uuid, ${batch.fileName}, ${batch.fileBytes}, ${batch.generatedAt}::timestamptz,
      ${batch.stateGeneratedAt}::timestamptz, 1, ${batch.observations}, ${batch.changePoints}, ${batch.signals},
      ${batch.tagMarks}, ${batch.invalidRecords}, ${batch.unmappedSignals})
    on conflict (org_id, file_name) do update
      set file_bytes = excluded.file_bytes,
          last_generated_at = greatest(s.last_generated_at, excluded.last_generated_at),
          last_state_generated_at = greatest(s.last_state_generated_at, excluded.last_state_generated_at),
          batches_imported = s.batches_imported + 1,
          observations = s.observations + excluded.observations,
          change_points = s.change_points + excluded.change_points,
          signals = s.signals + excluded.signals,
          tag_marks = s.tag_marks + excluded.tag_marks,
          invalid_records = s.invalid_records + excluded.invalid_records,
          unmapped_signals = s.unmapped_signals + excluded.unmapped_signals
    returning org_id
  `;
  if (rows.length !== 1) throw new Error('Market signals import position was not recorded');
}

/** After a file is read with every batch accounted for, each organisation's position covers its bytes. */
export async function markMarketSignalsFileRead(handle: QueryHandle, fileName: string, fileBytes: number): Promise<number> {
  const rows = await handle.sql<{ org_id: string }[]>`
    update public.market_signals_import_state set file_bytes = ${fileBytes}
     where file_name = ${fileName} and file_bytes <> ${fileBytes}
    returning org_id
  `;
  return rows.length;
}

/** Totals for /sync-status and the Market position "data as of" line; null before any import. */
export async function readMarketSignalsImportStatus(
  handle: QueryHandle,
  orgId: string,
): Promise<MarketSignalsImportStatus | null> {
  const [row] = await handle.sql<{
    files: number; batches: string | null; observations: string | null; change_points: string | null;
    signals: string | null; tag_marks: string | null; invalid_records: string | null;
    unmapped_signals: string | null; data_as_of: string | null; last_imported_at: string | null;
  }[]>`
    select count(*)::integer as files, sum(batches_imported)::text as batches,
           sum(observations)::text as observations, sum(change_points)::text as change_points,
           sum(signals)::text as signals, sum(tag_marks)::text as tag_marks,
           sum(invalid_records)::text as invalid_records, sum(unmapped_signals)::text as unmapped_signals,
           to_char(max(last_state_generated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as data_as_of,
           to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_imported_at
      from public.market_signals_import_state where org_id = ${orgId}::uuid
  `;
  if (!row || row.files === 0) return null;
  return {
    files: row.files,
    batchesImported: Number(row.batches ?? 0),
    observations: Number(row.observations ?? 0),
    changePoints: Number(row.change_points ?? 0),
    signals: Number(row.signals ?? 0),
    tagMarks: Number(row.tag_marks ?? 0),
    invalidRecords: Number(row.invalid_records ?? 0),
    unmappedSignals: Number(row.unmapped_signals ?? 0),
    dataAsOf: row.data_as_of,
    lastImportedAt: row.last_imported_at,
  };
}

export class MarketSignalsMapError extends Error {
  constructor(message: string, readonly reason: 'org_not_found' | 'profile_not_found' | 'profile_ambiguous' | 'invalid_key') {
    super(message);
  }
}

/**
 * Map a wizards-ai profile key to one profile of the organisation, an owner's
 * operator act run with the service connection. Signals already imported under
 * the key take the profile, and one audit row records the change.
 */
export async function mapMarketSignalsProfile(
  handle: DbHandle,
  input: { orgSlug: string; profileKey: string; profile: string },
): Promise<{ row: MarketSignalsProfileMapRow; insightsAttached: number }> {
  const profileKey = input.profileKey.trim();
  if (!profileKey || profileKey.length > 200) throw new MarketSignalsMapError('A profile key is 1 to 200 characters', 'invalid_key');
  return handle.sql.begin(async (sql) => {
    const orgs = await sql<{ id: string }[]>`select id from public.orgs where slug = ${input.orgSlug}`;
    const orgId = orgs[0]?.id;
    if (!orgId) throw new MarketSignalsMapError('No organisation has that slug', 'org_not_found');
    const profiles = await sql<{ id: string }[]>`
      select id from public.ad_profiles
       where org_id = ${orgId}::uuid
         and (id::text = ${input.profile} or amazon_profile_id = ${input.profile}
           or coalesce(account_name, amazon_profile_id) = ${input.profile})
    `;
    if (profiles.length === 0) throw new MarketSignalsMapError('No profile of that organisation matches', 'profile_not_found');
    if (profiles.length > 1) throw new MarketSignalsMapError(`${profiles.length} profiles match; pass the profile id`, 'profile_ambiguous');
    const profileId = profiles[0]!.id;
    const [row] = await sql<{ id: string; created_at: Date; updated_at: Date }[]>`
      insert into public.market_signals_profile_map (org_id, profile_key, profile_id)
      values (${orgId}::uuid, ${profileKey}, ${profileId}::uuid)
      on conflict (org_id, profile_key) do update set profile_id = excluded.profile_id
      returning id, created_at, updated_at
    `;
    if (!row) throw new Error('Market signals profile map row was not written');
    const attached = await sql<{ id: string }[]>`
      update public.insights set profile_id = ${profileId}::uuid
       where org_id = ${orgId}::uuid and source = ${MARKET_SIGNALS_ROW_SOURCE}
         and figures ->> 'profile_key' = ${profileKey} and profile_id is distinct from ${profileId}::uuid
      returning id
    `;
    await sql`
      insert into public.audit_log (org_id, actor_type, action, target_type, target_id, payload, source)
      values (${orgId}::uuid, 'service', 'market_signals.profile_mapped', 'market_signals_profile_map', ${row.id},
        ${JSON.stringify({ profileKey, profileId, insightsAttached: attached.length })}::text::jsonb, 'worker-cli')
    `;
    return {
      row: {
        orgId, profileKey, profileId,
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
      },
      insightsAttached: attached.length,
    };
  }) as Promise<{ row: MarketSignalsProfileMapRow; insightsAttached: number }>;
}
