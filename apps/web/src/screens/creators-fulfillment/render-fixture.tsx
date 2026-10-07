/**
 * Frames 447:2 and 449:2. 0072's submit was ambiguous (Reconciliation
 * Required, reservation MCFR-9f2c41ab77e0d3b5, fee 6.20, verified for submit at
 * 06:44:12); 0088's order was found, with a package Amazon holds and the
 * carrier has not scanned. Every read time, shipment id, carrier and tracking
 * number below is a synthetic placeholder; no creator name appears anywhere.
 */
import type {
  CreatorFulfillmentDetail, CreatorMcfObservationEvent, CreatorSamplePackage, CreatorSampleShipment, FulfillmentShipmentObservation,
} from '@wizard-ads/shared';
import { failedImport, lastImport } from '../creators-daily-queue/render-fixture';
import { ambiguous as ambiguousLane, shipped as shippedLane } from '../creators-sample-shipments/render-fixture';
import type { ScreenData } from './view';

export const ambiguous: CreatorSampleShipment = { ...ambiguousLane, verifiedAt: '2026-09-08T06:44:12.000Z' };

const observation = (lane: CreatorSampleShipment, change: Partial<CreatorMcfObservationEvent> & Pick<CreatorMcfObservationEvent, 'observationKey' | 'readAt'>):
  CreatorMcfObservationEvent => ({
  creatorRecordId: lane.creatorRecordId, asin: lane.asin, derivedOrderKey: lane.derivedOrderKey, queriedOrderId: lane.derivedOrderKey,
  operation: 'getFulfillmentOrder', outcome: 'not_found', status: null, shipments: null, packages: null, recordedAt: change.readAt, ...change,
});

/** Newest first, as the read returns them. */
export const notFoundReads: CreatorMcfObservationEvent[] = [
  observation(ambiguous, { observationKey: 'observe:0072:2', readAt: '2026-09-08T08:44:31.000Z' }),
  observation(ambiguous, { observationKey: 'observe:0072:1', readAt: '2026-09-08T07:14:05.000Z' }),
];

const base: CreatorFulfillmentDetail = {
  lastImport, derivedOrderKey: ambiguous.derivedOrderKey, lane: ambiguous, lockState: 'Locked for MCF', settlement: null, shipments: null,
  observations: [], observationsTotal: 0,
};

/** Reconciliation Required, and the worker has not asked Amazon yet: not measured. */
export const notMeasured = { view: 'ready', props: { detail: base } } satisfies ScreenData;
/** Two not-found reads running: one more escalates. */
export const notFound = { view: 'ready', props: { detail: {
  ...base, settlement: { settlement: 'not_found', notFoundProbes: 2, lastProbeAt: notFoundReads[0]!.readAt },
  observations: notFoundReads, observationsTotal: 2,
} } } satisfies ScreenData;
const thirdRead = observation(ambiguous, { observationKey: 'observe:0072:3', readAt: '2026-09-08T10:15:00.000Z' });
export const escalated = { view: 'ready', props: { detail: {
  ...base, settlement: { settlement: 'escalated', notFoundProbes: 3, lastProbeAt: thirdRead.readAt },
  observations: [thirdRead, ...notFoundReads], observationsTotal: 3,
} } } satisfies ScreenData;

export const scannedPackage: CreatorSamplePackage = {
  packageNumber: 1, carrierCode: 'Synthetic carrier', trackingNumber: 'SYNTHETIC-TRACK-0088', estimatedArrivalAt: '2026-09-12T18:00:00.000Z',
  carrierStatus: null, carrierStatusReadAt: null,
};
export const pendingShipment: FulfillmentShipmentObservation = {
  amazonShipmentId: 'SYNTHETIC-SHIP-0088-A', status: 'PENDING', shippedAt: null, estimatedArrivalAt: '2026-09-12T18:00:00.000Z',
  packages: [{ packageNumber: 1, carrierCode: 'Synthetic carrier', trackingNumber: 'SYNTHETIC-TRACK-0088', estimatedArrivalAt: '2026-09-12T18:00:00.000Z' }],
};
/** Found, Processing: a carrier and tracking number, and no carrier status yet (449:2). */
export const processing: CreatorSampleShipment = {
  ...shippedLane, mcf: { status: 'Processing', operation: 'getFulfillmentOrder', readAt: '2026-09-09T07:02:18.000Z' }, packages: [scannedPackage],
};
const foundRead = (lane: CreatorSampleShipment, shipments: FulfillmentShipmentObservation[], key: string, readAt: string) => observation(lane, {
  observationKey: key, readAt, outcome: 'found', status: lane.mcf!.status, shipments, packages: lane.packages,
});
export const trackingNotSafe = { view: 'ready', props: { detail: {
  ...base, derivedOrderKey: processing.derivedOrderKey, lane: processing, lockState: 'Locked for MCF', shipments: [pendingShipment],
  settlement: { settlement: 'found', notFoundProbes: 0, lastProbeAt: processing.mcf!.readAt },
  observations: [foundRead(processing, [pendingShipment], 'observe:0088:1', processing.mcf!.readAt)], observationsTotal: 1,
} } } satisfies ScreenData;

/** Found and moving: the carrier scanned it in transit. Twenty reads shown of twenty-three kept. */
export const inTransitLane: CreatorSampleShipment = {
  ...processing, mcf: { status: 'Complete', operation: 'getFulfillmentOrder', readAt: '2026-09-10T09:30:00.000Z' },
  packages: [{ ...scannedPackage, carrierStatus: 'IN_TRANSIT', carrierStatusReadAt: '2026-09-10T09:31:07.000Z' }],
};
export const shippedShipment: FulfillmentShipmentObservation = { ...pendingShipment, status: 'SHIPPED', shippedAt: '2026-09-09T15:20:00.000Z' };
const hourly = Array.from({ length: 20 }, (_, index) => new Date(Date.parse('2026-09-10T09:30:00.000Z') - index * 3_600_000).toISOString());
export const inTransit = { view: 'ready', props: { detail: {
  ...base, derivedOrderKey: inTransitLane.derivedOrderKey, lane: inTransitLane, lockState: 'Locked for MCF', shipments: [shippedShipment],
  settlement: { settlement: 'found', notFoundProbes: 0, lastProbeAt: inTransitLane.mcf!.readAt },
  observations: hourly.map((readAt, index) => foundRead(inTransitLane, [shippedShipment], `observe:0088:${23 - index}`, readAt)), observationsTotal: 23,
} } } satisfies ScreenData;

/** A well-formed key that no lane carries. */
export const empty = { view: 'ready', props: { detail: {
  ...base, derivedOrderKey: 'CCS-00000000000000000000000000000999', lane: null, lockState: null,
} } } satisfies ScreenData;
export const missing = { view: 'missing', props: { key: null } } satisfies ScreenData;
export const refused = { view: 'ready', props: { detail: { ...notFound.props.detail, lastImport: failedImport } } } satisfies ScreenData;
