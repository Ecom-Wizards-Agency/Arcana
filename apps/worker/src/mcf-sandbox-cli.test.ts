/**
 * WP-338k: the sandbox harness never calls a host other than the NA SP-API
 * sandbox (and LWA), refuses to run without its configuration, and never
 * prints the synthetic recipient. Every Amazon answer here comes from an
 * in-memory fake; nothing reaches a network.
 */
import { readFileSync } from 'node:fs';
import { SP_MARKETPLACE_MONEY_RULES, type CreatorSampleOrderKey } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import {
  MCF_SANDBOX_ENDPOINT, MCF_SANDBOX_EXIT, MCF_SANDBOX_LWA_TOKEN_URL, MCF_SANDBOX_SPACING_MS, MCF_SANDBOX_THROTTLE_READS,
  McfSandboxError, mcfSandboxGuard, mcfSandboxLine, mcfSandboxRecipientScreen, mcfSandboxRequestAllowed, omitActionAndPolicy,
  parseMcfSandboxConfig, runMcfSandbox, type McfSandboxDependencies,
} from './mcf-sandbox-cli.js';

// Synthetic values assembled at runtime; none is a real id, address or credential.
const ORG = '0f0e0d0c-0b0a-4908-8706-' + '0504030201aa';
const CONNECTION = '0f0e0d0c-0b0a-4908-8706-' + '0504030201bb';
const marketplaceIn = (region: string): string => Object.entries(SP_MARKETPLACE_MONEY_RULES).find(([, rule]) => rule.region === region)![0];
const NA = marketplaceIn('NA');
const EU = marketplaceIn('EU');
const RECIPIENT = {
  name: 'Zephyrine Quartzwell',
  addressLine1: '77 Brambleholt Lane',
  city: 'Vellumford',
  stateOrRegion: 'WA',
  postalCode: '98001',
  countryCode: 'US',
};
const RECIPIENT_TOKENS = ['Zephyrine', 'Quartzwell', 'Brambleholt', 'Vellumford'];
const SKU = 'SYNTH-SKU-0001';
const CONFIG = { endpoint: MCF_SANDBOX_ENDPOINT, orgId: ORG, scope: `${CONNECTION}:${NA}`, sellerSku: SKU, recipient: RECIPIENT };
const REFRESH = 'synthetic-refresh-' + 'value-0003';
const ACCESS = 'synthetic-access-' + 'value-0004';

interface Sent { url: string; method: string; body: string | undefined; redirect: RequestInit['redirect'] }
interface FakeOptions {
  unknownStatus?: 400 | 404;
  /** The 1-based GET from which every GET answers 429; null never throttles. */
  throttleFromGet?: number | null;
  lwaStatus?: number;
  duplicateStatus?: number;
  /** A duplicate create adds a unit to the existing order, as a careless provider might. */
  duplicateAddsUnit?: boolean;
  /** Every create answers 200 with a non-empty errors array. */
  createErrors?: boolean;
  /** Reads of known orders answer under another id. */
  readIdentityMismatch?: boolean;
}

