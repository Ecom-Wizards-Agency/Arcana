import { describe, expect, it, vi } from 'vitest';
import type { FulfillmentIntent, FulfillmentRequest } from '@wizard-ads/shared';
import { FulfillmentOutboundClient, fulfillmentIntent } from './fulfillment-outbound.js';

// Synthetic examples shaped from the pinned Amazon Fulfillment Outbound
// 2020-07-01 model. No seller report, address or credential was recorded.
const request: FulfillmentRequest = {
  scope: { orgId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222',
    connectionId: '33333333-3333-4333-8333-333333333333', marketplaceId: 'market-fixture', sellingPartnerId: 'seller-fixture', region: 'EU' },
  callerRequestId: 'caller-fixture', sellerFulfillmentOrderId: 'order-fixture', displayableOrderId: 'display-fixture',
  displayableOrderDate: '2026-09-01T00:00:00.000Z', displayableOrderComment: 'Synthetic fixture', shippingSpeedCategory: 'Standard',
  destinationAddress: { name: 'Fixture Recipient', addressLine1: '1 Example Street', city: 'Example', countryCode: 'GB', postalCode: 'EX1 1AA' },
  items: [{ sellerFulfillmentOrderItemId: 'item-a', sellerSku: 'sku-a', quantity: 2 },
    { sellerFulfillmentOrderItemId: 'item-b', sellerSku: 'sku-b', quantity: 1 }],
};
const reply = (value: unknown, status = 200) => new Response(value === null ? '' : JSON.stringify(value), { status });
function fixture() {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const access = vi.fn(async () => 'synthetic-token');
  return { fetch, access, client: new FulfillmentOutboundClient({ endpoint: 'https://fulfillment.invalid',
    userAgent: 'Fixture/1', accessTokenProvider: { getAccessToken: access }, fetch }) };
}
function lookup(items: unknown[] = request.items.map(item => ({ ...item, cancelledQuantity: 0, unfulfillableQuantity: 0 }))) {
  return { payload: { fulfillmentOrder: { ...request, marketplaceId: request.scope.marketplaceId,
    fulfillmentOrderStatus: 'Processing', receivedDate: '2026-09-01T00:00:00Z', statusUpdatedDate: '2026-09-01T00:00:00Z' },
    fulfillmentOrderItems: items, returnItems: [], returnAuthorizations: [] } };
}
function preview(items: unknown[], refused: unknown[] = []) {
  return { payload: { fulfillmentPreviews: [{ marketplaceId: request.scope.marketplaceId,
    shippingSpeedCategory: 'Standard', isCODCapable: false, isFulfillable: refused.length === 0,
    fulfillmentPreviewShipments: [{ fulfillmentPreviewItems: items }], unfulfillablePreviewItems: refused }] } };
}

