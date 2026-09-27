import { describe, expect, it, vi } from 'vitest';
import { CREATOR_MCF_PACKING_SLIP_COMMENT, CreatorMcfProviderOutcome, type CreatorMcfRecipient } from '@wizard-ads/shared';
import { FulfillmentOutboundError } from './fulfillment-outbound.js';
import {
  CREATOR_MCF_ORDER_SETTINGS, FulfillmentOutboundWriter, type CreatorMcfCreateInput, type CreatorMcfPreviewEvidence,
} from './fulfillment-outbound-writer.js';

// Synthetic only. Every recipient field carries a canary token, so a leak is
// found by searching every output for the tokens rather than trusting a field list.
const CANARIES = ['Qzkanaryname', 'Qzkanarystreet', 'Qzkanaryunit', 'Qzkanarytown', 'Qzkanarycounty', 'QZ9 7KX'];
const recipient: CreatorMcfRecipient = {
  name: `Test ${CANARIES[0]}`, addressLine1: `1 ${CANARIES[1]} Way`, addressLine2: `Flat ${CANARIES[2]}`, city: CANARIES[3]!,
  districtOrCounty: CANARIES[4], postalCode: CANARIES[5]!, countryCode: 'GB',
};
const KEY = 'CCS-0123456789abcdef0123456789abcdef';
const MARKETPLACE = 'SYNTHMKT00001';
const input: CreatorMcfCreateInput = {
  marketplaceId: MARKETPLACE, derivedOrderKey: KEY, sellerSku: 'SYN-SKU-1', recipient, displayableOrderDate: '2026-09-27T21:14:05.123Z',
};

/** Case-folded, spaces removed, and base64, base64url, hex and URL-encoded forms of each canary. */
function leaks(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const folded = text.toLowerCase().replace(/\s+/g, '');
  return CANARIES.filter((canary) => {
    const plain = canary.toLowerCase().replace(/\s+/g, '');
    const forms = [plain, Buffer.from(canary).toString('base64'), Buffer.from(canary).toString('base64url'),
      Buffer.from(canary).toString('hex'), encodeURIComponent(canary).toLowerCase()];
    return forms.some((form) => folded.includes(form.toLowerCase()) || text.includes(form));
  });
}

const reply = (value: unknown, status = 200) =>
  new Response(value === null ? null : typeof value === 'string' ? value : JSON.stringify(value), { status });

function fixture(options: { timeoutMs?: number } = {}) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const invalidate = vi.fn();
  const getAccessToken = vi.fn(async () => 'synthetic-token');
  const writer = new FulfillmentOutboundWriter({ endpoint: 'https://fulfillment.invalid/', userAgent: 'Fixture/1',
    accessTokenProvider: { getAccessToken, invalidate }, fetch, now: () => new Date('2026-09-27T21:15:00Z'), ...options });
  return { fetch, invalidate, getAccessToken, writer };
}
function sentBody(fetch: ReturnType<typeof fixture>['fetch'], call = 0): Record<string, unknown> {
  const body = fetch.mock.calls[call]![1]?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON body');
  return JSON.parse(body) as Record<string, unknown>;
}

function previewPayload(overrides: Record<string, unknown> = {}) {
  return { payload: { fulfillmentPreviews: [{
    shippingSpeedCategory: 'Standard', marketplaceId: MARKETPLACE, isFulfillable: true, isCODCapable: false,
    estimatedShippingWeight: { unit: 'KILOGRAMS', value: '0.4' },
    estimatedFees: [
      { name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'GBP', value: '3.50' } },
      { name: 'FBATransportationFee', amount: { currencyCode: 'GBP', value: '0.25' } },
    ],
    fulfillmentPreviewShipments: [
      { earliestShipDate: '2026-09-28T08:00:00Z', latestShipDate: '2026-09-28T20:00:00Z', earliestArrivalDate: '2026-09-30T08:00:00Z',
        latestArrivalDate: '2026-10-01T20:00:00Z', shippingNotes: [`Deliver to ${CANARIES[1]}`],
        fulfillmentPreviewItems: [{ sellerSku: 'SYN-SKU-1', quantity: 1, sellerFulfillmentOrderItemId: `${KEY}-1` }] },
    ],
    unfulfillablePreviewItems: [], orderUnfulfillableReasons: [], featureConstraints: [],
    destinationEcho: { ...recipient },
    ...overrides,
  }] } };
}

