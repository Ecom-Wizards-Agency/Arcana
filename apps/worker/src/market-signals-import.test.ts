import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { KEEPA_EPOCH_MS, parseProduct } from '@wizard-ads/keepa-api';
import { MarketSignalsRecord, MarketSignalsSignal } from '@wizard-ads/shared';
import { MarketSignalsMapError } from '@wizard-ads/db/worker';
import { closeServer, startHealthServer } from './health.js';
import { detectForProduct } from './keepa.js';
import {
  DEFAULT_MARKET_SIGNALS_ORG_KEY,
  MarketSignalsImportPass,
  createMarketSignalsImportPass,
  detectImportedPriceEvents,
  emptyMarketSignalsCounts,
  marketSignalsImportConfigFromEnv,
  parseMarketSignalsFile,
  signalInsightRow,
  sortMarketSignalsFiles,
} from './market-signals-import.js';
import { runMarketSignalsImportCli } from './market-signals-import-cli.js';
import { runMarketSignalsMapCli } from './market-signals-map-cli.js';
import {
  FIXTURE_HERO_SIGNAL_ID,
  FIXTURE_RIVAL_ASIN,
  FIXTURE_RIVAL_TIMES,
  exportId,
  firstBatch,
  secondBatch,
  toNdjson,
  uuid5,
} from './market-signals-import.fixture.js';
import type { SyncWorker } from './worker.js';

const ORG = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('market signals import configuration', () => {
  it('is off without the directory and parses the org-key map', () => {
    expect(marketSignalsImportConfigFromEnv({})).toEqual({ directory: null, orgKeys: new Map() });
    const config = marketSignalsImportConfigFromEnv({
      OPENSPELL_MARKET_SIGNALS_DIR: ' /srv/market-signals ',
      OPENSPELL_MARKET_SIGNALS_ORG_KEYS: `synthetic-org=${ORG.toUpperCase()}, other=${ORG}`,
    });
    expect(config.directory).toBe('/srv/market-signals');
    expect([...config.orgKeys]).toEqual([['synthetic-org', ORG], ['other', ORG]]);
  });

  it.each(['synthetic-org', 'synthetic-org=not-a-uuid', `=${ORG}`, `a=${ORG},a=${ORG}`])('refuses the malformed map %s', (value) => {
    expect(() => marketSignalsImportConfigFromEnv({ OPENSPELL_MARKET_SIGNALS_ORG_KEYS: value }))
      .toThrow('OPENSPELL_MARKET_SIGNALS_ORG_KEYS must be key=uuid');
  });

  it('registers the pass only on a background-pass runtime with the directory set', () => {
    const handle = {} as DbHandle;
    expect(createMarketSignalsImportPass(handle, {}, true)).toBeUndefined();
    expect(createMarketSignalsImportPass(handle, { OPENSPELL_MARKET_SIGNALS_DIR: '  ' }, true)).toBeUndefined();
    expect(createMarketSignalsImportPass(handle, { OPENSPELL_MARKET_SIGNALS_DIR: '/srv/ms' }, false)).toBeUndefined();
    // An unused malformed map does not stop a worker whose import is off.
    expect(createMarketSignalsImportPass(handle, { OPENSPELL_MARKET_SIGNALS_ORG_KEYS: 'bad' }, true)).toBeUndefined();
    expect(() => createMarketSignalsImportPass(handle, { OPENSPELL_MARKET_SIGNALS_DIR: '/srv/ms', OPENSPELL_MARKET_SIGNALS_ORG_KEYS: 'bad' }, true)).toThrow();
    expect(createMarketSignalsImportPass(handle, { OPENSPELL_MARKET_SIGNALS_DIR: '/srv/ms' }, true)).toBeInstanceOf(MarketSignalsImportPass);
    const main = source('./main.ts');
    expect(main).toContain('createMarketSignalsImportPass(handle, process.env, config.startsBackgroundPasses)');
    expect(main).toContain('marketSignalsImport?.start();');
    expect(main).toContain('await marketSignalsImport?.stop();');
    expect(main).toMatch(/startHealthServer\([\s\S]*?marketSignalsImport,\s*\}, config\.healthHost\)/);
    expect(DEFAULT_MARKET_SIGNALS_ORG_KEY).toBe('ecom-wizards');
  });
});

