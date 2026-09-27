import { describe, expect, it, vi } from 'vitest';
import { FulfillmentOutboundError, FulfillmentOutboundReader } from './fulfillment-outbound.js';

// Synthetic bodies shaped from the pinned Fulfillment Outbound 2020-07-01 model.
// Every recipient field carries a marker string, so a leak is found by searching
// the result for the markers rather than trusting the field list.
const MARKERS = ['Marker Recipient', 'Marker Street 1', 'MARKERTOWN', 'marker@invalid', '+00 0000 marker', 'Marker Signer',
  'Marker display id', 'Marker comment', 'Marker locker', 'Marker door'];
const reply = (value: unknown, status = 200) => new Response(value === null ? '' : JSON.stringify(value), { status });
function fixture() {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  return { fetch, reader: new FulfillmentOutboundReader({ endpoint: 'https://fulfillment.invalid', userAgent: 'Fixture/1',
    accessTokenProvider: { getAccessToken: async () => 'synthetic-token' }, fetch }) };
}
const address = { name: MARKERS[0], addressLine1: MARKERS[1], city: MARKERS[2], postalCode: 'EX1 1AA', countryCode: 'GB', phone: MARKERS[4] };
function order(id = 'CCS-0123456789abcdef0123456789abcdef') {
  return { payload: {
    fulfillmentOrder: { sellerFulfillmentOrderId: id, marketplaceId: 'market-fixture', displayableOrderId: MARKERS[6],
      displayableOrderDate: '2026-09-09T06:34:00Z', displayableOrderComment: MARKERS[7], shippingSpeedCategory: 'Standard',
      destinationAddress: address, notificationEmails: [MARKERS[3]], fulfillmentOrderStatus: 'Processing',
      receivedDate: '2026-09-09T06:34:41Z', statusUpdatedDate: '2026-09-09T07:02:18Z' },
    fulfillmentOrderItems: [{ sellerSku: 'SYN-SKU-1', sellerFulfillmentOrderItemId: 'item-1', quantity: 1, cancelledQuantity: 0,
      unfulfillableQuantity: 0 }],
    fulfillmentShipments: [
      { amazonShipmentId: 'shipment-cancelled', fulfillmentCenterId: 'FC-1', fulfillmentShipmentStatus: 'CANCELLED_BY_FULFILLER',
        shippingNotes: [MARKERS[7]], fulfillmentShipmentPackage: [{ packageNumber: 11, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-OLD' }] },
      { amazonShipmentId: 'shipment-live', fulfillmentCenterId: 'FC-2', fulfillmentShipmentStatus: 'PENDING', estimatedArrivalDate: '2026-09-12T18:00:00Z',
        fulfillmentShipmentPackage: [{ packageNumber: 12, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-NEW',
          estimatedArrivalDate: '2026-09-12T18:00:00Z', lockerDetails: { lockerNumber: MARKERS[8] },
          deliveryInformation: { deliveryDocumentList: [], dropOffLocation: { type: 'FRONT_DOOR', attributes: { doorCode: MARKERS[9] } } } }] },
    ],
    returnItems: [], returnAuthorizations: [{ returnToAddress: address }],
    paymentInformation: [{ paymentTransactionId: 'pay-1' }],
  } };
}
const leaks = (value: unknown) => MARKERS.filter((marker) => JSON.stringify(value).includes(marker));

describe('Fulfillment Outbound read-only observation', () => {
  it('reads an order by id, keeps the whole shipments array, and drops every recipient field', async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(reply(order()));
    const lookup = await f.reader.getOrder('CCS-0123456789abcdef0123456789abcdef');
    expect(lookup.outcome).toBe('found');
    if (lookup.outcome !== 'found') throw new Error('unreachable');
    expect(lookup.order.status).toBe('Processing');
    expect(lookup.order.items).toEqual([{ sellerSku: 'SYN-SKU-1', quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }]);
    expect(lookup.order.shipments.map((item) => [item.amazonShipmentId, item.status, item.packages.length]))
      .toEqual([['shipment-cancelled', 'CANCELLED_BY_FULFILLER', 1], ['shipment-live', 'PENDING', 1]]);
    expect(lookup.order.shipments[1]!.packages[0]).toEqual({ packageNumber: 12, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-NEW',
      estimatedArrivalAt: '2026-09-12T18:00:00.000Z' });
    expect(leaks(lookup)).toEqual([]);
    expect(Object.keys(lookup.order).sort()).toEqual(['items', 'receivedAt', 'sellerFulfillmentOrderId', 'shipments', 'status', 'statusUpdatedAt']);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe('https://fulfillment.invalid/fba/outbound/2020-07-01/fulfillmentOrders/CCS-0123456789abcdef0123456789abcdef');
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
  });

  it('settles not found only on HTTP 404; a transport or server failure is never a not-found', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({ errors: [{ code: 'NotFound', message: MARKERS[0] }] }, 404))
      .mockResolvedValueOnce(reply({ errors: [] }, 503))
      .mockRejectedValueOnce(new Error('socket closed'));
    expect(await f.reader.getOrder('CCS-missing')).toEqual({ outcome: 'not_found', sellerFulfillmentOrderId: 'CCS-missing' });
    await expect(f.reader.getOrder('CCS-missing')).rejects.toThrow('Fulfillment Outbound http (503)');
    await expect(f.reader.getOrder('CCS-missing')).rejects.toThrow('Fulfillment Outbound transport');
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it('refuses an order that answers for another id, an unknown status and an id longer than Amazon accepts', async () => {
    const f = fixture();
    const unknown = order();
    unknown.payload.fulfillmentOrder.fulfillmentOrderStatus = 'Teleported';
    f.fetch.mockResolvedValueOnce(reply(order('CCS-other'))).mockResolvedValueOnce(reply(unknown));
    await expect(f.reader.getOrder('CCS-0123456789abcdef0123456789abcdef')).rejects.toThrow('identity_conflict');
    await expect(f.reader.getOrder('CCS-0123456789abcdef0123456789abcdef')).rejects.toThrow('invalid_response');
    await expect(f.reader.getOrder('x'.repeat(41))).rejects.toThrow('invalid_request');
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it('lists orders over a bounded window, stops at the page bound, and says it did', async () => {
    const f = fixture();
    const page = (ids: string[], nextToken?: string) => reply({ payload: { ...(nextToken ? { nextToken } : {}),
      fulfillmentOrders: ids.map((id) => ({ sellerFulfillmentOrderId: id, displayableOrderId: MARKERS[6], destinationAddress: address,
        notificationEmails: [MARKERS[3]], fulfillmentOrderStatus: 'Complete', receivedDate: '2026-09-08T00:00:00Z', statusUpdatedDate: '2026-09-09T00:00:00Z' })) } });
    f.fetch.mockResolvedValueOnce(page(['a-1', 'a-2'], 'token-2')).mockResolvedValueOnce(page(['a-3'], 'token-3'));
    const listed = await f.reader.listOrders('2026-09-08T00:00:00Z', 2);
    expect(listed).toMatchObject({ queryStartDate: '2026-09-08T00:00:00.000Z', pages: 2, complete: false });
    expect(listed.orders.map((item) => item.sellerFulfillmentOrderId)).toEqual(['a-1', 'a-2', 'a-3']);
    expect(leaks(listed)).toEqual([]);
    expect(f.fetch.mock.calls.map(([url]) => new URL(url).searchParams.get('nextToken'))).toEqual([null, 'token-2']);
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET' && init.body === undefined)).toBe(true);
    await expect(f.reader.listOrders('not a date')).rejects.toThrow('invalid_request');
  });

  it('reads package tracking without the signer, ship-to address, carrier phone or event locations', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({ payload: { packageNumber: 12, trackingNumber: 'SYN-TRACK-NEW', carrierCode: 'Synthetic carrier',
      carrierPhoneNumber: MARKERS[4], carrierURL: 'https://carrier.invalid', customerTrackingLink: 'https://track.invalid', shipDate: '2026-09-09T08:00:00Z',
      estimatedArrivalDate: '2026-09-12T18:00:00Z', shipToAddress: { city: MARKERS[2], state: 'XX', country: 'GB' }, currentStatus: 'IN_TRANSIT',
      currentStatusDescription: MARKERS[9], signedForBy: MARKERS[5], additionalLocationInfo: 'FRONT_DOOR',
      trackingEvents: [{ eventDate: '2026-09-09T09:00:00Z', eventAddress: { city: MARKERS[2], country: 'GB' }, eventCode: 'EVENT_101', eventDescription: MARKERS[1] }] } }))
      .mockResolvedValueOnce(reply({ errors: [] }, 404))
      .mockResolvedValueOnce(reply({ payload: { packageNumber: 12, currentStatus: 'LOST_IN_SPACE' } }))
      .mockResolvedValueOnce(reply({ payload: { packageNumber: 99, currentStatus: 'DELIVERED' } }));
    const tracked = await f.reader.trackPackage(12);
    expect(tracked).toEqual({ packageNumber: 12, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-NEW',
      estimatedArrivalAt: '2026-09-12T18:00:00.000Z', currentStatus: 'IN_TRANSIT' });
    expect(leaks(tracked)).toEqual([]);
    expect(await f.reader.trackPackage(12)).toBeNull();
    await expect(f.reader.trackPackage(12)).rejects.toThrow('invalid_response');
    await expect(f.reader.trackPackage(12)).rejects.toThrow('identity_conflict');
    expect(new URL(f.fetch.mock.calls[0]![0]).pathname).toBe('/fba/outbound/2020-07-01/tracking');
    expect(f.fetch.mock.calls.every(([, init]) => init?.method === 'GET' && init.body === undefined)).toBe(true);
  });

  it('has no path that writes: only readers, and every request is a GET without a body', () => {
    const methods = Object.getOwnPropertyNames(FulfillmentOutboundReader.prototype).filter((name) => name !== 'constructor').sort();
    expect(methods).toEqual(['getOrder', 'listOrders', 'read', 'trackPackage']);
    expect(new FulfillmentOutboundError('http', 404).message).not.toMatch(/Recipient|Street/);
  });
});