describe('FulfillmentOutboundWriter.create: the request', () => {
  it('POSTs exactly the model-required fields plus marketplaceId, Ship and FillOrKill, the key twice and one unit', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({}));
    expect(await f.writer.create(input)).toEqual({ outcome: 'accepted', status: 200 });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe('https://fulfillment.invalid/fba/outbound/2020-07-01/fulfillmentOrders');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = sentBody(f.fetch);
    expect(body).toEqual({
      marketplaceId: MARKETPLACE,
      sellerFulfillmentOrderId: KEY,
      displayableOrderId: KEY,
      displayableOrderDate: '2026-09-27T21:14:05.123Z',
      displayableOrderComment: CREATOR_MCF_PACKING_SLIP_COMMENT,
      shippingSpeedCategory: 'Standard',
      destinationAddress: { ...recipient },
      fulfillmentAction: 'Ship',
      fulfillmentPolicy: 'FillOrKill',
      items: [{ sellerSku: 'SYN-SKU-1', sellerFulfillmentOrderItemId: `${KEY}-1`, quantity: 1 }],
    });
    // Every field the v2020 CreateFulfillmentOrderRequest model marks required.
    const required = ['destinationAddress', 'displayableOrderComment', 'displayableOrderDate', 'displayableOrderId', 'items',
      'sellerFulfillmentOrderId', 'shippingSpeedCategory'];
    expect(required.filter((field) => body[field] === undefined)).toEqual([]);
    expect(Object.keys(body).sort()).toEqual([...required, 'fulfillmentAction', 'fulfillmentPolicy', 'marketplaceId'].sort());
    expect([body['sellerFulfillmentOrderId'], body['displayableOrderId']].filter((id) => id === KEY)).toHaveLength(2);
    expect((body['items'] as { quantity: number }[]).map((item) => item.quantity)).toEqual([1]);
    expect(String(body['displayableOrderComment']).length).toBeLessThanOrEqual(750);
    const text = JSON.stringify(body);
    for (const absent of ['notificationEmails', 'phone', 'featureConstraints', 'codSettings', 'shipFromAddress', 'deliveryWindow']) {
      expect(text.includes(`"${absent}"`)).toBe(false);
    }
    // The positive control: the canaries are in the request to Amazon, and only there.
    expect(leaks(body)).toEqual(CANARIES);
    const headers = new Headers(init?.headers);
    expect(headers.get('x-amz-access-token')).toBe('synthetic-token');
    expect(headers.get('x-amz-date')).toBe('20260927T211500Z');
  });

  it('refuses input that does not parse before any request leaves, with a message that names no value', async () => {
    const f = fixture();
    const bad: unknown[] = [
      { ...input, recipient: { ...recipient, phone: '+00 0000 0000' } },
      { ...input, recipient: { ...recipient, countryCode: 'US' } },
      { ...input, recipient: { ...recipient, name: `${CANARIES[0]}‮` } },
      { ...input, derivedOrderKey: 'CCS-0123' },
      { ...input, derivedOrderKey: 'ORDER-1' },
      { ...input, marketplaceId: 'market fixture' },
      { ...input, sellerSku: ' padded' },
      { ...input, displayableOrderDate: '27/09/2026' },
      { ...input, displayableOrderDate: '2026-09-27' },
    ];
    for (const candidate of bad) {
      const error = await f.writer.create(candidate as CreatorMcfCreateInput).then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(FulfillmentOutboundError);
      expect((error as Error).message).toBe('Fulfillment Outbound invalid_request');
      expect(leaks([(error as Error).message, String(error), (error as Error).stack, { ...(error as object) }])).toEqual([]);
    }
    expect(f.fetch).toHaveBeenCalledTimes(0);
  });

  it('throws authentication, and sends nothing, when no access token can be obtained', async () => {
    const f = fixture();
    f.getAccessToken.mockRejectedValueOnce(new Error(`token store said ${CANARIES[1]}`));
    const error = await f.writer.create(input).then(() => null, (thrown: unknown) => thrown);
    expect((error as Error).message).toBe('Fulfillment Outbound authentication');
    expect(leaks(String(error))).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(0);
  });
});

