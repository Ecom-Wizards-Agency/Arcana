import {
  FulfillmentCarrierStatus, FulfillmentIntent, FulfillmentOrderList, FulfillmentOrderLookup, FulfillmentOrderStatus, FulfillmentRequest,
  FulfillmentResult, FulfillmentShipmentStatus, PackageTrackingObservation,
  type FulfillmentOrderListEntry, type FulfillmentShipmentObservation,
} from '@wizard-ads/shared';
import type { SpApiClientOptions } from './types.js';
import { canonicalSpJson, spFingerprint } from './report-families.js';

const PATH = '/fba/outbound/2020-07-01/fulfillmentOrders';
const TRACKING_PATH = '/fba/outbound/2020-07-01/tracking';
type Options = Pick<SpApiClientOptions, 'endpoint' | 'accessTokenProvider' | 'userAgent' | 'now'> & {
  /** Explicit transport injection keeps this sibling inert until worker composition. */
  fetch: NonNullable<SpApiClientOptions['fetch']>;
};
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FulfillmentOutboundError('invalid_response');
  return value as RecordValue;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new FulfillmentOutboundError('invalid_response');
  return value;
}

/** Provider bodies, recipient fields, credentials and underlying errors never escape. */
export class FulfillmentOutboundError extends Error {
  constructor(readonly reason: 'invalid_request' | 'identity_conflict' | 'invalid_response' | 'transport' | 'authentication' | 'http', readonly status = 0) {
    super(`Fulfillment Outbound ${reason}${status ? ` (${status})` : ''}`);
    this.name = 'FulfillmentOutboundError';
  }
}

function request(raw: FulfillmentRequest): FulfillmentRequest {
  const parsed = FulfillmentRequest.safeParse(raw);
  if (!parsed.success) throw new FulfillmentOutboundError('invalid_request');
  return parsed.data;
}
function payload(input: FulfillmentRequest): RecordValue {
  const { scope, callerRequestId: _caller, ...body } = input;
  return { ...body, marketplaceId: scope.marketplaceId };
}
export function fulfillmentIntent(raw: FulfillmentRequest): FulfillmentIntent {
  const input = request(raw);
  return { scope: input.scope, callerRequestId: input.callerRequestId,
    sellerFulfillmentOrderId: input.sellerFulfillmentOrderId,
    payloadFingerprint: spFingerprint({ scope: input.scope, callerRequestId: input.callerRequestId, payload: payload(input) }),
    items: input.items, state: 'reserved' };
}
function verify(input: FulfillmentRequest, raw: FulfillmentIntent): FulfillmentIntent {
  const parsed = FulfillmentIntent.safeParse(raw);
  if (!parsed.success) throw new FulfillmentOutboundError('identity_conflict');
  const expected = fulfillmentIntent(input);
  if (canonicalSpJson({ ...parsed.data, state: 'reserved' }) !== canonicalSpJson(expected)) {
    throw new FulfillmentOutboundError('identity_conflict');
  }
  return parsed.data;
}
function empty(input: FulfillmentRequest, state: FulfillmentResult['state'] = 'unresolved'): FulfillmentResult {
  return { state, requestedItems: input.items.length, returnedItems: 0, missingItems: input.items.length, refusedItems: 0, items: [] };
}

