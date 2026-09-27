/**
 * SP-API Fulfillment Outbound v2020-07-01 writer for Creator Connections sample
 * orders (WP-338c): the preview evidence (getFulfillmentPreview), the create
 * (createFulfillmentOrder) and the cancel (cancelFulfillmentOrder).
 *
 * Creating and cancelling an Amazon order are Amazon writes under the ten
 * clauses of the Amazon write contract in AGENTS.md. This file is a library
 * only: no gate, no scheduler, no persistence and no caller live here. The
 * MCF worker supplies the gates, the approval and the reservation, and reads
 * orders through WP-334's `FulfillmentOutboundReader.getOrder`.
 *
 * The recipient reaches this module in memory and leaves it only in the
 * request to Amazon. Nothing here logs; results and errors carry ids, numbers
 * and provider codes only. A provider code survives only when it matches
 * `^[A-Za-z0-9_.]{1,64}$` and, where the recipient is known, does not repeat
 * recipient text.
 */
import {
  CREATOR_MCF_PACKING_SLIP_COMMENT, CreatorMcfFees, CreatorMcfPreviewItem, CreatorMcfProviderOutcome, CreatorMcfRecipient,
  CreatorSampleOrderKey,
} from '@wizard-ads/shared';
import { FulfillmentOutboundError } from './fulfillment-outbound.js';
import type { SpApiClientOptions } from './types.js';

const PATH = '/fba/outbound/2020-07-01/fulfillmentOrders';
/** The same pattern as the shared `ProviderCode`: no free text survives. */
const PROVIDER_CODE = /^[A-Za-z0-9_.]{1,64}$/;
/** The v2020 model's FeeName enum. Any other fee name refuses the preview. */
const FEE_NAMES: ReadonlySet<string> = new Set(['FBAPerUnitFulfillmentFee', 'FBAPerOrderFulfillmentFee', 'FBATransportationFee',
  'FBAFulfillmentCODFee']);
/**
 * Codes Amazon uses for SP-API errors and unfulfillable reasons. They are kept
 * without the recipient screen, so a recipient word inside a known code (a city
 * named "Tina" inside InvalidDestinationAddress) never hides it. Any other code
 * still passes the screen.
 */
const KNOWN_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'InvalidInput', 'InvalidDestinationAddress', 'InvalidSKU', 'InvalidMarketplace', 'InvalidQuantity', 'NoInventory',
  'InventoryUnavailable', 'NotMCFEligible', 'NotFound', 'Unauthorized', 'Forbidden', 'QuotaExceeded', 'InternalFailure',
  'ServiceUnavailable', 'UnsupportedMediaType', 'RequestEntityTooLarge', 'RequestTimeout', 'MethodNotAllowed',
]);
/** The shared outcome and preview keep at most 20 codes. */
const MAX_CODES = 20;
/** Error bodies larger than this are not parsed; the status alone classifies them. */
const MAX_BODY_CHARS = 64 * 1024;
/** The same pattern as the shared preview's marketplace id. */
const MARKETPLACE_ID = /^[A-Z0-9]{9,16}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Per-request limit and its maximum. A request still open at the limit is
 * aborted; for a create that is an uncertain outcome. Token acquisition is not
 * covered: the caller's access token provider must bound its own time.
 */
export const FULFILLMENT_OUTBOUND_WRITE_TIMEOUT_MS = 60_000;

/**
 * The settings every sample order uses. The preview asks Amazon about exactly
 * these, and the create sends exactly these: Standard shipping, Ship (not Hold)
 * and FillOrKill, with no feature constraints.
 */
export const CREATOR_MCF_ORDER_SETTINGS = Object.freeze({
  shippingSpeedCategory: 'Standard',
  fulfillmentAction: 'Ship',
  fulfillmentPolicy: 'FillOrKill',
  featureConstraints: Object.freeze([]) as readonly [],
} as const);

