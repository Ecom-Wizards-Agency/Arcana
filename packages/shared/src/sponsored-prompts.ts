import { z } from 'zod';
import { Uuid } from './primitives.js';

export const SPONSORED_PROMPT_IMPORT_MAX_ROWS = 1000;
export const SPONSORED_PROMPT_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const SponsoredPromptStatus = z.enum(['live', 'paused']);
export type SponsoredPromptStatus = z.infer<typeof SponsoredPromptStatus>;
const instant = z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString());
const identifier = z.string().trim().min(1).max(200);
const amount = z.number().finite().nonnegative().max(999999999).multipleOf(0.0001).nullable();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();

/** Amounts belong to [intervalStart, intervalEnd), never cumulative export totals. */
export const SponsoredPromptImportRow = z.object({
  adProduct: z.enum(['SP', 'SB']), campaignId: identifier, adGroupId: identifier,
  promptText: z.string().trim().min(1).max(2000), observedAt: instant,
  status: SponsoredPromptStatus, intervalStart: instant, intervalEnd: instant,
  spend: amount, clicks: count, sales: amount, orders: count,
}).strict().refine((row) => row.intervalStart < row.intervalEnd && row.intervalEnd <= row.observedAt, {
  message: 'The metric interval must end after its start and no later than the observation.',
});
export type SponsoredPromptImportRow = z.infer<typeof SponsoredPromptImportRow>;
export const SponsoredPromptImport = z.object({
  profileId: Uuid,
  metricSemantics: z.literal('disjoint_interval_deltas'),
  rows: z.array(SponsoredPromptImportRow).min(1).max(SPONSORED_PROMPT_IMPORT_MAX_ROWS),
}).strict();
export type SponsoredPromptImport = z.infer<typeof SponsoredPromptImport>;
export const SponsoredPromptVisit = z.object({ profileId: Uuid, viewedThrough: instant }).strict();
export type SponsoredPromptVisit = z.infer<typeof SponsoredPromptVisit>;
export const SponsoredPromptImportResult = z.object({
  offered: z.number().int().nonnegative(), prompts: z.number().int().nonnegative(),
  inserted: z.number().int().nonnegative(), alreadyPresent: z.number().int().nonnegative(),
  verified: z.number().int().nonnegative(),
}).refine((value) => value.offered === value.inserted + value.alreadyPresent && value.verified === value.offered);
export type SponsoredPromptImportResult = z.infer<typeof SponsoredPromptImportResult>;

export const SponsoredPromptObservation = z.object({
  observedAt: instant, status: SponsoredPromptStatus, intervalStart: instant, intervalEnd: instant,
  spend: amount, clicks: count, sales: amount, orders: count,
});
export type SponsoredPromptObservation = z.infer<typeof SponsoredPromptObservation>;
export const SponsoredPrompt = z.object({
  id: Uuid, adProduct: z.enum(['SP', 'SB']), campaignId: identifier, adGroupId: identifier,
  campaignName: z.string().nullable(), adGroupName: z.string().nullable(),
  promptText: z.string(), normalizedPrompt: z.string(), firstSeenAt: instant, lastSeenAt: instant,
  currentStatus: SponsoredPromptStatus, observations: z.array(SponsoredPromptObservation),
});
export type SponsoredPrompt = z.infer<typeof SponsoredPrompt>;
export const SponsoredPromptSnapshot = z.object({
  profileId: Uuid, lastVisitedAt: instant.nullable(), viewedThrough: instant,
  /** Thirty complete calendar days in the profile's timezone. */
  windowStart: instant, windowEnd: instant,
  scheduledImports: z.array(z.object({ referenceId: Uuid, observedAt: instant, collectedAt: instant })).optional(),
  latestObservationAt: instant.nullable(), prompts: z.array(SponsoredPrompt),
});
export type SponsoredPromptSnapshot = z.infer<typeof SponsoredPromptSnapshot>;

const metric = z.number().finite().nonnegative().nullable();
export const SponsoredPromptMetrics = z.object({ spend: metric, clicks: metric, sales: metric, orders: metric, acos: metric });
export type SponsoredPromptMetrics = z.infer<typeof SponsoredPromptMetrics>;
export const SponsoredPromptDisplayRow = SponsoredPromptMetrics.extend({
  prompt: SponsoredPrompt, change: z.enum(['newly_sponsored', 'returned', 'unchanged']), returnedAt: instant.nullable(),
});
export type SponsoredPromptDisplayRow = z.infer<typeof SponsoredPromptDisplayRow>;
export const SponsoredPromptAnalysis = z.object({
  changed: z.array(SponsoredPromptDisplayRow), unchanged: z.array(SponsoredPromptDisplayRow),
  live: z.number().int().nonnegative(), paused: z.number().int().nonnegative(),
  thirtyDays: SponsoredPromptMetrics, sinceVisit: SponsoredPromptMetrics.nullable(),
  loop: z.object({ pausedPrompts: z.number().int().nonnegative(), returnedPrompts: z.number().int().nonnegative(),
    returns: z.number().int().nonnegative(), meanReturnsPerPausedPrompt: metric, meanDaysBetweenPauses: metric }),
});
export type SponsoredPromptAnalysis = z.infer<typeof SponsoredPromptAnalysis>;

export function normalizeSponsoredPrompt(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Console links carry no account, profile, ad group, user or authentication identifier. */
export function sponsoredPromptConsoleUrl(countryCode: string, adProduct: 'SP' | 'SB', campaignId: string): string | null {
  const domains: Readonly<Record<string, string>> = {
    US: 'advertising.amazon.com', CA: 'advertising.amazon.ca', MX: 'advertising.amazon.com.mx',
    BR: 'advertising.amazon.com.br', UK: 'advertising.amazon.co.uk', GB: 'advertising.amazon.co.uk',
    DE: 'advertising.amazon.de', FR: 'advertising.amazon.fr', IT: 'advertising.amazon.it',
    ES: 'advertising.amazon.es', NL: 'advertising.amazon.nl', SE: 'advertising.amazon.se',
    PL: 'advertising.amazon.pl', BE: 'advertising.amazon.com.be', IN: 'advertising.amazon.in',
    JP: 'advertising.amazon.co.jp', AU: 'advertising.amazon.com.au', AE: 'advertising.amazon.ae',
    SA: 'advertising.amazon.sa', SG: 'advertising.amazon.sg', TR: 'advertising.amazon.com.tr',
  };
  const domain = domains[countryCode.toUpperCase()];
  if (!domain || !/^[A-Za-z0-9_-]{1,200}$/.test(campaignId)) return null;
  return `https://${domain}/cm/${adProduct === 'SP' ? 'sp' : 'sb'}/campaigns/${encodeURIComponent(campaignId)}/ad-groups`;
}