describe('FulfillmentOutboundWriter.create: outcome classification', () => {
  type Case = [label: string, answer: () => Promise<Response>, expected: CreatorMcfProviderOutcome];
  const errors = (...codes: string[]) => ({ errors: codes.map((code) => ({ code, message: `synthetic ${code}` })) });
  const cases: Case[] = [
    ['200 with an empty body', async () => reply(null), { outcome: 'accepted', status: 200 }],
    ['200 with an empty object', async () => reply({}), { outcome: 'accepted', status: 200 }],
    ['200 with an empty errors list', async () => reply({ errors: [] }), { outcome: 'accepted', status: 200 }],
    ['200 that is not JSON', async () => reply('<html>ok</html>'), { outcome: 'uncertain', cause: 'decode', status: 200 }],
    ['200 that carries errors', async () => reply(errors('InternalFailure')), { outcome: 'uncertain', cause: 'decode', status: 200 }],
    ['200 that is a JSON array', async () => reply([]), { outcome: 'uncertain', cause: 'decode', status: 200 }],
    ['200 whose body cannot be read', async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('reset')); } }), { status: 200 }),
      { outcome: 'uncertain', cause: 'decode', status: 200 }],
    ['201', async () => reply({}, 201), { outcome: 'uncertain', cause: 'decode', status: 201 }],
    ['202', async () => reply({}, 202), { outcome: 'uncertain', cause: 'decode', status: 202 }],
    ['307 (never followed)', async () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.invalid/' } }),
      { outcome: 'uncertain', cause: 'decode', status: 307 }],
    ['400', async () => reply(errors('InvalidInput'), 400), { outcome: 'rejected', status: 400, reason: 'validation', codes: ['InvalidInput'] }],
    ['404', async () => reply(errors('NotFound'), 404), { outcome: 'rejected', status: 404, reason: 'validation', codes: ['NotFound'] }],
    ['409 (unlisted)', async () => reply(errors('Conflict'), 409), { outcome: 'rejected', status: 409, reason: 'validation', codes: ['Conflict'] }],
    ['413 (unlisted)', async () => reply(null, 413), { outcome: 'rejected', status: 413, reason: 'validation', codes: [] }],
    ['415 (unlisted)', async () => reply(errors('UnsupportedMediaType'), 415),
      { outcome: 'rejected', status: 415, reason: 'validation', codes: ['UnsupportedMediaType'] }],
    ['401', async () => reply(errors('Unauthorized'), 401), { outcome: 'rejected', status: 401, reason: 'authorization', codes: ['Unauthorized'] }],
    ['403', async () => reply(errors('Unauthorized'), 403), { outcome: 'rejected', status: 403, reason: 'authorization', codes: ['Unauthorized'] }],
    ['429', async () => reply(errors('QuotaExceeded'), 429), { outcome: 'rejected', status: 429, reason: 'throttled', codes: ['QuotaExceeded'] }],
    ['408', async () => reply(null, 408), { outcome: 'uncertain', cause: 'http_408', status: 408 }],
    ['500', async () => reply(errors('InternalFailure'), 500), { outcome: 'uncertain', cause: 'http_5xx', status: 500 }],
    ['502 with a non-JSON body', async () => reply('Bad gateway', 502), { outcome: 'uncertain', cause: 'http_5xx', status: 502 }],
    ['503', async () => reply(errors('ServiceUnavailable'), 503), { outcome: 'uncertain', cause: 'http_5xx', status: 503 }],
    ['504', async () => reply(null, 504), { outcome: 'uncertain', cause: 'http_5xx', status: 504 }],
    ['a network failure', async () => { throw new TypeError('fetch failed'); }, { outcome: 'uncertain', cause: 'transport', status: null }],
    ['an abort (timeout)', async () => { throw new DOMException('The operation was aborted.', 'TimeoutError'); },
      { outcome: 'uncertain', cause: 'transport', status: null }],
  ];

  it.each(cases)('%s', async (_label, answer, expected) => {
    const f = fixture();
    f.fetch.mockImplementationOnce(answer);
    const outcome = await f.writer.create(input);
    expect(outcome).toEqual(expected);
    expect(CreatorMcfProviderOutcome.safeParse(outcome).success).toBe(true);
    // No retry, no re-authentication, no second POST, whatever the answer.
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.getAccessToken).toHaveBeenCalledTimes(1);
    expect(f.invalidate).toHaveBeenCalledTimes(0);
  });

  it('covers every status from 400 to 599 with exactly one request each', async () => {
    const tally = { validation: 0, authorization: 0, throttled: 0, http_408: 0, http_5xx: 0 };
    for (let status = 400; status <= 599; status += 1) {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(reply(null, status));
      const outcome = await f.writer.create(input);
      if (outcome.outcome === 'rejected') tally[outcome.reason as 'validation' | 'authorization' | 'throttled'] += 1;
      else if (outcome.outcome === 'uncertain') tally[outcome.cause as 'http_408' | 'http_5xx'] += 1;
      else throw new Error(`unexpected accepted for ${status}`);
      expect(f.fetch).toHaveBeenCalledTimes(1);
    }
    expect(tally).toEqual({ validation: 96, authorization: 2, throttled: 1, http_408: 1, http_5xx: 100 });
  });

  it('keeps errors[].code only: no message or details, bad codes dropped, repeats removed, at most 20', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({ errors: [
      { code: 'InvalidInput', message: `Address ${CANARIES[1]} is not valid`, details: CANARIES.join(', ') },
      { code: 'InvalidInput', message: 'repeat' },
      { code: 'Has space', message: 'free text' },
      { code: 'x'.repeat(65) },
      { code: 42 },
      { message: 'no code' },
      'not an object',
      { code: 'Invalid.Destination_Address' },
      ...Array.from({ length: 30 }, (_, index) => ({ code: `Code${index}` })),
    ] }, 400));
    const outcome = await f.writer.create(input);
    if (outcome.outcome !== 'rejected') throw new Error('expected rejected');
    expect(outcome.codes).toEqual(['InvalidInput', 'Invalid.Destination_Address', ...Array.from({ length: 18 }, (_, index) => `Code${index}`)]);
    expect(Object.keys(outcome).sort()).toEqual(['codes', 'outcome', 'reason', 'status']);
    expect(leaks(outcome)).toEqual([]);
  });

  it('returns no codes for a 4xx body that is not JSON, not an errors list, or larger than 64 KiB', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply(`<html>${CANARIES[1]}</html>`, 400))
      .mockResolvedValueOnce(reply({ message: CANARIES[1] }, 400))
      .mockResolvedValueOnce(reply({ errors: [{ code: 'Big', message: 'x'.repeat(70_000) }] }, 400));
    for (let call = 0; call < 3; call += 1) {
      expect(await f.writer.create(input)).toEqual({ outcome: 'rejected', status: 400, reason: 'validation', codes: [] });
    }
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it('withholds a code that repeats recipient text, even when it matches the code pattern', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({ errors: [
      { code: CANARIES[1] }, { code: `Unknown${CANARIES[3]}` }, { code: CANARIES[5]!.replace(' ', '') }, { code: 'GB' },
      { code: 'InvalidDestinationAddress' },
    ] }, 400));
    expect(await f.writer.create(input)).toEqual({ outcome: 'rejected', status: 400, reason: 'validation', codes: ['InvalidDestinationAddress'] });
  });

  it('never withholds a known Amazon code because it contains a recipient word', async () => {
    const f = fixture();
    const tina: CreatorMcfCreateInput = { ...input, recipient: { ...recipient, city: 'Tina', name: 'Val Dress', addressLine1: '1 Nation Vent' } };
    f.fetch.mockResolvedValueOnce(reply({ errors: [{ code: 'InvalidDestinationAddress' }, { code: 'InvalidSKU' }, { code: 'NoInventory' },
      { code: 'TinaUnknown' }] }, 400))
      .mockResolvedValueOnce(reply(previewPayload({ isFulfillable: false, estimatedFees: undefined, fulfillmentPreviewShipments: [],
        orderUnfulfillableReasons: ['InvalidDestinationAddress', 'TinaUnknown'] })));
    expect(await f.writer.create(tina)).toEqual({ outcome: 'rejected', status: 400, reason: 'validation',
      codes: ['InvalidDestinationAddress', 'InvalidSKU', 'NoInventory'] });
    expect(await f.writer.preview(tina)).toMatchObject({ outcome: 'previewed', orderUnfulfillableReasons: ['InvalidDestinationAddress'],
      withheldReasons: 1 });
  });

  it('reports a local failure before sending as invalid_request, never as transport', async () => {
    const f = fixture();
    const broken = new FulfillmentOutboundWriter({ endpoint: 'https://fulfillment.invalid', userAgent: 'Fixture/1',
      accessTokenProvider: { getAccessToken: async () => 'synthetic-token' }, fetch: f.fetch,
      now: () => { throw new Error(`clock near ${CANARIES[1]}`); } });
    const error = await broken.create(input).then(() => null, (thrown: unknown) => thrown);
    expect((error as Error).message).toBe('Fulfillment Outbound invalid_request');
    expect(leaks(String(error))).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(0);
  });

  it('passes the per-request timeout to the transport', async () => {
    const f = fixture({ timeoutMs: 5 });
    f.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(init.signal?.reason); });
    }));
    expect(await f.writer.create(input)).toEqual({ outcome: 'uncertain', cause: 'transport', status: null });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    for (const timeoutMs of [0, 60_001, 120_000]) {
      const bad = fixture({ timeoutMs });
      await expect(bad.writer.create(input)).rejects.toThrow('Fulfillment Outbound invalid_request');
      expect(bad.fetch).toHaveBeenCalledTimes(0);
    }
  });
});

