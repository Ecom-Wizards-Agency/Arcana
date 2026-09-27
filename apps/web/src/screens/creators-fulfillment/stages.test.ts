import { describe, expect, it } from 'vitest';
import { inTransit, inTransitLane, pendingShipment, processing, scannedPackage, shippedShipment } from './render-fixture';
import { carrierFailed, fulfillmentStages, livePackages, trackingNotSafeToSend } from './stages';

const states = (lane: Parameters<typeof fulfillmentStages>[0], shipments: Parameters<typeof fulfillmentStages>[1]) =>
  fulfillmentStages(lane, shipments).map((stage) => stage.state);

describe('fulfillment stages', () => {
  it('returns the four stages in order with their titles', () => {
    const stages = fulfillmentStages(processing, [pendingShipment]);
    expect(stages).toHaveLength(4);
    expect(stages.map((stage) => [stage.stage, stage.title])).toEqual([
      ['accepted', 'Order accepted by Amazon'], ['shipment', 'Shipment created, carrier named'], ['in_transit', 'Package in transit'], ['delivered', 'Delivered']]);
    expect(stages.map((stage) => stage.note)).toEqual(['Amazon status Processing', 'Synthetic carrier', 'the creator hears from us here', null]);
  });

  it('marks the furthest stage reached as where it is now, and the stages before it done', () => {
    expect(states(processing, [pendingShipment])).toEqual(['done', 'now', 'not_yet', 'not_yet']);
    expect(states(inTransitLane, inTransit.props.detail.shipments)).toEqual(['done', 'done', 'now', 'not_yet']);
    expect(states({ ...processing, packages: [] }, [])).toEqual(['now', 'not_yet', 'not_yet', 'not_yet']);
  });

  it('calls it delivered only when every package is delivered', () => {
    const delivered = { ...scannedPackage, carrierStatus: 'DELIVERED', carrierStatusReadAt: '2026-09-12T10:00:00.000Z' };
    expect(states({ ...inTransitLane, packages: [delivered] }, [shippedShipment])).toEqual(['done', 'done', 'done', 'done']);
    const second = { ...scannedPackage, packageNumber: 2, carrierStatus: 'IN_TRANSIT', carrierStatusReadAt: '2026-09-12T10:00:00.000Z' };
    const split = { ...shippedShipment, packages: [...shippedShipment.packages, { ...shippedShipment.packages[0]!, packageNumber: 2 }] };
    expect(states({ ...inTransitLane, packages: [delivered, second] }, [split])).toEqual(['done', 'done', 'now', 'not_yet']);
  });

  it('says not read, never not yet, for a stage whose input has not been read', () => {
    expect(states({ mcf: null, packages: null }, null)).toEqual(['not_read', 'not_read', 'not_read', 'not_read']);
    expect(states({ ...processing, packages: null }, null)).toEqual(['now', 'not_read', 'not_read', 'not_read']);
  });

  it('marks a cancelled or refused order and ignores a cancelled shipment\'s carrier', () => {
    for (const status of ['Cancelled', 'Invalid', 'Unfulfillable'] as const) {
      expect(fulfillmentStages({ ...processing, mcf: { ...processing.mcf!, status } }, [pendingShipment])[0]!.state).toBe('refused');
    }
    expect(states(processing, [{ ...pendingShipment, status: 'CANCELLED_BY_FULFILLER' }])).toEqual(['now', 'not_yet', 'not_yet', 'not_yet']);
    expect(states(processing, [{ ...pendingShipment, packages: [{ ...pendingShipment.packages[0]!, carrierCode: null }] }]))
      .toEqual(['now', 'not_yet', 'not_yet', 'not_yet']);
  });

  it('is not safe to send while a tracked live package is not moving', () => {
    expect(trackingNotSafeToSend(processing.packages, [pendingShipment])).toBe(true);
    expect(trackingNotSafeToSend(inTransitLane.packages, [shippedShipment])).toBe(false);
    expect(trackingNotSafeToSend(null, null)).toBe(false);
    expect(trackingNotSafeToSend([{ ...scannedPackage, trackingNumber: null }], [shippedShipment])).toBe(false);
    // A delayed parcel is with the carrier and moving.
    expect(trackingNotSafeToSend([{ ...scannedPackage, carrierStatus: 'DELAYED', carrierStatusReadAt: '2026-09-10T09:31:07.000Z' }], [shippedShipment])).toBe(false);
  });

  it('judges only packages of live shipments: a cancelled shipment\'s package does not hold the banner up', () => {
    const cancelled = { ...pendingShipment, amazonShipmentId: 'SYNTHETIC-SHIP-CANCELLED', status: 'CANCELLED_BY_FULFILLER' as const };
    const replacement = { ...shippedShipment, packages: [{ ...shippedShipment.packages[0]!, packageNumber: 2 }] };
    const stuck = { ...scannedPackage, packageNumber: 1, carrierStatus: null, carrierStatusReadAt: null };
    const moving = { ...scannedPackage, packageNumber: 2, carrierStatus: 'IN_TRANSIT', carrierStatusReadAt: '2026-09-10T09:31:07.000Z' };
    expect(livePackages([stuck, moving], [cancelled, replacement])).toEqual([moving]);
    expect(livePackages([stuck, moving], null)).toHaveLength(2);
    expect(livePackages(null, [replacement])).toBeNull();
    expect(trackingNotSafeToSend([stuck, moving], [cancelled, replacement])).toBe(false);
    expect(trackingNotSafeToSend([stuck], [cancelled, replacement])).toBe(false);
    expect(trackingNotSafeToSend([stuck, { ...moving, carrierStatus: null }], [cancelled, replacement])).toBe(true);
    expect(states({ ...inTransitLane, packages: [stuck, moving] }, [cancelled, replacement])).toEqual(['done', 'done', 'now', 'not_yet']);
  });

  it('raises the failure, not the wait, when the carrier reports a return or an undeliverable parcel', () => {
    for (const status of ['RETURNING', 'RETURNED', 'UNDELIVERABLE']) {
      const failed = [{ ...scannedPackage, carrierStatus: status }];
      expect(carrierFailed(failed, [shippedShipment])).toBe(true);
      expect(trackingNotSafeToSend(failed, [shippedShipment])).toBe(false);
    }
    expect(carrierFailed(inTransitLane.packages, [shippedShipment])).toBe(false);
    expect(carrierFailed(null, null)).toBe(false);
  });
});
