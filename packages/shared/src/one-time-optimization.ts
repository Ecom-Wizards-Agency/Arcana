/** Explicit settings for one read-only run. No tenant policy defaults live here. */
import { z } from 'zod';
import { MethodId, MethodVersion, MethodSelection, PlacementEvidenceRequirements } from './methods.js';
import { Uuid } from './primitives.js';

export const ONE_TIME_PREVIEW_CAMPAIGN_MAX = 10_000;
export const ONE_TIME_PREVIEW_BODY_MAX_BYTES = 512 * 1024;

/** Completed calendar dates in the advertising profile's timezone. */
export const OneTimeOptimizationWindow = z.strictObject({
  start: z.iso.date(),
  end: z.iso.date(),
}).refine((window) => window.start <= window.end, {
  path: ['end'],
  message: 'The reporting end date must be on or after its start date.',
}).refine((window) => Date.parse(window.end) - Date.parse(window.start) < 366 * 86_400_000, {
  path: ['end'],
  message: 'One preview can evaluate at most 366 reporting days.',
});
export type OneTimeOptimizationWindow = z.infer<typeof OneTimeOptimizationWindow>;

/**
 * Ratios are fractions (not display percentages); bids use the profile currency.
 * Run values fill settings not defined by the assigned group.
 * This document never changes that group's strategy or schedule.
 */
const ReferenceConfiguration = z.strictObject({
  version: z.literal(1),
  method: z.enum(['sp.reference-efficiency', 'rpc']).transform((method) =>
    method === 'rpc' ? 'sp.reference-efficiency' as const : method),
  targetAcos: z.number().positive(),
  bidFloor: z.number().nonnegative(),
  bidCeiling: z.number().positive(),
  bidIncreaseCap: z.number().nonnegative(),
  bidDecreaseCap: z.number().min(0).max(1),
  window: OneTimeOptimizationWindow,
}).refine((settings) => settings.bidFloor <= settings.bidCeiling, {
  path: ['bidCeiling'],
  message: 'The maximum bid must be at least the minimum bid.',
});
export const CoordinatedConfiguration = z.strictObject({ ...ReferenceConfiguration.shape,
  version: z.literal(2), method: z.literal('sp.coordinated-efficiency'),
  exposureCeiling: z.number().positive(), placementEvidenceRequirements: PlacementEvidenceRequirements,
  minClicksPerPlacement: z.number().int().positive(),
}).refine((settings) => settings.bidFloor <= settings.bidCeiling, { path: ['bidCeiling'], message: 'The maximum bid must be at least the minimum bid.' });
export const OneTimeRpcConfiguration = z.discriminatedUnion('version', [ReferenceConfiguration, CoordinatedConfiguration]);
export type OneTimeRpcConfiguration = z.infer<typeof OneTimeRpcConfiguration>;

const SelectedCampaignIds = z.array(
  z.string().min(1).refine((id) => id === id.trim(), 'Campaign ids must be canonical strings.'),
).min(1).max(ONE_TIME_PREVIEW_CAMPAIGN_MAX).refine(
  (ids) => new Set(ids).size === ids.length,
  'Campaign ids must be unique.',
);

export const OneTimePreviewSelection = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('selected'), campaignIds: SelectedCampaignIds }),
]);
export type OneTimePreviewSelection = z.infer<typeof OneTimePreviewSelection>;

/** Sent to the versioned one-time endpoint; legacy endpoints must not consume it. */
export const OneTimeRpcPreviewRequest = z.strictObject({
  version: z.literal(1),
  profileId: Uuid,
  clientRequestId: Uuid,
  scope: OneTimePreviewSelection,
  configuration: OneTimeRpcConfiguration,
  /** Temporary per-campaign choices, frozen in each child's method admission. */
  campaignMethods: z.record(z.string().min(1).refine((id) => id === id.trim(), 'Campaign ids must be canonical strings.'), MethodSelection)
    .refine((selections) => Object.keys(selections).length <= ONE_TIME_PREVIEW_CAMPAIGN_MAX, 'Too many campaign method selections.').optional(),
}).refine((request) => request.scope.mode === 'all' || Object.keys(request.campaignMethods ?? {})
  .every((id) => request.scope.mode === 'selected' && request.scope.campaignIds.includes(id)), {
  path: ['campaignMethods'], message: 'Method selections must belong to the selected campaign scope.',
});
export type OneTimeRpcPreviewRequest = z.infer<typeof OneTimeRpcPreviewRequest>;

/** Admission freezes the timezone and date, so queue delays cannot move a run. */
export const OneTimeRpcSnapshot = z.strictObject({
  methodId: MethodId.optional(),
  methodVersion: MethodVersion.optional(),
  version: z.union([z.literal(1), z.literal(2)]),
  configuration: OneTimeRpcConfiguration,
  profileTimezone: z.string().min(1),
  admittedAt: z.iso.datetime(),
  profileToday: z.iso.date(),
}).refine((snapshot) => snapshot.version === snapshot.configuration.version
  && (snapshot.version === 1
    ? (snapshot.methodId === undefined || snapshot.methodId === 'sp.reference-efficiency')
      && (snapshot.methodVersion === undefined || snapshot.methodVersion === 'reference.1')
    : snapshot.methodId === 'sp.coordinated-efficiency' && snapshot.methodVersion === 'candidate.1'), { message: 'Snapshot version and method must match its configuration.' }).refine((snapshot) => snapshot.configuration.window.end < snapshot.profileToday, {
  path: ['configuration', 'window', 'end'],
  message: 'Use completed reporting days before today in the advertising profile timezone.',
});
export type OneTimeRpcSnapshot = z.infer<typeof OneTimeRpcSnapshot>;

export const ONE_TIME_RPC_BID_FIELDS = [
  'targetAcos', 'bidFloor', 'bidCeiling', 'bidIncreaseCap', 'bidDecreaseCap',
] as const;
export type OneTimeRpcBidSettings = Pick<OneTimeRpcConfiguration, typeof ONE_TIME_RPC_BID_FIELDS[number]>;

/** Legacy input is accepted only at parsing boundaries; output is always canonical. */
export function oneTimeMethodId(method: MethodId | 'rpc'): MethodId {
  return method === 'rpc' ? 'sp.reference-efficiency' : MethodId.parse(method);
}
