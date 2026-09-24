import { gzipSync } from 'node:zlib';
import { classifyReportLaneFailure } from '@wizard-ads/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbAdsApiClient, DownloadUrlExpiredError, downloadUrlExpiresAt } from './ads-api.js';
import {
  DEFAULT_REPORT_DOWNLOAD_LIMITS,
  ReportDownloadLimitError,
  ReportPayloadFormatError,
  ReportPayloadShapeError,
  gunzipJson,
  type ReportDownloadLimits,
} from './parsers.js';

const generous: ReportDownloadLimits = {
  maxCompressedBytes: 1_024,
  maxDecompressedBytes: 4_096,
  idleTimeoutMs: 1_000,
  totalTimeoutMs: 5_000,
};

async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

function never(): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
      return: async () => ({ done: true, value: undefined }),
    }),
  };
}

function downloadClient(body: ReadableStream<Uint8Array>): DbAdsApiClient {
  return new DbAdsApiClient({
    resolveProfileBinding: async () => null,
    resolveConnectionBinding: async () => null,
    listConnectionIds: async () => [],
    getRefreshToken: async () => null,
    createClient: () => { throw new Error('unused'); },
    fetch: async () => new Response(body),
  });
}

function consumeRows(rows: unknown[]): (chunk: readonly unknown[]) => void {
  return (chunk) => rows.push(...chunk);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bounded report download', () => {
  it('inflates and accounts a valid bounded JSON document', async () => {
    const compressed = gzipSync(JSON.stringify([{ row: 1 }, { row: 2 }]));
    const rows: unknown[] = [];

    await expect(gunzipJson(bytes(compressed), generous, {
      consumeRows: consumeRows(rows),
    })).resolves.toEqual({
      rowsParsed: 2,
      bytesDownloaded: compressed.byteLength,
    });
    expect(rows).toEqual([{ row: 1 }, { row: 2 }]);
  });

  it('delivers a larger parsed array only in bounded acknowledged chunks', async () => {
    const expected = Array.from({ length: 300 }, (_, row) => ({ row }));
    const compressed = gzipSync(JSON.stringify(expected));
    const rows: unknown[] = [];
    const chunkSizes: number[] = [];

    await expect(gunzipJson(bytes(compressed), generous, {
      consumeRows: async (chunk) => {
        chunkSizes.push(chunk.length);
        rows.push(...chunk);
      },
    })).resolves.toMatchObject({ rowsParsed: expected.length });
    expect(rows).toEqual(expected);
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(128);
  });

  it('refuses a single parsed row above the structural-clone chunk bound', async () => {
    const document = JSON.stringify([{ row: 'x'.repeat(300 * 1_024) }]);
    const compressed = gzipSync(document);

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxDecompressedBytes: Buffer.byteLength(document) + 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      kind: 'parsed_row_bytes',
    });
  });

  it('refuses an array whose object count could amplify parent heap', async () => {
    const document = JSON.stringify(Array.from({ length: 100_001 }, () => null));
    const compressed = gzipSync(document);

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxDecompressedBytes: Buffer.byteLength(document) + 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      kind: 'parsed_rows',
    });
  });

  it('refuses compressed input above the wire-byte ceiling', async () => {
    const compressed = gzipSync(JSON.stringify([{ row: 'value' }]));

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxCompressedBytes: compressed.byteLength - 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'compressed_bytes',
    });
  });

  it('refuses inflated input above the retained-byte ceiling', async () => {
    const document = JSON.stringify([{ row: 'value'.repeat(20) }]);
    const compressed = gzipSync(document);

    await expect(gunzipJson(bytes(compressed), {
      ...generous,
      maxDecompressedBytes: Buffer.byteLength(document) - 1,
    }, { consumeRows: () => undefined })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'decompressed_bytes',
    });
  });

  it('interrupts a source that stops producing chunks', async () => {
    vi.useFakeTimers();
    const result = gunzipJson(never(), {
      ...generous,
      idleTimeoutMs: 50,
      totalTimeoutMs: 500,
    }, { consumeRows: () => undefined, cancellationTimeoutMs: 50 });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'idle_timeout',
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('enforces the total deadline independently of the idle deadline', async () => {
    vi.useFakeTimers();
    const result = gunzipJson(never(), {
      ...generous,
      idleTimeoutMs: 500,
      totalTimeoutMs: 50,
    }, { consumeRows: () => undefined, cancellationTimeoutMs: 50 });
    const rejection = expect(result).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'total_timeout',
    });

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('aborts and proves cancellation of a real ReadableStream on idle timeout', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(gzipSync('['));
      },
      cancel() {
        cancelCalls += 1;
      },
    });
    const api = downloadClient(stream);
    const outer = new AbortController();
    const source = await api.downloadReport('https://reports.invalid/idle', outer.signal);

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      signal: outer.signal,
      abortSource: (reason) => outer.abort(reason),
      consumeRows: () => undefined,
      cancellationTimeoutMs: 100,
    })).rejects.toMatchObject({ kind: 'idle_timeout' });
    expect(outer.signal.aborted).toBe(true);
    expect(cancelCalls).toBe(1);
  });

  it('fails closed when real ReadableStream cancellation never settles', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        return new Promise<void>(() => undefined);
      },
    });
    const api = downloadClient(stream);
    const outer = new AbortController();
    const source = await api.downloadReport('https://reports.invalid/hanging-cancel', outer.signal);

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      signal: outer.signal,
      abortSource: (reason) => outer.abort(reason),
      consumeRows: () => undefined,
      cancellationTimeoutMs: 20,
    })).rejects.toMatchObject({ kind: 'source_cancellation' });
    expect(cancelCalls).toBe(1);
  });

  it('preserves a real ReadableStream cancellation rejection as source failure', async () => {
    let cancelCalls = 0;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
        return Promise.reject(new Error('synthetic transport cancellation rejection'));
      },
    });
    const api = downloadClient(stream);
    const outer = new AbortController();
    const source = await api.downloadReport('https://reports.invalid/rejecting-cancel', outer.signal);

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      signal: outer.signal,
      abortSource: (reason) => outer.abort(reason),
      consumeRows: () => undefined,
      cancellationTimeoutMs: 100,
    })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'source_cancellation',
    });
    expect(cancelCalls).toBe(1);
  });

  it.each([
    ['throws synchronously', () => { throw new Error('synthetic return throw'); }],
    ['returns a rejected promise', () => Promise.reject(new Error('synthetic return rejection'))],
    ['returns a non-done result', () => Promise.resolve({ done: false, value: new Uint8Array() })],
  ] as const)('normalizes an iterator that %s', async (_case, close) => {
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: close,
      }),
    };

    await expect(gunzipJson(source, {
      ...generous,
      idleTimeoutMs: 20,
      totalTimeoutMs: 500,
    }, {
      consumeRows: () => undefined,
      cancellationTimeoutMs: 100,
    })).rejects.toMatchObject({
      name: 'ReportDownloadLimitError',
      kind: 'source_cancellation',
    });
  });

  it('lets a concurrent bounded download finish while another is cancelling', async () => {
    const blocked = gunzipJson(never(), {
      ...generous,
      idleTimeoutMs: 40,
      totalTimeoutMs: 500,
    }, { consumeRows: () => undefined, cancellationTimeoutMs: 50 });
    const blockedRejection = expect(blocked).rejects.toMatchObject({ kind: 'idle_timeout' });
    const compressed = gzipSync(JSON.stringify([{ row: 'independent' }]));
    const rows: unknown[] = [];

    await expect(gunzipJson(bytes(compressed), generous, {
      consumeRows: consumeRows(rows),
    })).resolves.toMatchObject({ rowsParsed: 1 });
    expect(rows).toEqual([{ row: 'independent' }]);
    await blockedRejection;
  });

  it('rejects non-positive or non-integral limits before reading the source', async () => {
    await expect(gunzipJson(bytes(gzipSync('[]')), {
      ...generous,
      maxCompressedBytes: 0,
    }, { consumeRows: () => undefined })).rejects.toBeInstanceOf(RangeError);
    await expect(gunzipJson(bytes(gzipSync('[]')), {
      ...generous,
      totalTimeoutMs: 1.5,
    }, { consumeRows: () => undefined })).rejects.toBeInstanceOf(RangeError);
  });
});

