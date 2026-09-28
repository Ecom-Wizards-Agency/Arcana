/**
 * One-shot SP-API sandbox harness for the MCF send path (WP-338k; DESIGN
 * sections 7, 14, 17 and "Amazon facts still unverified").
 *
 * It runs once, in `wizard-ads-mcf-sandbox.service` on the Evo (the runtime's
 * `mcf-sandbox` mode), and records what Amazon's sandbox answers for the
 * behaviours the design could not verify from the model:
 *
 *  1. getFulfillmentOrder for an id no order has (404 or 400?),
 *  2. createFulfillmentOrder with Ship and FillOrKill sent explicitly,
 *  3. the same create again under the same sellerFulfillmentOrderId, then a
 *     read that the first order is unchanged and still one unit,
 *  4. a create with fulfillmentAction and fulfillmentPolicy omitted, then a
 *     read of what Amazon filled in,
 *  5. cancelFulfillmentOrder, then a read of the cancelled order,
 *  6. a create under the cancelled id,
 *  7. the 429 shape, from un-spaced reads of an unknown id (no 429 is an
 *     observation, not a mismatch: the sandbox may not throttle them).
 *
 * For each request it records the HTTP status, `errors[].code` and what the
 * WP-338c writer or WP-334 reader made of the answer, and whether that matches
 * the design's assumption. Sandbox answers are indicative only: production may
 * differ (the fixtures README labels them so).
 *
 * Host: only the documented North America sandbox endpoint,
 * https://sandbox.sellingpartnerapi-na.amazon.com, listed on
 * https://developer-docs.amazon/sp-api/docs/the-selling-partner-api-sandbox
 * (which also gives the sandbox limit: 5 requests a second, burst 15).
 * Fulfillment Outbound v2020-07-01 is served by the dynamic sandbox with any
 * SKU and unlimited inventory:
 * https://developer-docs.amazon/sp-api/docs/fulfillment-outbound-dynamic-sandbox-guide.
 * The configuration must name that endpoint exactly; any other value, a
 * production endpoint included, is refused before the database is opened or a
 * token is requested. Every request then passes a guard that lets through only
 * that origin's Fulfillment Outbound paths and the LWA token exchange.
 *
 * Configuration: /etc/wizard-ads/mcf-sandbox.json (template
 * docs/deploy/wizard-ads-mcf-sandbox.TEMPLATE.json) holds the endpoint, the
 * organisation, the `<connection uuid>:<marketplace id>` scope, a seller SKU and
 * a synthetic recipient. The seller's refresh token is read through the
 * database, as mcf.observe and the MCF unit read it (getSpApiRefreshToken);
 * DATABASE_URL and the SP-API LWA pair come from the unit's credentials.
 *
 * Output: one JSON line per probe and a summary line, with fixed fields only.
 * The recipient never enters a line: provider codes pass the provider-code
 * pattern and a screen against the recipient's words, and no body, message or
 * id is printed.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connectionStringFromEnv, createDb, getSpApiRefreshToken } from '@wizard-ads/db';
import {
  CreatorMcfPreviewItem, CreatorMcfRecipient, CreatorSampleOrderKey, FulfillmentOrderStatus, SP_MARKETPLACE_MONEY_RULES,
  type CreatorMcfProviderOutcome,
} from '@wizard-ads/shared';
import {
  FulfillmentOutboundError, FulfillmentOutboundReader, FulfillmentOutboundWriter, LwaRefreshTokenProvider, type FetchLike,
  type SpApiAccessTokenProvider,
} from '@wizard-ads/sp-api';
import {
  MCF_POST_TIMEOUT_MS, MCF_READ_TIMEOUT_MS, MCF_TOKEN_TIMEOUT_MS, boundedAccessTokenProvider, timeoutFetch,
} from './mcf-send/loop.js';

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

export const MCF_SANDBOX_CONFIG_PATH = '/etc/wizard-ads/mcf-sandbox.json';
/** The documented NA SP-API sandbox endpoint (see the file comment for the source). The only host this harness calls. */
export const MCF_SANDBOX_ENDPOINT = 'https://sandbox.sellingpartnerapi-na.amazon.com';
/** The LWA token exchange (packages/sp-api/src/auth.ts). The only other URL a request may reach. */
export const MCF_SANDBOX_LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const FULFILLMENT_PATH = '/fba/outbound/2020-07-01/fulfillmentOrders';
/** Spacing between probes: well under the sandbox's 5 requests a second. */
export const MCF_SANDBOX_SPACING_MS = 1_000;
/** Un-spaced reads in the throttle probe: twice the sandbox burst of 15, and never more. */
export const MCF_SANDBOX_THROTTLE_READS = 30;
const CONFIG_KEYS = ['endpoint', 'orgId', 'recipient', 'scope', 'sellerSku'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Z0-9]{9,16})$/;
const CODE = /^[A-Za-z0-9_.]{1,64}$/;
const MAX_CODES = 20;
const MAX_BODY_CHARS = 64 * 1024;
const FULFILLMENT_ACTIONS: ReadonlySet<string> = new Set(['Ship', 'Hold']);
const FULFILLMENT_POLICIES: ReadonlySet<string> = new Set(['FillOrKill', 'FillAll', 'FillAllAvailable']);