describe('market signals fixture and parsing', () => {
  it('builds valid synthetic records whose ids derive the way the exporter derives them', () => {
    const records = [...firstBatch(), ...secondBatch()];
    expect(records).toHaveLength(18);
    expect(records.filter((record) => !MarketSignalsRecord.safeParse(record).success)).toEqual([]);
    const kinds = records.reduce<Record<string, number>>((counts, record) => ({ ...counts, [String(record['kind'])]: (counts[String(record['kind'])] ?? 0) + 1 }), {});
    expect(kinds).toEqual({ header: 2, observation: 6, change_point: 7, signal: 3 });
    // The hand-off's published examples fix the derivation.
    expect(uuid5('signal/family/buybox')).toBe('6c124524-519b-5002-a562-538bd1ceee41');
    expect(exportId('observation', 'US', 'B0HERO0001', '2026-09-25T00:00:00Z')).toBe('0c92ced4-e2c4-5b67-8f11-46301f618a3d');
    expect(uuid5('Example Brand|US|ASIN:B0HERO0001|buybox_lost|2026-09-24T23:00Z')).toBe('3dd12852-0b86-5a67-b42e-cb204ffaecd9');
    expect(FIXTURE_HERO_SIGNAL_ID).toBe(uuid5('Synthetic Store|US|ASIN:B0SYNHERO1|buybox_lost|2026-09-24T23:00Z'));
  });

  it('splits batches, counts invalid lines and keeps going', () => {
    const [header, ...records] = firstBatch();
    const lines = [JSON.stringify({ kind: 'observation', note: 'before any header' }), JSON.stringify(header),
      ...records.map((record) => JSON.stringify(record))];
    // Two broken lines inside the batch, the header counts them.
    lines.splice(3, 1, '{not json');
    lines.splice(5, 1, JSON.stringify({ ...records[3], org_key: 'another-org' }));
    const parsed = parseMarketSignalsFile(Buffer.from(lines.join('\n') + '\n'));
    expect(parsed.orphanInvalid).toBe(1);
    expect(parsed.batches).toHaveLength(1);
    const [batch] = parsed.batches;
    expect(batch).toMatchObject({ lines: 15, invalid: 2, incomplete: false, countMismatch: false });
    expect([batch!.observations.length, batch!.changePoints.length, batch!.signals.length]).toEqual([4, 7, 2]);
    expect(parsed.completeBytes).toBe(Buffer.byteLength(lines.join('\n') + '\n'));
  });

  it('flags a complete batch whose lines disagree with its header', () => {
    const [header, ...records] = firstBatch();
    const parsed = parseMarketSignalsFile(Buffer.from(toNdjson([header!, ...records.slice(1), ...secondBatch()])));
    expect(parsed.batches.map((batch) => [batch.lines, batch.incomplete, batch.countMismatch])).toEqual([[14, false, true], [1, false, false]]);
    expect(parsed.batches[0]!.invalid).toBe(0);
  });

  it('waits for a trailing batch still being written and ignores a partial last line', () => {
    const complete = toNdjson(firstBatch());
    const [header, ...records] = secondBatch();
    const partial = `${JSON.stringify(header)}\n${JSON.stringify(records[0]).slice(0, 40)}`;
    const parsed = parseMarketSignalsFile(Buffer.from(complete + partial));
    expect(parsed.batches.map((batch) => [batch.incomplete, batch.countMismatch])).toEqual([[false, false], [true, false]]);
    expect(parsed.completeBytes).toBe(Buffer.byteLength(complete) + Buffer.byteLength(JSON.stringify(header)) + 1);
    expect(parsed.batches[0]!.endOffset).toBe(Buffer.byteLength(complete));
  });

  it('refuses an observation Arcana cannot store', () => {
    const [header, ...records] = firstBatch();
    const lines = [header!, { ...records[0], price: 1e10 }, { ...records[1], bsr: 2 ** 31 }, ...records.slice(2)];
    const [batch] = parseMarketSignalsFile(Buffer.from(toNdjson(lines))).batches;
    expect(batch).toMatchObject({ invalid: 2, lines: 15, countMismatch: false });
    expect(batch!.observations).toHaveLength(4);
  });

  it('refuses every record under an invalid header', () => {
    const [header, ...records] = firstBatch();
    const text = toNdjson([{ ...header, schema: 'market-signals/1' }, ...records, ...secondBatch()]);
    const parsed = parseMarketSignalsFile(Buffer.from(text));
    expect(parsed.orphanInvalid).toBe(1 + records.length);
    expect(parsed.batches).toHaveLength(1);
    expect(parsed.batches[0]!.signals.map((signal) => signal.status)).toEqual(['resolved']);
  });

  it('orders files by date, the day file before a snapshot of the same date', () => {
    expect(sortMarketSignalsFiles([
      { name: 'full-2026-09-25.ndjson' }, { name: '2026-09-26.ndjson' }, { name: '2026-09-25.ndjson' }, { name: 'full-2026-09-24.ndjson' },
    ]).map((file) => file.name)).toEqual(['full-2026-09-24.ndjson', '2026-09-25.ndjson', 'full-2026-09-25.ndjson', '2026-09-26.ndjson']);
  });
});

