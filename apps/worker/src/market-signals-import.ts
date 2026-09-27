/**
 * WP-331: import wizards-ai's `market-signals/2` export.
 *
 * wizards-ai is the only process that calls Keepa. Its hourly pass appends a
 * batch to `<UTC date>.ndjson` in a directory this worker can read; this pass
 * lists the directory, reads files in date order and batches in file order,
 * and upserts every record by its stable identity. Replaying a file changes no
 * row, the latest batch wins, and nothing is deleted because a later export
 * lacks it. The batch source is an interface so push delivery can replace the
 * directory reader later.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DbHandle, QueryHandle } from '@wizard-ads/db';
import {
  ensureMarketSignalsTags,
  insertInsightTagMarks,
  insertMarketSignalsPriceEvents,
  loadMarketSignalsObservationHistory,
  lookupMarketSignalsProfiles,
  markMarketSignalsFileRead,
  marketSignalsOrgCandidates,
  marketSignalsOrgExists,
  readMarketSignalsFileStates,
  recordMarketSignalsBatch,
  recordMarketSignalsOrphanLines,
  upsertMarketSignalsInsights,
  upsertMarketSignalsObservations,
} from '@wizard-ads/db/worker';
import type {
  MarketSignalsHistoryPoint,
  MarketSignalsInsightRow,
  MarketSignalsPriceEvent,
  MarketSignalsTagMarkRow,
} from '@wizard-ads/db/worker';
import type { KeepaProduct, ObservationPoint } from '@wizard-ads/keepa-api';
import {
  MarketSignalsChangePoint,
  MarketSignalsHeader,
  MarketSignalsObservation,
  MarketSignalsSignal,
} from '@wizard-ads/shared';
import type { MarketSignalsImportCounts } from '@wizard-ads/shared';
import { detectForProduct } from './keepa.js';

export const MARKET_SIGNALS_DIR_ENV = 'OPENSPELL_MARKET_SIGNALS_DIR';
export const MARKET_SIGNALS_ORG_KEYS_ENV = 'OPENSPELL_MARKET_SIGNALS_ORG_KEYS';
/** wizards-ai's default `market_signals.arcana.org_key`. */
export const DEFAULT_MARKET_SIGNALS_ORG_KEY = 'ecom-wizards';
export const MARKET_SIGNALS_IMPORT_INTERVAL_MS = 15 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ndjson$/;
const FILE_DATE = /(\d{4}-\d{2}-\d{2})/;

export interface MarketSignalsImportConfig {
  /** Unset means the import is off. */
  directory: string | null;
  /** `org_key` to Arcana organisation id. Empty when the variable is unset. */
  orgKeys: ReadonlyMap<string, string>;
}

/** Non-secret settings. A malformed org-key map fails startup rather than importing into a guess. */
export function marketSignalsImportConfigFromEnv(env: NodeJS.ProcessEnv): MarketSignalsImportConfig {
  const directory = env[MARKET_SIGNALS_DIR_ENV]?.trim() || null;
  const orgKeys = new Map<string, string>();
  const raw = env[MARKET_SIGNALS_ORG_KEYS_ENV]?.trim();
  if (raw) {
    for (const entry of raw.split(',')) {
      const separator = entry.indexOf('=');
      const key = entry.slice(0, separator).trim();
      const orgId = entry.slice(separator + 1).trim().toLowerCase();
      if (separator < 1 || !key || !UUID.test(orgId) || orgKeys.has(key)) {
        throw new Error(`${MARKET_SIGNALS_ORG_KEYS_ENV} must be key=uuid[,key=uuid] with unique keys`);
      }
      orgKeys.set(key, orgId);
    }
  }
  return { directory, orgKeys };
}

// ---------------------------------------------------------------------------
// Batch source
// ---------------------------------------------------------------------------

export interface MarketSignalsFile {
  name: string;
  bytes: number;
  modifiedMs: number;
}

/** Where batches come from. A directory now; a push inbox can implement the same two calls. */
export interface MarketSignalsBatchSource {
  list(): Promise<MarketSignalsFile[]>;
  read(name: string): Promise<Buffer>;
}

export class DirectoryBatchSource implements MarketSignalsBatchSource {
  constructor(private readonly directory: string) {}

