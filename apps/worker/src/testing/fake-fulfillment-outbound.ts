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
 * Echo mode (WP-338j, `echo: true`) is the privacy suite's adversary: every
 * answer that can carry text carries the last destination the fake was sent,
 * in bodies, in a response header, in 404, 429 and 5xx bodies, in the text of
 * an undecodable answer and in the message of a transport failure; the order
 * list and package tracking answer as well. A `hang` create answer waits for
 * the request's abort signal (the writer's timeout) and then fails with the
 * destination in its message. Without echo mode the fake answers as before.
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
 * Amazon afterwards (a 5xx or a lost answer may still have created it). `hang`
 * never answers: it fails when the request's signal aborts (a timeout).
 */
export type FakeCreateAnswer =
  | { kind: 'ok'; status?: FakeOrderStatus }
  | { kind: 'http'; status: number; codes?: string[]; creates?: boolean; createdStatus?: FakeOrderStatus }
  | { kind: 'transport'; creates?: boolean; createdStatus?: FakeOrderStatus }
  | { kind: 'undecodable'; creates?: boolean }
  | { kind: 'hang'; creates?: boolean; createdStatus?: FakeOrderStatus };

/**
 * cancelFulfillmentOrder answers (WP-338i). `cancels` says whether the order is
 * Cancelled at Amazon afterwards (default: true for 200, false otherwise; a 5xx
 * or a lost answer may still have cancelled it). An order that is not Received
 * or Planning is never cancelled, whatever the script says: Amazon refuses it.
 */
export type FakeCancelAnswer =
  | { kind: 'ok'; cancels?: boolean }
  | { kind: 'http'; status: number; codes?: string[]; cancels?: boolean }
  | { kind: 'transport'; cancels?: boolean }
  | { kind: 'undecodable'; cancels?: boolean };

/** One-shot getFulfillmentOrder failures, consumed before the normal answer. */
export type FakeReadAnswer = { kind: 'http'; status: number } | { kind: 'transport' };

export interface FakeRequest {
  method: string;
  path: string;
  /** The body as sent, recipient included (the positive control). */
  body: string | null;
  /** The fake's clock when the request arrived. */
  at: number;
  operation: 'preview' | 'create' | 'get' | 'cancel' | 'list' | 'track' | 'other';
}

export interface FakeFulfillmentOutboundOptions {
  /** Clock for `requests[].at` (tests pass their fake clock). */
  now?: () => number;
  /** Called with each request before it is answered: tests turn flags off "between steps" here. */
  onRequest?: (request: FakeRequest) => void | Promise<void>;
  /** Echo mode: every answer that can carry text carries the last destination sent (see the file comment). */
  echo?: boolean;
}

function echoText(destination: Record<string, unknown> | null): string {
  return destination === null ? '' : Object.values(destination).filter((value) => typeof value === 'string').join(', ');
}

export class FakeFulfillmentOutbound {
  readonly requests: FakeRequest[] = [];
  /** The last destination any request carried (echo mode repeats it everywhere). */
  private lastDestination: Record<string, unknown> | null = null;
  readonly orders = new Map<string, FakeOrder>();
  /** Queued preview answers; the last one repeats. */
  previewAnswers: FakePreviewAnswer[] = [{ kind: 'ok' }];
  /** Queued create answers; `ok` when empty. */
  createAnswers: FakeCreateAnswer[] = [];
  /** Queued one-shot read failures. */
  readFailures: FakeReadAnswer[] = [];
  /** Queued cancel answers; when empty, Amazon's own rule: 200 and Cancelled from Received or Planning, else 400. */
  cancelAnswers: FakeCancelAnswer[] = [];

  /** Called with each request before it is answered: tests turn flags off "between steps" here. */
  onRequest: FakeFulfillmentOutboundOptions['onRequest'];
  readonly echo: boolean;

  constructor(private readonly options: FakeFulfillmentOutboundOptions = {}) {
    this.onRequest = options.onRequest;
    this.echo = options.echo === true;
  }