describe('Fulfillment Outbound sibling transport', () => {
  it('sends the pinned preview envelope and reconciles split-shipment quantities once per item', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(reply(preview([{ ...request.items[0], quantity: 1 }, { ...request.items[0], quantity: 1 }, request.items[1]])));
    const result = await f.client.preview(request);
    expect(result).toMatchObject({ state: 'observed', requestedItems: 2, returnedItems: 2, missingItems: 0, refusedItems: 0 });
    expect(result.items.map(item => item.quantity)).toEqual([2, 1]);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toContain('/fba/outbound/2020-07-01/fulfillmentOrders/preview');
    expect(JSON.parse(String(init?.body))).toEqual({ marketplaceId: request.scope.marketplaceId,
      address: request.destinationAddress, items: request.items, shippingSpeedCategories: ['Standard'], includeCODFulfillmentPreview: false });
  });

  it('counts missing, refused and partial-quantity items without claiming completion', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply(preview([request.items[0]])))
      .mockResolvedValueOnce(reply(preview([request.items[0]], [request.items[1]])))
      .mockResolvedValueOnce(reply(preview([{ ...request.items[0], quantity: 1 }, request.items[1]])));
    expect(await f.client.preview(request)).toMatchObject({ state: 'unresolved', requestedItems: 2, returnedItems: 1, missingItems: 1, refusedItems: 0 });
    expect(await f.client.preview(request)).toMatchObject({ state: 'refused', returnedItems: 2, missingItems: 0, refusedItems: 1 });
    expect(await f.client.preview(request)).toMatchObject({ state: 'unresolved', returnedItems: 2, missingItems: 0 });
  });

  it('persists uncertainty before a single create and leaves item observation pending', async () => {
    const f = fixture();
    let persisted: FulfillmentIntent | undefined;
    f.fetch.mockImplementation(async () => { expect(persisted?.state).toBe('uncertain'); return reply(null); });
    const result = await f.client.create(request, fulfillmentIntent(request), async intent => { persisted = structuredClone(intent); });
    expect(result).toMatchObject({ state: 'accepted', requestedItems: 2, returnedItems: 0, missingItems: 2 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(f.fetch.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body['scope']).toBeUndefined();
    expect(body['callerRequestId']).toBeUndefined();
    expect(body['marketplaceId']).toBe(request.scope.marketplaceId);
  });

  it('makes zero provider calls when durable intent persistence fails', async () => {
    const f = fixture();
    await expect(f.client.create(request, fulfillmentIntent(request), async () => { throw new Error('store unavailable'); })).rejects.toThrow('store unavailable');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.access).not.toHaveBeenCalled();
  });

  it('refuses unsupported provider fields before fingerprinting or sending a create', async () => {
    const f = fixture(); const save = vi.fn(async () => undefined);
    const unsupported = [
      { ...request, fulfillmentAction: 'Hold' },
      { ...request, destinationAddress: { ...request.destinationAddress, phone: 'synthetic' } },
      { ...request, items: [{ ...request.items[0], giftMessage: 'synthetic' }, request.items[1]] },
    ];
    for (const raw of unsupported) {
      await expect(f.client.create(raw as FulfillmentRequest, fulfillmentIntent(request), save)).rejects.toThrow('invalid_request');
    }
    expect(save).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled(); expect(f.access).not.toHaveBeenCalled();
  });

  it.each(['timeout', 'server', 'decode'])('reconciles ambiguous %s create by stable order identity across restart', async kind => {
    const f = fixture();
    if (kind === 'timeout') f.fetch.mockRejectedValueOnce(new Error('private transport details'));
    else if (kind === 'server') f.fetch.mockResolvedValueOnce(reply({ errors: [{ message: 'private provider details' }] }, 503));
    else f.fetch.mockResolvedValueOnce(new Response('truncated', { status: 200 }));
    f.fetch.mockResolvedValueOnce(reply(null, 404));
    let persisted = fulfillmentIntent(request);
    expect(await f.client.create(request, persisted, async intent => { persisted = structuredClone(intent); })).toMatchObject({ state: 'unresolved' });
    const restarted = fixture();
    restarted.fetch.mockResolvedValue(reply(lookup()));
    expect(await restarted.client.create(request, persisted, async () => { throw new Error('must not reserve again'); })).toMatchObject({ state: 'observed', returnedItems: 2, missingItems: 0 });
    expect(f.fetch.mock.calls.map(call => call[1]?.method)).toEqual(['POST', 'GET']);
    expect(restarted.fetch.mock.calls.map(call => call[1]?.method)).toEqual(['GET']);
    expect(restarted.fetch.mock.calls[0]![0]).toMatch(/\/order-fixture$/);
  });

  it.each([['shippingSpeedCategory', 'Priority'], ['displayableOrderComment', 'changed'], ['callerRequestId', 'different']])('refuses changed %s before provider access', async (key, value) => {
    const f = fixture();
    await expect(f.client.create({ ...request, [key]: value }, fulfillmentIntent(request), async () => undefined)).rejects.toThrow('identity_conflict');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.access).not.toHaveBeenCalled();
  });

  it('fingerprints address, scope and per-item identity and refuses a modified persisted intent', async () => {
    const original = fulfillmentIntent(request);
    for (const changed of [{ ...request, destinationAddress: { ...request.destinationAddress, name: 'Changed' } },
      { ...request, scope: { ...request.scope, sellingPartnerId: 'different' } },
      { ...request, items: [{ ...request.items[0]!, quantity: 1 }, request.items[1]!] }]) {
      expect(fulfillmentIntent(changed).payloadFingerprint).not.toBe(original.payloadFingerprint);
    }
    const f = fixture();
    await expect(f.client.status(request, { ...original, items: [request.items[0]!] })).rejects.toThrow('identity_conflict');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it('checks returned order identity and accounts returned status item refusals', async () => {
    const f = fixture();
    const mismatched = lookup();
    mismatched.payload.fulfillmentOrder.displayableOrderComment = 'different';
    f.fetch.mockResolvedValueOnce(reply(mismatched)).mockResolvedValueOnce(reply(lookup([
      { ...request.items[0], cancelledQuantity: 0, unfulfillableQuantity: 1 },
    ])));
    await expect(f.client.status(request, fulfillmentIntent(request))).rejects.toThrow('identity_conflict');
    expect(await f.client.status(request, fulfillmentIntent(request))).toMatchObject({ state: 'unresolved', requestedItems: 2, returnedItems: 1, refusedItems: 1, missingItems: 1 });
  });

  it.each(['2026-09-01T00:00:00Z', '2026-09-01T02:00:00+02:00'])('reconciles equivalent provider timestamp %s', async timestamp => {
    const f = fixture(); const response = lookup();
    response.payload.fulfillmentOrder.displayableOrderDate = timestamp;
    f.fetch.mockResolvedValue(reply(response));
    expect(await f.client.status(request, fulfillmentIntent(request))).toMatchObject({ state: 'observed', providerOrderStatus: 'Processing' });
  });

  it.each(['Invalid', 'Unfulfillable', 'Cancelled'])('preserves provider %s status without presenting order acceptance', async status => {
    const f = fixture(); const response = lookup();
    response.payload.fulfillmentOrder.fulfillmentOrderStatus = status;
    f.fetch.mockResolvedValue(reply(response));
    expect(await f.client.status(request, fulfillmentIntent(request))).toMatchObject({ state: 'refused', providerOrderStatus: status, requestedItems: 2, returnedItems: 2, refusedItems: 2 });
  });

  it('rejects unknown statuses and impossible refused-quantity accounting', async () => {
    const f = fixture(); const response = lookup();
    response.payload.fulfillmentOrder.fulfillmentOrderStatus = 'UnknownState';
    f.fetch.mockResolvedValueOnce(reply(response)).mockResolvedValueOnce(reply(lookup([
      { ...request.items[0], cancelledQuantity: 2, unfulfillableQuantity: 1 },
    ])));
    await expect(f.client.status(request, fulfillmentIntent(request))).rejects.toThrow('invalid_response');
    await expect(f.client.status(request, fulfillmentIntent(request))).rejects.toThrow('invalid_response');
  });

  it('rejects unknown item identity, duplicate status rows and excess quantities', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply(preview([{ ...request.items[0], sellerFulfillmentOrderItemId: 'unknown' }])))
      .mockResolvedValueOnce(reply(lookup([0, 1].map(() => ({ ...request.items[0], cancelledQuantity: 0, unfulfillableQuantity: 0 })))))
      .mockResolvedValueOnce(reply(preview([{ ...request.items[0], quantity: 3 }])));
    await expect(f.client.preview(request)).rejects.toThrow('invalid_response');
    await expect(f.client.status(request, fulfillmentIntent(request))).rejects.toThrow('invalid_response');
    await expect(f.client.preview(request)).rejects.toThrow('invalid_response');
  });

  it.each([401, 429])('does not inherit Reports retries for HTTP %s and redacts provider errors', async status => {
    const f = fixture();
    f.fetch.mockResolvedValue(reply({ errors: [{ message: 'Recipient private details', code: 'Sensitive' }] }, status));
    await expect(f.client.create(request, fulfillmentIntent(request), async () => undefined)).rejects.toThrow(`Fulfillment Outbound http (${status})`);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});