describe('competitor price events reuse the keepa.sync rule', () => {
  const history = FIXTURE_RIVAL_TIMES.map((time, index) => ({
    marketplace: 'US', asin: FIXTURE_RIVAL_ASIN, observedAt: new Date(time), category: '11',
    price: [21, 21, 16, 21][index]!, buyBoxPrice: [20, 20, 15, 20][index]!,
  }));

  it('decides a drop and a restore on consecutive imported observations', () => {
    const decided = history.map((_, index) => detectImportedPriceEvents(history, index));
    expect(decided.map((events) => events.map((event) => event.eventKind))).toEqual([[], [], ['price_drop'], ['price_restore']]);
    expect(decided[2]![0]).toMatchObject({ asin: FIXTURE_RIVAL_ASIN, price: 15, baselinePrice: 20,
      detectedAt: new Date(FIXTURE_RIVAL_TIMES[2]), details: { previousPrice: 20, marketplace: 'US', source: 'market-signals/2' } });
    expect(decided[3]![0]).toMatchObject({ price: 20, baselinePrice: 17.5, details: { previousPrice: 15 } });
  });

  it('compares with the last price that had an offer, as keepa.sync stores it', () => {
    // Buy Box 20 then 25, then gone twice while the new price sits at 15.
    const gaps = [[20, 21], [25, 26], [null, 15], [null, 15]].map(([buyBoxPrice, price], index) => ({
      marketplace: 'US', asin: FIXTURE_RIVAL_ASIN, observedAt: new Date(Date.UTC(2026, 8, 24, 20 + index)), category: '11',
      price: price!, buyBoxPrice: buyBoxPrice ?? null,
    }));
    // Keepa still reports 25 as the Buy Box; the previous record also holds 25, so nothing moved.
    expect(gaps.map((_, index) => detectImportedPriceEvents(gaps, index).map((event) => event.eventKind))).toEqual([[], [], [], []]);
  });

  it('matches what keepa.sync decides from the equivalent Keepa product', () => {
    const minutes = (time: string) => (Date.parse(time) - KEEPA_EPOCH_MS) / 60_000;
    const [t1, , t3] = FIXTURE_RIVAL_TIMES;
    const raw = {
      asin: FIXTURE_RIVAL_ASIN, salesRankReference: 11, lastUpdate: minutes(t3),
      csv: Object.assign(new Array(19).fill(null), { 1: [minutes(t1), 2100, minutes(t3), 1600], 18: [minutes(t1), 2000, 0, minutes(t3), 1500, 0] }),
    };
    const previous = { asin: FIXTURE_RIVAL_ASIN, observedAt: new Date(FIXTURE_RIVAL_TIMES[1]), category: '11', price: 21, buyBoxPrice: 20, lightningDeal: null, coupon: null };
    const viaKeepa = detectForProduct(parseProduct(raw, Date.parse(t3)), previous, new Date(t3));
    const viaImport = detectImportedPriceEvents(history, 2).map(({ details, ...event }) => ({
      ...event, details: { previousPrice: details['previousPrice'] },
    }));
    expect(viaKeepa).toHaveLength(1);
    expect(viaImport).toEqual(viaKeepa);
  });
});

