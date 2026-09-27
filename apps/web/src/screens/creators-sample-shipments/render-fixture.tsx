/**
 * Sample lanes from CREATOR-FIXTURE.json: 0088 passed pre-flight and ships;
 * 0072's submit was ambiguous (Reconciliation Required, reservation
 * MCFR-9f2c41ab77e0d3b5, fee 6.20). The fixture carries no package or carrier
 * values, so 0088's MCF status, package and read times below are synthetic
 * placeholders for the "Amazon has the package, the carrier does not" state.
 */
import type { CreatorSampleShipment } from '@wizard-ads/shared';
import { failedImport, lastImport, snapshot as queue } from '../creators-daily-queue/render-fixture';
import type { ScreenData } from './view';

const base = { orderOwner: 'runner', campaignId: null, runnerOrderId: null, feeCapCents: 800, reservedAt: null, verifiedAt: null, confirmedAt: null, cancelledAt: null,
  cancellationReason: null, reconciliationReason: null, mcf: null, packages: null, source: 'control-runner', importedAt: '2026-09-09T06:14:00.000Z' } as const;
export const shipped: CreatorSampleShipment = {
  ...base, creatorRecordId: 'CCR-SW-26-0088', asin: 'B0D9K3M2QP', derivedOrderKey: 'CCS-5a0f3c9e1b7d42a8c6e0f1b3d5a7c9e1', sku: 'SW-DERMA-05-FBA',
  reservationId: 'MCFR-00000000000000D8', laneState: 'Confirmed', runnerOrderId: 'synthetic-order-0088', feeCents: 620,
  reservedAt: '2026-09-09T06:33:19.000Z', confirmedAt: '2026-09-09T06:40:00.000Z',
  mcf: { status: 'Complete', operation: 'getFulfillmentOrder', readAt: '2026-09-09T11:02:41.000Z' },
  packages: [{ packageNumber: 1, carrierCode: 'Synthetic carrier', trackingNumber: 'SYNTHETIC-TRACK-0088', estimatedArrivalAt: null, carrierStatus: null, carrierStatusReadAt: null }],
};
export const ambiguous: CreatorSampleShipment = {
  ...base, creatorRecordId: 'CCR-SW-26-0072', asin: 'B0D9K3M2QP', derivedOrderKey: 'CCS-c0f442832fffd7a5ca62f194d171bd90', sku: 'SW-DERMA-05-FBA',
  reservationId: 'MCFR-9f2c41ab77e0d3b5', laneState: 'Reconciliation Required', feeCents: 620, verifiedAt: '2026-09-08T06:44:00.000Z',
  reconciliationReason: 'outcome_unknown',
};
export const ready = { view: 'ready', props: { snapshot: { lastImport, shipments: [shipped, ambiguous] }, report: null } } satisfies ScreenData;
export const refused = { view: 'ready', props: { snapshot: { lastImport: failedImport, shipments: [shipped, ambiguous] }, report: null } } satisfies ScreenData;
export const empty = { view: 'ready', props: { snapshot: { lastImport, shipments: [] }, report: null } } satisfies ScreenData;
export const notImported = { view: 'ready', props: { snapshot: { lastImport: null, shipments: [] }, report: null } } satisfies ScreenData;
/** An import that read only the queue: nothing that records a sample lane was read. */
export const queueOnly = { view: 'ready', props: { snapshot: { lastImport: { ...lastImport, files: ['queue'] }, shipments: [] }, report: null } } satisfies ScreenData;
/**
 * `?report=daily`: the fixture queue (34 items) and sweep (did not reconcile),
 * with 0088's order found by a read and 0072 read twice with nothing found.
 */
export const reported = { view: 'ready', props: { snapshot: ready.props.snapshot, report: { queue, settlements: {
  [shipped.derivedOrderKey]: { settlement: 'found', notFoundProbes: 0, lastProbeAt: '2026-09-09T11:02:41.000Z' },
  [ambiguous.derivedOrderKey]: { settlement: 'not_found', notFoundProbes: 2, lastProbeAt: '2026-09-09T11:02:43.000Z' },
} } } } satisfies ScreenData;