describe('FulfillmentOutboundWriter.preview', () => {
  it('asks about exactly the item, address, marketplace and speed the create sends, with no feature constraints', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply(previewPayload())).mockResolvedValueOnce(reply({}));
    await f.writer.preview(input);
    await f.writer.create(input);
    const [url, init] = f.fetch.mock.calls[0]!;
    expect(url).toBe('https://fulfillment.invalid/fba/outbound/2020-07-01/fulfillmentOrders/preview');
    expect(init?.method).toBe('POST');
    const preview = sentBody(f.fetch, 0);
    const create = sentBody(f.fetch, 1);
    expect(preview).toEqual({ marketplaceId: MARKETPLACE, address: { ...recipient },
      items: [{ sellerSku: 'SYN-SKU-1', sellerFulfillmentOrderItemId: `${KEY}-1`, quantity: 1 }],
      shippingSpeedCategories: ['Standard'], includeCODFulfillmentPreview: false, includeDeliveryWindows: false });
    expect(preview['items']).toEqual(create['items']);
    expect(preview['address']).toEqual(create['destinationAddress']);
    expect(preview['marketplaceId']).toBe(create['marketplaceId']);
    expect(preview['shippingSpeedCategories']).toEqual([create['shippingSpeedCategory']]);
    expect('featureConstraints' in preview).toBe(false);
  });

  it('keeps fulfillability, fees in minor units with currency, reasons and the ship and arrival windows, and nothing else', async () => {
    const f = fixture();
    const second = { earliestShipDate: '2026-09-28T06:00:00Z', latestShipDate: '2026-09-29T10:00:00+02:00',
      earliestArrivalDate: '2026-09-30T09:00:00Z', latestArrivalDate: '2026-10-02T09:00:00Z', fulfillmentPreviewItems: [] };
    f.fetch.mockResolvedValueOnce(reply(previewPayload({
      fulfillmentPreviewShipments: [...previewPayload().payload.fulfillmentPreviews[0]!.fulfillmentPreviewShipments, second],
    })));
    const result = await f.writer.preview(input);
    expect(result).toEqual({
      outcome: 'previewed', marketplaceId: MARKETPLACE, derivedOrderKey: KEY,
      items: [{ sellerSku: 'SYN-SKU-1', sellerFulfillmentOrderItemId: `${KEY}-1`, quantity: 1 }],
      shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', featureConstraints: [],
      isFulfillable: true,
      fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 350 }, { feeName: 'FBATransportationFee', amountMinor: 25 }],
        totalMinor: 375, currency: 'GBP' },
      fulfillableUnits: 1, unfulfillableUnits: 0,
      orderUnfulfillableReasons: [], itemUnfulfillableReasons: [], unfulfillableReasons: [], withheldReasons: 0,
      earliestShipAt: '2026-09-28T06:00:00.000Z', latestShipAt: '2026-09-29T08:00:00.000Z',
      earliestArrivalAt: '2026-09-30T08:00:00.000Z', latestArrivalAt: '2026-10-02T09:00:00.000Z',
    } satisfies CreatorMcfPreviewEvidence);
    expect(leaks(result)).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('converts fees exactly: zero-decimal currencies, numeric values and trailing zeros, never rounding', async () => {
    const cases: [unknown[], { totalMinor: number; currency: string } | 'invalid_response'][] = [
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'JPY', value: '420' } }], { totalMinor: 420, currency: 'JPY' }],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'USD', value: 4.1 } }], { totalMinor: 410, currency: 'USD' }],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'EUR', value: '2.5000' } }], { totalMinor: 250, currency: 'EUR' }],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'USD', value: '4.105' } }], 'invalid_response'],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'JPY', value: '420.5' } }], 'invalid_response'],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'USD', value: '-1.00' } }], 'invalid_response'],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'XTS', value: '1.00' } }], 'invalid_response'],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'USD', value: '1.00' } },
        { name: 'FBATransportationFee', amount: { currencyCode: 'EUR', value: '1.00' } }], 'invalid_response'],
      [[{ name: 'Fee with spaces', amount: { currencyCode: 'USD', value: '1.00' } }], 'invalid_response'],
      // A fee name is kept only from the model's FeeName enum: a recipient canary or an unknown name refuses the preview.
      [[{ name: CANARIES[1], amount: { currencyCode: 'GBP', value: '1.00' } }], 'invalid_response'],
      [[{ name: 'FBAMysteryFee', amount: { currencyCode: 'GBP', value: '1.00' } }], 'invalid_response'],
      [[{ name: 'FBAPerOrderFulfillmentFee', amount: { currencyCode: 'GBP', value: '1.00' } },
        { name: 'FBAFulfillmentCODFee', amount: { currencyCode: 'GBP', value: '0.10' } }], { totalMinor: 110, currency: 'GBP' }],
      [[{ name: 'FBAPerUnitFulfillmentFee', amount: { currencyCode: 'USD', value: '1e2' } }], 'invalid_response'],
    ];
    for (const [estimatedFees, expected] of cases) {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(reply(previewPayload({ estimatedFees })));
      if (expected === 'invalid_response') {
        await expect(f.writer.preview(input)).rejects.toThrow('Fulfillment Outbound invalid_response');
      } else {
        const result = await f.writer.preview(input);
        if (result.outcome !== 'previewed') throw new Error('expected previewed');
        expect({ totalMinor: result.fees?.totalMinor, currency: result.fees?.currency }).toEqual(expected);
      }
    }
    const none = fixture();
    none.fetch.mockResolvedValueOnce(reply(previewPayload({ estimatedFees: [] })));
    expect((await none.writer.preview(input) as CreatorMcfPreviewEvidence).fees).toBeNull();
  });

  it('keeps an unfulfillable preview with its order and item reasons as codes, withholding free text and recipient text', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply(previewPayload({
      isFulfillable: false, estimatedFees: undefined, fulfillmentPreviewShipments: [],
      orderUnfulfillableReasons: ['InvalidDestinationAddress', `Cannot deliver to ${CANARIES[1]}`, CANARIES[3], 'InvalidDestinationAddress'],
      unfulfillablePreviewItems: [{ sellerSku: 'SYN-SKU-1', quantity: 1, sellerFulfillmentOrderItemId: `${KEY}-1`,
        itemUnfulfillableReasons: ['InventoryUnavailable', 7] }],
    })));
    const result = await f.writer.preview(input);
    expect(result).toMatchObject({ outcome: 'previewed', isFulfillable: false, fees: null, fulfillableUnits: 0, unfulfillableUnits: 1,
      orderUnfulfillableReasons: ['InvalidDestinationAddress'], itemUnfulfillableReasons: ['InventoryUnavailable'],
      unfulfillableReasons: ['InvalidDestinationAddress', 'InventoryUnavailable'], withheldReasons: 3,
      earliestShipAt: null, latestShipAt: null, earliestArrivalAt: null, latestArrivalAt: null });
    expect(leaks(result)).toEqual([]);
  });

  it('refuses a 200 that is not one well-formed Standard preview for this item', async () => {
    const base = previewPayload().payload.fulfillmentPreviews[0]!;
    const bodies: unknown[] = [
      'not json',
      { payload: { fulfillmentPreviews: [] } },
      { payload: { fulfillmentPreviews: [base, { ...base }] } },
      { payload: { fulfillmentPreviews: [{ ...base, marketplaceId: 'OTHERMKT0001' }] } },
      { payload: { fulfillmentPreviews: [{ ...base, isFulfillable: 'yes' }] } },
      { payload: { fulfillmentPreviews: [{ ...base, fulfillmentPreviewShipments: [{ ...base.fulfillmentPreviewShipments[0],
        fulfillmentPreviewItems: [{ sellerSku: 'OTHER-SKU', quantity: 1, sellerFulfillmentOrderItemId: `${KEY}-1` }] }] }] } },
      { payload: { fulfillmentPreviews: [{ ...base, fulfillmentPreviewShipments: [{ ...base.fulfillmentPreviewShipments[0],
        fulfillmentPreviewItems: [{ sellerSku: 'SYN-SKU-1', quantity: 2, sellerFulfillmentOrderItemId: `${KEY}-1` }] }] }] } },
      { payload: { fulfillmentPreviews: [{ ...base, fulfillmentPreviewShipments: [] }] } },
      { payload: { fulfillmentPreviews: [{ ...base, fulfillmentPreviewShipments: [{ ...base.fulfillmentPreviewShipments[0],
        earliestArrivalDate: 'next week' }] }] } },
      { errors: [{ code: 'InternalFailure', message: CANARIES[1] }], payload: { fulfillmentPreviews: [base] } },
    ];
    for (const body of bodies) {
      const f = fixture();
      f.fetch.mockResolvedValueOnce(reply(body));
      const error = await f.writer.preview(input).then(() => null, (thrown: unknown) => thrown);
      expect((error as Error).message).toBe('Fulfillment Outbound invalid_response');
      expect(leaks([String(error), { ...(error as object) }])).toEqual([]);
    }
  });

  it('keeps the Standard preview and ignores other speeds and a COD preview', async () => {
    const base = previewPayload().payload.fulfillmentPreviews[0]!;
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({ payload: { fulfillmentPreviews: [
      { ...base, shippingSpeedCategory: 'Expedited', isFulfillable: false }, { ...base, isCODCapable: true, isFulfillable: false }, base,
    ] } }));
    expect(await f.writer.preview(input)).toMatchObject({ outcome: 'previewed', isFulfillable: true, fees: { totalMinor: 375 } });
  });

  it('returns a 4xx as a refusal with codes only, and throws for transport, 408 and 5xx without a second request', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({ errors: [{ code: 'InvalidInput', message: `${CANARIES[1]} is not an address` }, { code: CANARIES[0] }] }, 400))
      .mockResolvedValueOnce(reply({ errors: [{ code: 'QuotaExceeded' }] }, 429))
      .mockResolvedValueOnce(reply(null, 403))
      .mockRejectedValueOnce(new TypeError(`connect failed near ${CANARIES[3]}`))
      .mockResolvedValueOnce(reply(null, 408))
      .mockResolvedValueOnce(reply({ errors: [{ code: 'InternalFailure', message: CANARIES[1] }] }, 503));
    const refused = await f.writer.preview(input);
    expect(refused).toEqual({ outcome: 'refused', status: 400, reason: 'validation', codes: ['InvalidInput'] });
    expect(await f.writer.preview(input)).toEqual({ outcome: 'refused', status: 429, reason: 'throttled', codes: ['QuotaExceeded'] });
    expect(await f.writer.preview(input)).toEqual({ outcome: 'refused', status: 403, reason: 'authorization', codes: [] });
    const thrown: unknown[] = [];
    for (let call = 0; call < 3; call += 1) thrown.push(await f.writer.preview(input).then(() => null, (error: unknown) => error));
    expect(thrown.map((error) => (error as Error).message)).toEqual(['Fulfillment Outbound transport', 'Fulfillment Outbound http (408)',
      'Fulfillment Outbound http (503)']);
    expect(leaks([refused, ...thrown.map(String)])).toEqual([]);
    expect(f.fetch).toHaveBeenCalledTimes(6);
    expect(f.invalidate).toHaveBeenCalledTimes(0);
  });
});

