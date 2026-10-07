import { z } from 'zod';
import { SpReportScope } from './spapi-reports.js';
const id = z.string().min(1).max(40);
export const FulfillmentItem = z.object({ sellerFulfillmentOrderItemId: id, sellerSku: z.string().min(1).max(50), quantity: z.number().int().positive() }).strict();
export const FulfillmentRequest = z.object({
  scope: SpReportScope, callerRequestId: z.string().min(1), sellerFulfillmentOrderId: id,
  displayableOrderId: id, displayableOrderDate: z.iso.datetime(), displayableOrderComment: z.string().max(750),
  shippingSpeedCategory: z.enum(['Standard', 'Expedited', 'Priority']),
  destinationAddress: z.object({ name: z.string().min(1), addressLine1: z.string().min(1), addressLine2: z.string().optional(),
    city: z.string().min(1).optional(), stateOrRegion: z.string().optional(), postalCode: z.string().min(1), countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict(),
  items: z.array(FulfillmentItem).min(1).max(100),
}).strict().superRefine((r, ctx) => {
  if ((r.destinationAddress.countryCode === 'JP') === (r.destinationAddress.city !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Destination city does not match country requirements' });
  if (r.items.reduce((sum, i) => sum + i.quantity, 0) > 250 || new Set(r.items.map(i => i.sellerFulfillmentOrderItemId)).size !== r.items.length)
    ctx.addIssue({ code: 'custom', message: 'Fulfillment items exceed bounds or repeat identity' });
});
export type FulfillmentRequest = z.infer<typeof FulfillmentRequest>;
export const FulfillmentIntent = z.object({
  scope: SpReportScope, callerRequestId: z.string(), sellerFulfillmentOrderId: id,
  payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/), items: z.array(FulfillmentItem),
  state: z.enum(['reserved', 'uncertain', 'accepted']),
});
export type FulfillmentIntent = z.infer<typeof FulfillmentIntent>;
export const FulfillmentOrderStatus = z.enum(['New', 'Received', 'Planning', 'Processing', 'Cancelled', 'Complete', 'CompletePartialled', 'Unfulfillable', 'Invalid']);
export type FulfillmentOrderStatus = z.infer<typeof FulfillmentOrderStatus>;
export const FulfillmentResult = z.object({
  state: z.enum(['accepted', 'observed', 'unresolved', 'refused']),
  providerOrderStatus: FulfillmentOrderStatus.optional(),
  requestedItems: z.number().int().nonnegative(), returnedItems: z.number().int().nonnegative(),
  missingItems: z.number().int().nonnegative(), refusedItems: z.number().int().nonnegative(),
  items: z.array(z.object({ sellerFulfillmentOrderItemId: id, quantity: z.number().int().nonnegative(), status: z.string() })),
});
export type FulfillmentResult = z.infer<typeof FulfillmentResult>;

// ---------------------------------------------------------------------------
// Read-only observation (WP-334). What getFulfillmentOrder, listAllFulfillmentOrders
// and getPackageTrackingDetails return once every recipient field is dropped:
// no destination address, notification email, recipient or signer name,
// carrier phone number or event location crosses the client boundary.
// ---------------------------------------------------------------------------

const Observed = z.iso.datetime({ offset: true });
/** `fulfillmentShipmentStatus` on the 2020-07-01 model. */
export const FulfillmentShipmentStatus = z.enum(['PENDING', 'SHIPPED', 'CANCELLED_BY_FULFILLER', 'CANCELLED_BY_SELLER']);
export type FulfillmentShipmentStatus = z.infer<typeof FulfillmentShipmentStatus>;
/** `CurrentStatus` on getPackageTrackingDetails, 2020-07-01. */
export const FulfillmentCarrierStatus = z.enum([
  'IN_TRANSIT', 'DELIVERED', 'RETURNING', 'RETURNED', 'UNDELIVERABLE', 'DELAYED', 'AVAILABLE_FOR_PICKUP', 'CUSTOMER_ACTION',
  'UNKNOWN', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'PICKUP_SUCCESSFUL', 'PICKUP_CANCELLED', 'PICKUP_ATTEMPTED',
  'PICKUP_SCHEDULED', 'RETURN_REQUEST_ACCEPTED', 'REFUND_ISSUED', 'RETURN_RECEIVED_IN_FC',
]);
export type FulfillmentCarrierStatus = z.infer<typeof FulfillmentCarrierStatus>;
/** One `fulfillmentShipmentPackage` entry: identity and carrier, never where it is going. */
export const FulfillmentPackageObservation = z.object({
  packageNumber: z.number().int().nonnegative(),
  carrierCode: z.string().min(1).max(100).nullable(),
  trackingNumber: z.string().min(1).max(100).nullable(),
  estimatedArrivalAt: Observed.nullable(),
}).strict();
export type FulfillmentPackageObservation = z.infer<typeof FulfillmentPackageObservation>;
/** One `fulfillmentShipments` entry. The whole array is read: a cancelled shipment can be replaced by another entry. */
export const FulfillmentShipmentObservation = z.object({
  amazonShipmentId: z.string().min(1).max(100),
  status: FulfillmentShipmentStatus,
  shippedAt: Observed.nullable(),
  estimatedArrivalAt: Observed.nullable(),
  packages: z.array(FulfillmentPackageObservation),
}).strict();
export type FulfillmentShipmentObservation = z.infer<typeof FulfillmentShipmentObservation>;
export const FulfillmentOrderItemObservation = z.object({
  sellerSku: z.string().min(1).max(50),
  quantity: z.number().int().nonnegative(),
  cancelledQuantity: z.number().int().nonnegative(),
  unfulfillableQuantity: z.number().int().nonnegative(),
}).strict();
export type FulfillmentOrderItemObservation = z.infer<typeof FulfillmentOrderItemObservation>;
/** getFulfillmentOrder, sanitized. */
export const FulfillmentOrderObservation = z.object({
  sellerFulfillmentOrderId: id,
  status: FulfillmentOrderStatus,
  receivedAt: Observed.nullable(),
  statusUpdatedAt: Observed.nullable(),
  items: z.array(FulfillmentOrderItemObservation),
  shipments: z.array(FulfillmentShipmentObservation),
}).strict();
export type FulfillmentOrderObservation = z.infer<typeof FulfillmentOrderObservation>;
/** The read that settles an ambiguous submit: the order exists under this id, or Amazon has none. */
export const FulfillmentOrderLookup = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('found'), order: FulfillmentOrderObservation }).strict(),
  z.object({ outcome: z.literal('not_found'), sellerFulfillmentOrderId: id }).strict(),
]);
export type FulfillmentOrderLookup = z.infer<typeof FulfillmentOrderLookup>;
/** One listAllFulfillmentOrders entry, sanitized: identity and status only. */
export const FulfillmentOrderListEntry = z.object({
  sellerFulfillmentOrderId: id, status: FulfillmentOrderStatus, receivedAt: Observed.nullable(), statusUpdatedAt: Observed.nullable(),
}).strict();
export type FulfillmentOrderListEntry = z.infer<typeof FulfillmentOrderListEntry>;
/** listAllFulfillmentOrders over a bounded window. `complete` is false when the page bound stopped the read. */
export const FulfillmentOrderList = z.object({
  queryStartDate: Observed, pages: z.number().int().positive(), complete: z.boolean(), orders: z.array(FulfillmentOrderListEntry),
}).strict();
export type FulfillmentOrderList = z.infer<typeof FulfillmentOrderList>;
/** getPackageTrackingDetails, sanitized. A null status is Amazon returning no carrier status yet. */
export const PackageTrackingObservation = z.object({
  packageNumber: z.number().int().nonnegative(),
  carrierCode: z.string().min(1).max(100).nullable(),
  trackingNumber: z.string().min(1).max(100).nullable(),
  estimatedArrivalAt: Observed.nullable(),
  currentStatus: FulfillmentCarrierStatus.nullable(),
}).strict();
export type PackageTrackingObservation = z.infer<typeof PackageTrackingObservation>;