/** A sandbox that keeps orders in memory and echoes the recipient wherever a careless answer might. */
function fakeSandbox(options: FakeOptions = {}) {
  const sent: Sent[] = [];
  const orders = new Map<string, { status: string; action: string; policy: string; units: number }>();
  let gets = 0;
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const echo = [{ code: 'InvalidInput', message: `refused for ${RECIPIENT.name} at ${RECIPIENT.addressLine1}` },
    { code: RECIPIENT.city }, { code: `Bad${RECIPIENT.name.split(' ')[1]}` }, { code: 'free text code' }];
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    sent.push({ url: input, method, body: typeof init?.body === 'string' ? init.body : undefined, redirect: init?.redirect });
    if (input === MCF_SANDBOX_LWA_TOKEN_URL) {
      const status = options.lwaStatus ?? 200;
      return status === 200 ? json(200, { access_token: ACCESS, expires_in: 3600 }) : json(status, { error: 'invalid_grant' });
    }
    const url = new URL(input);
    if (url.origin !== MCF_SANDBOX_ENDPOINT) throw new Error('fake reached with a foreign host');
    const path = url.pathname.replace('/fba/outbound/2020-07-01/fulfillmentOrders', '');
    if (method === 'POST' && path === '') {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>;
      const id = body['sellerFulfillmentOrderId'] as string;
      const existing = orders.get(id);
      if (existing !== undefined) {
        if (options.duplicateAddsUnit) { existing.units++; return new Response('', { status: 200 }); }
        return json(options.duplicateStatus ?? 400, { errors: echo });
      }
      orders.set(id, { status: 'Received', action: (body['fulfillmentAction'] as string | undefined) ?? 'Ship',
        policy: (body['fulfillmentPolicy'] as string | undefined) ?? 'FillAllAvailable', units: 1 });
      return options.createErrors ? json(200, { errors: [{ code: 'X' }] }) : new Response('', { status: 200 });
    }
    if (method === 'PUT' && path.endsWith('/cancel')) {
      const order = orders.get(decodeURIComponent(path.slice(1, -'/cancel'.length)));
      if (order === undefined) return json(404, { errors: [{ code: 'NotFound' }] });
      order.status = 'Cancelled';
      return new Response('', { status: 200 });
    }
    if (method === 'GET') {
      gets++;
      if (options.throttleFromGet !== null && gets >= (options.throttleFromGet ?? 20)) {
        return json(429, { errors: [{ code: 'QuotaExceeded', message: `quota for ${RECIPIENT.city}` }] }, { 'x-amzn-RateLimit-Limit': '5.0' });
      }
      const id = decodeURIComponent(path.slice(1));
      const order = orders.get(id);
      if (order === undefined) return json(options.unknownStatus ?? 404, { errors: [{ code: 'NotFound', message: `no order for ${RECIPIENT.name}` }] });
      return json(200, { payload: {
        fulfillmentOrder: { sellerFulfillmentOrderId: options.readIdentityMismatch ? `${id}-other` : id, fulfillmentOrderStatus: order.status, fulfillmentAction: order.action,
          fulfillmentPolicy: order.policy, destinationAddress: RECIPIENT, receivedDate: '2026-09-28T10:00:00Z',
          statusUpdatedDate: '2026-09-28T10:00:01Z' },
        fulfillmentOrderItems: [{ sellerSku: SKU, sellerFulfillmentOrderItemId: `${id}-1`, quantity: order.units }],
        fulfillmentShipments: [],
      } });
    }
    return json(405, { errors: [{ code: 'MethodNotAllowed' }] });
  };
  return { fetch, sent, orders };
}

