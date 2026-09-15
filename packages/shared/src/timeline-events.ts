import { z } from 'zod';
import { CreativeChangeCertainty } from './creative.js';
import { ExperimentScope } from './experiments.js';
export const TimelineMeasure = z.enum(['spend', 'sales', 'acos', 'clicks', 'orders', 'cvr']);
export type TimelineMeasure = z.infer<typeof TimelineMeasure>;
export const TimelineFocus = z.enum([...TimelineMeasure.options, 'ctr', 'share']);
export type TimelineFocus = z.infer<typeof TimelineFocus>;
export const TimelineEventKind = z.enum(['experiment', 'apply_batch', 'promotion', 'market', 'listing', 'supply']);
export type TimelineEventKind = z.infer<typeof TimelineEventKind>;
export const TimelineManualKind = z.enum(['promotion', 'market', 'listing', 'supply']);
export const TimelineEventInput = z.object({
    profileId: z.uuid(), name: z.string().trim().min(1).max(200), kind: TimelineManualKind,
    start: z.iso.date(), end: z.iso.date().nullable(), scopeText: z.string().trim().max(2000),
    note: z.string().trim().max(20000), supersedesId: z.uuid().nullable().default(null),
}).strict().refine((v) => v.end === null || v.end >= v.start, { message: 'The end cannot precede the start', path: ['end'] });
export type TimelineEventInput = z.infer<typeof TimelineEventInput>;
export const TimelineDaily = z.object({
    date: z.iso.date(), spend: z.number().nonnegative().nullable(), sales: z.number().nonnegative().nullable(),
    clicks: z.number().nonnegative().nullable(), orders: z.number().nonnegative().nullable(), impressions: z.number().nonnegative().nullable(),
});
export type TimelineDaily = z.infer<typeof TimelineDaily>;
export const TimelineEvent = z.object({
    id: z.string(), name: z.string(), kind: TimelineEventKind, start: z.iso.date(), end: z.iso.date().nullable(),
    status: z.string(), scope: ExperimentScope, scopeText: z.string(), focus: TimelineFocus,
    certainty: z.lazy(() => CreativeChangeCertainty).optional(), source: z.string().optional(),
    note: z.string(), actorId: z.string().nullable(), createdAt: z.string(), supersedesId: z.string().nullable(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;
export const TimelineEvidenceSettings = z.object({ minDays: z.number().int().positive().nullable(), minClicks: z.number().nonnegative().nullable() });
export type TimelineEvidenceSettings = z.infer<typeof TimelineEvidenceSettings>;
export const TimelineRank = z.object({ mode: z.enum(['organic', 'bsr']), asin: z.string(), keyword: z.string().nullable(), category: z.string().nullable(),
    points: z.array(z.object({ date: z.iso.date(), value: z.number().int().positive().nullable() })),
});
export type TimelineRank = z.infer<typeof TimelineRank>;
export const TimelineSnapshot = z.object({
    profile: z.array(TimelineDaily), events: z.array(TimelineEvent), scoped: z.record(z.string(), z.array(TimelineDaily)),
    syncFailureSince: z.iso.date().nullable().optional(),
    ranks: z.array(TimelineRank), settings: TimelineEvidenceSettings,
});
export type TimelineSnapshot = z.infer<typeof TimelineSnapshot>;
