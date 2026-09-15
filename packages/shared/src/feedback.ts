/** Feedback domain contracts. Agency identity comes from the verified actor. */
import { z } from 'zod';
import { Uuid } from './primitives.js';

export const FeedbackType = z.enum(['bug', 'feature']);
export type FeedbackType = z.infer<typeof FeedbackType>;
export const FEEDBACK_TYPES = FeedbackType.options;
export const FeedbackSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type FeedbackSeverity = z.infer<typeof FeedbackSeverity>;
export const FEEDBACK_SEVERITIES = FeedbackSeverity.options;
export const FeedbackStatus = z.enum(['new', 'triaged', 'planned', 'in_progress', 'shipped', 'declined']);
export type FeedbackStatus = z.infer<typeof FeedbackStatus>;
export const FEEDBACK_STATUSES = FeedbackStatus.options;

export const FeedbackTitle = z.string().trim().transform((value) => value.replace(/\s+/g, ' '))
  .pipe(z.string().min(1, 'A feedback title cannot be empty').max(200, 'A feedback title cannot exceed 200 characters'));
export const FeedbackBody = z.string().trim().max(20_000, 'A feedback description cannot exceed 20000 characters');

export const FeedbackRoute = z.string().trim().transform((value) => {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')
    || [...value].some((character) => character.charCodeAt(0) < 32)) return null;
  return value.slice(0, 512);
}).nullable();
export const FeedbackAppVersion = z.string().trim().transform((value) => value ? value.slice(0, 64) : null).nullable();

/** Normalized optional provenance. A UUID still requires an agency-bound lookup. */
export const FeedbackSubmissionContext = z.object({
  route: FeedbackRoute,
  profileId: Uuid.nullable(),
  appVersion: FeedbackAppVersion,
}).strict();
export type FeedbackSubmissionContext = z.infer<typeof FeedbackSubmissionContext>;

export const FeedbackCommand = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'), type: FeedbackType, title: FeedbackTitle,
    body: FeedbackBody.optional(), severity: FeedbackSeverity.nullable().optional(),
    pageContext: FeedbackSubmissionContext.optional(),
  }).strict().refine((value) => value.type === 'bug' || value.severity == null, {
    message: 'Only a bug report carries a severity', path: ['severity'],
  }),
  z.object({
    kind: z.literal('edit'), itemId: Uuid, title: FeedbackTitle.optional(),
    body: FeedbackBody.optional(), severity: FeedbackSeverity.nullable().optional(),
  }).strict().refine((value) => value.title !== undefined || value.body !== undefined || value.severity !== undefined, {
    message: 'An edit must change the title, the description or the severity',
  }),
  z.object({
    kind: z.literal('triage'), itemId: Uuid, status: FeedbackStatus.optional(),
    adminNote: z.string().trim().nullable().optional(),
  }).strict().refine((value) => value.status !== undefined || value.adminNote !== undefined, {
    message: 'A triage update must change the status or the note',
  }),
  z.object({ kind: z.literal('duplicate'), itemId: Uuid, duplicateOf: Uuid }).strict(),
  z.object({ kind: z.literal('toggleVote'), itemId: Uuid }).strict(),
]);
export type FeedbackCommand = z.infer<typeof FeedbackCommand>;

/** Existing database read model, retaining Date fields until HTTP serialization. */
export const FeedbackItemRecord = z.object({
  id: Uuid, orgId: Uuid, authorId: Uuid.nullable(), type: FeedbackType,
  title: z.string(), body: z.string(), severity: FeedbackSeverity.nullable(), status: FeedbackStatus,
  adminNote: z.string().nullable(), duplicateOf: Uuid.nullable(), dedupCheckedAt: z.date().nullable(),
  pageContext: z.json(), votes: z.number().int().nonnegative(), viewerHasVoted: z.boolean(),
  createdAt: z.date(), updatedAt: z.date(), statusChangedAt: z.date(),
}).strict();
export type FeedbackItemRecord = z.infer<typeof FeedbackItemRecord>;

/** A committed readback, not a durable replay receipt or permanently fresh count. */
export const FeedbackCommandResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('created'), item: FeedbackItemRecord }).strict(),
  z.object({ kind: z.literal('updated'), item: FeedbackItemRecord }).strict(),
  z.object({ kind: z.literal('vote'), itemId: Uuid, voted: z.boolean(), votes: z.number().int().nonnegative() }).strict(),
]);
export type FeedbackCommandResult = z.infer<typeof FeedbackCommandResult>;
