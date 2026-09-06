/** Organization-scoped Amazon consent and discovery, before any profile exists. */
import { z } from 'zod';
import { AmazonId, CurrencyCode, Region, Uuid } from './primitives.js';

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

/** A fresh database binding governs client-cache reuse across worker processes. */
export const AdsConnectionCredentialBinding = z.object({
  orgId: Uuid,
  connectionId: Uuid,
  /** PostgreSQL bigint is kept as decimal text, never rounded through Number. */
  generation: z.string().regex(/^[1-9][0-9]*$/),
}).strict();
export type AdsConnectionCredentialBinding = z.infer<typeof AdsConnectionCredentialBinding>;

const Digest = z.string().regex(/^[a-f0-9]{64}$/);
/** The server supplies installation values. A callback cannot replace them. */
export const AmazonConnectionBegin = z.object({
  requestId: Uuid,
  nonceHash: Digest,
  clientId: z.string().min(1).max(256),
  redirectUri: z.url().max(2048).refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash
      && (url.protocol === 'https:' || (url.protocol === 'http:'
        && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }, 'Expected an HTTPS callback or local development origin'),
  scope: z.string().min(1).max(256),
}).strict();
export type AmazonConnectionBegin = z.infer<typeof AmazonConnectionBegin>;

export const AmazonConnectionInstallation = AmazonConnectionBegin.pick({
  clientId: true, redirectUri: true, scope: true,
});
export type AmazonConnectionInstallation = z.infer<typeof AmazonConnectionInstallation>;

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
    || (value.state === 'failed' && (value.reason === null || value.upserted !== 0))
    || (['pending', 'running'].includes(value.state)
      && (value.received !== null || value.parsed !== 0 || value.rejected !== 0
        || value.upserted !== 0 || value.created !== 0 || value.reason !== null))) {
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
  const refuse = (message: string): void => { ctx.addIssue({ code: 'custom', message }); };
  if (new Set(value.regions.map((row) => row.region)).size !== 3) {
    refuse('Expected each discovery region exactly once');
  }
  const beforeGrant = ['awaiting_consent', 'queued', 'exchanging'].includes(value.state);
  const completedRegions = value.regions.filter((region) => region.state === 'completed').length;
  const allSettled = value.regions.every((region) => ['completed', 'failed'].includes(region.state));
  const hasRefusals = value.regions.some((region) => region.state === 'failed' || region.rejected > 0);
  const written = value.regions.reduce((total, region) => total + region.upserted, 0);
  if (beforeGrant && (value.connectionId !== null || value.reason !== null
    || value.regions.some((region) => region.state !== 'pending'))) refuse('Consent cannot claim discovery progress');
  if (['discovering', 'completed', 'partial', 'empty'].includes(value.state) && value.connectionId === null) {
    refuse('Discovery requires an attached connection');
  }
  if (value.state === 'discovering' && value.reason !== null) refuse('Active discovery has no terminal reason');
  if (value.state === 'completed' && (!allSettled || hasRefusals || written === 0 || value.reason !== null)) {
    refuse('Completed connection requires fully reconciled profiles');
  }
  if (value.state === 'partial' && (!allSettled || !hasRefusals || completedRegions === 0
    || value.reason !== 'discovery_incomplete')) refuse('Partial connection requires settled regional evidence');
  if (value.state === 'empty' && (!allSettled || hasRefusals || written !== 0 || value.reason !== 'no_profiles')) {
    refuse('Empty connection requires a complete empty discovery');
  }
  if (value.state === 'cancelled' && value.reason !== 'operator_cancelled') refuse('Cancellation reason mismatch');
  if (value.state === 'refused' && value.reason !== 'authority_changed') refuse('Authority refusal reason mismatch');
  if (value.state === 'reconnect_required' && (value.reason === null
    || !['consent_expired', 'code_expired', 'exchange_refused', 'exchange_uncertain',
      'installation_changed', 'discovery_failed'].includes(value.reason))) refuse('Reconnection requires a fixed reason');
});
export type AmazonConnectionOperation = z.infer<typeof AmazonConnectionOperation>;

/** Required roster metadata is checked before persistence, with every refusal counted. */
export const AmazonConnectionRosterProfile = DiscoveredAdsProfile.extend({
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  currencyCode: CurrencyCode,
  timezone: z.string().min(1).max(100),
});
export type AmazonConnectionRosterProfile = z.infer<typeof AmazonConnectionRosterProfile>;

export const AmazonConnectionRosterInput = z.object({
  region: Region,
  received: z.number().int().nonnegative(),
  profiles: z.array(AmazonConnectionRosterProfile).max(10_000),
  rejected: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.received !== value.profiles.length + value.rejected
    || value.profiles.some((profile) => profile.region !== value.region)
    || new Set(value.profiles.map((profile) => profile.profileId)).size !== value.profiles.length) {
    ctx.addIssue({ code: 'custom', message: 'Roster input counts or identities do not reconcile' });
  }
});
export type AmazonConnectionRosterInput = z.infer<typeof AmazonConnectionRosterInput>;

/** Worker-only transient response. Never serialize a claim into status, jobs or logs. */
const ClaimCustody = z.object({
  leaseId: Uuid,
  leaseExpiresAt: z.iso.datetime({ offset: true }),
  operation: AmazonConnectionOperation,
  installation: AmazonConnectionInstallation,
});
export const AmazonConnectionClaim = z.discriminatedUnion('kind', [
  ClaimCustody.extend({ kind: z.literal('exchange'), code: z.string().min(1).max(8192) }).strict(),
  ClaimCustody.extend({ kind: z.literal('discover'), binding: AdsConnectionCredentialBinding }).strict(),
]).superRefine((value, ctx) => {
  if ((value.kind === 'exchange' && value.operation.state !== 'exchanging')
    || (value.kind === 'discover' && (value.operation.state !== 'discovering'
      || value.binding.orgId !== value.operation.orgId
      || value.binding.connectionId !== value.operation.connectionId))) {
    ctx.addIssue({ code: 'custom', message: 'Connection claim does not match operation custody' });
  }
});
export type AmazonConnectionClaim = z.infer<typeof AmazonConnectionClaim>;
