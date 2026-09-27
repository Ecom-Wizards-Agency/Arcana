/**
 * `mcf.observe` through the real read-only Fulfillment Outbound reader over a
 * fake transport: an order found with a package the carrier has not scanned,
 * an ambiguous submit settled as not found, a list that contradicts the lookup,
 * a retried job, and the flag. Synthetic values only; no Amazon call is made.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CreatorMcfObservationWrite, CreatorMcfSettlementState, McfObserveJob } from '@wizard-ads/shared';
import { FulfillmentOutboundReader } from '@wizard-ads/sp-api';
import type { CreatorObservableLane } from '@wizard-ads/db/worker';
import { IngestionRegistry } from './ingestion-registry.js';
import {
  MCF_OBSERVE_ENABLED_ENV, McfObservePass, createMcfObservePass, mcfObserveEnabled, mcfObserveIntervalMs, observeCreatorMcfLanes,
  registerMcfObserve, type McfObserveStore,
} from './mcf-observe.js';

const ORG = '33400000-0000-4000-8000-00000000000a';
const JOB: McfObserveJob = { type: 'mcf.observe', orgId: ORG, profileId: '33400000-0000-4000-8000-00000000000b', marketplaceId: 'market-fixture' };
const SHIPPED = 'CCS-00000000000000000000000000000088';
const AMBIGUOUS = 'CCS-00000000000000000000000000000072';
const LAGGING = 'CCS-00000000000000000000000000000209';
const RECIPIENT = ['Marker', 'Recipient'].join(' ');
const STREET = ['1', 'Marker', 'Street'].join(' ');

const lane = (derivedOrderKey: string, laneState: CreatorObservableLane['laneState'], runnerOrderId: string | null = null): CreatorObservableLane => ({
  creatorRecordId: `CCR-SW-26-${derivedOrderKey.slice(-4)}`, asin: 'B0D9K3M2QP', derivedOrderKey, laneState, runnerOrderId,
  reservedAt: '2026-09-08T06:40:00.000Z', mcfStatus: null, packages: [],
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const order = (id: string, packages: { packageNumber: number; trackingNumber: string }[]) => ({ payload: {
  fulfillmentOrder: { sellerFulfillmentOrderId: id, fulfillmentOrderStatus: 'Processing', receivedDate: '2026-09-09T06:34:41Z',
    statusUpdatedDate: '2026-09-09T07:02:18Z', destinationAddress: { name: RECIPIENT, addressLine1: STREET }, notificationEmails: ['marker@invalid'] },
  fulfillmentOrderItems: [{ sellerSku: 'SW-DERMA-05-FBA', quantity: 1, cancelledQuantity: 0, unfulfillableQuantity: 0 }],
  fulfillmentShipments: [{ amazonShipmentId: `shipment-${id.slice(-4)}`, fulfillmentShipmentStatus: 'PENDING',
    fulfillmentShipmentPackage: packages.map((item) => ({ ...item, carrierCode: 'Synthetic carrier', lockerDetails: { lockerNumber: STREET } })) }],
} });

/** A fake SP-API: getFulfillmentOrder, listAllFulfillmentOrders and getPackageTrackingDetails by URL. */
function transport(routes: { orders: Record<string, unknown>; listed?: string[]; tracking: Record<number, unknown> }) {
  return vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
    if (init?.method !== 'GET' || init.body !== undefined) throw new Error('the observer only reads');
    const parsed = new URL(url);
    if (parsed.pathname === '/fba/outbound/2020-07-01/tracking') {
      const found = routes.tracking[Number(parsed.searchParams.get('packageNumber'))];
      return found === undefined ? json({ errors: [{ code: 'NotFound' }] }, 404) : json({ payload: found });
    }
    if (parsed.pathname === '/fba/outbound/2020-07-01/fulfillmentOrders') {
      return json({ payload: { fulfillmentOrders: (routes.listed ?? []).map((id) => ({ sellerFulfillmentOrderId: id, fulfillmentOrderStatus: 'Received',
        destinationAddress: { name: RECIPIENT } })) } });
    }
    const id = decodeURIComponent(parsed.pathname.split('/').pop()!);
    const found = routes.orders[id];
    return found === undefined ? json({ errors: [{ code: 'NotFound' }] }, 404) : json(found);
  });
}
function reader(fetch: ReturnType<typeof transport>) {
  return new FulfillmentOutboundReader({ endpoint: 'https://sellingpartnerapi.invalid', userAgent: 'Fixture/1',
    accessTokenProvider: { getAccessToken: async () => 'synthetic-token' }, fetch });
}
/** An in-memory store with the database's settlement rule. */
function store(lanes: CreatorObservableLane[], connections = 1) {
  const written: CreatorMcfObservationWrite[] = [];
  const probes = new Map<string, number>();
  const fake: McfObserveStore & { written: CreatorMcfObservationWrite[] } = {
    written,
    activeConnections: async () => connections,
    lanes: async (_org, limit) => lanes.slice(0, limit),
    observedKeys: async (_org, jobId) => new Set(written.filter((item) => item.jobId === jobId).map((item) => item.derivedOrderKey)),
    record: async (_org, write) => {
      if (written.some((item) => item.observationKey === write.observationKey)) return { outcome: 'unchanged', settlement: null };
      written.push(write);
      const ambiguous = lanes.find((item) => item.derivedOrderKey === write.derivedOrderKey)?.laneState === 'Reconciliation Required';
      // The database's rule: only not-found reads while the submit is ambiguous count.
      const count = write.outcome === 'found' || !ambiguous ? 0 : (probes.get(write.derivedOrderKey) ?? 0) + 1;
      probes.set(write.derivedOrderKey, count);
      const settlement: CreatorMcfSettlementState = { settlement: write.outcome === 'found' ? 'found' : ambiguous && count >= 3 ? 'escalated' : 'not_found',
        notFoundProbes: count, lastProbeAt: write.readAt };
      return { outcome: 'inserted', settlement };
    },
  };
  return fake;
}
const clock = () => { let tick = 0; return () => new Date(Date.parse('2026-09-09T07:02:18.000Z') + 1000 * tick++); };
const deps = (fetch: ReturnType<typeof transport>, fake: McfObserveStore) => ({ reader: reader(fetch), store: fake, now: clock(), pause: async () => undefined });

