/**
 * WP-338n: the general worker's MCF housekeeping pass over a fake clock, a fake
 * ledger and a fake webhook. Synthetic values only; no network call is made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import type { CreatorMcfAlertCode, CreatorMcfAlertSummary } from '@wizard-ads/db/worker';
import {
  MCF_ALERT_APP_URL_ENV, MCF_ALERT_WEBHOOK_ENV, MCF_HOUSEKEEPING_INTERVAL_MS, McfHousekeepingConfigError, McfHousekeepingPass,
  activeMcfAlertConditions, createMcfHousekeepingPass, formatMcfAlert, mcfHousekeepingConfigFromEnv, type McfAlertFetch,
  type McfHousekeepingConfig, type McfHousekeepingStore,
} from './mcf-housekeeping.js';

const WEBHOOK = 'https://hooks.example.test/services/T000/B000/synthetic-webhook-secret';
const SAMPLES = 'https://app.example.test/creators/samples';
const SEND_A = '33800000-0000-4000-8000-00000000000a';
const SEND_B = '33800000-0000-4000-8000-00000000000b';
const SEND_C = '33800000-0000-4000-8000-00000000000c';
const CANARY_NAME = ['Canary', 'Recipient', 'Zq7'].join(' ');
const CANARY_STREET = ['9', 'Canary', 'Lane', 'Zq7'].join(' ');
const CANARY_MASK = 'US|ZQ7|9****';

type Active = Partial<Record<CreatorMcfAlertCode, { count: number; sendIds?: string[] }>>;
const ALL: CreatorMcfAlertCode[] = ['uncertain_over_15m', 'lane_escalated', 'ladder_exhausted', 'conflict', 'heartbeat_stale', 'custody_residue',
  'authorization_failure'];
const summary = (active: Active): CreatorMcfAlertSummary => ({
  generatedAt: '2026-09-28T10:00:00.000Z',
  conditions: ALL.map((code) => ({ code, count: active[code]?.count ?? 0, sendIds: active[code]?.sendIds ?? [] })),
});

/** A settable clock and a ledger whose summary the test changes between ticks. */
function harness(options: { webhook?: string | null; fetch?: McfAlertFetch; start?: string } = {}) {
  let now = new Date(options.start ?? '2026-09-28T10:00:00.000Z');
  let current: CreatorMcfAlertSummary | (() => Promise<CreatorMcfAlertSummary>) = summary({});
  const store = {
    expire: vi.fn<McfHousekeepingStore['expire']>(async () => ({ expiredTtl: 1, expiredUnclaimed: 0, uncertainCrash: 0 })),
    purge: vi.fn<McfHousekeepingStore['purge']>(async () => ({ scheduled: 0, backstop: 0, purged: 2 })),
    alertSummary: vi.fn<McfHousekeepingStore['alertSummary']>(async () => typeof current === 'function' ? current() : current),
  };
  const fetch = vi.fn<McfAlertFetch>(options.fetch ?? (async () => ({ ok: true, status: 200, body: null })));
  const logs: { level: string; args: unknown[] }[] = [];
  const logger = {
    info: (...args: unknown[]) => { logs.push({ level: 'info', args }); },
    warn: (...args: unknown[]) => { logs.push({ level: 'warn', args }); },
    error: (...args: unknown[]) => { logs.push({ level: 'error', args }); },
  };
  const config: McfHousekeepingConfig = { webhookUrl: options.webhook === undefined ? WEBHOOK : options.webhook, samplesUrl: SAMPLES };
  const pass = new McfHousekeepingPass({ store, config, fetch, logger, now: () => now });
  return {
    pass, store, fetch, logs,
    set: (next: CreatorMcfAlertSummary | (() => Promise<CreatorMcfAlertSummary>)) => { current = next; },
    at: (iso: string) => { now = new Date(iso); },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    posted: () => fetch.mock.calls.map(([, init]) => (JSON.parse(String(init.body)) as { text: string }).text),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('custody expiry and mask purge', () => {
  it('runs the expiry sweep on every tick and reports its counts', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) {
      const tick = await h.pass.runOnce();
      expect(tick?.expire).toEqual({ expiredTtl: 1, expiredUnclaimed: 0, uncertainCrash: 0 });
      h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    }
    expect(h.store.expire).toHaveBeenCalledTimes(4);
    expect(h.pass.totals().ticks).toBe(4);
  });

  it('purges masks once per UTC day, and again on the next UTC day', async () => {
    const h = harness({ start: '2026-09-28T23:50:00.000Z' });
    const purges: unknown[] = [];
    for (const at of ['2026-09-28T23:50:00.000Z', '2026-09-28T23:55:00.000Z', '2026-09-29T00:00:00.000Z', '2026-09-29T00:05:00.000Z',
      '2026-09-29T23:59:59.999Z', '2026-09-30T00:00:00.000Z']) {
      h.at(at);
      purges.push((await h.pass.runOnce())?.purge);
    }
    const ran = { scheduled: 0, backstop: 0, purged: 2 };
    expect(purges).toEqual([ran, 'not_due', ran, 'not_due', 'not_due', ran]);
    expect(h.store.purge).toHaveBeenCalledTimes(3);
    expect(h.store.expire).toHaveBeenCalledTimes(6);
    expect(h.pass.totals().purgeRuns).toBe(3);
  });

  it('retries a failed purge on the next tick of the same day, and the tick still expires and reads the summary', async () => {
    const h = harness();
    h.store.purge.mockRejectedValueOnce(Object.assign(new Error('synthetic'), { code: '57014' }));
    const first = await h.pass.runOnce();
    expect(first).toMatchObject({ purge: 'failed', expire: { expiredTtl: 1 }, conditions: [], failures: ['purge'] });
    h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    expect((await h.pass.runOnce())?.purge).toEqual({ scheduled: 0, backstop: 0, purged: 2 });
    h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    expect((await h.pass.runOnce())?.purge).toBe('not_due');
    expect(h.store.purge).toHaveBeenCalledTimes(2);
    expect(h.pass.totals()).toMatchObject({ purgeFailures: 1, purgeRuns: 1 });
    expect(h.logs.filter((log) => log.level === 'error').map((log) => log.args)).toEqual([
      ['MCF housekeeping step failed', { step: 'purge', code: '57014' }],
    ]);
  });

  it('keeps going when the sweep fails, and marks the failure rather than reporting zero', async () => {
    const h = harness();
    h.store.expire.mockRejectedValueOnce(new Error('synthetic'));
    h.set(summary({ conflict: { count: 1, sendIds: [SEND_A] } }));
    const tick = await h.pass.runOnce();
    expect(tick).toMatchObject({ expire: 'failed', alert: 'changed', delivery: 'sent', failures: ['expire'] });
    expect(h.store.alertSummary).toHaveBeenCalledTimes(1);
    expect(h.pass.totals().expireFailures).toBe(1);
  });

  it('sends nothing when the summary cannot be read, and resumes from the same state after', async () => {
    const h = harness();
    h.set(summary({ conflict: { count: 1, sendIds: [SEND_A] } }));
    await h.pass.runOnce();
    h.set(async () => { throw new Error('synthetic'); });
    const failed = await h.pass.runOnce();
    expect(failed).toMatchObject({ conditions: 'failed', alert: 'none', delivery: 'not_due', failures: ['summary'] });
    h.set(summary({ conflict: { count: 1, sendIds: [SEND_A] } }));
    expect((await h.pass.runOnce())?.alert).toBe('none');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.pass.totals().summaryFailures).toBe(1);
  });
});