  async list(): Promise<MarketSignalsFile[]> {
    const names = (await readdir(this.directory)).filter((name) => FILE_NAME.test(name) && FILE_DATE.test(name));
    const files: MarketSignalsFile[] = [];
    for (const name of names) {
      const info = await stat(join(this.directory, name));
      if (info.isFile()) files.push({ name, bytes: info.size, modifiedMs: info.mtimeMs });
    }
    return sortMarketSignalsFiles(files);
  }

  read(name: string): Promise<Buffer> {
    if (!FILE_NAME.test(name)) return Promise.reject(new Error('Unsafe market signals file name'));
    return readFile(join(this.directory, name));
  }
}

/** Date order; on one date the day file (`<date>.ndjson`) before snapshots, then by name. */
export function sortMarketSignalsFiles<T extends { name: string }>(files: readonly T[]): T[] {
  const key = (name: string) => [FILE_DATE.exec(name)?.[1] ?? '', /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name) ? '0' : '1', name] as const;
  return [...files].sort((left, right) => {
    const a = key(left.name);
    const b = key(right.name);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index]! < b[index]!) return -1;
      if (a[index]! > b[index]!) return 1;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface ParsedBatch {
  header: MarketSignalsHeader;
  observations: MarketSignalsObservation[];
  changePoints: MarketSignalsChangePoint[];
  signals: MarketSignalsSignal[];
  /** Record lines after the header, valid or not. */
  lines: number;
  invalid: number;
  /** Byte offset just past the batch's last complete line. */
  endOffset: number;
  /** Fewer lines than the header counts and nothing after it: still being written. */
  incomplete: boolean;
  countMismatch: boolean;
}

export interface ParsedFile {
  batches: ParsedBatch[];
  /** Invalid lines outside any valid batch, including every record under an invalid header. */
  orphanInvalid: number;
  /** Bytes of complete lines; a trailing partial line is left for the next pass. */
  completeBytes: number;
}

/** Split one NDJSON file into validated batches. Invalid lines are counted, never thrown. */
export function parseMarketSignalsFile(content: Buffer): ParsedFile {
  const batches: ParsedBatch[] = [];
  let current: ParsedBatch | null = null;
  let orphanInvalid = 0;
  let offset = 0;
  let underInvalidHeader = false;
  while (offset < content.length) {
    const newline = content.indexOf(0x0a, offset);
    if (newline === -1) break;
    const text = content.subarray(offset, newline).toString('utf8').trim();
    offset = newline + 1;
    if (!text) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    const kind = typeof value === 'object' && value !== null ? (value as { kind?: unknown }).kind : undefined;
    if (kind === 'header') {
      const header = MarketSignalsHeader.safeParse(value);
      if (!header.success) {
        current = null;
        underInvalidHeader = true;
        orphanInvalid += 1;
        continue;
      }
      underInvalidHeader = false;
      current = {
        header: header.data, observations: [], changePoints: [], signals: [], lines: 0, invalid: 0,
        endOffset: offset, incomplete: false, countMismatch: false,
      };
      batches.push(current);
      continue;
    }
    if (current === null || underInvalidHeader) {
      orphanInvalid += 1;
      continue;
    }
    current.lines += 1;
    current.endOffset = offset;
    const orgKey = (value as { org_key?: unknown } | undefined)?.org_key;
    if (orgKey !== current.header.org_key) {
      current.invalid += 1;
      continue;
    }
    if (kind === 'observation') {
      const parsed = MarketSignalsObservation.safeParse(value);
      if (parsed.success && storable(parsed.data)) current.observations.push(parsed.data); else current.invalid += 1;
    } else if (kind === 'change_point') {
      const parsed = MarketSignalsChangePoint.safeParse(value);
      if (parsed.success) current.changePoints.push(parsed.data); else current.invalid += 1;
    } else if (kind === 'signal') {
      const parsed = MarketSignalsSignal.safeParse(value);
      if (parsed.success) current.signals.push(parsed.data); else current.invalid += 1;
    } else {
      current.invalid += 1;
    }
  }
  for (const [index, batch] of batches.entries()) {
    const { counts } = batch.header;
    const expected = counts.observation + counts.change_point + counts.signal;
    const last = index === batches.length - 1;
    batch.incomplete = last && batch.lines < expected;
    batch.countMismatch = !batch.incomplete && (batch.lines !== expected || (batch.invalid === 0 && (
      batch.observations.length !== counts.observation
      || batch.changePoints.length !== counts.change_point
      || batch.signals.length !== counts.signal)));
  }
  return { batches, orphanInvalid, completeBytes: offset };
}