/** Minor-unit exponents for the currencies of Amazon's MCF marketplaces. Any other currency refuses the preview. */
const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  USD: 2, CAD: 2, MXN: 2, BRL: 2, GBP: 2, EUR: 2, SEK: 2, PLN: 2, TRY: 2, AED: 2, SAR: 2, EGP: 2, INR: 2, AUD: 2, SGD: 2,
  ZAR: 2, JPY: 0,
});

export type FulfillmentOutboundWriterOptions = Pick<SpApiClientOptions, 'endpoint' | 'accessTokenProvider' | 'userAgent' | 'now'> & {
  /** Explicit transport injection, as for WP-334's reader: nothing reaches Amazon until the worker composes this. */
  fetch: NonNullable<SpApiClientOptions['fetch']>;
  /** Defaults to FULFILLMENT_OUTBOUND_WRITE_TIMEOUT_MS; 1 to 60,000. */
  timeoutMs?: number;
};

/** One sample order: one unit of one SKU, under the lane's CCS key. */
export interface CreatorMcfOrderInput {
  marketplaceId: string;
  /** The CCS key: sellerFulfillmentOrderId and displayableOrderId of the create. */
  derivedOrderKey: CreatorSampleOrderKey;
  sellerSku: string;
  /** Opened in the worker's memory; parsed again here and sent only to Amazon. */
  recipient: CreatorMcfRecipient;
}

export interface CreatorMcfCreateInput extends CreatorMcfOrderInput {
  /** The approval time (approved_at), sent as displayableOrderDate. */
  displayableOrderDate: string;
}

/** Why Amazon refused a request, from the HTTP status alone. */
export type CreatorMcfRefusalReason = 'validation' | 'authorization' | 'throttled';

/**
 * Amazon's preview for exactly the order the create would send. It holds no
 * recipient attribute: ids, settings, numbers, times and provider codes only.
 */
export interface CreatorMcfPreviewEvidence {
  readonly outcome: 'previewed';
  readonly marketplaceId: string;
  readonly derivedOrderKey: CreatorSampleOrderKey;
  /** The items sent, which are the items the create sends. */
  readonly items: readonly CreatorMcfPreviewItem[];
  readonly shippingSpeedCategory: 'Standard';
  readonly fulfillmentAction: 'Ship';
  readonly fulfillmentPolicy: 'FillOrKill';
  readonly featureConstraints: readonly [];
  readonly isFulfillable: boolean;
  /** Amazon's estimated fees in minor units with the currency; null when Amazon returned no estimate. */
  readonly fees: CreatorMcfFees | null;
  /** Units Amazon planned into shipments, and units it listed as unfulfillable. */
  readonly fulfillableUnits: number;
  readonly unfulfillableUnits: number;
  readonly orderUnfulfillableReasons: readonly string[];
  readonly itemUnfulfillableReasons: readonly string[];
  /** Order reasons then item reasons, without repeats, at most 20. */
  readonly unfulfillableReasons: readonly string[];
  /** Reasons not in `unfulfillableReasons`: not a provider code, repeating recipient text, or beyond the first 20. */
  readonly withheldReasons: number;
  /** ISO timestamps across all planned shipments (earliest of the earliest, latest of the latest); null when Amazon gave none. */
  readonly earliestShipAt: string | null;
  readonly latestShipAt: string | null;
  readonly earliestArrivalAt: string | null;
  readonly latestArrivalAt: string | null;
}

/** Amazon answered the preview with a 4xx: nothing to approve. Codes only. */
export interface CreatorMcfPreviewRefusal {
  readonly outcome: 'refused';
  readonly status: number;
  readonly reason: CreatorMcfRefusalReason;
  readonly codes: readonly string[];
}

export type CreatorMcfPreviewResult = CreatorMcfPreviewEvidence | CreatorMcfPreviewRefusal;

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function record(value: unknown): RecordValue {
  if (!isRecord(value)) throw new FulfillmentOutboundError('invalid_response');
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new FulfillmentOutboundError('invalid_response');
  return value;
}