function harness(overrides: Partial<McfSandboxDependencies> & { config?: unknown; fake?: ReturnType<typeof fakeSandbox> } = {}) {
  const fake = overrides.fake ?? fakeSandbox();
  const lines: string[] = [];
  const pauses: number[] = [];
  const store = { opened: 0, reads: 0, closed: 0 };
  let keys = 0;
  const deps: McfSandboxDependencies = {
    readConfig: async () => JSON.stringify(overrides.config ?? CONFIG),
    openStore: () => {
      store.opened++;
      return {
        refreshToken: async (input) => {
          store.reads++;
          expect(input).toEqual({ orgId: ORG, connectionId: CONNECTION });
          return REFRESH;
        },
        close: async () => { store.closed++; },
      };
    },
    lwaClientId: 'synthetic-lwa-' + 'client-id-0001',
    lwaClientSecret: 'synthetic-lwa-' + 'client-value-0002',
    fetch: fake.fetch,
    write: (line) => lines.push(line),
    pause: async (ms) => { pauses.push(ms); },
    newKey: () => `CCS-${(++keys).toString(16).padStart(32, '0')}` as CreatorSampleOrderKey,
    now: () => new Date('2026-09-28T10:00:00.000Z'),
    ...overrides,
  };
  return { deps, fake, lines, pauses, store, parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

function refusedWith(lines: string[]): unknown {
  expect(lines).toHaveLength(1);
  const line = JSON.parse(lines[0]!) as Record<string, unknown>;
  expect(line['event']).toBe('mcf_sandbox_refused');
  return line['code'];
}

/** Every form of a recipient word a line could carry. */
function recipientHits(text: string): string[] {
  const folded = text.toLowerCase();
  const hits: string[] = [];
  for (const value of [...Object.values(RECIPIENT).filter((value) => value.length > 2), ...RECIPIENT_TOKENS]) {
    for (const form of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex'), encodeURIComponent(value)]) {
      if (folded.includes(form.toLowerCase())) hits.push(value);
    }
  }
  return hits;
}

describe('host refusal', () => {
  it('refuses every endpoint other than the NA sandbox before the database or a token is touched', async () => {
    const endpoints: unknown[] = [
      'https://sellingpartnerapi-na.amazon.com', 'https://sellingpartnerapi-eu.amazon.com', 'https://sellingpartnerapi-fe.amazon.com',
      'https://sandbox.sellingpartnerapi-eu.amazon.com', 'https://sandbox.sellingpartnerapi-fe.amazon.com',
      'http://sandbox.sellingpartnerapi-na.amazon.com', `${MCF_SANDBOX_ENDPOINT}/`, `${MCF_SANDBOX_ENDPOINT}:443`,
      MCF_SANDBOX_ENDPOINT.toUpperCase(), ` ${MCF_SANDBOX_ENDPOINT}`, `${MCF_SANDBOX_ENDPOINT}.example.test`,
      'https://user:pass@sandbox.sellingpartnerapi-na.amazon.com', 'https://example.test', '', null, 1, undefined,
    ];
    let refused = 0;
    for (const endpoint of endpoints) {
      const config = endpoint === undefined ? { ...CONFIG, endpoint: undefined } : { ...CONFIG, endpoint };
      const { deps, fake, lines, store } = harness({ config });
      expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.refused);
      expect(refusedWith(lines)).toBe('host_refused');
      expect(fake.sent).toHaveLength(0);
      expect(store.opened).toBe(0);
      refused++;
    }
    expect(refused).toBe(endpoints.length);
  });

  it('checks the endpoint before any other field', () => {
    expect(() => parseMcfSandboxConfig(JSON.stringify({ endpoint: 'https://sellingpartnerapi-na.amazon.com' })))
      .toThrow(new McfSandboxError('host_refused'));
  });

  it('lets through only the sandbox Fulfillment Outbound paths and the LWA exchange', () => {
    const allowed = [
      [`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrders`, 'POST'],
      [`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrders/CCS-x`, 'GET'],
      [`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrders/CCS-x/cancel`, 'PUT'],
      [MCF_SANDBOX_LWA_TOKEN_URL, 'POST'],
    ] as const;
    const refused = [
      ['https://sellingpartnerapi-na.amazon.com/fba/outbound/2020-07-01/fulfillmentOrders', 'POST'],
      [`${MCF_SANDBOX_ENDPOINT}/reports/2021-06-30/reports`, 'GET'],
      [`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrdersX`, 'GET'],
      [`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2026-07-04/orders`, 'GET'],
      [MCF_SANDBOX_LWA_TOKEN_URL, 'GET'],
      [`${MCF_SANDBOX_LWA_TOKEN_URL}?x=1`, 'POST'],
      ['https://api.amazon.com/other', 'POST'],
      ['https://user:pass@sandbox.sellingpartnerapi-na.amazon.com/fba/outbound/2020-07-01/fulfillmentOrders', 'POST'],
      ['not a url', 'GET'],
    ] as const;
    expect(allowed.filter(([url, method]) => mcfSandboxRequestAllowed(url, method))).toHaveLength(allowed.length);
    expect(refused.filter(([url, method]) => !mcfSandboxRequestAllowed(url, method))).toHaveLength(refused.length);
  });

  it('the guard refuses without calling the transport and never follows a redirect', async () => {
    const calls: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const guard = mcfSandboxGuard(async (url, init) => { calls.push({ url, redirect: init?.redirect }); return new Response('{}'); });
    await expect(guard.fetch('https://sellingpartnerapi-na.amazon.com/fba/outbound/2020-07-01/fulfillmentOrders/x'))
      .rejects.toThrow(new McfSandboxError('host_refused'));
    expect(calls).toHaveLength(0);
    expect(guard.refused()).toBe(true);
    await guard.fetch(`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrders/x`, { redirect: 'follow' });
    expect(calls).toEqual([{ url: `${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrders/x`, redirect: 'manual' }]);
  });
});

describe('configuration', () => {
  it('refuses to run without its configuration, before the database or any request', async () => {
    const { deps, fake, lines, store } = harness({ readConfig: async () => { throw new Error('ENOENT /etc/wizard-ads/mcf-sandbox.json'); } });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.refused);
    expect(refusedWith(lines)).toBe('config_unavailable');
    expect(lines[0]).not.toContain('ENOENT');
    expect(fake.sent).toHaveLength(0);
    expect(store.opened).toBe(0);
  });

  it('refuses malformed, incomplete, widened, non-NA and unfilled configurations with a code only', async () => {
    const { recipient: _recipient, ...withoutRecipient } = CONFIG;
    const cases: [string, unknown, string][] = [
      ['not json', 'not json', 'config_invalid'],
      ['array', [], 'config_invalid'],
      ['missing recipient', withoutRecipient, 'config_invalid'],
      ['extra key', { ...CONFIG, OPENSPELL_MCF_DISPATCH_ENABLED: '1' }, 'config_invalid'],
      ['upper-case org', { ...CONFIG, orgId: ORG.toUpperCase() }, 'config_invalid'],
      ['scope without marketplace', { ...CONFIG, scope: CONNECTION }, 'config_invalid'],
      ['two scopes', { ...CONFIG, scope: `${CONNECTION}:${NA},${CONNECTION}:${NA}` }, 'config_invalid'],
      ['EU marketplace', { ...CONFIG, scope: `${CONNECTION}:${EU}` }, 'marketplace_not_na'],
      ['unknown marketplace', { ...CONFIG, scope: `${CONNECTION}:SYNTHMKT0001` }, 'marketplace_not_na'],
      ['bad sku', { ...CONFIG, sellerSku: ' spaced ' }, 'sku_invalid'],
      ['US without state', { ...CONFIG, recipient: { ...RECIPIENT, stateOrRegion: undefined } }, 'recipient_invalid'],
      ['recipient extra field', { ...CONFIG, recipient: { ...RECIPIENT, phone: '5550100' } }, 'recipient_invalid'],
    ];
    let refused = 0;
    for (const [label, config, code] of cases) {
      const { deps, fake, lines, store } = harness({ readConfig: async () => (typeof config === 'string' ? config : JSON.stringify(config)) });
      expect(await runMcfSandbox(deps), label).toBe(MCF_SANDBOX_EXIT.refused);
      expect(refusedWith(lines), label).toBe(code);
      expect(recipientHits(lines.join('\n')), label).toEqual([]);
      expect(fake.sent, label).toHaveLength(0);
      expect(store.opened, label).toBe(0);
      refused++;
    }
    expect(refused).toBe(cases.length);
  });

  it('refuses the tracked template until it is filled in', async () => {
    const template = readFileSync(new URL('../../../docs/deploy/wizard-ads-mcf-sandbox.TEMPLATE.json', import.meta.url), 'utf8');
    expect(Object.keys(JSON.parse(template) as object).sort()).toEqual(['endpoint', 'orgId', 'recipient', 'scope', 'sellerSku']);
    expect((JSON.parse(template) as { endpoint: string }).endpoint).toBe(MCF_SANDBOX_ENDPOINT);
    const { deps, fake, lines, store } = harness({ readConfig: async () => template });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.refused);
    expect(refusedWith(lines)).toBe('config_invalid');
    expect(fake.sent).toHaveLength(0);
    expect(store.opened).toBe(0);
  });

  it('refuses without both LWA credentials, before the database', async () => {
    const cases = [{ lwaClientId: undefined }, { lwaClientSecret: '' }, { lwaClientId: ' ', lwaClientSecret: ' ' }];
    for (const lwa of cases) {
      const { deps, fake, lines, store } = harness(lwa);
      expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.refused);
      expect(refusedWith(lines)).toBe('lwa_missing');
      expect(fake.sent).toHaveLength(0);
      expect(store.opened).toBe(0);
    }
  });

  it('refuses when the database cannot be opened, before any request', async () => {
    const { deps, fake, lines } = harness({ openStore: () => { throw new Error('DATABASE_URL postgres://synthetic'); } });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.refused);
    expect(refusedWith(lines)).toBe('database_url_invalid');
    expect(lines[0]).not.toContain('postgres');
    expect(fake.sent).toHaveLength(0);
  });
});