const MAX_MONEY = 1e10; // numeric(14, 4)
const MAX_INTEGER = 2_147_483_647;

/** Values the contract allows but `keepa_bsr_observations` cannot hold make the record invalid. */
function storable(observation: MarketSignalsObservation): boolean {
  return [observation.price, observation.buy_box_price].every((value) => value === null || value < MAX_MONEY)
    && [observation.bsr, observation.review_count, observation.offer_count].every((value) => value === null || value <= MAX_INTEGER);
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const ADDED_FIGURES = [
  'status', 'band', 'route', 'family', 'holder', 'hero', 'resolved_at',
  'marketplace', 'asin', 'profile_key', 'batch_generated_at',
] as const;

/**
 * A signal as an insight: id = signal id, date = UTC date of onset, kind
 * `market_signal.<issue_type>`, title and body from the summary. Figures are
 * the signal's evidence plus its state; an evidence key the state would
 * overwrite with a different value is kept as `figures_<key>`.
 */
export function signalInsightRow(
  signal: MarketSignalsSignal,
  profileId: string | null,
  batchGeneratedAt: string,
): MarketSignalsInsightRow {
  const added: Record<(typeof ADDED_FIGURES)[number], unknown> = {
    status: signal.status, band: signal.band, route: signal.route, family: signal.family,
    holder: signal.holder, hero: signal.hero, resolved_at: signal.resolved_at,
    marketplace: signal.marketplace, asin: signal.asin, profile_key: signal.profile_key,
    batch_generated_at: batchGeneratedAt,
  };
  const figures: Record<string, unknown> = { ...signal.figures };
  for (const key of ADDED_FIGURES) {
    if (key in figures && JSON.stringify(figures[key]) !== JSON.stringify(added[key])) figures[`figures_${key}`] = figures[key];
    figures[key] = added[key];
  }
  return {
    id: signal.id,
    profileId,
    date: signal.onset_at.slice(0, 10),
    kind: `market_signal.${signal.issue_type}`,
    title: signal.summary,
    body: signal.summary,
    figures: figures as MarketSignalsInsightRow['figures'],
  };
}

const PRICE_EVENT_TRACKS = new Set(['buybox_price', 'new_price']);

/** Keepa series from imported observations: a point wherever the value changed, no-offer dropped. */
function series(points: readonly MarketSignalsHistoryPoint[], pick: (point: MarketSignalsHistoryPoint) => number | null): ObservationPoint<number>[] {
  const out: ObservationPoint<number>[] = [];
  for (const [index, point] of points.entries()) {
    const value = pick(point);
    if (value === null) continue;
    if (index > 0 && pick(points[index - 1]!) === value) continue;
    out.push({ observedAt: point.observedAt, value });
  }
  return out;
}

/**
 * Competitor price events for one imported observation, decided by keepa.sync's
 * own rule: the listing's history up to it becomes a Keepa product and the
 * preceding observation the previous record.
 */
export function detectImportedPriceEvents(history: readonly MarketSignalsHistoryPoint[], index: number): MarketSignalsPriceEvent[] {
  const current = history[index];
  const prior = history[index - 1];
  if (!current || !prior) return [];
  const upTo = history.slice(0, index + 1);
  const product: KeepaProduct = {
    asin: current.asin,
    category: current.category,
    categoryName: null,
    updatedAt: current.observedAt,
    salesRank: [],
    newPrice: series(upTo, (point) => point.price),
    buyBoxPrice: series(upTo, (point) => point.buyBoxPrice),
    rating: [],
    reviewCount: [],
    lightningDeal: null,
    coupon: null,
  };
  // keepa.sync stores the last value with an offer (Keepa's no-offer points are
  // dropped), so the previous record carries the same, not the prior row's null.
  const lastWithOffer = (pick: (point: MarketSignalsHistoryPoint) => number | null) =>
    history.slice(0, index).map(pick).filter((value): value is number => value !== null).at(-1) ?? null;
  const previous = {
    asin: prior.asin, observedAt: prior.observedAt, category: prior.category,
    price: lastWithOffer((point) => point.price), buyBoxPrice: lastWithOffer((point) => point.buyBoxPrice),
    lightningDeal: null, coupon: null,
  };
  return detectForProduct(product, previous, current.observedAt).map((event) => ({
    ...event,
    details: { ...event.details, marketplace: current.marketplace, source: 'market-signals/2' },
  }));
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function emptyMarketSignalsCounts(): MarketSignalsImportCounts {
  return {
    filesSeen: 0, filesSkippedUnchanged: 0, filesFailed: 0, batchesSeen: 0, batchesImported: 0, batchesAlreadyImported: 0,
    batchesIncomplete: 0, batchesCountMismatch: 0, batchesUnmappedOrg: 0, batchesFailed: 0,
    observations: 0, observationsWritten: 0, observationsUnchanged: 0,
    changePoints: 0, changePointsWithoutObservation: 0, priceEventsWritten: 0, priceEventsExisting: 0,
    signals: 0, signalsWritten: 0, signalsAdvanced: 0, signalsBlocked: 0, signalsUnchanged: 0, unmappedSignals: 0,
    tagMarks: 0, tagMarksWritten: 0, tagMarksExisting: 0, invalidRecords: 0, stateGeneratedAt: null,
  };
}

export function addMarketSignalsCounts(total: MarketSignalsImportCounts, run: MarketSignalsImportCounts): MarketSignalsImportCounts {
  const out = { ...total };
  for (const key of Object.keys(run) as (keyof MarketSignalsImportCounts)[]) {
    if (key === 'stateGeneratedAt') continue;
    out[key] = (total[key] as number) + (run[key] as number);
  }
  out.stateGeneratedAt = latest(total.stateGeneratedAt, run.stateGeneratedAt);
  return out;
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function lastById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((row) => [row.id, row])).values()];
}

