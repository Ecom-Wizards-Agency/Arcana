/**
 * A fake SP-API Fulfillment Outbound v2020-07-01 endpoint for the MCF unit's
 * tests (WP-338e). It answers at the HTTP level, so the real
 * `FulfillmentOutboundWriter` and `FulfillmentOutboundReader` parse every
 * answer, and it counts requests at the wire: `posts` is the number of
 * createFulfillmentOrder requests that reached "Amazon".
 *
 * Like Amazon, it keeps the destination it was sent and echoes it back: in
 * getFulfillmentOrder bodies, and in error messages and details of 4xx bodies.
 * The reader and writer must drop all of it; a test that finds a recipient
 * value anywhere but in `requests` has found a leak. `requests` is the positive
 * control: it holds the bodies as sent, recipient included, in memory only.
 *
 * Synthetic data only. No network: `fetch` is a function the worker is given.
 */
import type { FetchLike, SpApiAccessTokenProvider } from '@wizard-ads/sp-api';

const BASE = '/fba/outbound/2020-07-01/fulfillmentOrders';

export type FakeOrderStatus = 'New' | 'Received' | 'Planning' | 'Processing' | 'Complete' | 'CompletePartialled' | 'Invalid' | 'Unfulfillable' | 'Cancelled';

export interface FakeOrder {
  sellerFulfillmentOrderId: string;
  status: FakeOrderStatus;
  sellerSku: string;
  quantity: number;
  destination: Record<string, unknown> | null;
}

/** getFulfillmentPreview answers. `ok` is Amazon's single Standard preview. */
export type FakePreviewAnswer =
  | { kind: 'ok'; fulfillable?: boolean; feeValue?: string; currency?: string; earliestArrival?: string; latestArrival?: string; reasons?: string[] }
  | { kind: 'http'; status: number; codes?: string[] }
  | { kind: 'transport' };

/**
 * createFulfillmentOrder answers. `creates` says whether the order exists at
 * Amazon afterwards (a 5xx or a lost answer may still have created it).
 */
export type FakeCreateAnswer =
  | { kind: 'ok'; status?: FakeOrderStatus }
  | { kind: 'http'; status: number; codes?: string[]; creates?: boolean; createdStatus?: FakeOrderStatus }
  | { kind: 'transport'; creates?: boolean; createdStatus?: FakeOrderStatus }
  | { kind: 'undecodable'; creates?: boolean };

/** One-shot getFulfillmentOrder failures, consumed before the normal answer. */
export type FakeReadAnswer = { kind: 'http'; status: number } | { kind: 'transport' };

export interface FakeRequest {
  method: string;
  path: string;
  /** The body as sent, recipient included (the positive control). */
  body: string | null;
  /** The fake's clock when the request arrived. */
  at: number;
  operation: 'preview' | 'create' | 'get' | 'cancel' | 'other';
}

export interface FakeFulfillmentOutboundOptions {
  /** Clock for `requests[].at` (tests pass their fake clock). */
  now?: () => number;
  /** Called with each request before it is answered: tests turn flags off "between steps" here. */
  onRequest?: (request: FakeRequest) => void | Promise<void>;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function echoText(destination: Record<string, unknown> | null): string {
  return destination === null ? '' : Object.values(destination).filter((value) => typeof value === 'string').join(', ');
}

export class FakeFulfillmentOutbound {
  readonly requests: FakeRequest[] = [];
  readonly orders = new Map<string, FakeOrder>();
  /** Queued preview answers; the last one repeats. */
  previewAnswers: FakePreviewAnswer[] = [{ kind: 'ok' }];
  /** Queued create answers; `ok` when empty. */
  createAnswers: FakeCreateAnswer[] = [];
  /** Queued one-shot read failures. */
  readFailures: FakeReadAnswer[] = [];

  /** Called with each request before it is answered: tests turn flags off "between steps" here. */
  onRequest: FakeFulfillmentOutboundOptions['onRequest'];

  constructor(private readonly options: FakeFulfillmentOutboundOptions = {}) {
    this.onRequest = options.onRequest;
  }

  get posts(): number { return this.requests.filter((request) => request.operation === 'create').length; }
  get previews(): number { return this.requests.filter((request) => request.operation === 'preview').length; }
  get reads(): number { return this.requests.filter((request) => request.operation === 'get').length; }
  /** Every request, in order, as `operation`. */
  get operations(): string[] { return this.requests.map((request) => request.operation); }

  /** Put an order at "Amazon" directly (an order placed some other way). */
  seedOrder(order: Omit<FakeOrder, 'destination'> & { destination?: Record<string, unknown> | null }): void {
    this.orders.set(order.sellerFulfillmentOrderId, { destination: null, ...order });
  }

  /** A token provider that never calls LWA. */
  static tokens(): SpApiAccessTokenProvider {
    return { getAccessToken: async () => ['synthetic', 'access', 'value'].join('-') };
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const body = typeof init?.body === 'string' ? init.body : null;
    const operation: FakeRequest['operation'] = method === 'POST' && path === `${BASE}/preview` ? 'preview'
      : method === 'POST' && path === BASE ? 'create'
        : method === 'GET' && path.startsWith(`${BASE}/`) ? 'get'
          : method === 'PUT' && path.endsWith('/cancel') ? 'cancel' : 'other';
    const request: FakeRequest = { method, path, body, at: this.options.now?.() ?? Date.now(), operation };
    this.requests.push(request);
    await this.onRequest?.(request);
    switch (operation) {
      case 'preview': return this.preview(body);
      case 'create': return this.create(body);
      case 'get': return this.get(decodeURIComponent(path.slice(BASE.length + 1)));
      case 'cancel': return this.cancel(decodeURIComponent(path.slice(BASE.length + 1, -'/cancel'.length)));
      default: return json(404, { errors: [{ code: 'NotFound', message: 'no such operation' }] });
    }
  };

