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
