import { createGunzip, type Gunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import {
  parseSpCampaignReport,
  parseSpPlacementReport,
  parseSpSearchTermReport,
  parseSpTargetingReport,
} from '@wizard-ads/ads-api';
import type { SkippedReportRow } from '@wizard-ads/ads-api';
import type {
  NewPlacementFact,
  NewProfileFact,
  NewSearchTermFact,
  NewSpTargetFact,
} from '@wizard-ads/db';
import type { ReportType } from '@wizard-ads/shared';
import type { AdsProfileContext } from './ads-api.js';

/**
 * Legacy SB/SD refusal threshold. Sponsored Products replacement is stricter:
 * one refused source row blocks the complete-date replacement.
 */
export const SKIP_FAILURE_RATIO = 0.01;

interface CommonRow { date: string; impressions: number; clicks: number; cost: number }
interface SpCampaignRow extends CommonRow { campaignId: string; purchases7d: number; sales7d: number; unitsSoldClicks7d: number }
interface CampaignRow extends SpCampaignRow { adGroupId: string | null }

export interface CampaignFactRow {
  orgId: string;
  profileId: string;
  date: string;
  campaignId: string;
  adGroupId: string | null;
  impressions: number;
  clicks: number;
  cost: number;
  purchases7d: number;
  sales7d: number;
  unitsSold7d: number;
  metrics: Record<string, unknown>;
  reportRequestId: string;
}

/**
 * `sourceRows` is how many rows Amazon sent; `rows` is how many fact rows they
 * became; `skipped` is what a parser refused and why.
 *
 * The three differ in two ways. `spCampaigns` arrives per campaign and lands on
 * a per-profile grain, so it aggregates and `rows` is smaller by design.
 * `spTargeting` and `spSearchTerm` are parsed by `@wizard-ads/ads-api`, which
 * refuses a row missing a dimension its grain is keyed by rather than throwing
 * the whole report away — for those, `rows.length + skipped.length` equals
 * `sourceRows` exactly, and the fetch handler asserts it.
 *
 * Keeping all three means the fetch handler can assert fact rows offered
 * against fact rows written (the invariant the ledger records) without losing
 * the number an operator compares to the Amazon UI.
 */
export type ParsedFactBatch = { sourceRows: number; skipped: SkippedReportRow[] } & (
  | { kind: 'sp_target'; rows: NewSpTargetFact[] }
  | { kind: 'search_term'; rows: NewSearchTermFact[] }
  | { kind: 'placement'; rows: NewPlacementFact[] }
  | { kind: 'profile'; rows: NewProfileFact[] }
  | { kind: 'sb'; rows: CampaignFactRow[] }
  | { kind: 'sd'; rows: CampaignFactRow[] }
);

export interface DownloadedJson {
  rowsParsed: number;
  bytesDownloaded: number;
}

export type ReportRowChunkConsumer = (
  rows: readonly unknown[],
  offset: number,
) => void | Promise<void>;

export interface ReportDownloadControl {
  signal?: AbortSignal;
  /** Abort the HTTP transport synchronously when a local bound fires. */
  abortSource?: (reason: Error) => void;
  /** Consume one freshly parsed, byte-and-row-bounded chunk at a time. */
  consumeRows: ReportRowChunkConsumer;
  /** Testable fail-closed deadline for proving iterator/transport cancellation. */
  cancellationTimeoutMs?: number;
}

export interface ReportDownloadLimits {
  /** Compressed wire bytes accepted from the pre-signed report URL. */
  maxCompressedBytes: number;
  /** Inflated JSON bytes streamed through the parser (the inflate limit). */
  maxDecompressedBytes: number;
  /** Longest permitted wait between compressed chunks. */
  idleTimeoutMs: number;
  /** Complete download, inflation and JSON parsing budget. */
  totalTimeoutMs: number;
}

/**
 * Production aggregates currently remain below 300 KiB compressed (the largest
 * completed report in the 40 days before WP-323 was 275,732 bytes, average
 * about 11 KB). These limits keep over 100x compressed headroom. The inflated
 * document is streamed, never retained, so the inflate ceiling bounds work and
 * decompression-bomb amplification rather than resident memory; a realistic
 * report inflates to a few MB, so 64 MiB is not raised.
 */
export const DEFAULT_REPORT_DOWNLOAD_LIMITS: Readonly<ReportDownloadLimits> = Object.freeze({
  maxCompressedBytes: 32 * 1024 * 1024,
  maxDecompressedBytes: 64 * 1024 * 1024,
  idleTimeoutMs: 60_000,
  totalTimeoutMs: 15 * 60_000,
});

/**
 * One kind per bound. `decompressed_bytes` is only ever the inflate loop; the
 * JSON parser's own bounds (`parsed_row_bytes`, `parsed_rows`) and the parent's
 * normalized-row bound (`parsed_bytes`) are named separately, so a parser
 * failure can never be reported as an oversized download again.
 */
export type ReportDownloadLimitKind =
  | 'compressed_bytes'
  | 'decompressed_bytes'
  | 'parsed_row_bytes'
  | 'parsed_bytes'
  | 'parsed_rows'
  | 'idle_timeout'
  | 'total_timeout'
  | 'source_cancellation';

/** Fixed-category limit failure. Source chunks and provider details are never retained. */
export class ReportDownloadLimitError extends Error {
  readonly provider = 'amazon_ads';
  readonly retryAfterSeconds = undefined;
  get retryable(): boolean { return this.kind !== 'compressed_bytes' && this.kind !== 'decompressed_bytes'; }
  override readonly name = 'ReportDownloadLimitError';

  constructor(readonly kind: ReportDownloadLimitKind, readonly limit: number) {
    super(`report download exceeded ${kind} limit`);
  }
}

/** The bounded parser accepted JSON, but the top-level report shape is unusable. */
export class ReportPayloadShapeError extends Error {
  override readonly name = 'ReportPayloadShapeError';

  constructor() {
    super('report payload must be a JSON array');
  }
}

/**
 * The body is not a report document at all. `corrupt_gzip` is the only
 * retryable kind: a truncated or damaged stream is a transport accident, while
 * an empty body, a non-JSON body (an XML or HTML error page answered with a
 * success status) or malformed JSON will be the same on every retry.
 */
export type ReportPayloadFormatKind = 'empty' | 'not_gzip_or_json' | 'corrupt_gzip' | 'invalid_json';

const PAYLOAD_FORMAT_MESSAGES: Readonly<Record<ReportPayloadFormatKind, string>> = {
  empty: 'report payload is empty',
  not_gzip_or_json: 'report payload is neither gzip nor JSON',
  corrupt_gzip: 'report payload gzip stream is corrupt or truncated',
  invalid_json: 'report payload is not valid JSON',
};

/** Fixed-category payload failure. Source bytes are never quoted. */
export class ReportPayloadFormatError extends Error {
  readonly provider = 'amazon_ads';
  readonly retryAfterSeconds = undefined;
  get retryable(): boolean { return this.kind === 'corrupt_gzip'; }
  override readonly name = 'ReportPayloadFormatError';

  constructor(readonly kind: ReportPayloadFormatKind) {
    super(PAYLOAD_FORMAT_MESSAGES[kind]);
  }
}

const PARSED_CHUNK_MAX_ROWS = 128;
const PARSED_CHUNK_MAX_BYTES = 256 * 1024;
const PARSED_DOCUMENT_MAX_ROWS = 100_000;
const SOURCE_CANCELLATION_TIMEOUT_MS = 5_000;
const GZIP_MAGIC = [0x1f, 0x8b] as const;

/**
 * Stream a report body through gunzip (when it is gzip) and a streaming JSON
 * array parser under explicit byte, row and time bounds.
 *
 * Amazon stores reports gzip-compressed, but a transport that honours
 * `Content-Encoding: gzip` hands over the inflated JSON instead; the first two
 * bytes decide which one arrived. The document is never buffered whole: each
 * top-level array element is parsed as soon as its closing byte inflates, and
 * rows reach `consumeRows` in bounded chunks. Parsing happens on this thread,
 * so the path does not depend on a bundler resolving a worker module URL.
 */
export async function gunzipJson(
  source: AsyncIterable<Uint8Array>,
  limits: Readonly<ReportDownloadLimits> = DEFAULT_REPORT_DOWNLOAD_LIMITS,
  control: ReportDownloadControl,
): Promise<DownloadedJson> {
  assertDownloadLimits(limits);
  const cancellationTimeoutMs = control.cancellationTimeoutMs
    ?? SOURCE_CANCELLATION_TIMEOUT_MS;
  if (!Number.isSafeInteger(cancellationTimeoutMs) || cancellationTimeoutMs <= 0) {
    throw new RangeError('cancellationTimeoutMs must be a positive safe integer');
  }
  const startedAt = Date.now();
  let bytesDownloaded = 0;
  const controller = new AbortController();
  const totalError = new ReportDownloadLimitError('total_timeout', limits.totalTimeoutMs);
  const abortSource = (reason: Error): void => {
    control.abortSource?.(reason);
    controller.abort(reason);
  };
  const abortFromCaller = (): void => {
    const reason = control.signal?.reason instanceof Error
      ? control.signal.reason
      : totalError;
    controller.abort(reason);
  };
  if (control.signal?.aborted === true) abortFromCaller();
  else control.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const totalTimer = setTimeout(() => abortSource(totalError), limits.totalTimeoutMs);
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let iteratorClose: Promise<void> | undefined;
  let sourceCompleted = false;

  const closeIterator = async (): Promise<void> => {
    if (sourceCompleted) return;
    if (iterator?.return === undefined) {
      throw new ReportDownloadLimitError(
        'source_cancellation',
        cancellationTimeoutMs,
      );
    }
    try {
      if (!iteratorClose) {
        try {
          iteratorClose = Promise.resolve(iterator.return()).then((result) => {
            if (!result.done) throw new Error('source iterator did not close');
          });
        } catch (error) {
          iteratorClose = Promise.reject(error);
        }
        // A return implementation may hand back an already-rejected promise.
        // Observe it immediately and still await the original below so the
        // cancellation failure remains authoritative.
        void iteratorClose.catch(() => undefined);
      }
      await withCancellationDeadline(iteratorClose, cancellationTimeoutMs);
    } catch (error) {
      if (error instanceof ReportDownloadLimitError) throw error;
      throw new ReportDownloadLimitError('source_cancellation', cancellationTimeoutMs);
    }
  };

  async function* measured(): AsyncGenerator<Uint8Array> {
    iterator = source[Symbol.asyncIterator]();
    try {
      for (;;) {
        const item = await nextDownloadChunk(
          iterator,
          controller.signal,
          limits.idleTimeoutMs,
          abortSource,
        );
        if (item.done) {
          sourceCompleted = true;
          return;
        }
        const nextBytes = bytesDownloaded + item.value.byteLength;
        if (nextBytes > limits.maxCompressedBytes) {
          const error = new ReportDownloadLimitError(
            'compressed_bytes',
            limits.maxCompressedBytes,
          );
          abortSource(error);
          throw error;
        }
        bytesDownloaded = nextBytes;
        if (item.value.byteLength > 0) yield item.value;
      }
    } finally {
      await closeIterator();
    }
  }

  const wire = measured();
  let compressed: Readable | undefined;
  let unzipped: Gunzip | undefined;
  const abort = (): void => {
    const reason = controller.signal.reason instanceof Error
      ? controller.signal.reason
      : totalError;
    compressed?.destroy(reason);
    unzipped?.destroy(reason);
  };
  controller.signal.addEventListener('abort', abort, { once: true });

  const pending: { value: unknown; bytes: number }[] = [];
  let emitted = 0;
  const flush = async (final: boolean): Promise<void> => {
    while (pending.length > 0) {
      let bytes = 2;
      let take = 0;
      while (take < pending.length && take < PARSED_CHUNK_MAX_ROWS) {
        const next = bytes + pending[take]!.bytes + (take === 0 ? 0 : 1);
        if (take > 0 && next > PARSED_CHUNK_MAX_BYTES) break;
        bytes = next;
        take += 1;
      }
      // Hold a partial chunk back until more rows arrive, so chunk sizes stay
      // independent of how the transport happened to split the bytes.
      if (!final && take === pending.length && take < PARSED_CHUNK_MAX_ROWS
        && bytes < PARSED_CHUNK_MAX_BYTES) return;
      const rows = pending.splice(0, take).map((row) => row.value);
      const offset = emitted;
      emitted += rows.length;
      await control.consumeRows(rows, offset);
      if (controller.signal.aborted) throw abortReason(controller.signal, totalError);
    }
  };

  try {
    // Sniff the encoding from the first bytes without consuming them.
    const head: Uint8Array[] = [];
    let headBytes = 0;
    while (headBytes < GZIP_MAGIC.length) {
      const next = await wire.next();
      if (next.done) break;
      head.push(next.value);
      headBytes += next.value.byteLength;
    }
    const prefix = Buffer.concat(head.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
    const encoding = prefix.length >= GZIP_MAGIC.length
      && prefix[0] === GZIP_MAGIC[0] && prefix[1] === GZIP_MAGIC[1] ? 'gzip' : 'identity';
    async function* replay(): AsyncGenerator<Uint8Array> {
      if (prefix.length > 0) yield prefix;
      yield* wire;
    }
    let body: AsyncIterable<Uint8Array>;
    if (encoding === 'gzip') {
      compressed = Readable.from(replay());
      unzipped = createGunzip();
      const inflater = unzipped;
      compressed.once('error', (error) => inflater.destroy(error));
      compressed.pipe(inflater);
      body = inflater;
    } else {
      body = replay();
    }

    const parser = new JsonArrayStreamParser(encoding, PARSED_CHUNK_MAX_BYTES, PARSED_DOCUMENT_MAX_ROWS);
    let inflatedBytes = 0;
    try {
      for await (const chunk of body) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const nextBytes = inflatedBytes + buffer.byteLength;
        if (nextBytes > limits.maxDecompressedBytes) {
          const error = new ReportDownloadLimitError(
            'decompressed_bytes',
            limits.maxDecompressedBytes,
          );
          abortSource(error);
          throw error;
        }
        inflatedBytes = nextBytes;
        parser.push(buffer, (value, bytes) => { pending.push({ value, bytes }); });
        await flush(false);
      }
    } catch (error) {
      const failure = isZlibError(error) ? new ReportPayloadFormatError('corrupt_gzip') : error;
      // Stop the transport on any mid-stream failure, not only on a bound:
      // a parser or consumer refusal must not leave the download running.
      if (!controller.signal.aborted) {
        abortSource(failure instanceof Error ? failure : new Error('report download failed'));
      }
      throw failure;
    }
    if (controller.signal.aborted || Date.now() - startedAt >= limits.totalTimeoutMs) {
      throw abortReason(controller.signal, totalError);
    }
    parser.end();
    await flush(true);
    if (controller.signal.aborted || Date.now() - startedAt >= limits.totalTimeoutMs) {
      throw abortReason(controller.signal, totalError);
    }
    return {
      rowsParsed: parser.elements,
      bytesDownloaded,
    };
  } finally {
    clearTimeout(totalTimer);
    control.signal?.removeEventListener('abort', abortFromCaller);
    controller.signal.removeEventListener('abort', abort);
    compressed?.destroy();
    unzipped?.destroy();
    await closeIterator();
  }
}

function abortReason(signal: AbortSignal, fallback: Error): Error {
  return signal.reason instanceof Error ? signal.reason : fallback;
}

function isZlibError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    && /^Z_[A-Z_]+$/.test(error.code);
}

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const COMMA = 0x2c;