// ---------------------------------------------------------------------------
// The order, built once for both the preview and the create.
// ---------------------------------------------------------------------------

interface Order {
  readonly marketplaceId: string;
  readonly key: CreatorSampleOrderKey;
  readonly item: CreatorMcfPreviewItem;
  /** The v2020 Address, field by field from the parsed recipient: never a phone. */
  readonly address: Readonly<Record<string, string>>;
  readonly screen: (code: string) => boolean;
}

function order(input: CreatorMcfOrderInput): Order {
  if (!isRecord(input) || typeof input.marketplaceId !== 'string' || !MARKETPLACE_ID.test(input.marketplaceId)) {
    throw new FulfillmentOutboundError('invalid_request');
  }
  const key = CreatorSampleOrderKey.safeParse(input.derivedOrderKey);
  const recipient = CreatorMcfRecipient.safeParse(input.recipient);
  if (!key.success || !recipient.success) throw new FulfillmentOutboundError('invalid_request');
  const item = CreatorMcfPreviewItem.safeParse({ sellerSku: input.sellerSku, sellerFulfillmentOrderItemId: `${key.data}-1`, quantity: 1 });
  if (!item.success) throw new FulfillmentOutboundError('invalid_request');
  const address: Record<string, string> = {};
  for (const field of ['name', 'addressLine1', 'addressLine2', 'addressLine3', 'city', 'districtOrCounty', 'stateOrRegion',
    'postalCode', 'countryCode'] as const) {
    const value = recipient.data[field];
    if (value !== undefined) address[field] = value;
  }
  return { marketplaceId: input.marketplaceId, key: key.data, item: item.data, address, screen: recipientScreen(recipient.data) };
}

/**
 * Whether a provider code repeats recipient text. The code pattern already
 * refuses free text; this also withholds an unknown code that is or contains a
 * recipient word (for example a street name Amazon echoed as a code). Known
 * Amazon codes are never withheld. A withheld code only costs detail: the
 * status still classifies the answer.
 */
function recipientScreen(recipient: CreatorMcfRecipient): (code: string) => boolean {
  const exact = new Set<string>();
  const contained = new Set<string>();
  for (const value of Object.values(recipient)) {
    if (typeof value !== 'string') continue;
    const runs = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of [...runs, runs.join('')]) {
      if (token.length >= 4) contained.add(token);
      else if (token.length >= 2) exact.add(token);
    }
  }
  return (code) => {
    if (KNOWN_PROVIDER_CODES.has(code)) return false;
    const folded = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    return exact.has(folded) || [...contained].some((token) => folded.includes(token));
  };
}

const withholdNothing = (): boolean => false;

function createBody(input: Order, displayableOrderDate: string): RecordValue {
  return {
    marketplaceId: input.marketplaceId,
    sellerFulfillmentOrderId: input.key,
    displayableOrderId: input.key,
    displayableOrderDate,
    displayableOrderComment: CREATOR_MCF_PACKING_SLIP_COMMENT,
    shippingSpeedCategory: CREATOR_MCF_ORDER_SETTINGS.shippingSpeedCategory,
    destinationAddress: { ...input.address },
    fulfillmentAction: CREATOR_MCF_ORDER_SETTINGS.fulfillmentAction,
    fulfillmentPolicy: CREATOR_MCF_ORDER_SETTINGS.fulfillmentPolicy,
    items: [{ ...input.item }],
  };
}

function previewBody(input: Order): RecordValue {
  return {
    marketplaceId: input.marketplaceId,
    address: { ...input.address },
    items: [{ ...input.item }],
    shippingSpeedCategories: [CREATOR_MCF_ORDER_SETTINGS.shippingSpeedCategory],
    includeCODFulfillmentPreview: false,
    includeDeliveryWindows: false,
  };
}