/** Synthetic search-term rows with the production shape; values are invented. */
function syntheticSearchTermRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-09-${String(20 + (index % 3)).padStart(2, '0')}`,
    campaignId: `synthetic-campaign-${index % 97}`,
    adGroupId: `synthetic-group-${index % 211}`,
    keywordId: `synthetic-keyword-${index}`,
    keyword: `synthetic keyword ${index % 503}`,
    searchTerm: `synthetic search term number ${index} with "quotes" and \\ backslash, Grüße ✓`,
    matchType: index % 2 ? 'EXACT' : 'TARGETING_EXPRESSION',
    impressions: 1_000 + index,
    clicks: index % 9,
    cost: (index % 9) * 0.37,
    purchases7d: index % 2,
    sales7d: (index % 2) * 19.99,
    unitsSoldClicks7d: index % 2,
    nested: { list: [index, [index % 3, { deep: `value-${index}` }]] },
  }));
}

async function* chunked(value: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += size) yield value.subarray(offset, offset + size);
}

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then((value) => ({ ok: true, value }), (error: unknown) => ({ ok: false, error }));
}

function respondingClient(respond: () => Response): DbAdsApiClient {
  return new DbAdsApiClient({
    resolveProfileBinding: async () => null,
    resolveConnectionBinding: async () => null,
    listConnectionIds: async () => [],
    getRefreshToken: async () => null,
    createClient: () => { throw new Error('unused'); },
    fetch: async () => respond(),
  });
}

describe('WP-323 (a) realistic report bodies', () => {
  it('inflates and parses a realistic multi-megabyte gzip report in bounded, offset-exact chunks', async () => {
    const rows = syntheticSearchTermRows(20_000);
    const document = JSON.stringify(rows);
    const compressed = gzipSync(document);
    expect(Buffer.byteLength(document)).toBeGreaterThan(4 * 1024 * 1024);
    expect(compressed.byteLength).toBeLessThan(DEFAULT_REPORT_DOWNLOAD_LIMITS.maxCompressedBytes);
    const consumed: unknown[] = [];
    const sizes: number[] = [];

    const result = await gunzipJson(chunked(compressed, 64 * 1_024), DEFAULT_REPORT_DOWNLOAD_LIMITS, {
      consumeRows: (chunk, offset) => {
        expect(offset).toBe(consumed.length);
        sizes.push(chunk.length);
        consumed.push(...chunk);
      },
    });

    expect(result).toEqual({ rowsParsed: rows.length, bytesDownloaded: compressed.byteLength });
    expect(consumed).toHaveLength(rows.length);
    expect(consumed).toEqual(rows);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(128);
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(rows.length);
  });

  it('delivers rows while the download is still arriving instead of buffering the whole document', async () => {
    const rows = syntheticSearchTermRows(4_000);
    const compressed = gzipSync(JSON.stringify(rows));
    const half = Math.floor(compressed.byteLength / 2);
    const consumed: unknown[] = [];
    let firstRows!: () => void;
    const rowsArrived = new Promise<void>((resolve) => { firstRows = resolve; });
    let rowsBeforeSecondHalf = -1;
    async function* source(): AsyncGenerator<Uint8Array> {
      yield compressed.subarray(0, half);
      // A buffering parser never calls back before the end; do not hang it.
      await Promise.race([rowsArrived, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      rowsBeforeSecondHalf = consumed.length;
      yield compressed.subarray(half);
    }

    const result = await gunzipJson(source(), { ...DEFAULT_REPORT_DOWNLOAD_LIMITS, idleTimeoutMs: 5_000 }, {
      consumeRows: (chunk) => { consumed.push(...chunk); firstRows(); },
    });

    expect(result.rowsParsed).toBe(rows.length);
    expect(rowsBeforeSecondHalf).toBeGreaterThan(0);
    expect(consumed).toEqual(rows);
  });

  it('splits elements exactly across every possible chunk boundary, including multi-byte text and escapes', async () => {
    const rows = syntheticSearchTermRows(3);
    const document = Buffer.from(` \n[ ${rows.map((row) => JSON.stringify(row, null, 1)).join(' ,\n')} ]\n`);
    const consumed: unknown[] = [];

    await expect(gunzipJson(chunked(document, 1), DEFAULT_REPORT_DOWNLOAD_LIMITS, {
      consumeRows: (chunk) => { consumed.push(...chunk); },
    }).then((value) => value.rowsParsed)).resolves.toBe(rows.length);
    expect(consumed).toEqual(rows);
  });
});

describe('WP-323 (b) an expired pre-signed URL', () => {
  // The shape of S3's answer to an expired signature; every value is synthetic.
  const expiredXml = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code>'
    + '<Message>Request has expired</Message><X-Amz-Expires>3600</X-Amz-Expires>'
    + '<Expires>2026-09-24T08:34:00Z</Expires><ServerTime>2026-09-24T10:10:00Z</ServerTime>'
    + '<RequestId>SYNTHETICREQUEST</RequestId><HostId>synthetic-host</HostId></Error>';
  const signedUrl = (signedAt: string) => `https://reports.invalid/report.json.gz?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${signedAt}&X-Amz-Expires=3600&X-Amz-Signature=synthetic`;

  it('classifies the 403 XML body as download_url_expired, never as a size error', async () => {
    const client = respondingClient(() => new Response(expiredXml, {
      status: 403, headers: { 'content-type': 'application/xml' },
    }));
    const result = await outcome(client.downloadReport(signedUrl('20260924T073400Z')));

    expect(result).toMatchObject({ ok: false, error: expect.any(DownloadUrlExpiredError) });
    const error = (result as { error: DownloadUrlExpiredError }).error;
    expect(error).not.toBeInstanceOf(ReportDownloadLimitError);
    expect(error).toMatchObject({ rejection: 'expired', errorClass: 'download_url_expired', retryable: true });
    expect(error.message).toBe('report download URL expired');
    expect(classifyReportLaneFailure('report.fetch', error.message)).toEqual({
      stage: 'fetch', errorClass: 'download_url_expired', recoverableByReRequest: true,
    });
  });

  it('treats a body-less 403 on a URL past its own signature expiry as expired', async () => {
    const client = respondingClient(() => new Response(null, { status: 403 }));
    await expect(client.downloadReport(signedUrl('20200101T000000Z'))).rejects.toMatchObject({
      rejection: 'expired', errorClass: 'download_url_expired',
    });
  });

  it('reports any other storage 403 as a rejected URL, still repaired by re-requesting', async () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const client = respondingClient(() => new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 }));
    const result = await outcome(client.downloadReport(signedUrl(future)));
    const error = (result as { error: DownloadUrlExpiredError }).error;
    expect(error).toMatchObject({ rejection: 'rejected', errorClass: 'download_url_rejected' });
    expect(classifyReportLaneFailure('report.fetch', error.message)).toMatchObject({
      errorClass: 'download_url_rejected', recoverableByReRequest: true,
    });
  });

  it('reads the expiry a pre-signed URL carries', () => {
    expect(downloadUrlExpiresAt(signedUrl('20260924T073400Z'))?.toISOString()).toBe('2026-09-24T08:34:00.000Z');
    expect(downloadUrlExpiresAt('https://reports.invalid/r?Expires=1790000000')?.toISOString()).toBe('2026-09-21T14:13:20.000Z');
    expect(downloadUrlExpiresAt('https://reports.invalid/r')).toBeNull();
    expect(downloadUrlExpiresAt('https://reports.invalid/r?X-Amz-Date=bad&X-Amz-Expires=3600')).toBeNull();
    expect(downloadUrlExpiresAt('not a url')).toBeNull();
  });
});

