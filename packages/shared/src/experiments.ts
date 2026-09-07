/** Experiment lifecycle contracts; agency and event provenance come from the actor. */
import { z } from 'zod';
import { Uuid } from './primitives.js';

export const ExperimentType = z.enum(['bid_push', 'creative', 'listing_content', 'price', 'placement', 'other']);
export type ExperimentType = z.infer<typeof ExperimentType>;
export const EXPERIMENT_TYPES = ExperimentType.options;
export const ExperimentMetric = z.enum(['acos', 'cvr', 'ctr', 'sales', 'share']);
export type ExperimentMetric = z.infer<typeof ExperimentMetric>;
export const EXPERIMENT_METRICS = ExperimentMetric.options;
export const ExperimentStatus = z.enum(['planned', 'running', 'ended', 'analyzed', 'aborted']);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;
export const EXPERIMENT_STATUSES = ExperimentStatus.options;

export const EXPERIMENT_TRANSITIONS: Readonly<Record<ExperimentStatus, readonly ExperimentStatus[]>> = {
  planned: ['running', 'aborted'], running: ['ended', 'aborted'],
  ended: ['analyzed', 'running', 'aborted'], analyzed: ['running', 'aborted'], aborted: [],
};
export function canTransitionExperiment(from: ExperimentStatus, to: ExperimentStatus): boolean {
  return from === to || EXPERIMENT_TRANSITIONS[from].includes(to);
}

export const ExperimentName = z.string().trim().transform((value) => value.replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'An experiment name cannot be empty').max(200, 'An experiment name cannot exceed 200 characters'));
export const ExperimentText = z.string().trim().max(20_000, 'Experiment text cannot exceed 20000 characters');
const scopeFields = {
  campaignIds: z.array(z.string()).optional(), adGroupIds: z.array(z.string()).optional(),
  targetIds: z.array(z.string()).optional(), asins: z.array(z.string()).optional(),
  searchTerms: z.array(z.string()).optional(), note: z.string().optional(),
};
/** Historical read shape. A write does not require old mirrors to still exist. */
export const ExperimentScope = z.object(scopeFields).passthrough();
export type ExperimentScope = z.infer<typeof ExperimentScope>;
const identifiers = z.array(z.string().trim().min(1)).transform((values) => [...new Set(values)]);
export const ExperimentScopeInput = z.object({
  campaignIds: identifiers.optional(), adGroupIds: identifiers.optional(), targetIds: identifiers.optional(),
  asins: identifiers.optional(), searchTerms: identifiers.optional(), note: ExperimentText.optional(),
}).strict();

/** New commands accept real ISO days/timestamps or already parsed Dates. */
export const ExperimentStart = z.union([
  z.date(), z.iso.date(), z.iso.datetime({ offset: true, local: true }),
]).transform((value) => value instanceof Date ? value : new Date(value)).pipe(z.date());

const editable = {
  name: ExperimentName.optional(), hypothesis: ExperimentText.optional(), type: ExperimentType.optional(),
  metricFocus: ExperimentMetric.optional(), scope: ExperimentScopeInput.optional(), startAt: ExperimentStart.optional(),
};
export const ExperimentCommand = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'), profileId: Uuid, name: ExperimentName, hypothesis: ExperimentText.optional(),
    type: ExperimentType, metricFocus: ExperimentMetric, scope: ExperimentScopeInput.optional(),
    startAt: ExperimentStart.nullable().optional(), status: z.enum(['planned', 'running']).optional(),
  }).strict(),
  z.object({ kind: z.literal('edit'), experimentId: Uuid, ...editable }).strict()
    .refine((value) => Object.keys(editable).some((key) => value[key as keyof typeof value] !== undefined), {
      message: 'An edit must change at least one experiment field',
    }),
  z.object({
    kind: z.literal('transition'), experimentId: Uuid, status: ExperimentStatus.optional(),
    note: ExperimentText.nullable().optional(), resultNote: ExperimentText.nullable().optional(),
  }).strict().refine((value) => value.status !== undefined || value.resultNote !== undefined, {
    message: 'A transition must set a status or result note',
  }),
]);
export type ExperimentCommand = z.infer<typeof ExperimentCommand>;

export const ExperimentRecord = z.object({
  id: Uuid, orgId: Uuid, profileId: Uuid, name: z.string(), hypothesis: z.string(), type: ExperimentType,
  scope: ExperimentScope, metricFocus: ExperimentMetric, startAt: z.date(), endAt: z.date().nullable(),
  status: ExperimentStatus, resultNote: z.string().nullable(), createdBy: Uuid.nullable(),
  createdAt: z.date(), updatedAt: z.date(), statusChangedAt: z.date(),
}).strict();
export type ExperimentRecord = z.infer<typeof ExperimentRecord>;
export const ExperimentEventRecord = z.object({
  id: z.number().int().positive(), experimentId: Uuid, orgId: Uuid, fromStatus: ExperimentStatus.nullable(),
  toStatus: ExperimentStatus, note: z.string().nullable(), actorId: Uuid.nullable(), createdAt: z.date(),
}).strict();
export type ExperimentEventRecord = z.infer<typeof ExperimentEventRecord>;

/** Actual item/event readback; this is not a durable replay receipt. */
export const ExperimentCommandResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), item: ExperimentRecord, event: ExperimentEventRecord }).strict(),
  z.object({ kind: z.literal('updated'), item: ExperimentRecord, event: z.null() }).strict(),
  z.object({ kind: z.literal('transitioned'), item: ExperimentRecord, event: ExperimentEventRecord.nullable() }).strict(),
]);
export type ExperimentCommandResult = z.infer<typeof ExperimentCommandResult>;

const iso = z.iso.datetime({ offset: true });
export const ExperimentHttpRecord = ExperimentRecord.extend({
  startAt: iso, endAt: iso.nullable(), createdAt: iso, updatedAt: iso, statusChangedAt: iso,
});
export const ExperimentHttpEvent = ExperimentEventRecord.extend({ createdAt: iso });
/** Additive event/null preserves the existing item response and JSON timestamps. */
export const ExperimentMutationResponse = z.object({
  item: ExperimentHttpRecord, event: ExperimentHttpEvent.nullable(),
}).strict();
export type ExperimentMutationResponse = z.infer<typeof ExperimentMutationResponse>;