/** First bytes of a JSON value that is valid but not an array. */
function startsNonArrayJson(byte: number): boolean {
  return byte === OPEN_OBJECT || byte === QUOTE || byte === 0x2d || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x74 || byte === 0x66 || byte === 0x6e;
}

/**
 * Split a top-level JSON array into its elements as bytes arrive.
 *
 * Only structural ASCII bytes are interpreted, and every UTF-8 continuation
 * byte is above 0x7f, so scanning bytes is exact across chunk boundaries. Each
 * complete element is validated by `JSON.parse`; the scanner itself only
 * tracks string, escape and nesting state. At most one element (bounded by
 * `maxElementBytes`) is retained between chunks.
 */
class JsonArrayStreamParser {
  elements = 0;
  private state: 'document' | 'first' | 'element' | 'next' | 'closed' = 'document';
  private depth = 0;
  private inString = false;
  private escaped = false;
  private pieces: Buffer[] = [];
  private pieceBytes = 0;

  constructor(
    private readonly encoding: 'gzip' | 'identity',
    private readonly maxElementBytes: number,
    private readonly maxElements: number,
  ) {}

  push(chunk: Buffer, emit: (value: unknown, bytes: number) => void): void {
    let start = this.state === 'element' ? 0 : -1;
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index]!;
      if (this.state === 'element') {
        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (byte === BACKSLASH) this.escaped = true;
          else if (byte === QUOTE) this.inString = false;
          continue;
        }
        if (byte === QUOTE) { this.inString = true; continue; }
        if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) { this.depth += 1; continue; }
        if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) {
          if (this.depth > 0) { this.depth -= 1; continue; }
          if (byte === CLOSE_OBJECT) throw new ReportPayloadFormatError('invalid_json');
          this.finish(chunk.subarray(start, index), emit);
          this.state = 'closed';
          start = -1;
          continue;
        }
        if (byte === COMMA && this.depth === 0) {
          this.finish(chunk.subarray(start, index), emit);
          this.state = 'next';
          start = -1;
        }
        continue;
      }
      if (WHITESPACE.has(byte)) continue;
      if (this.state === 'document') {
        if (byte === OPEN_ARRAY) { this.state = 'first'; continue; }
        if (startsNonArrayJson(byte)) throw new ReportPayloadShapeError();
        throw new ReportPayloadFormatError(this.encoding === 'gzip' ? 'invalid_json' : 'not_gzip_or_json');
      }
      if (this.state === 'closed') throw new ReportPayloadFormatError('invalid_json');
      if (byte === CLOSE_ARRAY && this.state === 'first') { this.state = 'closed'; continue; }
      if (byte === CLOSE_ARRAY || byte === COMMA) throw new ReportPayloadFormatError('invalid_json');
      // First byte of an element: re-read it in element state.
      this.state = 'element';
      this.depth = 0;
      this.inString = false;
      this.escaped = false;
      start = index;
      index -= 1;
    }
    if (this.state === 'element' && start >= 0 && start < chunk.length) {
      this.retain(chunk.subarray(start));
    }
  }

  end(): void {
    if (this.state === 'closed') return;
    if (this.state === 'document') {
      throw new ReportPayloadFormatError(this.encoding === 'gzip' ? 'invalid_json' : 'empty');
    }
    throw new ReportPayloadFormatError('invalid_json');
  }

  private retain(piece: Buffer): void {
    this.pieceBytes += piece.byteLength;
    if (this.pieceBytes > this.maxElementBytes) {
      throw new ReportDownloadLimitError('parsed_row_bytes', this.maxElementBytes);
    }
    // Copy: the inflater may reuse its output buffer for the next chunk.
    this.pieces.push(Buffer.from(piece));
  }

  private finish(tail: Buffer, emit: (value: unknown, bytes: number) => void): void {
    const bytes = this.pieceBytes + tail.byteLength;
    if (bytes > this.maxElementBytes) {
      throw new ReportDownloadLimitError('parsed_row_bytes', this.maxElementBytes);
    }
    const text = (this.pieces.length === 0 ? tail : Buffer.concat([...this.pieces, tail], bytes))
      .toString('utf8');
    this.pieces = [];
    this.pieceBytes = 0;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // JSON parser errors can quote source text. Return only a closed category.
      throw new ReportPayloadFormatError('invalid_json');
    }
    this.elements += 1;
    if (this.elements > this.maxElements) {
      throw new ReportDownloadLimitError('parsed_rows', this.maxElements);
    }
    emit(value, bytes);
  }
}