describe('alerts', () => {
  it('posts when a condition or a send appears, not while unchanged, daily while it persists, and when it clears', async () => {
    const h = harness();
    const decisions: unknown[] = [];
    const tick = async () => {
      const result = await h.pass.runOnce();
      decisions.push([result?.alert, result?.delivery]);
      h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    };
    await tick(); // 1: nothing active: the baseline, no post
    h.set(summary({ uncertain_over_15m: { count: 1, sendIds: [SEND_A] } }));
    await tick(); // 2: a condition appears
    await tick(); // 3: unchanged
    h.set(summary({ uncertain_over_15m: { count: 2, sendIds: [SEND_A, SEND_B] } }));
    await tick(); // 4: a new send under the same code
    h.set(summary({ uncertain_over_15m: { count: 1, sendIds: [SEND_A] } }));
    await tick(); // 5: a send resolved while the code stays active: no post
    h.set(summary({ uncertain_over_15m: { count: 2, sendIds: [SEND_A, SEND_B] } }));
    await tick(); // 6: the resolved send returns: it is new again
    h.set(summary({ uncertain_over_15m: { count: 1, sendIds: [SEND_A] } }));
    await tick(); // 7: resolved again: no post
    h.set(summary({ uncertain_over_15m: { count: 1, sendIds: [SEND_A] }, conflict: { count: 1, sendIds: [SEND_C] } }));
    await tick(); // 8: the set of codes changes
    h.advance(MCF_HOUSEKEEPING_INTERVAL_MS * 286);
    await tick(); // 9: 23h55m after the last post
    await tick(); // 10: exactly 24h after the last post: daily reminder
    await tick(); // 11: not again
    h.set(summary({}));
    await tick(); // 12: cleared
    await tick(); // 13: quiet
    expect(decisions).toEqual([
      ['none', 'not_due'], ['changed', 'sent'], ['none', 'not_due'], ['changed', 'sent'], ['none', 'not_due'], ['changed', 'sent'],
      ['none', 'not_due'], ['changed', 'sent'], ['none', 'not_due'], ['reminder', 'sent'], ['none', 'not_due'], ['cleared', 'sent'],
      ['none', 'not_due'],
    ]);
    expect(h.fetch).toHaveBeenCalledTimes(6);
    expect(h.pass.totals()).toMatchObject({ ticks: 13, alertsSent: 6, alertsLogged: 0, webhookFailures: 0 });
    const both = ['- uncertain_over_15m (uncertain sends or cancels unsettled for over 15 minutes): 1; sends: ' + SEND_A, `- conflict: 1; sends: ${SEND_C}`, `Samples: ${SAMPLES}`];
    expect(h.posted()).toEqual([
      ['Arcana MCF alert: 1 condition active (changed)', `- uncertain_over_15m (uncertain sends or cancels unsettled for over 15 minutes): 1; sends: ${SEND_A}`, `Samples: ${SAMPLES}`].join('\n'),
      ['Arcana MCF alert: 1 condition active (changed)', `- uncertain_over_15m (uncertain sends or cancels unsettled for over 15 minutes): 2; sends: ${SEND_A}, ${SEND_B}`, `Samples: ${SAMPLES}`].join('\n'),
      ['Arcana MCF alert: 1 condition active (changed)', `- uncertain_over_15m (uncertain sends or cancels unsettled for over 15 minutes): 2; sends: ${SEND_A}, ${SEND_B}`, `Samples: ${SAMPLES}`].join('\n'),
      ['Arcana MCF alert: 2 conditions active (changed)', ...both].join('\n'),
      ['Arcana MCF alert: 2 conditions active (daily reminder, unchanged)', ...both].join('\n'),
      ['Arcana MCF alert: no conditions active (cleared: uncertain_over_15m, conflict)', `Samples: ${SAMPLES}`].join('\n'),
    ]);
    const [url, init] = h.fetch.mock.calls[0]!;
    expect(url).toBe(WEBHOOK);
    expect(init).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' }, redirect: 'error' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('posts on the first reading after a start when something is already active', async () => {
    const h = harness();
    h.set(summary({ heartbeat_stale: { count: 1 } }));
    expect(await h.pass.runOnce()).toMatchObject({ alert: 'changed', delivery: 'sent', conditions: [{ code: 'heartbeat_stale', count: 1 }] });
    expect(h.posted()).toEqual([['Arcana MCF alert: 1 condition active (changed)', '- heartbeat_stale: 1', `Samples: ${SAMPLES}`].join('\n')]);
  });

  it('posts when a condition without send ids grows, and not when it shrinks', async () => {
    const h = harness();
    const decisions: unknown[] = [];
    for (const count of [1, 1, 2, 1, 1, 3]) {
      h.set(summary({ heartbeat_stale: { count } }));
      decisions.push((await h.pass.runOnce())?.alert);
      h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    }
    expect(decisions).toEqual(['changed', 'none', 'changed', 'none', 'none', 'changed']);
    expect(h.posted().map((text) => text.split('\n')[1])).toEqual(['- heartbeat_stale: 1', '- heartbeat_stale: 2', '- heartbeat_stale: 3']);
  });

  it('makes no network call without a webhook, and logs the message instead', async () => {
    const h = harness({ webhook: null });
    h.set(summary({ custody_residue: { count: 1, sendIds: [SEND_B] } }));
    expect(await h.pass.runOnce()).toMatchObject({ alert: 'changed', delivery: 'no_webhook' });
    h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    expect(await h.pass.runOnce()).toMatchObject({ alert: 'none', delivery: 'not_due' });
    h.set(summary({}));
    h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    expect(await h.pass.runOnce()).toMatchObject({ alert: 'cleared', delivery: 'no_webhook' });
    expect(h.fetch).toHaveBeenCalledTimes(0);
    expect(h.pass.totals()).toMatchObject({ ticks: 3, alertsSent: 0, alertsLogged: 2, webhookFailures: 0 });
    const warned = h.logs.filter((log) => log.level === 'warn');
    expect(warned).toHaveLength(2);
    expect(warned[0]!.args).toEqual(['MCF alert (no webhook configured)',
      { text: ['Arcana MCF alert: 1 condition active (changed)', `- custody_residue: 1; sends: ${SEND_B}`, `Samples: ${SAMPLES}`].join('\n') }]);
    expect(h.logs.filter((log) => log.level === 'info')).toHaveLength(3);
  });

  it('counts a failing webhook by code, never throws, keeps expiring, and retries the same alert on the next tick', async () => {
    const answers: (() => Promise<{ ok: boolean; status: number; body: null }>)[] = [
      async () => ({ ok: false, status: 500, body: null }),
      async () => { throw new TypeError('fetch failed'); },
      async () => { throw new DOMException('timed out', 'TimeoutError'); },
      async () => ({ ok: true, status: 200, body: null }),
    ];
    const h = harness({ fetch: async () => answers.shift()!() });
    h.set(summary({ ladder_exhausted: { count: 1, sendIds: [SEND_A] } }));
    const deliveries: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const tick = await h.pass.runOnce();
      deliveries.push([tick?.alert, tick?.delivery, tick?.failures]);
      h.advance(MCF_HOUSEKEEPING_INTERVAL_MS);
    }
    expect(deliveries).toEqual([
      ['changed', 'failed', ['webhook_http']], ['changed', 'failed', ['webhook_network']], ['changed', 'failed', ['webhook_timeout']],
      ['changed', 'sent', []], ['none', 'not_due', []],
    ]);
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.store.expire).toHaveBeenCalledTimes(5);
    expect(h.pass.totals()).toMatchObject({ ticks: 5, webhookFailures: 3, alertsSent: 1 });
    expect(h.logs.filter((log) => log.level === 'error').map((log) => log.args)).toEqual([
      ['MCF alert webhook failed', { code: 'webhook_http', status: 500, webhookFailures: 1 }],
      ['MCF alert webhook failed', { code: 'webhook_network', status: null, webhookFailures: 2 }],
      ['MCF alert webhook failed', { code: 'webhook_timeout', status: null, webhookFailures: 3 }],
    ]);
    expect(JSON.stringify(h.logs)).not.toContain('synthetic-webhook-secret');
  });

  it('never lets a recipient, mask or address canary into a message or a log', async () => {
    const canaries = [CANARY_NAME, CANARY_STREET, CANARY_MASK];
    const h = harness({ fetch: async () => { throw new Error(`echo ${CANARY_NAME}`); } });
    h.store.expire.mockRejectedValueOnce(Object.assign(new Error(`row for ${CANARY_STREET}`), { code: `bad ${CANARY_NAME}` }));
    h.store.purge.mockRejectedValueOnce(new Error(`mask ${CANARY_MASK}`));
    h.set(async () => ({
      generatedAt: '2026-09-28T10:00:00.000Z',
      conditions: [
        { code: 'conflict', count: 3, sendIds: [SEND_A, CANARY_NAME, `${SEND_B} ${CANARY_STREET}`] },
        { code: CANARY_MASK as CreatorMcfAlertCode, count: 1, sendIds: [CANARY_STREET] },
        { code: 'uncertain_over_15m', count: 0, sendIds: [CANARY_NAME] },
      ],
    }));
    const first = await h.pass.runOnce();
    expect(first).toMatchObject({ expire: 'failed', purge: 'failed', alert: 'changed', delivery: 'failed',
      conditions: [{ code: 'conflict', count: 3 }, { code: 'unknown_condition', count: 1 }] });
    // A second tick without a webhook sends the same message to the log.
    const logged = harness({ webhook: null });
    logged.set(async () => ({ generatedAt: '2026-09-28T10:00:00.000Z', conditions: [
      { code: 'conflict', count: 3, sendIds: [SEND_A, CANARY_NAME] }, { code: CANARY_MASK as CreatorMcfAlertCode, count: 1, sendIds: [] }] }));
    await logged.pass.runOnce();
    const outputs = [...h.fetch.mock.calls.map(([, init]) => String(init.body)), JSON.stringify(h.logs), JSON.stringify(logged.logs)];
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.posted()).toEqual([['Arcana MCF alert: 2 conditions active (changed)',
      `- conflict: 3; sends: ${SEND_A} (2 more not listed) (2 malformed ids withheld)`, '- unknown_condition: 1 (1 malformed ids withheld)',
      `Samples: ${SAMPLES}`].join('\n')]);
    // Every canary whole, and each distinctive word, in plain, case-folded, base64, base64url, hex and URL-encoded forms.
    const tokens = [...canaries, 'Canary', 'Recipient', 'Zq7'];
    let scanned = 0;
    for (const token of tokens) {
      const forms = [token, Buffer.from(token).toString('base64'), Buffer.from(token).toString('base64url'), Buffer.from(token).toString('hex'),
        encodeURIComponent(token)];
      for (const output of outputs) {
        for (const form of forms) { expect(output.toLowerCase()).not.toContain(form.toLowerCase()); scanned++; }
      }
    }
    expect(scanned).toBe(6 * 5 * 3);
  });
});