describe('WP-323 (c) a body that is not gzip', () => {
  it('parses JSON the transport already inflated (Content-Encoding handled upstream)', async () => {
    const rows = syntheticSearchTermRows(300);
    const body = Buffer.from(JSON.stringify(rows));
    const consumed: unknown[] = [];

    await expect(gunzipJson(chunked(body, 4_096), DEFAULT_REPORT_DOWNLOAD_LIMITS, {
      consumeRows: (chunk) => { consumed.push(...chunk); },
    })).resolves.toEqual({ rowsParsed: rows.length, bytesDownloaded: body.byteLength });
    expect(consumed).toEqual(rows);
  });

  it.each([
    ['an XML error page answered with success', Buffer.from('<?xml version="1.0"?><Error><Code>Synthetic</Code></Error>'), 'not_gzip_or_json', false],
    ['an HTML page', Buffer.from('<!doctype html><title>synthetic</title>'), 'not_gzip_or_json', false],
    ['an empty body', Buffer.alloc(0), 'empty', false],
    ['a truncated gzip stream', gzipSync(JSON.stringify(syntheticSearchTermRows(50))).subarray(0, 200), 'corrupt_gzip', true],
    ['gzip that inflates to something other than JSON', gzipSync('<html>synthetic</html>'), 'invalid_json', false],
    ['a JSON array that stops half way', Buffer.from('[{"date":"2026-09-20"},{"date":'), 'invalid_json', false],
    ['a malformed array element', Buffer.from('[{"date":"2026-09-20"} {"date":"2026-09-21"}]'), 'invalid_json', false],
    ['trailing data after the array', Buffer.from('[] []'), 'invalid_json', false],
  ] as const)('classifies %s truthfully as %s', async (_label, body, kind, retryable) => {
    const result = await outcome(gunzipJson(bytes(body), generous, { consumeRows: () => undefined }));
    expect(result).toMatchObject({ ok: false, error: expect.any(ReportPayloadFormatError) });
    const error = (result as { error: ReportPayloadFormatError }).error;
    expect(error).toMatchObject({ kind, retryable, provider: 'amazon_ads' });
    expect(error).not.toBeInstanceOf(ReportDownloadLimitError);
    expect(classifyReportLaneFailure('report.fetch', error.message).errorClass)
      .toBe(kind === 'corrupt_gzip' ? 'payload_corrupt' : 'payload_format');
  });

  it('keeps the top-level shape refusal for JSON that is not an array', async () => {
    await expect(gunzipJson(bytes(gzipSync('{"rows":[]}')), generous, { consumeRows: () => undefined }))
      .rejects.toBeInstanceOf(ReportPayloadShapeError);
  });
});