export interface MarketSignalsImporterOptions {
  /** Read every file, even one this importer read cleanly at the same size and time. */
  rescan?: boolean;
}

export class MarketSignalsImporter {
  private readonly orgCache = new Map<string, string | null>();
  /** Files read with every batch accounted for, by size and modification time. */
  private readonly cleanFiles = new Map<string, { bytes: number; modifiedMs: number }>();

  constructor(
    private readonly handle: DbHandle,
    private readonly source: MarketSignalsBatchSource,
    private readonly orgKeys: ReadonlyMap<string, string>,
    private readonly logger: Pick<MarketSignalsImportLogger, 'error'> = console,
  ) {}

  async run(options: MarketSignalsImporterOptions = {}): Promise<MarketSignalsImportCounts> {
    const counts = emptyMarketSignalsCounts();
    this.orgCache.clear();
    for (const file of await this.source.list()) {
      counts.filesSeen += 1;
      const known = this.cleanFiles.get(file.name);
      if (!options.rescan && known?.bytes === file.bytes && known.modifiedMs === file.modifiedMs) {
        counts.filesSkippedUnchanged += 1;
        continue;
      }
      try {
        if (await this.importFile(file, counts)) this.cleanFiles.set(file.name, { bytes: file.bytes, modifiedMs: file.modifiedMs });
        else this.cleanFiles.delete(file.name);
      } catch (error) {
        // An unreadable file, or a database error outside a batch: this file waits
        // for the next pass and the others go on. Imported batches keep their counts.
        counts.filesFailed += 1;
        this.cleanFiles.delete(file.name);
        this.logger.error('Market signals file failed', {
          file: file.name,
          error: error instanceof Error ? error.name : 'unknown',
          code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null,
        });
      }
    }
    return counts;
  }

