/** Sponsored subscriptions and separately admitted infrastructure operations. */
import { z } from 'zod';
import { AmazonId, Region, Uuid } from './primitives.js';
import { AmazonMarketingStreamDatasetId } from './dayparting.js';
import { StreamExtensionDataset } from './marketing-stream-extensions.js';

export const SponsoredStreamDatasetId = z.union([AmazonMarketingStreamDatasetId, StreamExtensionDataset]);
export type SponsoredStreamDatasetId = z.infer<typeof SponsoredStreamDatasetId>;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const awsRegion = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/);
const queueArn = z.string().regex(/^arn:aws:sqs:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+(?:\.fifo)?$/);
const topicArn = z.string().regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+(?:\.fifo)?$/);

export const StreamSubscriptionScope = z.object({
  orgId: Uuid, profileId: Uuid, providerProfileId: AmazonId,
  advertiserId: AmazonId, marketplaceId: AmazonId,
  region: Region, awsRegion, datasetId: SponsoredStreamDatasetId, destinationArn: queueArn,
}).strict().superRefine((scope, context) => {
  if (scope.destinationArn.split(':')[3] !== scope.awsRegion) {
    context.addIssue({ code: 'custom', message: 'SQS destination region does not match scope' });
  }
});
export type StreamSubscriptionScope = z.infer<typeof StreamSubscriptionScope>;

export const StreamSubscriptionStatus = z.enum([
  'ACTIVE', 'ARCHIVED', 'FAILED_CONFIRMATION', 'FAILED_PROVISIONING',
  'PENDING_CONFIRMATION', 'PROVISIONING', 'SUSPENDED',
]);
export const StreamSubscriptionObservation = z.object({
  subscriptionId: z.string().min(1).max(255), datasetId: SponsoredStreamDatasetId,
  destinationArn: queueArn, status: StreamSubscriptionStatus,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
}).strict();
export type StreamSubscriptionObservation = z.infer<typeof StreamSubscriptionObservation>;
export const StreamSubscriptionCreated = z.object({
  subscriptionId: z.string().min(1).max(255), clientRequestToken: z.string().min(22).max(36),
}).strict();
export type StreamSubscriptionCreated = z.infer<typeof StreamSubscriptionCreated>;
export const StreamSubscriptionInventory = z.object({
  subscriptions: z.array(StreamSubscriptionObservation),
  sourceRows: z.number().int().nonnegative(), parsedRows: z.number().int().nonnegative(),
  refusedRows: z.number().int().nonnegative(), duplicateRows: z.number().int().nonnegative(),
  complete: z.boolean(),
}).strict().superRefine((inventory, context) => {
  if (inventory.sourceRows !== inventory.parsedRows + inventory.refusedRows
    || inventory.parsedRows !== inventory.subscriptions.length + inventory.duplicateRows
    || (inventory.complete && inventory.refusedRows !== 0)) {
    context.addIssue({ code: 'custom', message: 'Subscription inventory counts do not reconcile' });
  }
});
export type StreamSubscriptionInventory = z.infer<typeof StreamSubscriptionInventory>;

const intentBase = {
  schemaVersion: z.literal('arcana.stream-provisioning-intent.v1'),
  intentId: Uuid, scope: StreamSubscriptionScope, createdAt: z.iso.datetime(),
};
export const StreamProvisioningIntent = z.discriminatedUnion('action', [
  z.object({ ...intentBase, action: z.literal('create'), clientRequestToken: z.string().min(22).max(36) }).strict(),
  z.object({ ...intentBase, action: z.literal('archive'), subscriptionId: z.string().min(1).max(255) }).strict(),
  z.object({ ...intentBase, action: z.literal('confirm'), subscriptionId: z.string().min(1).max(255),
    topicArn, confirmationMessageId: z.string().min(1), tokenFingerprint: sha256 }).strict(),
]);
export type StreamProvisioningIntent = z.infer<typeof StreamProvisioningIntent>;

/** Issued separately from all advertising write delegations; one exact intent. */
export const StreamInfrastructureAuthority = z.object({
  schemaVersion: z.literal('arcana.stream-infrastructure-authority.v1'),
  authorityId: Uuid, actorId: Uuid, enabled: z.boolean().default(false),
  scope: StreamSubscriptionScope, action: z.enum(['create', 'archive', 'confirm']),
  intentFingerprint: sha256, expiresAt: z.iso.datetime(),
}).strict();
export type StreamInfrastructureAuthority = z.infer<typeof StreamInfrastructureAuthority>;

export const StreamProvisioningReceipt = z.object({
  intentId: Uuid, intentFingerprint: sha256, authorityId: Uuid,
  state: z.enum(['reserved', 'accepted', 'uncertain', 'observed', 'conflict']),
  subscriptionId: z.string().min(1).max(255).nullable(),
  recordedAt: z.iso.datetime(), observedAt: z.iso.datetime().nullable(),
}).strict();
export type StreamProvisioningReceipt = z.infer<typeof StreamProvisioningReceipt>;

/** Transient only: neither the token nor SubscribeURL belongs in durable receipts. */
export const StreamConfirmationChallenge = z.object({
  messageId: z.string().min(1), topicArn, token: z.string().min(1).max(8192),
  subscribeUrl: z.string().url().max(16384),
}).strict();
export type StreamConfirmationChallenge = z.infer<typeof StreamConfirmationChallenge>;