describe('mcf.observe', () => {
  it('finds a shipped order under the runner\'s id, reads the whole shipments array, and records a package the carrier has not scanned', async () => {
    const fetch = transport({ orders: { 'synthetic-order-0088': order('synthetic-order-0088', [{ packageNumber: 12, trackingNumber: 'SYN-TRACK-12' }]),
      [LAGGING]: order(LAGGING, [{ packageNumber: 21, trackingNumber: 'SYN-TRACK-21' }]) },
    tracking: { 12: { packageNumber: 12, trackingNumber: 'SYN-TRACK-12', carrierCode: 'Synthetic carrier', currentStatus: 'IN_TRANSIT',
      signedForBy: RECIPIENT, shipToAddress: { city: STREET } } } });
    const fake = store([lane(SHIPPED, 'Confirmed', 'synthetic-order-0088'), lane(LAGGING, 'Verified for Submit')]);
    const result = await observeCreatorMcfLanes(deps(fetch, fake), JOB, 'job-1');
    expect(result).toEqual({ lanes: 2, alreadyObserved: 0, found: 2, notFound: 0, inconsistent: 0, escalated: 0, written: 2, unchanged: 0,
      packages: 2, carrierRead: 1, carrierNotYet: 1, carrierFailed: 0, amazonCalls: 5 });
    expect(fake.written.map((item) => [item.derivedOrderKey, item.queriedOrderId, item.outcome, item.status])).toEqual([
      [SHIPPED, 'synthetic-order-0088', 'found', 'Processing'], [LAGGING, LAGGING, 'found', 'Processing']]);
    // Amazon has the package; the carrier does not: a tracking number, no carrier status, and the time Amazon was asked.
    expect(fake.written[1]!.packages).toEqual([{ packageNumber: 21, carrierCode: 'Synthetic carrier', trackingNumber: 'SYN-TRACK-21',
      estimatedArrivalAt: null, carrierStatus: null, carrierStatusReadAt: '2026-09-09T07:02:21.000Z' }]);
    expect(fake.written[0]!.packages![0]!.carrierStatus).toBe('IN_TRANSIT');
    const text = JSON.stringify(fake.written);
    for (const marker of [RECIPIENT, STREET, 'marker@invalid']) expect(text).not.toContain(marker);
    expect(fetch.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('settles an ambiguous submit as not found by its derived id, corroborated by the bounded order list, and escalates on the third read', async () => {
    const fetch = transport({ orders: {}, listed: ['someone-elses-order'], tracking: {} });
    const fake = store([lane(AMBIGUOUS, 'Reconciliation Required')]);
    const runs = [];
    for (const job of ['job-a', 'job-b', 'job-c', 'job-d']) runs.push(await observeCreatorMcfLanes(deps(fetch, fake), JOB, job));
    // The third read escalates; the fourth reads an already escalated lane and is not counted again.
    expect(runs.map((run) => [run.notFound, run.escalated, run.written])).toEqual([[1, 0, 1], [1, 0, 1], [1, 1, 1], [1, 0, 1]]);
    expect(fake.written.map((item) => [item.queriedOrderId, item.operation, item.outcome])).toEqual(Array(4).fill([AMBIGUOUS, 'listAllFulfillmentOrders', 'not_found']));
    const listCall = fetch.mock.calls.find(([url]) => new URL(url).pathname.endsWith('/fulfillmentOrders'));
    expect(new URL(listCall![0]).searchParams.get('queryStartDate')).toBe('2026-09-07T06:40:00.000Z');
  });

  it('records nothing when the lookup and the order list disagree, and reads again next time', async () => {
    const fetch = transport({ orders: {}, listed: [AMBIGUOUS], tracking: {} });
    const fake = store([lane(AMBIGUOUS, 'Reconciliation Required')]);
    expect(await observeCreatorMcfLanes(deps(fetch, fake), JOB, 'job-1')).toMatchObject({ lanes: 1, inconsistent: 1, found: 0, notFound: 0, written: 0 });
    expect(fake.written).toHaveLength(0);
  });

  it('skips lanes a retried job already recorded, and refuses an organisation without exactly one SP-API connection', async () => {
    const fetch = transport({ orders: { [LAGGING]: order(LAGGING, []) }, tracking: {} });
    const fake = store([lane(LAGGING, 'Verified for Submit')]);
    await observeCreatorMcfLanes(deps(fetch, fake), JOB, 'job-retry');
    const calls = fetch.mock.calls.length;
    expect(await observeCreatorMcfLanes(deps(fetch, fake), JOB, 'job-retry')).toMatchObject({ lanes: 1, alreadyObserved: 1, written: 0, amazonCalls: 0 });
    expect(fetch.mock.calls.length).toBe(calls);
    for (const connections of [0, 2]) {
      await expect(observeCreatorMcfLanes(deps(fetch, store([lane(LAGGING, 'Verified for Submit')], connections)), JOB, 'job-x'))
        .rejects.toThrow(`exactly one active SP-API connection for the organisation; it has ${connections}`);
    }
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it('fails the job on a transport error rather than reading it as not found', async () => {
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => json({ errors: [] }, 503));
    const fake = store([lane(AMBIGUOUS, 'Reconciliation Required')]);
    await expect(observeCreatorMcfLanes(deps(fetch as never, fake), JOB, 'job-1')).rejects.toThrow('Fulfillment Outbound http (503)');
    expect(fake.written).toHaveLength(0);
  });
});

describe('the OPENSPELL_MCF_OBSERVE_ENABLED flag', () => {
  const id = 'synthetic-client';
  const key = ['synthetic', 'key'].join('-');
  it('is off unless the flag is exactly 1 and both credentials exist', () => {
    expect(mcfObserveEnabled({}, id, key)).toBe(false);
    expect(mcfObserveEnabled({ [MCF_OBSERVE_ENABLED_ENV]: 'true' }, id, key)).toBe(false);
    expect(mcfObserveEnabled({ [MCF_OBSERVE_ENABLED_ENV]: '1' }, id, undefined)).toBe(false);
    expect(mcfObserveEnabled({ [MCF_OBSERVE_ENABLED_ENV]: '1' }, undefined, key)).toBe(false);
    expect(mcfObserveEnabled({ [MCF_OBSERVE_ENABLED_ENV]: '1' }, id, key)).toBe(true);
  });

  it('registers nothing and enqueues nothing when off, so a queued job fails as unimplemented', async () => {
    const registry = new IngestionRegistry(async () => ({ offered: 1, written: 1, unchanged: 0 }));
    const handler = vi.fn();
    expect(registerMcfObserve(registry, { enabled: false, handler })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    await expect(registry.dispatch({ job: { id: 'job-1' } as never, payload: JOB, profile: {} as never }))
      .rejects.toThrow('mcf.observe is declared but unimplemented');
    const queue = { enqueue: vi.fn() };
    expect(createMcfObservePass({} as never, queue, {}, { enabled: false, startsBackgroundPasses: true, jobTypes: undefined })).toBeUndefined();
    expect(createMcfObservePass({} as never, queue, {}, { enabled: true, startsBackgroundPasses: false, jobTypes: undefined })).toBeUndefined();
    expect(createMcfObservePass({} as never, queue, {}, { enabled: true, startsBackgroundPasses: true, jobTypes: ['sqp.request'] })).toBeUndefined();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('registers the handler when on and dispatches the job to it with its id', async () => {
    const registry = new IngestionRegistry(async () => ({ offered: 1, written: 1, unchanged: 0 }));
    const run = vi.fn(async () => ({ lanes: 0 }) as never);
    expect(registerMcfObserve(registry, { enabled: true, handler: () => run })).toBe(true);
    await registry.dispatch({ job: { id: 'job-7' } as never, payload: JOB, profile: {} as never });
    expect(run).toHaveBeenCalledWith(JOB, 'job-7');
    expect(() => registerMcfObserve({ register: vi.fn() }, { enabled: true, handler: () => run })).toThrow('worker task registry');
  });

  it('enqueues one job per organisation per interval slot, and bounds the interval', async () => {
    const enqueue = vi.fn(async () => true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const pass = new McfObservePass(async () => ({ scopes: [{ orgId: ORG, profileId: JOB.profileId, marketplaceId: 'market-fixture' },
      { orgId: '33400000-0000-4000-8000-00000000000c', profileId: JOB.profileId, marketplaceId: 'market-fixture' }], refusedOrgs: 1 }),
    { enqueue }, 1_800_000, { info: vi.fn(), error: vi.fn() }, () => new Date('2026-09-09T07:10:00.000Z'));
    expect(await pass.runOnce()).toEqual({ enqueued: 1, deduplicated: 1, refusedOrgs: 1 });
    const slot = Math.floor(Date.parse('2026-09-09T07:10:00.000Z') / 1_800_000);
    expect(enqueue.mock.calls[0]).toEqual([JOB, new Date('2026-09-09T07:10:00.000Z'), `mcf-observe:${ORG}:${slot}`]);
    expect(mcfObserveIntervalMs({})).toBe(1_800_000);
    expect(() => mcfObserveIntervalMs({ OPENSPELL_MCF_OBSERVE_INTERVAL_MINUTES: '1' })).toThrow('from 5 to 1440');
  });
});