// ---------------------------------------------------------------------------
// Errors and configuration.
// ---------------------------------------------------------------------------

export type McfSandboxRefusal =
  | 'config_unavailable' | 'config_invalid' | 'host_refused' | 'marketplace_not_na' | 'recipient_invalid' | 'sku_invalid'
  | 'lwa_missing' | 'database_url_invalid';

/** A fixed-code refusal; the message is the code and never a value. */
export class McfSandboxError extends Error {
  constructor(readonly code: McfSandboxRefusal) {
    super(code);
    this.name = 'McfSandboxError';
  }
}

export interface McfSandboxConfig {
  readonly endpoint: typeof MCF_SANDBOX_ENDPOINT;
  readonly orgId: string;
  readonly spapiConnectionId: string;
  readonly marketplaceId: string;
  readonly sellerSku: string;
  readonly recipient: CreatorMcfRecipient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the sandbox configuration. The endpoint is checked first and must be
 * the sandbox endpoint byte for byte, so a production host is refused before
 * anything else is read. The error carries a code only.
 */
export function parseMcfSandboxConfig(text: string): McfSandboxConfig {
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch { throw new McfSandboxError('config_invalid'); }
  if (!isRecord(raw)) throw new McfSandboxError('config_invalid');
  if (raw['endpoint'] !== MCF_SANDBOX_ENDPOINT) throw new McfSandboxError('host_refused');
  const keys = Object.keys(raw).sort();
  if (keys.length !== CONFIG_KEYS.length || keys.some((key, index) => key !== CONFIG_KEYS[index])) throw new McfSandboxError('config_invalid');
  const { orgId, scope, sellerSku, recipient } = raw;
  if (typeof orgId !== 'string' || !UUID.test(orgId) || typeof scope !== 'string') throw new McfSandboxError('config_invalid');
  const match = SCOPE.exec(scope);
  if (match === null) throw new McfSandboxError('config_invalid');
  const [, spapiConnectionId, marketplaceId] = match as unknown as [string, string, string];
  if (SP_MARKETPLACE_MONEY_RULES[marketplaceId]?.region !== 'NA') throw new McfSandboxError('marketplace_not_na');
  if (!CreatorMcfPreviewItem.safeParse({ sellerSku, sellerFulfillmentOrderItemId: `CCS-${'0'.repeat(32)}-1`, quantity: 1 }).success) {
    throw new McfSandboxError('sku_invalid');
  }
  const parsed = CreatorMcfRecipient.safeParse(recipient);
  if (!parsed.success) throw new McfSandboxError('recipient_invalid');
  return { endpoint: MCF_SANDBOX_ENDPOINT, orgId, spapiConnectionId, marketplaceId, sellerSku: sellerSku as string, recipient: parsed.data };
}

// ---------------------------------------------------------------------------
// Transport: the host guard, the recorder and the omitted-settings body.
// ---------------------------------------------------------------------------

/** Whether a URL is one this harness may call: the sandbox's Fulfillment Outbound paths, or the LWA token exchange (POST). */
export function mcfSandboxRequestAllowed(input: string, method: string): boolean {
  let url: URL;
  try { url = new URL(input); } catch { return false; }
  if (url.username !== '' || url.password !== '') return false;
  if (url.origin === MCF_SANDBOX_ENDPOINT) {
    return url.pathname === FULFILLMENT_PATH || url.pathname.startsWith(`${FULFILLMENT_PATH}/`);
  }
  return method === 'POST' && url.href === MCF_SANDBOX_LWA_TOKEN_URL;
}

export interface McfSandboxGuard {
  readonly fetch: FetchLike;
  /** Set when any request was refused; the run stops at the next check. */
  refused(): boolean;
}

/**
 * Refuses, without calling the transport, any request the harness may not
 * make, and never follows a redirect (a redirect could leave the host).
 */
export function mcfSandboxGuard(inner: FetchLike): McfSandboxGuard {
  let refused = false;
  return {
    fetch: (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (!mcfSandboxRequestAllowed(input, method)) {
        refused = true;
        return Promise.reject(new McfSandboxError('host_refused'));
      }
      return inner(input, { ...init, redirect: 'manual' });
    },
    refused: () => refused,
  };
}

/** A copy of create bodies without fulfillmentAction and fulfillmentPolicy, for the omitted-settings probe only. */
export function omitActionAndPolicy(inner: FetchLike): FetchLike {
  return (input, init) => {
    if (init?.method !== 'POST' || typeof init.body !== 'string') return inner(input, init);
    let body: unknown;
    try { body = JSON.parse(init.body) as unknown; } catch { return inner(input, init); }
    if (!isRecord(body)) return inner(input, init);
    const { fulfillmentAction: _action, fulfillmentPolicy: _policy, ...rest } = body;
    return inner(input, { ...init, body: JSON.stringify(rest) });
  };
}

/** What the recorder keeps of one exchange: numbers, codes and enum values only. */
export interface McfSandboxExchange {
  readonly method: string;
  readonly status: number | null;
  readonly codes: readonly string[];
  readonly withheldCodes: number;
  readonly orderStatus: string | null;
  readonly fulfillmentAction: string | null;
  readonly fulfillmentPolicy: string | null;
  readonly rateLimit: string | null;
}

/**
 * Whether a provider code repeats the recipient's words. Codes that do are
 * withheld and counted; the status still tells the story.
 */
export function mcfSandboxRecipientScreen(recipient: CreatorMcfRecipient): (code: string) => boolean {
  const exact = new Set<string>();
  const contained = new Set<string>();
  for (const value of Object.values(recipient)) {
    if (typeof value !== 'string') continue;
    const runs = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of [...runs, runs.join('')]) {
      if (token.length >= 3) contained.add(token);
      else if (token.length === 2) exact.add(token);
    }
  }
  return (code) => {
    const folded = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    return exact.has(folded) || [...contained].some((token) => folded.includes(token));
  };
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && allowed.has(value) ? value : 'other';
}

