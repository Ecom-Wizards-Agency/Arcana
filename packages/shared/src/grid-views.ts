import { z } from 'zod';
import { TimelineMeasure, TimelineEventKind } from './timeline-events.js';

export const TimelineViewState = z.object({
  mode: z.enum(['performance', 'organic', 'bsr']).default('performance'),
  hiddenKinds: z.array(TimelineEventKind).default([]),
  eventId: z.string().nullable().default(null),
  asin: z.string().default(''), keyword: z.string().default(''), category: z.string().default(''),
}).strict();
export type TimelineViewState = z.infer<typeof TimelineViewState>;

import { TranslationView } from './translation.js';

const strings = z.array(z.string()).readonly();
/** Base-sum slots may be placeholders only when explicitly marked unmeasured. */
export const GridMeasurement = z.strictObject({
  missing: z.array(z.enum(['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'])),
  comparisonMissing: z.array(z.enum(['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'])),
});
export type GridMeasurement = z.infer<typeof GridMeasurement>;
export const GridEntity = z.enum(['campaigns', 'ad_groups', 'targets', 'search_terms', 'products', 'placements']);
export const VerdictThresholds = z.strictObject({
  ownedRank: z.number().positive().nullable(),
  rankGap: z.number().positive().nullable(),
  targetAcos: z.number().nonnegative().nullable(),
});
export type VerdictThresholds = z.infer<typeof VerdictThresholds>;
export const VerdictEvidence = z.strictObject({
  clicks: z.number().nonnegative().nullable(), spend: z.number().nonnegative().nullable(),
  acos: z.number().nonnegative().nullable(), organicRank: z.number().positive().nullable(),
  topOfSearchShare: z.number().min(0).max(1).nullable(),
});
export type VerdictEvidence = z.infer<typeof VerdictEvidence>;
export const PerformanceVerdict = z.strictObject({
  diagnosis: z.enum(['Paying for rank we own', 'Rank gap', 'Ranked, unfunded', 'Efficient', 'Insufficient evidence']),
  reason: z.string().min(1),
});
export type PerformanceVerdict = z.infer<typeof PerformanceVerdict>;
export const GridFeedCoverage = z.strictObject({
  feed: z.enum(['PPC', 'RANK', 'SQP']), daysHeld: z.number().int().nonnegative(),
  daysRequested: z.number().int().nonnegative(), notScraped: z.number().int().nonnegative(),
  status: z.enum(['complete', 'partial', 'not-measured']), reason: z.string().min(1),
});
export type GridFeedCoverage = z.infer<typeof GridFeedCoverage>;
export const GridPerformanceEvidence = z.strictObject({
  feeds: z.array(GridFeedCoverage),
  unattributed: z.strictObject({ adGroups: z.number().int().nonnegative(), spend: z.number().nonnegative(), days: z.number().int().nonnegative() }).nullable(),
  rankDays: z.record(z.string(), z.array(z.strictObject({ date: z.string(), observed: z.boolean(), rank: z.number().int().positive().nullable() })).length(14)),
});
export type GridPerformanceEvidence = z.infer<typeof GridPerformanceEvidence>;
/** One date axis per response. null = unobserved; 0 = observed, never ranked. */
export const GridPerformanceTransport = GridPerformanceEvidence.omit({ rankDays: true }).extend({
  rankAxis: z.array(z.string()).length(14).or(z.tuple([])),
  rankValues: z.record(z.string(), z.array(z.number().int().nonnegative().nullable()).length(14)),
});
export type GridPerformanceTransport = z.infer<typeof GridPerformanceTransport>;

export function encodeGridPerformance(evidence: GridPerformanceEvidence): GridPerformanceTransport {
  const histories = Object.entries(evidence.rankDays).filter(([, days]) => days.some((day) => day.observed));
  const rankAxis = histories[0]?.[1].map((day) => day.date) ?? [];
  for (const [, days] of histories) {
    if (days.some((day, index) => day.date !== rankAxis[index])) throw new Error('Rank history date axes disagree');
  }
  return { feeds: evidence.feeds, unattributed: evidence.unattributed, rankAxis,
    rankValues: Object.fromEntries(histories.map(([id, days]) => [id, days.map((day) => day.observed ? day.rank ?? 0 : null)])) };
}

export function decodeGridPerformance(raw: unknown): GridPerformanceEvidence {
  // Accept domain fixtures and previously cached responses as well as compact transport.
  if (typeof raw === 'object' && raw !== null && 'rankDays' in raw) return GridPerformanceEvidence.parse(raw);
  const value = GridPerformanceTransport.parse(raw);
  if (Object.keys(value.rankValues).length && value.rankAxis.length !== 14) throw new Error('Rank history date axis is missing');
  return { feeds: value.feeds, unattributed: value.unattributed,
    rankDays: Object.fromEntries(Object.entries(value.rankValues).map(([id, ranks]) => [id, ranks.map((rank, index) => ({
      date: value.rankAxis[index]!, observed: rank !== null, rank: rank === 0 ? null : rank,
    }))])) };
}

export const GridSavedView = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  entity: GridEntity,
  columns: strings,
  pinned: strings,
  widths: z.record(z.string(), z.number().finite()).readonly(),
  density: z.enum(['compact', 'normal', 'comfortable']).optional(),
  filter: z.object({ groups: z.array(z.object({ filters: z.array(z.object({
    key: z.string(),
    logical_operator: z.enum(['AND', 'OR']).optional(),
    conditions: z.array(z.object({
      operator: z.enum(['>', '<', '>=', '<=', '=', '<>', 'IN', 'NOT_IN', 'LIKE', 'NOT_LIKE', 'IS_NULL', 'IS_NOT_NULL']).optional(),
      values: strings,
    }).strict()).readonly(),
  }).strict()).readonly() }).strict()).readonly() }).strict(),
  sort: z.array(z.object({ columnId: z.string(), direction: z.enum(['asc', 'desc']) }).strict()).readonly(),
  groupBy: strings,
  collapsedGroupIds: strings.optional(),
  dateRange: z.object({ start: z.string(), end: z.string() }).strict().nullable(),
  chartedMeasures: z.array(TimelineMeasure).min(1).max(4).refine((values) => new Set(values).size === values.length).optional(),
  timeline: TimelineViewState.optional(),
  chart: z.strictObject({ series: z.array(z.enum(['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc'])).max(4).refine((series) => new Set(series).size === series.length) }).optional(),
  translation: TranslationView.optional(),
  updatedAt: z.string(),
}).strict();
export type GridSavedView = z.infer<typeof GridSavedView>;

/** Version prefix plus UTF-8 base64url; independent of Node and safe in browsers. */
export function serializeGridView(view: GridSavedView): string {
  const bytes = new TextEncoder().encode(JSON.stringify(GridSavedView.parse(view)));
  const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  return `1.${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function parseGridView(value: string | null | undefined): GridSavedView | null {
  if (!value || value.length > 64_000 || !/^1\.[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const binary = atob(value.slice(2).replaceAll('-', '+').replaceAll('_', '/'));
    const parsed = GridSavedView.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    )));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export const GridViewRecord = z.object({
  orgId: z.uuid(),
  profileId: z.uuid().nullable(),
  ownerId: z.uuid(),
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  view: GridSavedView,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();
export type GridViewRecord = z.infer<typeof GridViewRecord>;

export const GridViewSave = z.object({
  profileId: z.uuid().nullable(),
  views: z.array(GridSavedView).min(1).max(500),
}).strict();
