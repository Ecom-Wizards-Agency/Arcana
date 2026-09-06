/** Organization-scoped Amazon consent and discovery, before any profile exists. */
import { z } from 'zod';
import { AmazonId, Region, Uuid } from './primitives.js';

export const DiscoveredAdsProfile = z.object({
  profileId: AmazonId,
  region: Region,
  countryCode: z.string().nullable(),
  currencyCode: z.string().nullable(),
  timezone: z.string().nullable(),
  dailyBudget: z.number().finite().nullable(),
  accountType: z.enum(['seller', 'vendor', 'agency']).nullable(),
  accountName: z.string().nullable(),
  amazonAccountId: AmazonId.nullable(),
  marketplaceStringId: z.string().nullable(),
}).strict();
export type DiscoveredAdsProfile = z.infer<typeof DiscoveredAdsProfile>;

/** Refusals identify input positions only; raw provider rows never enter diagnostics. */
export const AdsProfileRefusal = z.object({
  index: z.number().int().nonnegative(),
  reason: z.enum(['invalid_row', 'invalid_profile_id', 'unsafe_profile_id', 'duplicate_profile_id']),
}).strict();
export type AdsProfileRefusal = z.infer<typeof AdsProfileRefusal>;

export const AdsProfileDiscoveryResult = z.object({
  region: Region,
  received: z.number().int().nonnegative(),
  profiles: z.array(DiscoveredAdsProfile),
  rejected: z.array(AdsProfileRefusal),
}).strict().superRefine((value, ctx) => {
  const refuse = (message: string): void => { ctx.addIssue({ code: 'custom', message }); };
  if (value.received !== value.profiles.length + value.rejected.length) refuse('Profile counts do not reconcile');
  if (value.profiles.some((profile) => profile.region !== value.region)) refuse('Profile region mismatch');
  if (new Set(value.profiles.map((profile) => profile.profileId)).size !== value.profiles.length) {
    refuse('Duplicate accepted profile');
  }
  if (new Set(value.rejected.map((row) => row.index)).size !== value.rejected.length
    || value.rejected.some((row) => row.index >= value.received)) refuse('Invalid refused input positions');
});
export type AdsProfileDiscoveryResult = z.infer<typeof AdsProfileDiscoveryResult>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
/** The server supplies installation values. A callback cannot replace them. */
export const AmazonConnectionBegin = z.object({
  requestId: Uuid,
  nonceHash: Digest,
  clientId: z.string().min(1).max(256),
  redirectUri: z.url().max(2048),
  scope: z.string().min(1).max(256),
}).strict();
export type AmazonConnectionBegin = z.infer<typeof AmazonConnectionBegin>;

/** Transport to encrypted custody only; never a job payload, view or audit value. */
export const AmazonConnectionSubmit = z.object({
  operationId: Uuid,
  nonceHash: Digest,
  code: z.string().min(1).max(8192),
}).strict();
export type AmazonConnectionSubmit = z.infer<typeof AmazonConnectionSubmit>;

export const AmazonConnectionState = z.enum([
  'awaiting_consent', 'queued', 'exchanging', 'discovering',
  'completed', 'partial', 'empty', 'reconnect_required', 'refused', 'cancelled',
]);
export type AmazonConnectionState = z.infer<typeof AmazonConnectionState>;

/** Fixed application reasons, never Amazon error descriptions or request bodies. */
export const AmazonConnectionReason = z.enum([
  'consent_expired', 'code_expired', 'exchange_refused', 'exchange_uncertain',
  'authority_changed', 'installation_changed', 'discovery_failed',
  'discovery_incomplete', 'no_profiles', 'operator_cancelled',
]);
export type AmazonConnectionReason = z.infer<typeof AmazonConnectionReason>;

export const AmazonConnectionRegionProgress = z.object({
  region: Region,
  state: z.enum(['pending', 'running', 'completed', 'failed']),
  received: z.number().int().nonnegative().nullable(),
  parsed: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  upserted: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  reason: z.enum(['access_refused', 'request_failed', 'invalid_response', 'persistence_failed']).nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.received === null && value.parsed + value.rejected !== 0)
    || (value.received !== null && value.received !== value.parsed + value.rejected)
    || value.upserted > value.parsed || value.created > value.upserted
    || (value.state === 'completed' && (value.received === null || value.upserted !== value.parsed || value.reason !== null))
    || (value.state === 'failed' && value.reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'Discovery progress does not reconcile' });
  }
});
export type AmazonConnectionRegionProgress = z.infer<typeof AmazonConnectionRegionProgress>;

export const AmazonConnectionOperation = z.object({
  version: z.literal(1),
  operationId: Uuid,
  orgId: Uuid,
  connectionId: Uuid.nullable(),
  state: AmazonConnectionState,
  reason: AmazonConnectionReason.nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  regions: z.array(AmazonConnectionRegionProgress).length(3),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.regions.map((row) => row.region)).size !== 3) {
    ctx.addIssue({ code: 'custom', message: 'Expected each discovery region exactly once' });
  }
});
export type AmazonConnectionOperation = z.infer<typeof AmazonConnectionOperation>;