// ---------------------------------------------------------------------------
// One HTTP exchange. No retry: every call below sends at most one request.
// ---------------------------------------------------------------------------

type Exchange = { readonly kind: 'transport' } | { readonly kind: 'response'; readonly status: number; readonly text: string | null };

async function exchange(options: FulfillmentOutboundWriterOptions, method: 'POST' | 'PUT', path: string, body?: RecordValue): Promise<Exchange> {
  const timeoutMs = options.timeoutMs ?? FULFILLMENT_OUTBOUND_WRITE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > FULFILLMENT_OUTBOUND_WRITE_TIMEOUT_MS) throw new FulfillmentOutboundError('invalid_request');
  let access: string;
  // Nothing has been sent yet, so a credential failure is not an uncertain outcome.
  try { access = await options.accessTokenProvider.getAccessToken(); }
  catch { throw new FulfillmentOutboundError('authentication'); }
  // Everything that can fail locally is built before the request, so only the
  // request itself can yield "transport".
  let url: string;
  let init: RequestInit;
  try {
    url = `${options.endpoint.replace(/\/$/, '')}${path}`;
    init = {
      method,
      // A followed 307 or 308 would repeat the request: redirects are answers, not hops.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        'User-Agent': options.userAgent,
        'x-amz-access-token': access,
        'x-amz-date': (options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, ''),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
  } catch { throw new FulfillmentOutboundError('invalid_request'); }
  let response: Response;
  try {
    response = await options.fetch(url, init);
  } catch {
    return { kind: 'transport' };
  }
  let text: string | null;
  try { text = await response.text(); } catch { text = null; }
  return { kind: 'response', status: response.status, text };
}

function decode(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null || text.length > MAX_BODY_CHARS) return { ok: false };
  if (text.trim() === '') return { ok: true, value: null };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false }; }
}

/** `errors[].code` only: never a message, details or any other member. */
function errorCodes(text: string | null, withheld: (code: string) => boolean): string[] {
  const decoded = decode(text);
  if (!decoded.ok || !isRecord(decoded.value) || !Array.isArray(decoded.value['errors'])) return [];
  const codes: string[] = [];
  for (const entry of decoded.value['errors'] as unknown[]) {
    if (codes.length === MAX_CODES) break;
    const code = isRecord(entry) ? entry['code'] : undefined;
    if (typeof code === 'string' && PROVIDER_CODE.test(code) && !withheld(code) && !codes.includes(code)) codes.push(code);
  }
  return codes;
}

function refusalReason(status: number): CreatorMcfRefusalReason {
  if (status === 429) return 'throttled';
  if (status === 401 || status === 403) return 'authorization';
  // 400, 404 and every 4xx not listed above.
  return 'validation';
}

/**
 * The write outcome of one create or cancel exchange.
 *
 * | Answer                                                   | Outcome                              |
 * |----------------------------------------------------------|--------------------------------------|
 * | no response (network, abort, timeout)                    | uncertain, transport, status null    |
 * | 200 with an empty body or a JSON object without errors   | accepted                             |
 * | 200 whose body cannot be read or decoded, or has errors  | uncertain, decode, 200               |
 * | 408                                                      | uncertain, http_408                  |
 * | 500 to 599                                               | uncertain, http_5xx                  |
 * | 429                                                      | rejected, throttled, codes           |
 * | 401, 403                                                 | rejected, authorization, codes       |
 * | 400, 404 and any other 4xx                               | rejected, validation, codes          |
 * | any other status (1xx, other 2xx, 3xx, opaque)           | uncertain, decode, status or null    |
 */