describe('WP-323 (d) a multi-member gzip stream', () => {
  it('inflates every member, including a split in the middle of a row', async () => {
    const rows = syntheticSearchTermRows(500);
    const document = Buffer.from(JSON.stringify(rows));
    const cut = Math.floor(document.byteLength / 3) + 7;
    const members = Buffer.concat([
      gzipSync(document.subarray(0, cut)),
      gzipSync(document.subarray(cut, cut * 2)),
      gzipSync(document.subarray(cut * 2)),
    ]);
    const consumed: unknown[] = [];

    await expect(gunzipJson(chunked(members, 1_000), DEFAULT_REPORT_DOWNLOAD_LIMITS, {
      consumeRows: (chunk) => { consumed.push(...chunk); },
    })).resolves.toEqual({ rowsParsed: rows.length, bytesDownloaded: members.byteLength });
    expect(consumed).toEqual(rows);
  });
});

describe('WP-323 (e) parser limits are named apart from the inflate limit', () => {
  const inflateOverflow = JSON.stringify([{ row: 'value'.repeat(20) }]);
  const failures = [
    ['inflate', gzipSync(inflateOverflow), { ...generous, maxDecompressedBytes: Buffer.byteLength(inflateOverflow) - 1 }, 'decompressed_bytes'],
    ['one oversized row', gzipSync(JSON.stringify([{ row: 'x'.repeat(300 * 1_024) }])), { ...generous, maxDecompressedBytes: 1024 * 1024 }, 'parsed_row_bytes'],
    ['too many rows', gzipSync(JSON.stringify(Array.from({ length: 100_001 }, () => 0))), { ...generous, maxCompressedBytes: 1024 * 1024, maxDecompressedBytes: 1024 * 1024 }, 'parsed_rows'],
  ] as const;

  it.each(failures)('%s fails with kind %s', async (_label, body, limits, kind) => {
    const result = await outcome(gunzipJson(bytes(body), limits, { consumeRows: () => undefined }));
    expect(result).toMatchObject({ ok: false, error: { name: 'ReportDownloadLimitError', kind } });
  });

  it('reports only the inflate overflow as decompressed_bytes', async () => {
    const kinds = await Promise.all(failures.map(async ([, body, limits]) => {
      const result = await outcome(gunzipJson(bytes(body), limits, { consumeRows: () => undefined }));
      return (result as { error: { kind?: string } }).error.kind;
    }));
    expect(kinds.filter((kind) => kind === 'decompressed_bytes')).toHaveLength(1);
    expect(new Set(kinds).size).toBe(failures.length);
  });

  it('stops the transport and closes the source when the consumer refuses mid-stream', async () => {
    const compressed = gzipSync(JSON.stringify(syntheticSearchTermRows(2_000)));
    const pieces = Array.from({ length: Math.ceil(compressed.byteLength / 2_048) },
      (_, index) => compressed.subarray(index * 2_048, (index + 1) * 2_048));
    let delivered = 0;
    let returned = 0;
    const aborted: Error[] = [];
    // A transport still in flight: after its bytes it waits for more.
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: () => delivered < pieces.length
          ? Promise.resolve({ done: false, value: pieces[delivered++]! })
          : new Promise<IteratorResult<Uint8Array>>(() => undefined),
        return: async () => { returned += 1; return { done: true, value: undefined }; },
      }),
    };
    const refusal = new Error('synthetic consumer refusal');

    await expect(gunzipJson(source, DEFAULT_REPORT_DOWNLOAD_LIMITS, {
      abortSource: (reason) => { aborted.push(reason); },
      consumeRows: () => { throw refusal; },
    })).rejects.toBe(refusal);
    expect(aborted).toEqual([refusal]);
    expect(returned).toBe(1);
  });
});
