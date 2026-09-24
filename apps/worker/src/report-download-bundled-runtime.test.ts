/**
 * WP-323 root cause, reproduced without a deployment.
 *
 * The Vercel cron lane runs this worker inside the Next.js server bundle.
 * Webpack rewrites `new Worker(new URL('./x.mjs', import.meta.url))` into a
 * worker chunk addressed through the server `publicPath` (`/_next/`) against
 * the chunks directory, so the thread is started from `file:///_next/<id>.js`,
 * a path that does not exist in the function. Node then emits `error`
 * (`MODULE_NOT_FOUND`) and `exit` with code 1 before any byte is parsed.
 *
 * The download path must not depend on starting a thread from a module URL,
 * and a parser that never ran must never be reported as the inflate limit.
 * This file replaces `node:worker_threads` with exactly that bundled
 * behaviour; the rest of the download path is real.
 */
import type * as WorkerThreads from 'node:worker_threads';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';

const { started } = vi.hoisted(() => ({ started: [] as string[] }));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerThreads>();
  const { EventEmitter } = await import('node:events');
  class BundledWorker extends EventEmitter {
    constructor(url: URL | string) {
      super();
      started.push(String(url));
      setImmediate(() => {
        this.emit('error', Object.assign(
          new Error("Cannot find module '/_next/8878.js'"),
          { code: 'MODULE_NOT_FOUND' },
        ));
        this.emit('exit', 1);
      });
    }
    postMessage(): void {}
    terminate(): Promise<number> { return Promise.resolve(1); }
  }
  return { ...actual, Worker: BundledWorker, default: { ...actual, Worker: BundledWorker } };
});

const { gunzipJson, DEFAULT_REPORT_DOWNLOAD_LIMITS } = await import('./parsers.js');

/** A synthetic three-day search-term report, the shape and size production saw. */
function syntheticSearchTermRows(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-09-${String(20 + (index % 3)).padStart(2, '0')}`,
    campaignId: `synthetic-campaign-${index % 7}`,
    adGroupId: `synthetic-group-${index % 11}`,
    keywordId: `synthetic-keyword-${index}`,
    searchTerm: `synthetic term ${index}`,
    matchType: 'EXACT',
    impressions: 100 + index,
    clicks: index % 9,
    cost: (index % 9) * 0.37,
    purchases7d: index % 2,
    sales7d: (index % 2) * 19.99,
    unitsSoldClicks7d: index % 2,
  }));
}

async function* once(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

describe('report download inside the bundled cron runtime', () => {
  it('parses a realistic small gzip report when a module-URL worker thread cannot start', async () => {
    const rows = syntheticSearchTermRows(60);
    const compressed = gzipSync(JSON.stringify(rows));
    // Production completed reports averaged about 11 KB compressed.
    expect(compressed.byteLength).toBeLessThan(DEFAULT_REPORT_DOWNLOAD_LIMITS.maxCompressedBytes);
    const consumed: unknown[] = [];

    const outcome = await gunzipJson(once(compressed), DEFAULT_REPORT_DOWNLOAD_LIMITS, {
      consumeRows: (chunk) => { consumed.push(...chunk); },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // Before WP-323 this rejected with `report download exceeded
    // decompressed_bytes limit` for every report of every size.
    expect(outcome).toEqual({
      ok: true,
      value: expect.objectContaining({ rowsParsed: rows.length, bytesDownloaded: compressed.byteLength }),
    });
    expect(consumed).toHaveLength(rows.length);
    expect(consumed).toEqual(rows);
    expect(started).toEqual([]);
  });
});