function summarise(method: string, status: number, text: string | null, rateLimit: string | null,
  withheld: (code: string) => boolean): McfSandboxExchange {
  let body: unknown = null;
  if (text !== null && text.length <= MAX_BODY_CHARS && text.trim() !== '') {
    try { body = JSON.parse(text) as unknown; } catch { body = null; }
  }
  const codes: string[] = [];
  let withheldCodes = 0;
  if (isRecord(body) && Array.isArray(body['errors'])) {
    for (const entry of body['errors'] as unknown[]) {
      const code = isRecord(entry) ? entry['code'] : undefined;
      if (typeof code !== 'string' || !CODE.test(code) || withheld(code)) { withheldCodes++; continue; }
      if (!codes.includes(code) && codes.length < MAX_CODES) codes.push(code);
    }
  }
  const order = isRecord(body) && isRecord(body['payload']) && isRecord(body['payload']['fulfillmentOrder'])
    ? body['payload']['fulfillmentOrder'] : null;
  return {
    method, status, codes, withheldCodes,
    orderStatus: order === null ? null : enumValue(order['fulfillmentOrderStatus'], new Set(FulfillmentOrderStatus.options)),
    fulfillmentAction: order === null ? null : enumValue(order['fulfillmentAction'], FULFILLMENT_ACTIONS),
    fulfillmentPolicy: order === null ? null : enumValue(order['fulfillmentPolicy'], FULFILLMENT_POLICIES),
    rateLimit: rateLimit !== null && /^\d{1,6}(?:\.\d{1,6})?$/.test(rateLimit) ? rateLimit : null,
  };
}

/** Records every SP-API exchange that passes through it, then hands the untouched response on. */
export class McfSandboxRecorder {
  private exchanges: McfSandboxExchange[] = [];
  private total = 0;

