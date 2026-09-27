import type { CreatorSamplePackage, CreatorSampleShipment, FulfillmentOrderStatus, FulfillmentShipmentObservation } from '@wizard-ads/shared';

/** Carrier statuses that mean the parcel has left Amazon and is moving toward the creator. A delayed parcel is still with the carrier. */
export const MOVING_CARRIER_STATUSES: readonly string[] = ['IN_TRANSIT', 'DELAYED', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'AVAILABLE_FOR_PICKUP',
  'DELIVERED'];
/** Carrier statuses that mean the parcel will not reach the creator: it is coming back or could not be delivered. */
export const FAILED_CARRIER_STATUSES: readonly string[] = ['RETURNING', 'RETURNED', 'UNDELIVERABLE', 'RETURN_REQUEST_ACCEPTED',
  'RETURN_RECEIVED_IN_FC', 'REFUND_ISSUED'];
/** Order statuses under which Amazon holds the order but will not ship it. */
export const REFUSED_ORDER_STATUSES: readonly FulfillmentOrderStatus[] = ['Invalid', 'Unfulfillable', 'Cancelled'];

export type FulfillmentStageId = 'accepted' | 'shipment' | 'in_transit' | 'delivered';
/**
 * done: reached and passed. now: the furthest stage reached. not_yet: read, and
 * not reached. not_read: the value it depends on has not been read from Amazon.
 * refused: Amazon holds the order under a status that will not ship.
 */
export type FulfillmentStageState = 'done' | 'now' | 'not_yet' | 'not_read' | 'refused';
export interface FulfillmentStage {
  stage: FulfillmentStageId;
  title: string;
  state: FulfillmentStageState;
  /** What the stage was read from, when there is something to say. */
  note: string | null;
}

export const STAGE_TITLES: Record<FulfillmentStageId, string> = {
  accepted: 'Order accepted by Amazon',
  shipment: 'Shipment created, carrier named',
  in_transit: 'Package in transit',
  delivered: 'Delivered',
};

export const isMoving = (status: string | null) => status !== null && MOVING_CARRIER_STATUSES.includes(status);
export const isFailed = (status: string | null) => status !== null && FAILED_CARRIER_STATUSES.includes(status);
const live = (shipment: FulfillmentShipmentObservation) => shipment.status === 'PENDING' || shipment.status === 'SHIPPED';

/**
 * The packages that belong to a live (pending or shipped) shipment. A cancelled
 * shipment's packages stay in the array and never move, so they are not judged.
 * Without a shipments read there is nothing to tell them apart, and every package counts.
 */
export function livePackages(packages: readonly CreatorSamplePackage[] | null, shipments: readonly FulfillmentShipmentObservation[] | null):
  CreatorSamplePackage[] | null {
  if (packages === null) return null;
  if (shipments === null) return [...packages];
  const numbers = new Set(shipments.filter(live).flatMap((shipment) => shipment.packages.map((item) => item.packageNumber)));
  return packages.filter((item) => numbers.has(item.packageNumber));
}

/** A live package the carrier reports coming back or undeliverable. */
export function carrierFailed(packages: readonly CreatorSamplePackage[] | null, shipments: readonly FulfillmentShipmentObservation[] | null): boolean {
  return (livePackages(packages, shipments) ?? []).some((item) => isFailed(item.carrierStatus));
}

/**
 * A live package has a tracking number and no live package is moving or has
 * failed: nothing may go to the creator yet.
 */
export function trackingNotSafeToSend(packages: readonly CreatorSamplePackage[] | null, shipments: readonly FulfillmentShipmentObservation[] | null): boolean {
  const judged = livePackages(packages, shipments) ?? [];
  return judged.some((item) => item.trackingNumber !== null)
    && !judged.some((item) => isMoving(item.carrierStatus) || isFailed(item.carrierStatus));
}

/**
 * The four stages of a found sample order, from the order status Amazon
 * reported, the shipments array of the newest found read, and each package's
 * carrier status. Each stage is judged from its own input only; a null input is
 * not read, never "not yet". A cancelled shipment names no carrier for stage two.
 */
export function fulfillmentStages(lane: Pick<CreatorSampleShipment, 'mcf' | 'packages'>,
  shipments: readonly FulfillmentShipmentObservation[] | null): FulfillmentStage[] {
  const status = lane.mcf?.status ?? null;
  const carriers = shipments === null ? [] : [...new Set(shipments.filter(live)
    .flatMap((shipment) => shipment.packages.map((item) => item.carrierCode)).filter((code): code is string => code !== null))];
  const packages = livePackages(lane.packages, shipments);
  const reached: Record<FulfillmentStageId, boolean | null> = {
    accepted: status === null ? null : !REFUSED_ORDER_STATUSES.includes(status),
    shipment: shipments === null ? null : carriers.length > 0,
    in_transit: packages === null ? null : packages.some((item) => isMoving(item.carrierStatus)),
    delivered: packages === null ? null : packages.length > 0 && packages.every((item) => item.carrierStatus === 'DELIVERED'),
  };
  const order: FulfillmentStageId[] = ['accepted', 'shipment', 'in_transit', 'delivered'];
  const furthest = order.reduce((last, stage, index) => reached[stage] === true ? index : last, -1);
  const notes: Record<FulfillmentStageId, string | null> = {
    accepted: status === null ? null : `Amazon status ${status}`,
    shipment: carriers.length === 0 ? null : carriers.join(', '),
    in_transit: 'the creator hears from us here',
    delivered: null,
  };
  return order.map((stage, index) => {
    const value = reached[stage];
    const state: FulfillmentStageState = value === null ? 'not_read'
      : stage === 'accepted' && value === false ? 'refused'
        : value === false ? 'not_yet'
          : index === furthest && stage !== 'delivered' ? 'now' : 'done';
    return { stage, title: STAGE_TITLES[stage], state, note: notes[stage] };
  });
}