  /** One file; true when every batch in it is accounted for. */
  private async importFile(file: MarketSignalsFile, counts: MarketSignalsImportCounts): Promise<boolean> {
    const states = await readMarketSignalsFileStates(this.handle, file.name);
    const positions = new Map(states.flatMap((state) =>
      state.lastGeneratedAt === null ? [] : [[state.orgId, state.lastGeneratedAt.getTime()] as const]));
    const parsed = parseMarketSignalsFile(await this.source.read(file.name));
    // A file with a batch still to take is read again on the next pass.
    let clean = true;
    const orgsInFile = new Set<string>();
    for (const batch of parsed.batches) {
      counts.batchesSeen += 1;
      if (batch.incomplete) {
        counts.batchesIncomplete += 1;
        clean = false;
        break;
      }
      const orgId = await this.resolveOrg(batch.header.org_key);
      if (orgId === null) {
        counts.batchesUnmappedOrg += 1;
        clean = false;
        continue;
      }
      orgsInFile.add(orgId);
      const generatedAt = Date.parse(batch.header.generated_at);
      const position = positions.get(orgId);
      if (position !== undefined && generatedAt <= position) {
        counts.batchesAlreadyImported += 1;
        continue;
      }
      try {
        await this.importBatch(orgId, file.name, batch, counts);
      } catch (error) {
        // Nothing of the batch was kept. Later batches of this file wait, so the
        // position never passes it.
        counts.batchesFailed += 1;
        clean = false;
        this.logger.error('Market signals batch failed', {
          file: file.name, generatedAt: batch.header.generated_at,
          error: error instanceof Error ? error.name : 'unknown',
          code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : null,
        });
        break;
      }
      if (batch.countMismatch) counts.batchesCountMismatch += 1;
      positions.set(orgId, generatedAt);
    }
    if (parsed.orphanInvalid > 0) {
      // Lines outside any batch name no organisation: record them for the
      // organisations whose batches the file holds, else every one the import maps.
      const targets = orgsInFile.size > 0 ? [...orgsInFile] : await this.mappedOrgs();
      let added = 0;
      for (const orgId of targets) {
        added = Math.max(added, await recordMarketSignalsOrphanLines(this.handle, { orgId, fileName: file.name, orphanLines: parsed.orphanInvalid }));
      }
      counts.invalidRecords += targets.length > 0
        ? added
        : Math.max(0, parsed.orphanInvalid - Math.max(0, ...states.map((state) => state.orphanLines)));
    }
    if (clean) await markMarketSignalsFileRead(this.handle, file.name, parsed.completeBytes);
    return clean;
  }

  /** Organisations the configuration can import into. */
  private async mappedOrgs(): Promise<string[]> {
    if (this.orgKeys.size > 0) {
      const orgs: string[] = [];
      for (const key of this.orgKeys.keys()) {
        const orgId = await this.resolveOrg(key);
        if (orgId !== null && !orgs.includes(orgId)) orgs.push(orgId);
      }
      return orgs;
    }
    const single = await this.resolveOrg(DEFAULT_MARKET_SIGNALS_ORG_KEY);
    return single === null ? [] : [single];
  }

  /** The explicit map first; without one, the only organisation when the key is the default. */
  private async resolveOrg(orgKey: string): Promise<string | null> {
    if (this.orgCache.has(orgKey)) return this.orgCache.get(orgKey)!;
    let orgId: string | null = null;
    if (this.orgKeys.size > 0) {
      const mapped = this.orgKeys.get(orgKey);
      orgId = mapped !== undefined && await marketSignalsOrgExists(this.handle, mapped) ? mapped : null;
    } else if (orgKey === DEFAULT_MARKET_SIGNALS_ORG_KEY) {
      const candidates = await marketSignalsOrgCandidates(this.handle);
      orgId = candidates.length === 1 ? candidates[0]! : null;
    }
    this.orgCache.set(orgKey, orgId);
    return orgId;
  }