describe('scheduling and runtime', () => {
  it('does not exist, and touches nothing, on a runtime that does not start background passes', () => {
    const handle = new Proxy({}, { get: () => { throw new Error('the database must not be touched'); } }) as unknown as DbHandle;
    expect(createMcfHousekeepingPass(handle, { [MCF_ALERT_WEBHOOK_ENV]: WEBHOOK }, false)).toBeUndefined();
    expect(createMcfHousekeepingPass(handle, {}, true)).toBeInstanceOf(McfHousekeepingPass);
  });

  it('without a webhook, the production pass reads the ledger through its wrappers and never calls fetch', async () => {
    const queries: string[] = [];
    const answer = (text: string): unknown => {
      if (text.includes('app.expire_creator_mcf_custody()')) return { expiredTtl: 0, expiredUnclaimed: 1, uncertainCrash: 0 };
      if (text.includes('app.purge_creator_mcf_masks()')) return { scheduled: 1, backstop: 0, purged: 1 };
      if (text.includes('app.creator_mcf_alert_summary()')) return summary({ conflict: { count: 1, sendIds: [SEND_A] } });
      throw new Error('unexpected query');
    };
    const sql = (strings: TemplateStringsArray) => { const text = strings.join('?'); queries.push(text); return Promise.resolve([{ result: answer(text) }]); };
    const handle = { sql } as unknown as DbHandle;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in tests'));
    const logs: unknown[][] = [];
    const logger = { info: (...args: unknown[]) => { logs.push(args); }, warn: (...args: unknown[]) => { logs.push(args); },
      error: (...args: unknown[]) => { logs.push(args); } };
    try {
      const pass = createMcfHousekeepingPass(handle, {}, true, { logger, now: () => new Date('2026-09-28T10:00:00.000Z') })!;
      pass.start();
      await pass.stop();
      expect(fetchSpy).toHaveBeenCalledTimes(0);
    } finally { fetchSpy.mockRestore(); }
    expect(queries).toHaveLength(3);
    expect(logs[0]).toEqual(['MCF alerts carry a relative samples link', { missing: 'WIZARD_ADS_APP_URL' }]);
    expect(logs).toContainEqual(['MCF alert (no webhook configured)',
      { text: ['Arcana MCF alert: 1 condition active (changed)', `- conflict: 1; sends: ${SEND_A}`, 'Samples: /creators/samples'].join('\n') }]);
    expect(logs).toContainEqual(['MCF housekeeping', expect.objectContaining({ expire: { expiredTtl: 0, expiredUnclaimed: 1, uncertainCrash: 0 },
      purge: { scheduled: 1, backstop: 0, purged: 1 }, alert: 'changed', delivery: 'no_webhook' })]);
  });

  it('ticks at start and then every 5 minutes until stopped', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.pass.start();
    h.pass.start(); // a second start is ignored
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.expire).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MCF_HOUSEKEEPING_INTERVAL_MS * 3);
    expect(h.store.expire).toHaveBeenCalledTimes(4);
    await h.pass.stop();
    await vi.advanceTimersByTimeAsync(MCF_HOUSEKEEPING_INTERVAL_MS * 3);
    expect(h.store.expire).toHaveBeenCalledTimes(4);
  });

  it('waits for a tick in progress when stopped', async () => {
    const h = harness();
    let release!: () => void;
    h.store.alertSummary.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(summary({})); }));
    const tick = h.pass.runOnce();
    await vi.waitFor(() => expect(h.store.alertSummary).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = h.pass.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    expect(await tick).toMatchObject({ conditions: [] });
  });

  it('skips a tick while the previous one is still running', async () => {
    const h = harness();
    let release!: () => void;
    h.store.expire.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ expiredTtl: 0, expiredUnclaimed: 0, uncertainCrash: 0 }); }));
    const first = h.pass.runOnce();
    expect(await h.pass.runOnce()).toBeNull();
    release();
    expect(await first).toMatchObject({ expire: { expiredTtl: 0 } });
    expect(h.store.expire).toHaveBeenCalledTimes(1);
  });
});