describe('one run', () => {
  it('records every probe once, calls only the sandbox and LWA, and exits', async () => {
    const { deps, fake, pauses, store, parsed } = harness();
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    const probes = out.filter((line) => line['event'] === 'mcf_sandbox_probe');
    expect(probes.map((line) => line['probe'])).toEqual([
      'unknown_id', 'create_explicit', 'read_explicit', 'create_duplicate', 'read_duplicate', 'create_omitted', 'read_omitted', 'cancel',
      'read_cancelled', 'create_cancelled_id', 'throttle',
    ]);
    const by = (probe: string) => probes.find((line) => line['probe'] === probe)!;
    expect(by('unknown_id')).toMatchObject({ operation: 'getFulfillmentOrder', requests: 1, httpStatus: 404, codes: ['NotFound'],
      mapped: 'not_found', matches: true });
    expect(by('create_explicit')).toMatchObject({ operation: 'createFulfillmentOrder', httpStatus: 200, mapped: 'accepted', matches: true });
    expect(by('read_explicit')).toMatchObject({ httpStatus: 200, mapped: 'found:Received', orderStatus: 'Received', fulfillmentAction: 'Ship',
      fulfillmentPolicy: 'FillOrKill', matches: true });
    // The duplicate's body echoes the recipient: only the known code survives, the rest are withheld and counted.
    expect(by('create_duplicate')).toMatchObject({ httpStatus: 400, codes: ['InvalidInput'], withheldCodes: 3,
      mapped: 'rejected:validation', matches: true });
    expect(by('read_duplicate')).toMatchObject({ httpStatus: 200, mapped: 'found:Received', matches: true });
    expect(by('create_omitted')).toMatchObject({ httpStatus: 200, mapped: 'accepted', matches: null });
    expect(by('read_omitted')).toMatchObject({ fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillAllAvailable', matches: true });
    expect(by('cancel')).toMatchObject({ operation: 'cancelFulfillmentOrder', httpStatus: 200, mapped: 'accepted', matches: true });
    expect(by('read_cancelled')).toMatchObject({ orderStatus: 'Cancelled', mapped: 'found:Cancelled', matches: true });
    expect(by('create_cancelled_id')).toMatchObject({ httpStatus: 400, mapped: 'rejected:validation', matches: null });
    // GETs 6 to 19 answer; the 20th GET overall (15th of the burst) is the first 429.
    expect(by('throttle')).toMatchObject({ requests: 15, httpStatus: 429, codes: ['QuotaExceeded'], withheldCodes: 0, rateLimit: '5.0',
      mapped: 'error:http', matches: true });
    const done = out[out.length - 1]!;
    const spRequests = fake.sent.filter((request) => request.url !== MCF_SANDBOX_LWA_TOKEN_URL);
    expect(done).toEqual({ event: 'mcf_sandbox_done', host: 'sandbox.sellingpartnerapi-na.amazon.com', indicative: true, probes: 11,
      requests: spRequests.length, mismatches: [] });
    expect(out).toHaveLength(12);
    expect(spRequests).toHaveLength(10 + 15);
    // One token exchange, one refresh read, one store, closed.
    expect(fake.sent.filter((request) => request.url === MCF_SANDBOX_LWA_TOKEN_URL)).toHaveLength(1);
    expect(store).toEqual({ opened: 1, reads: 1, closed: 1 });
    expect(fake.sent.every((request) => request.url.startsWith(`${MCF_SANDBOX_ENDPOINT}/fba/outbound/2020-07-01/fulfillmentOrders`)
      || request.url === MCF_SANDBOX_LWA_TOKEN_URL)).toBe(true);
    expect(fake.sent.every((request) => request.redirect === 'manual')).toBe(true);
    // Spaced once between probes, never inside the throttle burst.
    expect(pauses).toEqual(Array(10).fill(MCF_SANDBOX_SPACING_MS));
    // Exactly three creates carry settings; the omitted one carries neither.
    const creates = spRequests.filter((request) => request.method === 'POST').map((request) => JSON.parse(request.body!) as Record<string, unknown>);
    expect(creates).toHaveLength(4);
    expect(creates.map((body) => [body['fulfillmentAction'] ?? null, body['fulfillmentPolicy'] ?? null])).toEqual([
      ['Ship', 'FillOrKill'], ['Ship', 'FillOrKill'], [null, null], ['Ship', 'FillOrKill'],
    ]);
    expect(spRequests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  });

  it('never prints the synthetic recipient, which the fake did receive', async () => {
    const { deps, fake, lines } = harness();
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    expect(recipientHits(lines.join('\n'))).toEqual([]);
    expect(lines.join('\n')).not.toContain(REFRESH);
    expect(lines.join('\n')).not.toContain(ACCESS);
    // Positive control: the recipient did reach the fake sandbox in every create.
    const creates = fake.sent.filter((request) => request.method === 'POST' && request.url !== MCF_SANDBOX_LWA_TOKEN_URL);
    expect(creates.filter((request) => Object.values(RECIPIENT).every((value) => request.body!.includes(`"${value}"`)))).toHaveLength(4);
  });

  it('names a mismatch with the reader: an unknown id answered 400', async () => {
    const { deps, parsed } = harness({ fake: fakeSandbox({ unknownStatus: 400 }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    expect(out.find((line) => line['probe'] === 'unknown_id')).toMatchObject({ httpStatus: 400, mapped: 'error:http', matches: false });
    expect(out[out.length - 1]).toMatchObject({ mismatches: ['unknown_id'] });
  });

  it('names a mismatch with the writer: a duplicate create answered 200', async () => {
    const { deps, parsed } = harness({ fake: fakeSandbox({ duplicateStatus: 200 }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    expect(out.find((line) => line['probe'] === 'create_duplicate')).toMatchObject({ httpStatus: 200, mapped: 'uncertain:decode', matches: false });
    expect(out.find((line) => line['probe'] === 'read_duplicate')).toMatchObject({ mapped: 'found:Received', matches: true });
    expect(out[out.length - 1]).toMatchObject({ mismatches: ['create_duplicate'] });
  });

  it('names a mismatch when a 200 create carries errors, which the writer reads as uncertain', async () => {
    const { deps, parsed } = harness({ fake: fakeSandbox({ createErrors: true }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    expect(out.find((line) => line['probe'] === 'create_explicit')).toMatchObject({ httpStatus: 200, codes: ['X'], mapped: 'uncertain:decode',
      matches: false });
    expect(out[out.length - 1]).toMatchObject({ mismatches: ['create_explicit'] });
  });

  it('names a mismatch when a duplicate create changes the first order', async () => {
    const { deps, parsed } = harness({ fake: fakeSandbox({ duplicateAddsUnit: true }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    expect(out.find((line) => line['probe'] === 'create_duplicate')).toMatchObject({ httpStatus: 200, mapped: 'accepted', matches: false });
    expect(out.find((line) => line['probe'] === 'read_duplicate')).toMatchObject({ mapped: 'found:Received:units_2', matches: false });
    expect(out[out.length - 1]).toMatchObject({ mismatches: ['create_duplicate', 'read_duplicate', 'read_cancelled'] });
  });

  it('names a mismatch when the reader rejects what the sandbox returns', async () => {
    const { deps, parsed } = harness({ fake: fakeSandbox({ readIdentityMismatch: true }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    const reads = ['read_explicit', 'read_duplicate', 'read_omitted', 'read_cancelled'];
    expect(reads.map((probe) => out.find((line) => line['probe'] === probe)!['mapped'])).toEqual(Array(4).fill('error:identity_conflict'));
    expect(out[out.length - 1]).toMatchObject({ mismatches: reads });
  });

  it('stops the throttle burst at its cap when no 429 comes, and reports that as observed, not a mismatch', async () => {
    const { deps, fake, parsed } = harness({ fake: fakeSandbox({ throttleFromGet: null }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.done);
    const out = parsed();
    expect(out.find((line) => line['probe'] === 'throttle')).toMatchObject({ requests: MCF_SANDBOX_THROTTLE_READS, httpStatus: 404,
      mapped: 'not_throttled', expected: null, matches: null });
    expect(fake.sent.filter((request) => request.method === 'GET')).toHaveLength(5 + MCF_SANDBOX_THROTTLE_READS);
    expect(out[out.length - 1]).toMatchObject({ mismatches: [] });
  });

  it('stops at the first probe when no access token can be had, having sent nothing to the sandbox', async () => {
    const { deps, fake, lines, store } = harness({ fake: fakeSandbox({ lwaStatus: 400 }) });
    expect(await runMcfSandbox(deps)).toBe(MCF_SANDBOX_EXIT.fault);
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([{ event: 'mcf_sandbox_fault', code: 'authentication' }]);
    expect(fake.sent.filter((request) => request.url !== MCF_SANDBOX_LWA_TOKEN_URL)).toHaveLength(0);
    expect(store.closed).toBe(1);
  });
});

describe('pieces', () => {
  it('drops only the two settings from a create body', async () => {
    const bodies: unknown[] = [];
    const strip = omitActionAndPolicy(async (_url, init) => { bodies.push(JSON.parse(init!.body as string)); return new Response(''); });
    await strip('u', { method: 'POST', body: JSON.stringify({ a: 1, fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill' }) });
    expect(bodies).toEqual([{ a: 1 }]);
  });

  it('screens codes that repeat recipient words', () => {
    const withheld = mcfSandboxRecipientScreen(RECIPIENT);
    const codes = ['InvalidInput', 'QuotaExceeded', 'Vellumford', 'BadQuartzwell', 'wa', 'WA', 'NotFound', 'Invalid77Field'];
    expect(codes.filter(withheld)).toEqual(['Vellumford', 'BadQuartzwell', 'wa', 'WA']);
    // A three-character word is withheld inside a longer code too.
    const bob = mcfSandboxRecipientScreen({ ...RECIPIENT, name: 'Bob Quartzwell' });
    expect(['InvalidBobField', 'InvalidInput'].filter(bob)).toEqual(['InvalidBobField']);
  });

  it('prints only allowed shapes', () => {
    const line = JSON.parse(mcfSandboxLine({ event: 'mcf_sandbox_probe', observation: {
      probe: 'unknown_id', operation: 'getFulfillmentOrder', requests: 1, httpStatus: 404, codes: ['NotFound', 'two words'], withheldCodes: 0,
      mapped: 'not found, really', expected: null, matches: null, orderStatus: 'Received St', fulfillmentAction: null, fulfillmentPolicy: null,
      rateLimit: '5.0',
    } })) as Record<string, unknown>;
    expect(line).toEqual({ event: 'mcf_sandbox_probe', probe: 'unknown_id', operation: 'getFulfillmentOrder', requests: 1, httpStatus: 404,
      codes: ['NotFound'], withheldCodes: 0, mapped: 'other', expected: null, matches: null, rateLimit: '5.0' });
    expect(JSON.parse(mcfSandboxLine({ event: 'mcf_sandbox_refused', code: 'Has Spaces' }))).toEqual({ event: 'mcf_sandbox_refused', code: 'other' });
  });
});