  private async importBatch(orgId: string, fileName: string, batch: ParsedBatch, counts: MarketSignalsImportCounts): Promise<void> {
    const observations = lastById(batch.observations);
    const signals = lastById(batch.signals);
    const batchCounts = await this.handle.sql.begin(async (sql) => {
      const tx: QueryHandle = { sql };
      const observationLoad = await upsertMarketSignalsObservations(tx, orgId, observations);
      const events = await this.priceEvents(tx, orgId, batch.changePoints);
      const eventLoad = await insertMarketSignalsPriceEvents(tx, orgId, events.events);

      const profiles = await lookupMarketSignalsProfiles(tx, orgId,
        signals.flatMap((signal) => signal.profile_key === null ? [] : [signal.profile_key]));
      const unmappedSignals = signals.filter((signal) => signal.profile_key === null || !profiles.has(signal.profile_key)).length;
      const insightLoad = await upsertMarketSignalsInsights(tx, orgId, signals.map((signal) =>
        signalInsightRow(signal, signal.profile_key === null ? null : profiles.get(signal.profile_key) ?? null, batch.header.generated_at)));

      const marks = lastById(signals.flatMap((signal) => signal.tag_marks.map((mark) => ({ ...mark, insightId: signal.id }))));
      const tags = await ensureMarketSignalsTags(tx, orgId, marks.map((mark) => mark.path));
      const markLoad = await insertInsightTagMarks(tx, orgId, marks.map((mark): MarketSignalsTagMarkRow => ({
        ...mark, arcanaTagId: tags.get(mark.path)!,
      })));

      await recordMarketSignalsBatch(tx, {
        orgId, fileName, fileBytes: batch.endOffset,
        generatedAt: batch.header.generated_at, stateGeneratedAt: batch.header.state_generated_at,
        observations: batch.observations.length, changePoints: batch.changePoints.length,
        signals: batch.signals.length, tagMarks: marks.length, invalidRecords: batch.invalid, unmappedSignals,
      });
      return { observationLoad, events, eventLoad, insightLoad, unmappedSignals, marks: marks.length, markLoad };
    });
    counts.batchesImported += 1;
    counts.observations += batch.observations.length;
    counts.observationsWritten += batchCounts.observationLoad.written;
    counts.observationsUnchanged += batch.observations.length - batchCounts.observationLoad.written;
    counts.changePoints += batch.changePoints.length;
    counts.changePointsWithoutObservation += batchCounts.events.withoutObservation;
    counts.priceEventsWritten += batchCounts.eventLoad.written;
    counts.priceEventsExisting += batchCounts.eventLoad.unchanged + batchCounts.events.duplicates;
    counts.signals += batch.signals.length;
    counts.signalsWritten += batchCounts.insightLoad.written;
    counts.signalsAdvanced += batchCounts.insightLoad.advanced;
    counts.signalsBlocked += batchCounts.insightLoad.blocked;
    // Duplicate ids within the batch count with the unchanged.
    counts.signalsUnchanged += batch.signals.length - batchCounts.insightLoad.written
      - batchCounts.insightLoad.advanced - batchCounts.insightLoad.blocked;
    counts.unmappedSignals += batchCounts.unmappedSignals;
    counts.tagMarks += batchCounts.marks;
    counts.tagMarksWritten += batchCounts.markLoad.written;
    counts.tagMarksExisting += batchCounts.markLoad.unchanged;
    counts.invalidRecords += batch.invalid;
    counts.stateGeneratedAt = latest(counts.stateGeneratedAt, batch.header.state_generated_at);
  }

  /** Competitor Buy Box and new-price change points, each decided at its observation. */
  private async priceEvents(
    tx: QueryHandle,
    orgId: string,
    changePoints: readonly MarketSignalsChangePoint[],
  ): Promise<{ events: MarketSignalsPriceEvent[]; withoutObservation: number; duplicates: number }> {
    const relevant = changePoints.filter((point) => point.role === 'competitor' && PRICE_EVENT_TRACKS.has(point.track));
    if (relevant.length === 0) return { events: [], withoutObservation: 0, duplicates: 0 };
    const listingKey = (marketplace: string, asin: string) => `${marketplace}|${asin}`;
    const listings = new Map(relevant.map((point) => [listingKey(point.marketplace, point.asin), { marketplace: point.marketplace, asin: point.asin }]));
    const history = new Map<string, MarketSignalsHistoryPoint[]>();
    for (const point of await loadMarketSignalsObservationHistory(tx, orgId, [...listings.values()])) {
      const key = listingKey(point.marketplace, point.asin);
      history.set(key, [...(history.get(key) ?? []), point]);
    }
    const evaluated = new Set<string>();
    const events: MarketSignalsPriceEvent[] = [];
    let withoutObservation = 0;
    for (const point of relevant) {
      const key = listingKey(point.marketplace, point.asin);
      const points = history.get(key) ?? [];
      const at = Date.parse(point.at);
      const index = points.findIndex((candidate) => candidate.observedAt.getTime() === at);
      if (index === -1) {
        withoutObservation += 1;
        continue;
      }
      if (evaluated.has(`${key}|${index}`)) continue;
      evaluated.add(`${key}|${index}`);
      events.push(...detectImportedPriceEvents(points, index));
    }
    // One event key per statement: the table's grain is (org, ASIN, kind, time),
    // so the same ASIN in two marketplaces at one instant keeps the first.
    const unique = new Map<string, MarketSignalsPriceEvent>();
    for (const event of events) {
      const key = `${event.asin}|${event.eventKind}|${event.detectedAt.toISOString()}`;
      if (!unique.has(key)) unique.set(key, event);
    }
    return { events: [...unique.values()], withoutObservation, duplicates: events.length - unique.size };
  }
}