function assertDownloadLimits(limits: Readonly<ReportDownloadLimits>): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}

function nextDownloadChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
  idleTimeoutMs: number,
  abortSource: (reason: Error) => void,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(signal.reason));
    const idleTimer = setTimeout(() => {
      const error = new ReportDownloadLimitError('idle_timeout', idleTimeoutMs);
      abortSource(error);
      finish(() => reject(error));
    }, idleTimeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    void iterator.next().then(
      (item) => finish(() => resolve(item)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function withCancellationDeadline(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  return Promise.race([
    operation,
    new Promise<void>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new ReportDownloadLimitError(
        'source_cancellation',
        timeoutMs,
      )), timeoutMs);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('report row must be an object');
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, field: string, nullable = false): string | null {
  const value = row[field];
  if (nullable && (value === null || value === undefined)) return null;
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).length === 0) throw new Error(`${field} must be a non-empty string`);
  return String(value);
}

function numberField(row: Record<string, unknown>, field: string, integer = false): number {
  const raw = row[field] ?? 0;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new Error(`${field} must be a non-negative${integer ? ' integer' : ''}`);
  return value;
}

function parseCommon(value: unknown): [Record<string, unknown>, CommonRow] {
  const row = record(value);
  const date = stringField(row, 'date');
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  return [row, { date, impressions: numberField(row, 'impressions', true), clicks: numberField(row, 'clicks', true), cost: numberField(row, 'cost') }];
}

function parseSpCampaign(value: unknown): SpCampaignRow {
  const [row, commonRow] = parseCommon(value);
  return { ...commonRow, campaignId: stringField(row, 'campaignId') as string, purchases7d: numberField(row, 'purchases7d', true), sales7d: numberField(row, 'sales7d'), unitsSoldClicks7d: numberField(row, 'unitsSoldClicks7d', true) };
}

function parseCampaign(value: unknown): CampaignRow {
  const row = record(value);
  return { ...parseSpCampaign(value), adGroupId: stringField(row, 'adGroupId', true) };
}

function assertArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('report payload must be a JSON array');
  return value;
}