describe('FulfillmentOutboundWriter.cancel', () => {
  it('sends a PUT with no body to the key cancel path and classifies the answer like create', async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ errors: [{ code: 'InvalidInput', message: 'free text' }] }, 400))
      .mockResolvedValueOnce(reply(null, 500)).mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await f.writer.cancel(KEY)).toEqual({ outcome: 'accepted', status: 200 });
    expect(await f.writer.cancel(KEY)).toEqual({ outcome: 'rejected', status: 400, reason: 'validation', codes: ['InvalidInput'] });
    expect(await f.writer.cancel(KEY)).toEqual({ outcome: 'uncertain', cause: 'http_5xx', status: 500 });
    expect(await f.writer.cancel(KEY)).toEqual({ outcome: 'uncertain', cause: 'transport', status: null });
    expect(f.fetch).toHaveBeenCalledTimes(4);
    for (const [url, init] of f.fetch.mock.calls) {
      expect(url).toBe(`https://fulfillment.invalid/fba/outbound/2020-07-01/fulfillmentOrders/${KEY}/cancel`);
      expect(init?.method).toBe('PUT');
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has('content-type')).toBe(false);
      expect(init?.redirect).toBe('manual');
    }
  });

  it('cancels only a CCS key, refusing anything else before a request leaves', async () => {
    const f = fixture();
    for (const id of ['CCS-0123', 'SELLER-ORDER-1', `${KEY}/../other`, '']) {
      await expect(f.writer.cancel(id)).rejects.toThrow('Fulfillment Outbound invalid_request');
    }
    expect(f.fetch).toHaveBeenCalledTimes(0);
  });
});

describe('FulfillmentOutboundWriter surface', () => {
  it('has exactly preview, create and cancel, and fixed order settings', () => {
    expect(Object.getOwnPropertyNames(FulfillmentOutboundWriter.prototype).filter((name) => name !== 'constructor').sort())
      .toEqual(['cancel', 'create', 'preview']);
    expect(CREATOR_MCF_ORDER_SETTINGS).toEqual({ shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill',
      featureConstraints: [] });
    expect(Object.isFrozen(CREATOR_MCF_ORDER_SETTINGS)).toBe(true);
  });
});