// ---------------------------------------------------------------------------
// Background pass
// ---------------------------------------------------------------------------

export interface MarketSignalsImportLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface MarketSignalsImportStatusSnapshot {
  enabled: true;
  running: boolean;
  intervalMs: number;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  consecutiveFailures: number;
  lastRun: MarketSignalsImportCounts | null;
  /** Totals since this process started. */
  totals: MarketSignalsImportCounts;
  /** Newest `state_generated_at` imported by this process: "data as of". */
  dataAsOf: string | null;
}

export class MarketSignalsImportPass {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<MarketSignalsImportCounts | null> | undefined;
  private lastRunAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastErrorAt: string | null = null;
  private consecutiveFailures = 0;
  private lastRun: MarketSignalsImportCounts | null = null;
  private totals = emptyMarketSignalsCounts();

  constructor(
    private readonly importer: Pick<MarketSignalsImporter, 'run'>,
    private readonly logger: MarketSignalsImportLogger,
    private readonly intervalMs = MARKET_SIGNALS_IMPORT_INTERVAL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  /** Stops the schedule and waits for a pass in progress to settle its transaction. */
  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  runOnce(): Promise<MarketSignalsImportCounts | null> {
    if (this.inFlight) return Promise.resolve(null);
    this.inFlight = this.execute().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async execute(): Promise<MarketSignalsImportCounts | null> {
    this.lastRunAt = this.now().toISOString();
    try {
      const counts = await this.importer.run();
      this.lastRun = counts;
      this.totals = addMarketSignalsCounts(this.totals, counts);
      if (counts.batchesFailed > 0 || counts.filesFailed > 0) {
        this.lastErrorAt = this.now().toISOString();
        this.consecutiveFailures += 1;
      } else {
        this.lastSuccessAt = this.now().toISOString();
        this.consecutiveFailures = 0;
      }
      if (counts.batchesImported > 0 || counts.invalidRecords > 0 || counts.batchesUnmappedOrg > 0
        || counts.batchesFailed > 0 || counts.filesFailed > 0) {
        this.logger.info('Market signals imported', { ...counts });
      }
      return counts;
    } catch (error) {
      this.lastErrorAt = this.now().toISOString();
      this.consecutiveFailures += 1;
      this.logger.error('Market signals import failed', {
        error: error instanceof Error ? error.name : 'unknown',
        consecutiveFailures: this.consecutiveFailures,
      });
      return null;
    }
  }

  status(): MarketSignalsImportStatusSnapshot {
    return {
      enabled: true,
      running: this.timer !== undefined,
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      lastSuccessAt: this.lastSuccessAt,
      lastErrorAt: this.lastErrorAt,
      consecutiveFailures: this.consecutiveFailures,
      lastRun: this.lastRun,
      totals: this.totals,
      dataAsOf: this.totals.stateGeneratedAt,
    };
  }
}

/**
 * The general worker's pass, or undefined: it exists only on a runtime that
 * starts background passes and only when the directory variable is set.
 */
export function createMarketSignalsImportPass(
  handle: DbHandle,
  env: NodeJS.ProcessEnv,
  startsBackgroundPasses: boolean,
  logger: MarketSignalsImportLogger = console,
): MarketSignalsImportPass | undefined {
  if (!startsBackgroundPasses || !env[MARKET_SIGNALS_DIR_ENV]?.trim()) return undefined;
  const config = marketSignalsImportConfigFromEnv(env);
  if (config.directory === null) return undefined;
  return new MarketSignalsImportPass(
    new MarketSignalsImporter(handle, new DirectoryBatchSource(config.directory), config.orgKeys, logger),
    logger,
  );
}