  constructor(private readonly inner: FetchLike, private readonly withheld: (code: string) => boolean) {}

  readonly fetch: FetchLike = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    this.total++;
    let response: Response;
    try { response = await this.inner(input, init); }
    catch (error) {
      this.exchanges.push({ method, status: null, codes: [], withheldCodes: 0, orderStatus: null, fulfillmentAction: null,
        fulfillmentPolicy: null, rateLimit: null });
      throw error;
    }
    let text: string | null;
    try { text = await response.clone().text(); } catch { text = null; }
    this.exchanges.push(summarise(method, response.status, text, response.headers.get('x-amzn-RateLimit-Limit'), this.withheld));
    return response;
  };

  /** The exchanges since the last call, and resets them. */
  take(): McfSandboxExchange[] {
    const taken = this.exchanges;
    this.exchanges = [];
    return taken;
  }

  requests(): number { return this.total; }
}

// ---------------------------------------------------------------------------
// Output: fixed events and fields, so no free text can reach a line.
// ---------------------------------------------------------------------------

export type McfSandboxProbe =
  | 'unknown_id' | 'create_explicit' | 'read_explicit' | 'create_duplicate' | 'read_duplicate' | 'create_omitted' | 'read_omitted'
  | 'cancel' | 'read_cancelled' | 'create_cancelled_id' | 'throttle';

export type McfSandboxOperation = 'getFulfillmentOrder' | 'createFulfillmentOrder' | 'cancelFulfillmentOrder';

export interface McfSandboxObservation {
  readonly probe: McfSandboxProbe;
  readonly operation: McfSandboxOperation;
  /** Requests sent by the probe (more than 1 only for the throttle probe). */
  readonly requests: number;
  /** The last exchange's status (for the throttle probe, the first 429's); null for no response. */
  readonly httpStatus: number | null;
  readonly codes: readonly string[];
  readonly withheldCodes: number;
  /** What the writer or reader made of the answer: `accepted`, `rejected:validation`, `not_found`, `found:Received`, `error:http`... */
  readonly mapped: string;
  /** The design's assumption for this probe, or null when the probe only observes. */
  readonly expected: string | null;
  /** Whether the answer matched `expected`; null when nothing was expected. */
  readonly matches: boolean | null;
  readonly orderStatus: string | null;
  readonly fulfillmentAction: string | null;
  readonly fulfillmentPolicy: string | null;
  readonly rateLimit: string | null;
}

const MAPPED = /^[A-Za-z0-9_:]{1,48}$/;
const EXPECTED = /^[A-Za-z0-9 _:.,()-]{1,80}$/;