/** One HTTP exchange. Provider bodies and errors never escape; see FulfillmentOutboundError. */
async function send(options: Options, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  let access: string;
  try { access = await options.accessTokenProvider.getAccessToken(); }
  catch { throw new FulfillmentOutboundError('authentication'); }
  let response: Response;
  try {
    response = await options.fetch(`${options.endpoint.replace(/\/$/, '')}${path}`, {
      method, headers: { Accept: 'application/json', 'Content-Type': 'application/json',
        'User-Agent': options.userAgent, 'x-amz-access-token': access,
        'x-amz-date': (options.now?.() ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, '') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new FulfillmentOutboundError('transport'); }
  if (!response.ok) throw new FulfillmentOutboundError('http', response.status);
  try {
    const text = await response.text();
    if (!text) return null;
    const decoded: unknown = JSON.parse(text);
    if (record(decoded)['errors'] !== undefined && list(record(decoded)['errors']).length > 0) {
      throw new FulfillmentOutboundError('invalid_response');
    }
    return decoded;
  } catch { throw new FulfillmentOutboundError('invalid_response'); }
}

/** No retry loop, scheduler, authority grant or recipient persistence lives here. */
export class FulfillmentOutboundClient {
  constructor(private readonly options: Options) {}

  private call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    return send(this.options, method, path, body);
  }

  async preview(raw: FulfillmentRequest): Promise<FulfillmentResult> {
    const input = request(raw);
    const result = record(await this.call('POST', `${PATH}/preview`, {
      marketplaceId: input.scope.marketplaceId, address: input.destinationAddress, items: input.items,
      shippingSpeedCategories: [input.shippingSpeedCategory], includeCODFulfillmentPreview: false,
    }));
    const previews = list(record(result['payload'])['fulfillmentPreviews']).map(record).filter(row =>
      row['marketplaceId'] === input.scope.marketplaceId && row['shippingSpeedCategory'] === input.shippingSpeedCategory && row['isCODCapable'] === false);
    if (previews.length !== 1 || typeof previews[0]!['isFulfillable'] !== 'boolean') throw new FulfillmentOutboundError('invalid_response');
    const preview = previews[0]!;
    const observed = list(preview['fulfillmentPreviewShipments'] ?? []).flatMap(shipment =>
      list(record(shipment)['fulfillmentPreviewItems']).map(row => ({ row: record(row), refused: false })));
    observed.push(...list(preview['unfulfillablePreviewItems'] ?? []).map(row => ({ row: record(row), refused: true })));
    const counted = account(input, observed);
    if (preview['isFulfillable'] === false && counted.state === 'observed') counted.state = 'refused';
    return counted;
  }

  /**
   * Caller must atomically claim the reserved intent and durably save uncertainty
   * before returning from persistUncertain. Replays of uncertainty only read by ID.
   * This callback does not confer worker/operator authority.
   */
  async create(raw: FulfillmentRequest, persistedIntent: FulfillmentIntent,
    persistUncertain: (intent: FulfillmentIntent) => Promise<void>): Promise<FulfillmentResult> {
    const input = request(raw);
    const intent = verify(input, persistedIntent);
    if (intent.state !== 'reserved') return this.status(input, intent);
    await persistUncertain({ ...intent, state: 'uncertain' });
    try {
      // The pinned create operation returns HTTP 200 with no per-item receipt.
      await this.call('POST', PATH, payload(input));
      return empty(input, 'accepted');
    } catch (error) {
      if (error instanceof FulfillmentOutboundError && (error.reason === 'authentication' ||
        (error.reason === 'http' && error.status >= 400 && error.status < 500 && error.status !== 408))) throw error;
      return this.status(input, { ...intent, state: 'uncertain' });
    }
  }

  async status(raw: FulfillmentRequest, persistedIntent: FulfillmentIntent): Promise<FulfillmentResult> {
    const input = request(raw);
    verify(input, persistedIntent);
    let response: unknown;
    try { response = await this.call('GET', `${PATH}/${encodeURIComponent(input.sellerFulfillmentOrderId)}`); }
    catch (error) {
      if (error instanceof FulfillmentOutboundError && (error.reason === 'transport' || error.status === 404 || error.status === 408 || error.status >= 500)) return empty(input);
      throw error;
    }
    const result = record(record(response)['payload']);
    const order = record(result['fulfillmentOrder']);
    const expected = payload(input);
    for (const key of ['sellerFulfillmentOrderId', 'marketplaceId', 'displayableOrderId', 'displayableOrderComment', 'shippingSpeedCategory']) {
      if (order[key] !== expected[key]) throw new FulfillmentOutboundError('identity_conflict');
    }
    if (typeof order['displayableOrderDate'] !== 'string' || Date.parse(order['displayableOrderDate']) !== Date.parse(input.displayableOrderDate)) {
      throw new FulfillmentOutboundError('identity_conflict');
    }
    const address = record(order['destinationAddress']);
    for (const [key, value] of Object.entries(input.destinationAddress)) {
      if (address[key] !== value) throw new FulfillmentOutboundError('identity_conflict');
    }
    const parsedStatus = FulfillmentOrderStatus.safeParse(order['fulfillmentOrderStatus']);
    if (!parsedStatus.success) throw new FulfillmentOutboundError('invalid_response');
    const providerOrderStatus = parsedStatus.data;
    const orderRefused = ['Cancelled', 'Unfulfillable', 'Invalid'].includes(providerOrderStatus);
    const seen = new Set<unknown>();
    const rows = list(result['fulfillmentOrderItems']).map(value => {
      const row = record(value);
      const id = row['sellerFulfillmentOrderItemId'];
      if (seen.has(id)) throw new FulfillmentOutboundError('invalid_response');
      seen.add(id);
      for (const key of ['cancelledQuantity', 'unfulfillableQuantity']) {
        if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0 || Number(row[key]) > Number(row['quantity'])) throw new FulfillmentOutboundError('invalid_response');
      }
      const refusedQuantity = Number(row['cancelledQuantity']) + Number(row['unfulfillableQuantity']);
      if (refusedQuantity > Number(row['quantity'])) throw new FulfillmentOutboundError('invalid_response');
      return { row, refused: orderRefused || refusedQuantity > 0 };
    });
    const counted = account(input, rows);
    return { ...counted, providerOrderStatus, ...(orderRefused ? { state: 'refused' as const } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Read-only observation (WP-334). Each reader copies an allowlist of fields out
// of the provider body, so a recipient field Amazon adds tomorrow cannot pass
// through either: destination address, notification emails, displayable order
// id and comment, signer, ship-to address, carrier phone and event locations
// never leave this module.
// ---------------------------------------------------------------------------

function optional(value: unknown): RecordValue | null {
  return value === undefined || value === null ? null : record(value);
}
function text(value: unknown, max = 100): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new FulfillmentOutboundError('invalid_response');
  return value;
}
function when(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new FulfillmentOutboundError('invalid_response');
  return new Date(value).toISOString();
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new FulfillmentOutboundError('invalid_response');
  return Number(value);
}
function status<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new FulfillmentOutboundError('invalid_response');
  return parsed.data;
}

function shipment(value: unknown): FulfillmentShipmentObservation {
  const row = record(value);
  return {
    amazonShipmentId: text(row['amazonShipmentId']) ?? (() => { throw new FulfillmentOutboundError('invalid_response'); })(),
    status: status(FulfillmentShipmentStatus, row['fulfillmentShipmentStatus']),
    shippedAt: when(row['shippingDate']),
    estimatedArrivalAt: when(row['estimatedArrivalDate']),
    packages: list(row['fulfillmentShipmentPackage'] ?? []).map((item) => {
      const pkg = record(item);
      return { packageNumber: count(pkg['packageNumber']), carrierCode: text(pkg['carrierCode']), trackingNumber: text(pkg['trackingNumber']),
        estimatedArrivalAt: when(pkg['estimatedArrivalDate']) };
    }),
  };
}

/**
 * Read-only Fulfillment Outbound observation. It has no create, update or
 * cancel path and holds no request body: it can only ask Amazon what exists.
 */
export class FulfillmentOutboundReader {
  constructor(private readonly options: Options) {}

  /** The reader's only way to reach Amazon: a GET, never a body. */
  private read(path: string): Promise<unknown> { return send(this.options, 'GET', path); }

  /**
   * getFulfillmentOrder by seller fulfillment order id. HTTP 404 is Amazon
   * saying no order exists under that id; any other failure throws, so a
   * transport error is never read as "not found".
   */
  async getOrder(sellerFulfillmentOrderId: string): Promise<FulfillmentOrderLookup> {
    if (!/^.{1,40}$/.test(sellerFulfillmentOrderId)) throw new FulfillmentOutboundError('invalid_request');
    let response: unknown;
    try { response = await this.read(`${PATH}/${encodeURIComponent(sellerFulfillmentOrderId)}`); }
    catch (error) {
      if (error instanceof FulfillmentOutboundError && error.reason === 'http' && error.status === 404) {
        return { outcome: 'not_found', sellerFulfillmentOrderId };
      }
      throw error;
    }
    const payload = record(record(response)['payload']);
    const order = record(payload['fulfillmentOrder']);
    if (order['sellerFulfillmentOrderId'] !== sellerFulfillmentOrderId) throw new FulfillmentOutboundError('identity_conflict');
    return FulfillmentOrderLookup.parse({ outcome: 'found', order: {
      sellerFulfillmentOrderId,
      status: status(FulfillmentOrderStatus, order['fulfillmentOrderStatus']),
      receivedAt: when(order['receivedDate']),
      statusUpdatedAt: when(order['statusUpdatedDate']),
      items: list(payload['fulfillmentOrderItems'] ?? []).map((item) => {
        const row = record(item);
        return { sellerSku: text(row['sellerSku'], 50) ?? (() => { throw new FulfillmentOutboundError('invalid_response'); })(),
          quantity: count(row['quantity']), cancelledQuantity: count(row['cancelledQuantity'] ?? 0),
          unfulfillableQuantity: count(row['unfulfillableQuantity'] ?? 0) };
      }),
      // The whole array: a cancelled shipment can be replaced by another entry rather than removed.
      shipments: list(payload['fulfillmentShipments'] ?? []).map(shipment),
    } });
  }

  /** listAllFulfillmentOrders from `queryStartDate`, at most `maxPages` pages. Identity and status only. */
  async listOrders(queryStartDate: string, maxPages = 5): Promise<FulfillmentOrderList> {
    if (Number.isNaN(Date.parse(queryStartDate)) || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 20) {
      throw new FulfillmentOutboundError('invalid_request');
    }
    const start = new Date(queryStartDate).toISOString();
    const orders: FulfillmentOrderListEntry[] = [];
    let nextToken: string | null = null;
    let pages = 0;
    do {
      const query = new URLSearchParams({ queryStartDate: start, ...(nextToken === null ? {} : { nextToken }) });
      const payload = record(record(await this.read(`${PATH}?${query.toString()}`))['payload']);
      pages++;
      for (const item of list(payload['fulfillmentOrders'] ?? [])) {
        const row = record(item);
        orders.push({ sellerFulfillmentOrderId: text(row['sellerFulfillmentOrderId'], 40) ?? (() => { throw new FulfillmentOutboundError('invalid_response'); })(),
          status: status(FulfillmentOrderStatus, row['fulfillmentOrderStatus']), receivedAt: when(row['receivedDate']),
          statusUpdatedAt: when(row['statusUpdatedDate']) });
      }
      nextToken = text(payload['nextToken'], 2000);
    } while (nextToken !== null && pages < maxPages);
    return FulfillmentOrderList.parse({ queryStartDate: start, pages, complete: nextToken === null, orders });
  }

  /**
   * getPackageTrackingDetails. Null when Amazon has no tracking for the package
   * yet (HTTP 404); a null `currentStatus` is Amazon returning no carrier status.
   */
  async trackPackage(packageNumber: number): Promise<PackageTrackingObservation | null> {
    if (!Number.isSafeInteger(packageNumber) || packageNumber < 0) throw new FulfillmentOutboundError('invalid_request');
    let response: unknown;
    try { response = await this.read(`${TRACKING_PATH}?${new URLSearchParams({ packageNumber: String(packageNumber) }).toString()}`); }
    catch (error) {
      if (error instanceof FulfillmentOutboundError && error.reason === 'http' && error.status === 404) return null;
      throw error;
    }
    const payload = optional(record(response)['payload']);
    if (payload === null) return null;
    if (payload['packageNumber'] !== packageNumber) throw new FulfillmentOutboundError('identity_conflict');
    const current = payload['currentStatus'];
    return PackageTrackingObservation.parse({
      packageNumber, carrierCode: text(payload['carrierCode']), trackingNumber: text(payload['trackingNumber']),
      estimatedArrivalAt: when(payload['estimatedArrivalDate']),
      currentStatus: current === undefined || current === null ? null : status(FulfillmentCarrierStatus, current),
    });
  }
}

function account(input: FulfillmentRequest, rows: { row: RecordValue; refused: boolean }[]): FulfillmentResult {
  const quantities = new Map<string, { quantity: number; refused: boolean }>();
  for (const { row, refused } of rows) {
    const expected = input.items.find(item => item.sellerFulfillmentOrderItemId === row['sellerFulfillmentOrderItemId']);
    if (!expected || expected.sellerSku !== row['sellerSku'] || !Number.isSafeInteger(row['quantity']) || Number(row['quantity']) <= 0) throw new FulfillmentOutboundError('invalid_response');
    const previous = quantities.get(expected.sellerFulfillmentOrderItemId);
    const quantity = (previous?.quantity ?? 0) + Number(row['quantity']);
    if (quantity > expected.quantity) throw new FulfillmentOutboundError('invalid_response');
    quantities.set(expected.sellerFulfillmentOrderItemId, { quantity, refused: refused || previous?.refused === true });
  }
  const items = input.items.flatMap(item => {
    const found = quantities.get(item.sellerFulfillmentOrderItemId);
    return found ? [{ sellerFulfillmentOrderItemId: item.sellerFulfillmentOrderItemId, quantity: found.quantity,
      status: found.refused ? 'refused' : found.quantity === item.quantity ? 'observed' : 'partial' }] : [];
  });
  const missingItems = input.items.length - items.length;
  const refusedItems = items.filter(item => item.status === 'refused').length;
  const partial = items.some(item => item.quantity !== input.items.find(expected => expected.sellerFulfillmentOrderItemId === item.sellerFulfillmentOrderItemId)!.quantity);
  return FulfillmentResult.parse({ state: missingItems > 0 || partial ? 'unresolved' : refusedItems > 0 ? 'refused' : 'observed',
    requestedItems: input.items.length, returnedItems: items.length, missingItems, refusedItems, items });
}