function writeOutcome(answer: Exchange, withheld: (code: string) => boolean): CreatorMcfProviderOutcome {
  if (answer.kind === 'transport') return CreatorMcfProviderOutcome.parse({ outcome: 'uncertain', cause: 'transport', status: null });
  const { status, text } = answer;
  if (status === 200) {
    const decoded = decode(text);
    const clean = decoded.ok && (decoded.value === null
      || (isRecord(decoded.value) && (decoded.value['errors'] === undefined
        || (Array.isArray(decoded.value['errors']) && decoded.value['errors'].length === 0))));
    return CreatorMcfProviderOutcome.parse(clean ? { outcome: 'accepted', status: 200 } : { outcome: 'uncertain', cause: 'decode', status: 200 });
  }
  if (status === 408) return CreatorMcfProviderOutcome.parse({ outcome: 'uncertain', cause: 'http_408', status });
  if (status >= 500 && status <= 599) return CreatorMcfProviderOutcome.parse({ outcome: 'uncertain', cause: 'http_5xx', status });
  if (status >= 400 && status <= 499) {
    return CreatorMcfProviderOutcome.parse({ outcome: 'rejected', status, reason: refusalReason(status), codes: errorCodes(text, withheld) });
  }
  return CreatorMcfProviderOutcome.parse({ outcome: 'uncertain', cause: 'decode',
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null });
}

// ---------------------------------------------------------------------------
// Preview parsing: an allowlist copied out of the provider body.
// ---------------------------------------------------------------------------

function timestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) throw new FulfillmentOutboundError('invalid_response');
  return new Date(value).toISOString();
}

function units(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new FulfillmentOutboundError('invalid_response');
  return value as number;
}

/** A Money value in minor units: exact, never rounded. */
function minor(value: unknown, exponent: number): number {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  const match = typeof text === 'string' ? /^(\d{1,13})(?:\.(\d{1,12}))?$/.exec(text) : null;
  if (!match) throw new FulfillmentOutboundError('invalid_response');
  const fraction = match[2] ?? '';
  if (fraction.replace(/0+$/, '').length > exponent) throw new FulfillmentOutboundError('invalid_response');
  const amount = Number(match[1]) * 10 ** exponent + Number(fraction.padEnd(exponent, '0').slice(0, exponent) || '0');
  if (!Number.isSafeInteger(amount)) throw new FulfillmentOutboundError('invalid_response');
  return amount;
}

function fees(value: unknown): CreatorMcfFees | null {
  if (value === undefined || value === null) return null;
  const rows = list(value).map(record);
  if (rows.length === 0) return null;
  let currency: string | null = null;
  const parts = rows.map((row) => {
    const amount = record(row['amount']);
    const code = amount['currencyCode'];
    if (typeof code !== 'string' || CURRENCY_EXPONENT[code] === undefined || (currency !== null && currency !== code)) {
      throw new FulfillmentOutboundError('invalid_response');
    }
    currency = code;
    const feeName = row['name'];
    if (typeof feeName !== 'string' || !FEE_NAMES.has(feeName)) throw new FulfillmentOutboundError('invalid_response');
    return { feeName, amountMinor: minor(amount['value'], CURRENCY_EXPONENT[code]) };
  });
  const parsed = CreatorMcfFees.safeParse({ parts, totalMinor: parts.reduce((sum, part) => sum + part.amountMinor, 0), currency });
  if (!parsed.success) throw new FulfillmentOutboundError('invalid_response');
  return parsed.data;
}

function reasons(value: unknown, withheld: (code: string) => boolean): { kept: string[]; withheld: number } {
  const kept: string[] = [];
  let dropped = 0;
  for (const reason of list(value ?? [])) {
    if (typeof reason === 'string' && PROVIDER_CODE.test(reason) && !withheld(reason)) {
      if (!kept.includes(reason)) kept.push(reason);
    } else dropped += 1;
  }
  return { kept, withheld: dropped };
}

function earliest(values: (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null).sort();
  return present[0] ?? null;
}
function latest(values: (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null).sort();
  return present[present.length - 1] ?? null;
}