describe('environment', () => {
  it('treats an absent or empty webhook as no webhook, and builds the samples URL from the app origin', () => {
    expect(mcfHousekeepingConfigFromEnv({})).toEqual({ webhookUrl: null, samplesUrl: '/creators/samples' });
    expect(mcfHousekeepingConfigFromEnv({ [MCF_ALERT_WEBHOOK_ENV]: '  ', [MCF_ALERT_APP_URL_ENV]: '' }))
      .toEqual({ webhookUrl: null, samplesUrl: '/creators/samples' });
    expect(mcfHousekeepingConfigFromEnv({ [MCF_ALERT_WEBHOOK_ENV]: ` ${WEBHOOK} `, [MCF_ALERT_APP_URL_ENV]: 'https://app.example.test/' }))
      .toEqual({ webhookUrl: WEBHOOK, samplesUrl: SAMPLES });
  });

  it('refuses a webhook that is not https or carries credentials, without echoing the value', () => {
    const bad = ['http://hooks.example.test/services/synthetic-webhook-secret', 'synthetic-webhook-secret',
      'https://user:synthetic-webhook-secret@hooks.example.test/x', 'https://hooks.example.test/x#synthetic-webhook-secret'];
    let refused = 0;
    for (const value of bad) {
      try { mcfHousekeepingConfigFromEnv({ [MCF_ALERT_WEBHOOK_ENV]: value }); }
      catch (error) {
        expect(error).toBeInstanceOf(McfHousekeepingConfigError);
        expect((error as Error).message).toBe('OPENSPELL_MCF_ALERT_WEBHOOK_URL must be an https URL without credentials or fragment');
        refused++;
      }
    }
    expect(refused).toBe(bad.length);
  });

  it('refuses an app URL with a path or query, or that is not https outside localhost', () => {
    const bad = ['https://app.example.test/creators', 'https://app.example.test/?x=1', 'ftp://app.example.test', 'app.example.test',
      'http://app.example.test'];
    for (const value of bad) {
      expect(() => mcfHousekeepingConfigFromEnv({ [MCF_ALERT_APP_URL_ENV]: value }))
        .toThrow('WIZARD_ADS_APP_URL must be an https origin without a path (http only for localhost)');
    }
    expect(mcfHousekeepingConfigFromEnv({ [MCF_ALERT_APP_URL_ENV]: 'http://localhost:3000' }).samplesUrl).toBe('http://localhost:3000/creators/samples');
  });
});