  private preview(body: string | null): Response {
    const answer = this.previewAnswers.length > 1 ? this.previewAnswers.shift()! : this.previewAnswers[0] ?? { kind: 'ok' };
    const sent = JSON.parse(body ?? '{}') as { marketplaceId: string; address: Record<string, unknown>; items: { sellerSku: string; sellerFulfillmentOrderItemId: string; quantity: number }[] };
    if (answer.kind === 'transport') throw new TypeError('fake transport failure');
    if (answer.kind === 'http') {
      return json(answer.status, { errors: (answer.codes ?? ['InvalidInput']).map((code) => ({ code, message: `Could not ship to ${echoText(sent.address)}`,
        details: echoText(sent.address) })) });
    }
    const fulfillable = answer.fulfillable ?? true;
    const item = sent.items[0]!;
    const earliest = answer.earliestArrival ?? '2026-10-02T07:00:00Z';
    const latest = answer.latestArrival ?? '2026-10-05T07:00:00Z';
    return json(200, { payload: { fulfillmentPreviews: [{
      shippingSpeedCategory: 'Standard', isFulfillable: fulfillable, isCODCapable: false, marketplaceId: sent.marketplaceId,
      // Amazon echoes the address it priced; the writer copies an allowlist and must drop it.
      address: sent.address,
      ...(fulfillable || answer.feeValue !== undefined ? { estimatedFees: [{ name: 'FBAPerUnitFulfillmentFee',
        amount: { currencyCode: answer.currency ?? 'USD', value: answer.feeValue ?? '6.20' } }] } : {}),
      fulfillmentPreviewShipments: fulfillable ? [{ earliestShipDate: '2026-09-29T07:00:00Z', latestShipDate: '2026-09-30T07:00:00Z',
        earliestArrivalDate: earliest, latestArrivalDate: latest,
        fulfillmentPreviewItems: [{ sellerSku: item.sellerSku, sellerFulfillmentOrderItemId: item.sellerFulfillmentOrderItemId, quantity: item.quantity }] }] : [],
      unfulfillablePreviewItems: fulfillable ? [] : [{ sellerSku: item.sellerSku, sellerFulfillmentOrderItemId: item.sellerFulfillmentOrderItemId,
        quantity: item.quantity, itemUnfulfillableReasons: answer.reasons ?? ['InventoryUnavailable'] }],
      orderUnfulfillableReasons: [],
    }] } });
  }

  private store(body: string | null, status: FakeOrderStatus): void {
    const sent = JSON.parse(body ?? '{}') as { sellerFulfillmentOrderId: string; destinationAddress: Record<string, unknown>; items: { sellerSku: string; quantity: number }[] };
    if (this.orders.has(sent.sellerFulfillmentOrderId)) return;
    this.orders.set(sent.sellerFulfillmentOrderId, { sellerFulfillmentOrderId: sent.sellerFulfillmentOrderId, status,
      sellerSku: sent.items[0]!.sellerSku, quantity: sent.items[0]!.quantity, destination: sent.destinationAddress });
  }

  private create(body: string | null): Response {
    const answer = this.createAnswers.shift() ?? { kind: 'ok' };
    const sent = JSON.parse(body ?? '{}') as { sellerFulfillmentOrderId: string; destinationAddress: Record<string, unknown> };
    switch (answer.kind) {
      case 'ok':
        this.store(body, answer.status ?? 'Received');
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      case 'http':
        if (answer.creates) this.store(body, answer.createdStatus ?? 'Received');
        return json(answer.status, { errors: (answer.codes ?? ['InvalidInput']).map((code) => ({ code,
          message: `Order ${sent.sellerFulfillmentOrderId} for ${echoText(sent.destinationAddress)} was not accepted`, details: echoText(sent.destinationAddress) })) });
      case 'transport':
        if (answer.creates) this.store(body, answer.createdStatus ?? 'Received');
        throw new TypeError('fake transport failure');
      case 'undecodable':
        if (answer.creates) this.store(body, 'Received');
        return new Response('<html>not json</html>', { status: 200 });
    }
  }

  private get(id: string): Response {
    const failure = this.readFailures.shift();
    if (failure?.kind === 'transport') throw new TypeError('fake transport failure');
    if (failure?.kind === 'http') return json(failure.status, { errors: [{ code: failure.status === 429 ? 'QuotaExceeded' : 'InternalFailure', message: 'synthetic' }] });
    const order = this.orders.get(id);
    if (order === undefined) return json(404, { errors: [{ code: 'NotFound', message: `No order ${id}` }] });
    return json(200, { payload: {
      fulfillmentOrder: { sellerFulfillmentOrderId: order.sellerFulfillmentOrderId, displayableOrderId: order.sellerFulfillmentOrderId,
        fulfillmentOrderStatus: order.status, receivedDate: '2026-09-28T12:00:00Z', statusUpdatedDate: '2026-09-28T12:00:00Z',
        // Amazon returns the destination; the reader must drop it.
        destinationAddress: order.destination, displayableOrderComment: 'synthetic comment' },
      fulfillmentOrderItems: [{ sellerSku: order.sellerSku, sellerFulfillmentOrderItemId: `${order.sellerFulfillmentOrderId}-1`, quantity: order.quantity,
        cancelledQuantity: 0, unfulfillableQuantity: 0 }],
      fulfillmentShipments: [],
    } });
  }

  private cancel(id: string): Response {
    const order = this.orders.get(id);
    if (order === undefined) return json(404, { errors: [{ code: 'NotFound', message: `No order ${id}` }] });
    order.status = 'Cancelled';
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
}