function previewEvidence(input: Order, text: string | null): CreatorMcfPreviewEvidence {
  const decoded = decode(text);
  if (!decoded.ok) throw new FulfillmentOutboundError('invalid_response');
  const body = record(decoded.value);
  if (body['errors'] !== undefined && list(body['errors']).length > 0) throw new FulfillmentOutboundError('invalid_response');
  const previews = list(record(body['payload'])['fulfillmentPreviews']).map(record)
    .filter((row) => row['shippingSpeedCategory'] === CREATOR_MCF_ORDER_SETTINGS.shippingSpeedCategory && row['isCODCapable'] !== true);
  if (previews.length !== 1) throw new FulfillmentOutboundError('invalid_response');
  const preview = previews[0]!;
  if (preview['marketplaceId'] !== input.marketplaceId || typeof preview['isFulfillable'] !== 'boolean') {
    throw new FulfillmentOutboundError('invalid_response');
  }
  const isFulfillable = preview['isFulfillable'];
  const ours = (row: RecordValue): number => {
    if (row['sellerFulfillmentOrderItemId'] !== input.item.sellerFulfillmentOrderItemId || row['sellerSku'] !== input.item.sellerSku) {
      throw new FulfillmentOutboundError('invalid_response');
    }
    return units(row['quantity']);
  };
  const shipments = list(preview['fulfillmentPreviewShipments'] ?? []).map(record);
  const fulfillableUnits = shipments.reduce((sum, shipment) =>
    sum + list(shipment['fulfillmentPreviewItems'] ?? []).map(record).reduce((inner, row) => inner + ours(row), 0), 0);
  const unfulfillable = list(preview['unfulfillablePreviewItems'] ?? []).map(record);
  const unfulfillableUnits = unfulfillable.reduce((sum, row) => sum + ours(row), 0);
  if (fulfillableUnits + unfulfillableUnits > input.item.quantity || (isFulfillable && fulfillableUnits !== input.item.quantity)) {
    throw new FulfillmentOutboundError('invalid_response');
  }
  const orderReasons = reasons(preview['orderUnfulfillableReasons'], input.screen);
  const itemReasons = unfulfillable.map((row) => reasons(row['itemUnfulfillableReasons'], input.screen));
  const item = [...new Set(itemReasons.flatMap((entry) => entry.kept))];
  const all = [...new Set([...orderReasons.kept, ...item])];
  const window = shipments.map((shipment) => ({
    earliestShip: timestamp(shipment['earliestShipDate']), latestShip: timestamp(shipment['latestShipDate']),
    earliestArrival: timestamp(shipment['earliestArrivalDate']), latestArrival: timestamp(shipment['latestArrivalDate']),
  }));
  return {
    outcome: 'previewed',
    marketplaceId: input.marketplaceId,
    derivedOrderKey: input.key,
    items: [{ ...input.item }],
    shippingSpeedCategory: CREATOR_MCF_ORDER_SETTINGS.shippingSpeedCategory,
    fulfillmentAction: CREATOR_MCF_ORDER_SETTINGS.fulfillmentAction,
    fulfillmentPolicy: CREATOR_MCF_ORDER_SETTINGS.fulfillmentPolicy,
    featureConstraints: [],
    isFulfillable,
    fees: fees(preview['estimatedFees']),
    fulfillableUnits,
    unfulfillableUnits,
    orderUnfulfillableReasons: orderReasons.kept.slice(0, MAX_CODES),
    itemUnfulfillableReasons: item.slice(0, MAX_CODES),
    unfulfillableReasons: all.slice(0, MAX_CODES),
    withheldReasons: orderReasons.withheld + itemReasons.reduce((sum, entry) => sum + entry.withheld, 0) + Math.max(0, all.length - MAX_CODES),
    earliestShipAt: earliest(window.map((entry) => entry.earliestShip)),
    latestShipAt: latest(window.map((entry) => entry.latestShip)),
    earliestArrivalAt: earliest(window.map((entry) => entry.earliestArrival)),
    latestArrivalAt: latest(window.map((entry) => entry.latestArrival)),
  };
}

