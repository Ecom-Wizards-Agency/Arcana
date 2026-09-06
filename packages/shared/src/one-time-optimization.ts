/** Explicit settings for one read-only run. No tenant policy defaults live here. */
import { z } from 'zod';
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
 * Every value is deliberate. A missing setting cannot resolve from a saved group
 * later, and this document never changes that group's strategy or schedule.
 */
export const OneTimeRpcConfiguration = z.strictObject({
  version: z.literal(1),
  method: z.literal('rpc'),
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
});
export type OneTimeRpcPreviewRequest = z.infer<typeof OneTimeRpcPreviewRequest>;

/** Admission freezes the timezone and date, so queue delays cannot move a run. */
export const OneTimeRpcSnapshot = z.strictObject({
  version: z.literal(1),
  configuration: OneTimeRpcConfiguration,
  profileTimezone: z.string().min(1),
  admittedAt: z.iso.datetime(),
  profileToday: z.iso.date(),
}).refine((snapshot) => snapshot.configuration.window.end < snapshot.profileToday, {
  path: ['configuration', 'window', 'end'],
  message: 'Use completed reporting days before today in the advertising profile timezone.',
});
export type OneTimeRpcSnapshot = z.infer<typeof OneTimeRpcSnapshot>;

export const ONE_TIME_RPC_BID_FIELDS = [
  'targetAcos', 'bidFloor', 'bidCeiling', 'bidIncreaseCap', 'bidDecreaseCap',
] as const;
export type OneTimeRpcBidSettings = Pick<OneTimeRpcConfiguration, typeof ONE_TIME_RPC_BID_FIELDS[number]>;