  /** The last destination as text, in echo mode only. */
  private echoed(): string {
    return this.echo ? echoText(this.lastDestination) : '';
  }

  private json(status: number, body: unknown): Response {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.echo && this.lastDestination !== null) headers['x-synthetic-echo'] = encodeURIComponent(this.echoed());
    return new Response(JSON.stringify(body), { status, headers });
  }

  private failure(what: string): TypeError {
    return new TypeError(this.echo ? `fake ${what} failure while shipping to ${this.echoed()}` : `fake ${what} failure`);
  }

  get posts(): number { return this.requests.filter((request) => request.operation === 'create').length; }
  get previews(): number { return this.requests.filter((request) => request.operation === 'preview').length; }
  get reads(): number { return this.requests.filter((request) => request.operation === 'get').length; }
  /** cancelFulfillmentOrder requests that reached "Amazon". */
  get cancels(): number { return this.requests.filter((request) => request.operation === 'cancel').length; }
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
          : method === 'PUT' && path.endsWith('/cancel') ? 'cancel'
            : method === 'GET' && path === BASE ? 'list'
              : method === 'GET' && path === '/fba/outbound/2020-07-01/tracking' ? 'track' : 'other';
    const request: FakeRequest = { method, path, body, at: this.options.now?.() ?? Date.now(), operation };
    this.requests.push(request);
    if (body !== null && (operation === 'preview' || operation === 'create')) {
      const sent = JSON.parse(body) as { address?: Record<string, unknown>; destinationAddress?: Record<string, unknown> };
      this.lastDestination = sent.address ?? sent.destinationAddress ?? this.lastDestination;
    }
    await this.onRequest?.(request);
    switch (operation) {
      case 'preview': return this.preview(body);
      case 'create': return this.create(body, init?.signal ?? null);
      case 'get': return this.get(decodeURIComponent(path.slice(BASE.length + 1)));
      case 'cancel': return this.cancel(decodeURIComponent(path.slice(BASE.length + 1, -'/cancel'.length)));
      case 'list': return this.list();
      case 'track': return this.json(404, { errors: [{ code: 'NotFound', message: this.echo ? `no package for ${this.echoed()}` : 'no such operation' }] });
      default: return this.json(404, { errors: [{ code: 'NotFound', message: 'no such operation' }] });
    }
  };

  /** listAllFulfillmentOrders: every order held, destination included (echo mode); 404 as before otherwise. */
  private list(): Response {
    if (!this.echo) return this.json(404, { errors: [{ code: 'NotFound', message: 'no such operation' }] });
    return this.json(200, { payload: { fulfillmentOrders: [...this.orders.values()].map((order) => ({
      sellerFulfillmentOrderId: order.sellerFulfillmentOrderId, displayableOrderId: order.sellerFulfillmentOrderId,
      fulfillmentOrderStatus: order.status, receivedDate: '2026-09-28T12:00:00Z', statusUpdatedDate: '2026-09-28T12:00:00Z',
      destinationAddress: order.destination ?? this.lastDestination, displayableOrderComment: `for ${this.echoed()}` })) } });
  }

  private preview(body: string | null): Response {
    const answer = this.previewAnswers.length > 1 ? this.previewAnswers.shift()! : this.previewAnswers[0] ?? { kind: 'ok' };
    const sent = JSON.parse(body ?? '{}') as { marketplaceId: string; address: Record<string, unknown>; items: { sellerSku: string; sellerFulfillmentOrderItemId: string; quantity: number }[] };
    if (answer.kind === 'transport') throw this.failure('transport');
    if (answer.kind === 'http') {
      return this.json(answer.status, { errors: (answer.codes ?? ['InvalidInput']).map((code) => ({ code, message: `Could not ship to ${echoText(sent.address)}`,
        details: echoText(sent.address) })) });
    }
    const fulfillable = answer.fulfillable ?? true;
    const item = sent.items[0]!;
    const earliest = answer.earliestArrival ?? '2026-10-02T07:00:00Z';
    const latest = answer.latestArrival ?? '2026-10-05T07:00:00Z';
    return this.json(200, { payload: { fulfillmentPreviews: [{
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

  private async create(body: string | null, signal: AbortSignal | null): Promise<Response> {
    const answer = this.createAnswers.shift() ?? { kind: 'ok' };
    const sent = JSON.parse(body ?? '{}') as { sellerFulfillmentOrderId: string; destinationAddress: Record<string, unknown> };
    switch (answer.kind) {
      case 'ok':
        this.store(body, answer.status ?? 'Received');
        return this.json(200, this.echo ? { payload: {}, echo: this.echoed() } : {});
      case 'http':
        if (answer.creates) this.store(body, answer.createdStatus ?? 'Received');
        return this.json(answer.status, { errors: (answer.codes ?? ['InvalidInput']).map((code) => ({ code,
          message: `Order ${sent.sellerFulfillmentOrderId} for ${echoText(sent.destinationAddress)} was not accepted`, details: echoText(sent.destinationAddress) })) });
      case 'transport':
        if (answer.creates) this.store(body, answer.createdStatus ?? 'Received');
        throw this.failure('transport');
      case 'undecodable':
        if (answer.creates) this.store(body, 'Received');
        return new Response(`<html>not json${this.echo ? ` ${this.echoed()}` : ''}</html>`, { status: 200 });
      case 'hang':
        if (answer.creates) this.store(body, answer.createdStatus ?? 'Received');
        if (signal === null) throw new TypeError('a hanging answer needs a request signal');
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new DOMException(this.echo ? `request to ship to ${echoText(sent.destinationAddress)} timed out` : 'fake request timed out', 'TimeoutError');
    }
  }

  private get(id: string): Response {
    const failure = this.readFailures.shift();
    if (failure?.kind === 'transport') throw this.failure('transport');
    if (failure?.kind === 'http') {
      return this.json(failure.status, { errors: [{ code: failure.status === 429 ? 'QuotaExceeded' : 'InternalFailure',
        message: this.echo ? `synthetic failure reading the order for ${this.echoed()}` : 'synthetic' }] });
    }
    const order = this.orders.get(id);
    if (order === undefined) return this.json(404, { errors: [{ code: 'NotFound', message: `No order ${id}${this.echo ? ` for ${this.echoed()}` : ''}` }] });
    return this.json(200, { payload: {
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
    const answer = this.cancelAnswers.shift();
    const cancellable = order !== undefined && (order.status === 'Received' || order.status === 'Planning');
    const settle = (cancels: boolean | undefined, fallback: boolean) => { if (order !== undefined && cancellable && (cancels ?? fallback)) order.status = 'Cancelled'; };
    const refusal = (status: number, codes: string[]) => this.json(status, { errors: codes.map((code) => ({ code,
      message: `Order ${id} for ${echoText(order?.destination ?? null)} cannot be cancelled`, details: echoText(order?.destination ?? null) })) });
    if (answer === undefined) {
      if (order === undefined) return this.json(404, { errors: [{ code: 'NotFound', message: `No order ${id}${this.echo ? ` for ${this.echoed()}` : ''}` }] });
      if (!cancellable) return refusal(400, ['InvalidInput']);
      order.status = 'Cancelled';
      return this.json(200, this.echo ? { payload: {}, echo: this.echoed() } : {});
    }
    switch (answer.kind) {
      case 'ok':
        settle(answer.cancels, true);
        return this.json(200, this.echo ? { payload: {}, echo: this.echoed() } : {});
      case 'http':
        settle(answer.cancels, false);
        return refusal(answer.status, answer.codes ?? ['InvalidInput']);
      case 'transport':
        settle(answer.cancels, false);
        throw this.failure('transport');
      case 'undecodable':
        settle(answer.cancels, false);
        return new Response(`<html>not json${this.echo ? ` ${this.echoed()}` : ''}</html>`, { status: 200 });
    }
  }
}