export function parseReportRows(
  reportType: ReportType,
  value: unknown,
  profile: AdsProfileContext,
  reportRequestId: string,
): ParsedFactBatch {
  const raw = assertArray(value);
  const base = { orgId: profile.orgId, profileId: profile.id, reportRequestId };

  switch (reportType) {
    // `spTargeting` and `spSearchTerm` are parsed by `@wizard-ads/ads-api`,
    // which is the parser that has met the live report. Amazon sends
    // `keywordId` (not `targetId`) on the target grain and its own match-type
    // spellings (`EXACT`, `TARGETING_EXPRESSION`); a strict local parser
    // rejected every non-empty report of both types. The tenant join is all the
    // worker adds: the report knows Amazon's profile, we know our uuid.
    case 'spTargeting': {
      const result = parseSpTargetingReport(raw);
      return {
        sourceRows: result.input,
        skipped: result.skipped,
        kind: 'sp_target',
        rows: result.rows.map((row): NewSpTargetFact => ({
          ...row,
          topOfSearchImpressionShare: row.topOfSearchImpressionShare ?? null,
          ...base,
        })),
      };
    }
    case 'spSearchTerm': {
      const result = parseSpSearchTermReport(raw);
      return {
        sourceRows: result.input,
        skipped: result.skipped,
        kind: 'search_term',
        rows: result.rows.map((row): NewSearchTermFact => ({ ...row, ...base })),
      };
    }
    case 'spPlacement': {
      const result = parseSpPlacementReport(raw);
      return {
        sourceRows: result.input,
        skipped: result.skipped,
        kind: 'placement',
        rows: result.rows.map((row): NewPlacementFact => ({ ...row, ...base })),
      };
    }
    case 'spCampaigns': {
      // The campaign report arrives one row per campaign per day, and
      // `fact_profile_daily` is one row per profile per day. Summing here is
      // not a convenience: two campaigns on one date are two rows with the same
      // conflict target, and Postgres refuses to let one statement update the
      // same row twice. Aggregating turns that error into the number the grain
      // is supposed to hold.
      const byDate = new Map<string, Required<Pick<NewProfileFact,
        'impressions' | 'clicks' | 'cost' | 'purchases7d' | 'sales7d' | 'unitsSold7d'>>>();
      const result = parseSpCampaignReport(raw);
      for (const row of result.rows) {
        const running = byDate.get(row.date);
        if (running) {
          running.impressions += row.impressions;
          running.clicks += row.clicks;
          running.cost += row.cost;
          running.purchases7d += row.purchases7d;
          running.sales7d += row.sales7d;
          running.unitsSold7d += row.unitsSold7d;
          continue;
        }
        byDate.set(row.date, {
          impressions: row.impressions,
          clicks: row.clicks,
          cost: row.cost,
          purchases7d: row.purchases7d,
          sales7d: row.sales7d,
          unitsSold7d: row.unitsSold7d,
        });
      }
      const rows = [...byDate.entries()].map(([date, totals]): NewProfileFact => ({
        ...base,
        date,
        currencyCode: profile.currencyCode,
        provisional: false,
        ...totals,
      }));
      return { sourceRows: result.input, skipped: result.skipped, kind: 'profile', rows };
    }
    case 'sbCampaigns':
    case 'sdCampaigns': {
      const rows = raw.map((item): CampaignFactRow => {
        const row = parseCampaign(item);
        return {
          ...base,
          date: row.date,
          campaignId: row.campaignId,
          adGroupId: row.adGroupId,
          impressions: row.impressions,
          clicks: row.clicks,
          cost: row.cost,
          purchases7d: row.purchases7d,
          sales7d: row.sales7d,
          unitsSold7d: row.unitsSoldClicks7d,
          metrics: item as Record<string, unknown>,
        };
      });
      return { sourceRows: raw.length, skipped: [], kind: reportType === 'sbCampaigns' ? 'sb' : 'sd', rows };
    }
  }
}