describe('message building', () => {
  it('keeps active conditions only, in a fixed order, and withholds anything that is not a UUID', () => {
    const active = activeMcfAlertConditions({ generatedAt: '2026-09-28T10:00:00.000Z', conditions: [
      { code: 'authorization_failure', count: 2, sendIds: [SEND_C] },
      { code: 'conflict', count: 0, sendIds: [] },
      { code: 'uncertain_over_15m', count: 1, sendIds: [SEND_A, 'not-a-uuid'] },
      { code: 'custody_residue', count: Number.NaN, sendIds: [] },
    ] });
    expect(active).toEqual([
      { code: 'uncertain_over_15m', count: 1, sendIds: [SEND_A], sendIdsWithheld: 1 },
      { code: 'authorization_failure', count: 2, sendIds: [SEND_C], sendIdsWithheld: 0 },
    ]);
    expect(formatMcfAlert('changed', active, '/creators/samples', [])).toBe([
      'Arcana MCF alert: 2 conditions active (changed)', `- uncertain_over_15m (uncertain sends or cancels unsettled for over 15 minutes): 1; sends: ${SEND_A} (1 malformed ids withheld)`,
      `- authorization_failure: 2; sends: ${SEND_C} (1 more not listed)`, 'Samples: /creators/samples'].join('\n'));
  });
});