// ---------------------------------------------------------------------------
// The writer.
// ---------------------------------------------------------------------------

/**
 * getFulfillmentPreview, createFulfillmentOrder and cancelFulfillmentOrder for
 * one creator sample order. Each method sends at most one request and never
 * retries, re-authenticates or follows a redirect. Reads (getOrder) go through
 * WP-334's `FulfillmentOutboundReader`.
 */
export class FulfillmentOutboundWriter {
  constructor(private readonly options: FulfillmentOutboundWriterOptions) {}

  /**
   * getFulfillmentPreview for exactly the item, speed and settings `create`
   * sends. A 4xx is a refusal with codes only. Throws FulfillmentOutboundError
   * when nothing usable came back: invalid_request or authentication before
   * sending; transport; http for 408, 5xx and any status that is not 200 or
   * 4xx; invalid_response for a 200 that is not a single well-formed Standard
   * preview for this item.
   */
  async preview(input: CreatorMcfOrderInput): Promise<CreatorMcfPreviewResult> {
    const settled = order(input);
    const answer = await exchange(this.options, 'POST', `${PATH}/preview`, previewBody(settled));
    if (answer.kind === 'transport') throw new FulfillmentOutboundError('transport');
    if (answer.status === 200) return previewEvidence(settled, answer.text);
    if (answer.status >= 400 && answer.status <= 499 && answer.status !== 408) {
      return { outcome: 'refused', status: answer.status, reason: refusalReason(answer.status), codes: errorCodes(answer.text, settled.screen) };
    }
    throw new FulfillmentOutboundError('http', answer.status);
  }

  /**
   * createFulfillmentOrder: Ship, FillOrKill, Standard, one unit, the CCS key
   * as both sellerFulfillmentOrderId and displayableOrderId, the fixed
   * packing-slip comment, and no notification emails, phone or feature
   * constraints.
   *
   * Every provider answer, and every failure after the request may have left,
   * returns a CreatorMcfProviderOutcome (see `writeOutcome` for the table). It
   * throws only before any request leaves: invalid_request for input that does
   * not parse, authentication when no access token could be obtained. The
   * caller must reserve the intent durably before calling, and must settle an
   * uncertain outcome by reading the order, never by calling create again.
   *
   * A 4xx `rejected` does not prove that no order exists: what v2020 answers
   * for a duplicate sellerFulfillmentOrderId, and whether a 429 is always
   * returned before the order is processed, are unverified (DESIGN, "Amazon
   * facts still unverified"). The caller must follow every rejected outcome
   * with `FulfillmentOutboundReader.getOrder` before treating the send as not
   * placed (DESIGN section 8).
   */
  async create(input: CreatorMcfCreateInput): Promise<CreatorMcfProviderOutcome> {
    const settled = order(input);
    const date = input.displayableOrderDate;
    if (typeof date !== 'string' || !TIMESTAMP.test(date) || Number.isNaN(Date.parse(date))) {
      throw new FulfillmentOutboundError('invalid_request');
    }
    const answer = await exchange(this.options, 'POST', PATH, createBody(settled, new Date(date).toISOString()));
    return writeOutcome(answer, settled.screen);
  }

  /**
   * cancelFulfillmentOrder: a PUT with no body, for a CCS key only. Same
   * outcome table and the same no-throw rule as `create`. Whether the order may
   * be cancelled (Received or Planning) is the caller's read to make first.
   */
  async cancel(derivedOrderKey: CreatorSampleOrderKey): Promise<CreatorMcfProviderOutcome> {
    const key = CreatorSampleOrderKey.safeParse(derivedOrderKey);
    if (!key.success) throw new FulfillmentOutboundError('invalid_request');
    const answer = await exchange(this.options, 'PUT', `${PATH}/${encodeURIComponent(key.data)}/cancel`);
    return writeOutcome(answer, withholdNothing);
  }
}