/**
 * Merge one bounded parser chunk into report-wide normalized facts. Raw provider
 * rows are never retained in the parent process. Refusal indexes are shifted to
 * their report-wide positions so accounting remains exact.
 */
export function mergeParsedFactBatches(
  current: ParsedFactBatch | undefined,
  next: ParsedFactBatch,
  sourceOffset: number,
): ParsedFactBatch {
  const skipped = next.skipped.map((row) => ({ ...row, index: row.index + sourceOffset }));
  if (current === undefined) return { ...next, skipped };
  if (current.kind !== next.kind) throw new Error('report parser chunk kind changed');
  current.sourceRows += next.sourceRows;
  current.skipped.push(...skipped);

  switch (current.kind) {
    case 'sp_target': {
      if (next.kind !== 'sp_target') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'search_term': {
      if (next.kind !== 'search_term') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'placement': {
      if (next.kind !== 'placement') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'profile': {
      if (next.kind !== 'profile') throw new Error('report parser chunk kind changed');
      const byDate = new Map(current.rows.map((row) => [row.date, { ...row }]));
      for (const row of next.rows) {
        const existing = byDate.get(row.date);
        if (!existing) {
          byDate.set(row.date, { ...row });
          continue;
        }
        existing.impressions = (existing.impressions ?? 0) + (row.impressions ?? 0);
        existing.clicks = (existing.clicks ?? 0) + (row.clicks ?? 0);
        existing.cost = (existing.cost ?? 0) + (row.cost ?? 0);
        existing.purchases7d = (existing.purchases7d ?? 0) + (row.purchases7d ?? 0);
        existing.sales7d = (existing.sales7d ?? 0) + (row.sales7d ?? 0);
        existing.unitsSold7d = (existing.unitsSold7d ?? 0) + (row.unitsSold7d ?? 0);
      }
      current.rows.splice(0, current.rows.length, ...byDate.values());
      return current;
    }
    case 'sb': {
      if (next.kind !== 'sb') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
    case 'sd': {
      if (next.kind !== 'sd') throw new Error('report parser chunk kind changed');
      current.rows.push(...next.rows);
      return current;
    }
  }
}