/** One output line, rebuilt field by field from allowed shapes. */
export function mcfSandboxLine(entry: { event: 'mcf_sandbox_probe'; observation: McfSandboxObservation }
  | { event: 'mcf_sandbox_done'; probes: number; requests: number; mismatches: readonly McfSandboxProbe[] }
  | { event: 'mcf_sandbox_refused' | 'mcf_sandbox_fault'; code: string }): string {
  const line: Record<string, unknown> = { event: entry.event };
  if (entry.event === 'mcf_sandbox_probe') {
    const o = entry.observation;
    Object.assign(line, {
      probe: o.probe, operation: o.operation, requests: Number.isSafeInteger(o.requests) ? o.requests : null,
      httpStatus: o.httpStatus !== null && Number.isInteger(o.httpStatus) ? o.httpStatus : null,
      codes: o.codes.filter((code) => CODE.test(code)).slice(0, MAX_CODES),
      withheldCodes: Number.isSafeInteger(o.withheldCodes) ? o.withheldCodes : null,
      mapped: MAPPED.test(o.mapped) ? o.mapped : 'other',
      expected: o.expected !== null && EXPECTED.test(o.expected) ? o.expected : null,
      matches: o.matches,
    });
    for (const [key, value] of [['orderStatus', o.orderStatus], ['fulfillmentAction', o.fulfillmentAction],
      ['fulfillmentPolicy', o.fulfillmentPolicy], ['rateLimit', o.rateLimit]] as const) {
      if (value !== null && /^[A-Za-z0-9.]{1,32}$/.test(value)) line[key] = value;
    }
  } else if (entry.event === 'mcf_sandbox_done') {
    Object.assign(line, { host: new URL(MCF_SANDBOX_ENDPOINT).host, indicative: true, probes: entry.probes, requests: entry.requests,
      mismatches: [...entry.mismatches] });
  } else {
    line['code'] = /^[a-z_]{1,40}$/.test(entry.code) ? entry.code : 'other';
  }
  return JSON.stringify(line);
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** The seller's refresh token, read through the database the way mcf.observe and the MCF unit read it. */
export interface McfSandboxStore {
  refreshToken(input: { orgId: string; connectionId: string }): Promise<string | null>;
  close(): Promise<void>;
}

export interface McfSandboxDependencies {
  /** The configuration file's text; a throw is config_unavailable. */
  readConfig(): Promise<string>;
  /** Called only after the configuration and the LWA pair pass. */
  openStore(): McfSandboxStore;
  lwaClientId: string | undefined;
  lwaClientSecret: string | undefined;
  /** The network. Every call passes the host guard first. */
  fetch: FetchLike;
  write(line: string): void;
  pause?(ms: number): Promise<void>;
  newKey?(): CreatorSampleOrderKey;
  now?(): Date;
}

export const MCF_SANDBOX_EXIT = Object.freeze({ done: 0, fault: 1, refused: 2 });

type Matcher = (exchange: McfSandboxExchange | undefined, mapped: string) => boolean;
/** Prints one observation from the given exchanges (by default, those since the last observation). */
type RecordObservation = (probe: McfSandboxProbe, operation: McfSandboxOperation, mapped: string, expected: string | null, matches: Matcher,
  exchanges?: McfSandboxExchange[]) => void;

class Abort extends Error {
  constructor(readonly kind: 'refused' | 'fault', readonly code: string) { super(code); }
}

function describeOutcome(outcome: CreatorMcfProviderOutcome): string {
  switch (outcome.outcome) {
    case 'accepted': return 'accepted';
    case 'rejected': return `rejected:${outcome.reason}`;
    case 'uncertain': return `uncertain:${outcome.cause}`;
  }
}

/**
 * Runs every probe once and returns the process exit code: 0 when every probe
 * ran (mismatches are findings, listed in the summary), 2 when the harness
 * refused to start or a request was refused by the guard, 1 on a fault such as
 * no access token.
 */
export async function runMcfSandbox(deps: McfSandboxDependencies): Promise<number> {
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newKey = deps.newKey ?? (() => CreatorSampleOrderKey.parse(`CCS-${randomBytes(16).toString('hex')}`));
  const now = deps.now ?? (() => new Date());
  let config: McfSandboxConfig;
  try {
    let text: string;
    try { text = await deps.readConfig(); } catch { throw new McfSandboxError('config_unavailable'); }
    config = parseMcfSandboxConfig(text);
    if (!deps.lwaClientId?.trim() || !deps.lwaClientSecret?.trim()) throw new McfSandboxError('lwa_missing');
  } catch (error) {
    deps.write(mcfSandboxLine({ event: 'mcf_sandbox_refused', code: error instanceof McfSandboxError ? error.code : 'config_invalid' }));
    return MCF_SANDBOX_EXIT.refused;
  }
  let store: McfSandboxStore;
  try { store = deps.openStore(); }
  catch {
    deps.write(mcfSandboxLine({ event: 'mcf_sandbox_refused', code: 'database_url_invalid' }));
    return MCF_SANDBOX_EXIT.refused;
  }
  try {
    return await probeAll(deps, config, store, pause, newKey, now);
  } finally {
    await store.close().catch(() => {});
  }
}

async function probeAll(deps: McfSandboxDependencies, config: McfSandboxConfig, store: McfSandboxStore,
  pause: (ms: number) => Promise<void>, newKey: () => CreatorSampleOrderKey, now: () => Date): Promise<number> {
  const guard = mcfSandboxGuard(deps.fetch);
  const recorder = new McfSandboxRecorder(guard.fetch, mcfSandboxRecipientScreen(config.recipient));
  const lwaClientId = deps.lwaClientId!.trim();
  const lwaKey = deps.lwaClientSecret!.trim();
  const token: SpApiAccessTokenProvider = boundedAccessTokenProvider(new LwaRefreshTokenProvider({
    clientId: lwaClientId, clientSecret: lwaKey,
    refreshTokenProvider: () => store.refreshToken({ orgId: config.orgId, connectionId: config.spapiConnectionId }),
    fetch: timeoutFetch(guard.fetch, MCF_TOKEN_TIMEOUT_MS),
  }), MCF_TOKEN_TIMEOUT_MS);
  // The endpoint is the constant, never the configuration's value (which only had to equal it).
  const common = { endpoint: MCF_SANDBOX_ENDPOINT, accessTokenProvider: token, userAgent: 'WizardAds/1.0 (Language=TypeScript; sandbox)' };
  const reader = new FulfillmentOutboundReader({ ...common, fetch: timeoutFetch(recorder.fetch, MCF_READ_TIMEOUT_MS) });
  const writer = new FulfillmentOutboundWriter({ ...common, fetch: recorder.fetch, timeoutMs: MCF_POST_TIMEOUT_MS });
  const writerOmitting = new FulfillmentOutboundWriter({ ...common, fetch: omitActionAndPolicy(recorder.fetch), timeoutMs: MCF_POST_TIMEOUT_MS });
  const order = (key: CreatorSampleOrderKey) => ({ marketplaceId: config.marketplaceId, derivedOrderKey: key, sellerSku: config.sellerSku,
    recipient: config.recipient, displayableOrderDate: now().toISOString() });

  const observations: McfSandboxObservation[] = [];
  let first = true;
  const checkAbort = (error?: unknown): void => {
    if (guard.refused()) throw new Abort('refused', 'host_refused');
    if (error instanceof FulfillmentOutboundError && (error.reason === 'authentication' || error.reason === 'invalid_request')) {
      throw new Abort('fault', error.reason);
    }
  };
  const record: RecordObservation = (probe, operation, mapped, expected, matches, exchanges = recorder.take()) => {
    const last = exchanges[exchanges.length - 1];
    const observation: McfSandboxObservation = {
      probe, operation, requests: exchanges.length, httpStatus: last?.status ?? null, codes: last?.codes ?? [],
      withheldCodes: exchanges.reduce((sum, exchange) => sum + exchange.withheldCodes, 0), mapped, expected,
      matches: expected === null ? null : matches(last, mapped),
      orderStatus: last?.orderStatus ?? null, fulfillmentAction: last?.fulfillmentAction ?? null,
      fulfillmentPolicy: last?.fulfillmentPolicy ?? null, rateLimit: last?.rateLimit ?? null,
    };
    observations.push(observation);
    deps.write(mcfSandboxLine({ event: 'mcf_sandbox_probe', observation }));
  };
  const spaced = async (): Promise<void> => {
    if (!first) await pause(MCF_SANDBOX_SPACING_MS);
    first = false;
  };
  const read = async (probe: McfSandboxProbe, key: string, expected: string | null,
    matches: Matcher = () => true): Promise<void> => {
    await spaced();
    let mapped: string;
    try {
      const lookup = await reader.getOrder(key);
      if (lookup.outcome === 'found') {
        // A sample order holds one unit; any other total is shown, so a second order under the id cannot pass as the first.
        const units = lookup.order.items.reduce((sum, item) => sum + item.quantity, 0);
        mapped = `found:${lookup.order.status}${units === 1 ? '' : `:units_${Math.min(units, 999)}`}`;
      } else mapped = 'not_found';
    } catch (error) {
      checkAbort(error);
      mapped = error instanceof FulfillmentOutboundError ? `error:${error.reason}` : 'error:other';
    }
    checkAbort();
    record(probe, 'getFulfillmentOrder', mapped, expected, matches);
  };
  const write = async (probe: McfSandboxProbe, operation: McfSandboxOperation, send: () => Promise<CreatorMcfProviderOutcome>,
    expected: string | null, matches: Matcher = () => true): Promise<void> => {
    await spaced();
    let mapped: string;
    try { mapped = describeOutcome(await send()); }
    catch (error) {
      checkAbort(error);
      mapped = 'error:other';
    }
    checkAbort();
    record(probe, operation, mapped, expected, matches);
  };
  const accepted: Matcher = (exchange, mapped) => exchange?.status === 200 && mapped === 'accepted';
  const found: Matcher = (exchange, mapped) => exchange?.status === 200 && /^found:[A-Za-z]+$/.test(mapped);

  try {
    const unknown = newKey();
    const explicit = newKey();
    const omitted = newKey();
    await read('unknown_id', unknown, "404, the reader's not_found", (exchange, mapped) => exchange?.status === 404 && mapped === 'not_found');
    await write('create_explicit', 'createFulfillmentOrder', () => writer.create(order(explicit)), '200, accepted', accepted);
    await read('read_explicit', explicit, '200, found, one unit', found);
    const explicitRead = observations[observations.length - 1]!.mapped;
    await write('create_duplicate', 'createFulfillmentOrder', () => writer.create(order(explicit)), '4xx, rejected (never a second order)',
      (_exchange, mapped) => mapped.startsWith('rejected:'));
    // The first order must be unchanged: same status, still one unit.
    await read('read_duplicate', explicit, '200, found, as before the duplicate, one unit',
      (exchange, mapped) => found(exchange, mapped) && mapped === explicitRead);
    await write('create_omitted', 'createFulfillmentOrder', () => writerOmitting.create(order(omitted)), null);
    await read('read_omitted', omitted, '200, found, one unit', found);
    await write('cancel', 'cancelFulfillmentOrder', () => writer.cancel(explicit), '200, accepted', accepted);
    await read('read_cancelled', explicit, '200, found:Cancelled, one unit',
      (exchange, mapped) => exchange?.status === 200 && mapped === 'found:Cancelled');
    await write('create_cancelled_id', 'createFulfillmentOrder', () => writer.create(order(explicit)), null);
    await throttle(reader, newKey(), spaced, checkAbort, recorder, record);
  } catch (error) {
    if (error instanceof Abort) {
      recorder.take();
      deps.write(mcfSandboxLine({ event: error.kind === 'refused' ? 'mcf_sandbox_refused' : 'mcf_sandbox_fault', code: error.code }));
      return error.kind === 'refused' ? MCF_SANDBOX_EXIT.refused : MCF_SANDBOX_EXIT.fault;
    }
    throw error;
  }
  deps.write(mcfSandboxLine({ event: 'mcf_sandbox_done', probes: observations.length, requests: recorder.requests(),
    mismatches: observations.filter((observation) => observation.matches === false).map((observation) => observation.probe) }));
  return MCF_SANDBOX_EXIT.done;
}

/** Un-spaced reads of an unknown id until the first 429, at most MCF_SANDBOX_THROTTLE_READS. */
async function throttle(reader: FulfillmentOutboundReader, key: CreatorSampleOrderKey, spaced: () => Promise<void>,
  checkAbort: (error?: unknown) => void, recorder: McfSandboxRecorder, record: RecordObservation): Promise<void> {
  await spaced();
  let mapped = 'not_throttled';
  for (let attempt = 0; attempt < MCF_SANDBOX_THROTTLE_READS; attempt++) {
    try {
      await reader.getOrder(key);
    } catch (error) {
      checkAbort(error);
      if (error instanceof FulfillmentOutboundError && error.reason === 'http' && error.status === 429) {
        mapped = 'error:http';
        break;
      }
    }
    checkAbort();
  }
  // The observation keeps the counts of every read and the first 429's status and codes.
  const exchanges = recorder.take();
  const throttled = exchanges.findIndex((exchange) => exchange.status === 429);
  // The sandbox may not throttle sequential reads at all: no 429 is reported as observed, not as a mismatch.
  record('throttle', 'getFulfillmentOrder', mapped, throttled === -1 ? null : '429 with errors[].code', (exchange) => exchange?.status === 429,
    throttled === -1 ? exchanges : exchanges.slice(0, throttled + 1));
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = process.env;
  const code = await runMcfSandbox({
    readConfig: () => readFile(MCF_SANDBOX_CONFIG_PATH, 'utf8'),
    openStore: () => {
      const handle = createDb({ connectionString: connectionStringFromEnv(env), max: 1 });
      return {
        refreshToken: (input) => getSpApiRefreshToken(handle, input),
        close: () => handle.close(),
      };
    },
    lwaClientId: env['SP_API_LWA_CLIENT_ID'],
    lwaClientSecret: env['SP_API_LWA_CLIENT_SECRET'],
    fetch: globalThis.fetch,
    write: (line) => console.info(line),
  });
  process.exit(code);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(mcfSandboxLine({ event: 'mcf_sandbox_fault', code: 'unexpected' }));
    process.exit(MCF_SANDBOX_EXIT.fault);
  });
}