describe('signal to insight mapping', () => {
  it('maps id, date, kind, text and figures, keeping an overwritten evidence key', () => {
    const signal = MarketSignalsSignal.parse(firstBatch().find((record) => record['id'] === FIXTURE_HERO_SIGNAL_ID));
    const row = signalInsightRow(signal, 'profile-1', '2026-09-25T02:00:00Z');
    expect(row).toEqual({
      id: FIXTURE_HERO_SIGNAL_ID, profileId: 'profile-1', date: '2026-09-24', kind: 'market_signal.buybox_lost',
      title: signal.summary, body: signal.summary,
      figures: {
        holder: 'third_party', figures_holder: 'A0SYNTHOTHER1', ours: 'A0SYNTHOURS01', since: '2026-09-24T23:00:00+00:00',
        status: 'open', band: 4, route: 'now', family: 'buybox', hero: true, resolved_at: null,
        marketplace: 'US', asin: signal.asin, profile_key: 'synthetic-us', batch_generated_at: '2026-09-25T02:00:00Z',
      },
    });
  });
});

describe('market signals pass and counters', () => {
  const counts = (overrides: Partial<ReturnType<typeof emptyMarketSignalsCounts>>) => ({ ...emptyMarketSignalsCounts(), ...overrides });

  it('accumulates counters, reports data-as-of and survives a failed pass', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(counts({ filesSeen: 1, batchesImported: 1, observations: 6, signals: 2, unmappedSignals: 1, stateGeneratedAt: '2026-09-25T01:00:00Z' }))
      .mockRejectedValueOnce(new Error('synthetic database outage'))
      .mockResolvedValueOnce(counts({ filesSeen: 1, batchesImported: 1, signals: 1, invalidRecords: 2, stateGeneratedAt: '2026-09-25T02:00:00Z' }));
    const logger = { info: vi.fn(), error: vi.fn() };
    const pass = new MarketSignalsImportPass({ run }, logger, 60_000, () => new Date('2026-09-25T03:00:00Z'));
    const refused = new MarketSignalsImportPass({ run: async () => counts({ batchesFailed: 1 }) }, logger, 60_000);
    await refused.runOnce();
    expect(refused.status()).toMatchObject({ consecutiveFailures: 1, lastSuccessAt: null, totals: { batchesFailed: 1 } });
    const unreadable = new MarketSignalsImportPass({ run: async () => counts({ filesFailed: 1, batchesImported: 1 }) }, logger, 60_000);
    await unreadable.runOnce();
    expect(unreadable.status()).toMatchObject({ consecutiveFailures: 1, totals: { filesFailed: 1, batchesImported: 1 } });
    await pass.runOnce();
    await pass.runOnce();
    expect(pass.status()).toMatchObject({ consecutiveFailures: 1, lastErrorAt: '2026-09-25T03:00:00.000Z' });
    expect(logger.error).toHaveBeenCalledWith('Market signals import failed', { error: 'Error', consecutiveFailures: 1 });
    await pass.runOnce();
    const status = pass.status();
    expect(status).toMatchObject({ enabled: true, running: false, consecutiveFailures: 0, dataAsOf: '2026-09-25T02:00:00Z' });
    expect(status.totals).toMatchObject({ filesSeen: 2, batchesImported: 2, observations: 6, signals: 3, unmappedSignals: 1, invalidRecords: 2 });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('runs one pass at a time and waits for it on stop', async () => {
    let finish: (value: ReturnType<typeof emptyMarketSignalsCounts>) => void = () => {};
    const run = vi.fn(() => new Promise<ReturnType<typeof emptyMarketSignalsCounts>>((resolve) => { finish = resolve; }));
    const pass = new MarketSignalsImportPass({ run }, { info: vi.fn(), error: vi.fn() }, 60_000);
    pass.start();
    expect(pass.status().running).toBe(true);
    expect(await pass.runOnce()).toBeNull();
    let stopped = false;
    const stopping = pass.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish(counts({ filesSeen: 1 }));
    await stopping;
    expect(pass.status()).toMatchObject({ running: false, totals: { filesSeen: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('publishes the counters on /healthz without changing readiness', async () => {
    const worker = { status: () => ({ workerId: 'synthetic', stopping: false, running: 0, claimLoop: {
      phase: 'idle_wait', ready: true, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, failureKind: null, retryInMs: null,
    } }) } as unknown as SyncWorker;
    const deployment = { revision: 'abcdef1234567', role: 'general' as const, claimProtocol: 'legacy' as const, jobTypes: 'all' as const };
    const pass = new MarketSignalsImportPass({ run: async () => counts({ batchesImported: 1, stateGeneratedAt: '2026-09-25T01:00:00Z' }) }, { info: vi.fn(), error: vi.fn() });
    await pass.runOnce();
    const failing = new MarketSignalsImportPass({ run: async () => { throw new Error('down'); } }, { info: vi.fn(), error: vi.fn() });
    await failing.runOnce();
    const servers = await Promise.all([
      startHealthServer(worker, 0, { deployment, marketSignalsImport: pass }, '127.0.0.1'),
      startHealthServer(worker, 0, { deployment, marketSignalsImport: failing }, '127.0.0.1'),
      startHealthServer(worker, 0, { deployment }, '127.0.0.1'),
    ]);
    try {
      const bodies = await Promise.all(servers.map(async (server) => {
        const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/healthz`);
        return { status: response.status, body: await response.json() as { components: { marketSignalsImport: Record<string, unknown> } } };
      }));
      expect(bodies.map((entry) => entry.status)).toEqual([200, 200, 200]);
      expect(bodies[0]!.body.components.marketSignalsImport).toMatchObject({ enabled: true, dataAsOf: '2026-09-25T01:00:00Z', totals: { batchesImported: 1 } });
      expect(bodies[1]!.body.components.marketSignalsImport).toMatchObject({ enabled: true, consecutiveFailures: 1 });
      expect(bodies[2]!.body.components.marketSignalsImport).toEqual({ enabled: false });
    } finally {
      await Promise.all(servers.map(closeServer));
    }
  });
});

describe('market signals CLIs', () => {
  const env = { OPENSPELL_MARKET_SIGNALS_DIR: '/srv/ms', DATABASE_URL: 'postgres://synthetic@127.0.0.1:1/synthetic' };
  const importDeps = (result: () => Promise<ReturnType<typeof emptyMarketSignalsCounts>>) => ({
    run: vi.fn(result), write: vi.fn(), error: vi.fn(),
  });

  it('exits 2 on usage or configuration errors without touching the database', async () => {
    const deps = importDeps(async () => emptyMarketSignalsCounts());
    expect(await runMarketSignalsImportCli([], env, deps)).toBe(2);
    expect(await runMarketSignalsImportCli(['--once', '--later'], env, deps)).toBe(2);
    expect(await runMarketSignalsImportCli(['--once', '--once'], env, deps)).toBe(2);
    expect(await runMarketSignalsImportCli(['--once'], { DATABASE_URL: env.DATABASE_URL }, deps)).toBe(2);
    expect(await runMarketSignalsImportCli(['--once'], { ...env, OPENSPELL_MARKET_SIGNALS_ORG_KEYS: 'bad' }, deps)).toBe(2);
    expect(await runMarketSignalsImportCli(['--once'], { OPENSPELL_MARKET_SIGNALS_DIR: '/srv/ms' }, deps)).toBe(2);
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledTimes(6);
  });

  it('exits 0 when every batch is accounted for, 3 with findings and 1 on failure', async () => {
    const clean = importDeps(async () => emptyMarketSignalsCounts());
    expect(await runMarketSignalsImportCli(['--', '--once'], env, clean)).toBe(0);
    expect(clean.run).toHaveBeenCalledWith(expect.objectContaining({ directory: '/srv/ms' }));
    expect(JSON.parse(String(clean.write.mock.calls[0]![0]))).toMatchObject({ batchesImported: 0 });
    for (const finding of [{ invalidRecords: 1 }, { batchesCountMismatch: 1 }, { batchesUnmappedOrg: 1 }]) {
      expect(await runMarketSignalsImportCli(['--once'], env, importDeps(async () => ({ ...emptyMarketSignalsCounts(), ...finding })))).toBe(3);
    }
    // Profiles not yet mapped are normal, not a finding; a refused batch is a failure.
    expect(await runMarketSignalsImportCli(['--once'], env, importDeps(async () => ({ ...emptyMarketSignalsCounts(), unmappedSignals: 4 })))).toBe(0);
    expect(await runMarketSignalsImportCli(['--once'], env, importDeps(async () => ({ ...emptyMarketSignalsCounts(), batchesFailed: 1, invalidRecords: 2 })))).toBe(1);
    expect(await runMarketSignalsImportCli(['--once'], env, importDeps(async () => ({ ...emptyMarketSignalsCounts(), filesFailed: 1 })))).toBe(1);
    const failing = importDeps(async () => { throw new Error('synthetic outage'); });
    expect(await runMarketSignalsImportCli(['--once'], env, failing)).toBe(1);
    expect(failing.error).toHaveBeenCalledWith('Market signals import failed (Error)');
  });

  it('maps a profile with exit 0, refuses an unknown one with 3 and bad usage with 2', async () => {
    const row = { orgId: ORG, profileKey: 'synthetic-us', profileId: ORG, createdAt: 'now', updatedAt: 'now' };
    const args = ['--org', 'synthetic', '--profile-key', 'synthetic-us', '--profile', 'Synthetic US'];
    const ok = { map: vi.fn(async () => ({ row, insightsAttached: 2 })), write: vi.fn(), error: vi.fn() };
    expect(await runMarketSignalsMapCli(args, env, ok)).toBe(0);
    expect(ok.map).toHaveBeenCalledWith({ orgSlug: 'synthetic', profileKey: 'synthetic-us', profile: 'Synthetic US' }, env.DATABASE_URL);
    expect(JSON.parse(String(ok.write.mock.calls[0]![0]))).toEqual({ orgId: ORG, profileKey: 'synthetic-us', profileId: ORG, insightsAttached: 2 });
    const missing = { map: vi.fn(async () => { throw new MarketSignalsMapError('No profile', 'profile_not_found'); }), write: vi.fn(), error: vi.fn() };
    expect(await runMarketSignalsMapCli(args, env, missing)).toBe(3);
    const broken = { map: vi.fn(async () => { throw new Error('outage'); }), write: vi.fn(), error: vi.fn() };
    expect(await runMarketSignalsMapCli(args, env, broken)).toBe(1);
    expect(await runMarketSignalsMapCli(['--org', 'synthetic'], env, ok)).toBe(2);
    expect(await runMarketSignalsMapCli([...args, '--org', 'again'], env, ok)).toBe(2);
    expect(ok.map).toHaveBeenCalledTimes(1);
  });
});
