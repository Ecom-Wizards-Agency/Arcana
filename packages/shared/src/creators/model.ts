/**
 * Creator Connections in Arcana: the rows the import stores and the screens read.
 *
 * Values arrive from the control runner's files (`./runner.ts`), and later from
 * a `creator:write` MCP key or the web. Creator and campaign status written here
 * is not an Amazon write. The sample order is, and it is not created here.
 *
 * Absence stays absent: a record the queue has not scored has no qualification,
 * a shipment Amazon has not been asked about has no MCF status, and a file the
 * import did not find has no counts. None of these is a zero.
 */
import { z } from 'zod';
import { FulfillmentOrderStatus } from '../spapi-fulfillment.js';
import {
  CreatorAsin, CreatorCancellationReason, CreatorFingerprint, CreatorGateResult, CreatorLockState,
  CreatorQualificationCheck, CreatorQueueAction, CreatorQueueState, CreatorReconciliationReason,
  CreatorRecordId, CreatorReservationId, CreatorThreadOutcome,
} from './runner.js';

const Timestamp = z.iso.datetime({ offset: true });
const Count = z.number().int().nonnegative();
const Code = z.string().regex(/^[a-z0-9_]+$/).max(120);

/** Who wrote the row: the runner import this round; the MCP key class and the web later. */
export const CreatorSource = z.enum(['control-runner', 'mcp', 'web']);
export type CreatorSource = z.infer<typeof CreatorSource>;
/**
 * Who wrote an action-log entry: a `CreatorSource`, or the Arcana MCF worker
 * recording what happened to a send it placed. Only the action log takes it, so
 * a lane, an import or a pre-flight cannot claim a worker source.
 */
export const CreatorActionSource = z.enum([...CreatorSource.options, 'worker']);
export type CreatorActionSource = z.infer<typeof CreatorActionSource>;

/** The computed 10-point gate. `checks` and `missing` are two views of one result. */
export const CreatorQualification = z.object({
  score: z.number().int().min(0).max(10),
  checks: z.object(Object.fromEntries(CreatorQualificationCheck.options.map((check) => [check, z.boolean()])) as
    Record<CreatorQualificationCheck, z.ZodBoolean>).strict(),
  missing: z.array(CreatorQualificationCheck),
}).strict().refine((value) => value.score + value.missing.length === 10
  && CreatorQualificationCheck.options.every((check) => value.checks[check] === !value.missing.includes(check)),
'score, checks and missing disagree');
export type CreatorQualification = z.infer<typeof CreatorQualification>;

/** Opaque HMAC fingerprints; null where the runner recorded none. Never raw contact data. */
export const CreatorFingerprints = z.object({
  storefront: CreatorFingerprint.nullable(), thread: CreatorFingerprint.nullable(), fullName: CreatorFingerprint.nullable(),
  email: CreatorFingerprint.nullable(), phone: CreatorFingerprint.nullable(), address: CreatorFingerprint.nullable(),
}).strict();
export type CreatorFingerprints = z.infer<typeof CreatorFingerprints>;

/** One Creator Registry row keyed by the runner's immutable Creator Record ID. */
export const CreatorRecord = z.object({
  creatorRecordId: CreatorRecordId,
  brand: z.string(),
  campaignId: z.string(),
  fingerprints: CreatorFingerprints,
  recordState: z.string().min(1),
  lockState: CreatorLockState,
  escalationReason: Code.nullable(),
  runnerVersion: z.number().int().positive(),
  createdOn: z.iso.date(),
  lastVerifiedOn: z.iso.date().nullable(),
  /** The tracker status the latest queue run saw; null until a queue run names the record. */
  status: z.string().nullable(),
  qualification: CreatorQualification.nullable(),
  qualifiedOn: z.iso.date().nullable(),
  source: CreatorSource,
  importedAt: Timestamp,
}).strict();
export type CreatorRecord = z.infer<typeof CreatorRecord>;

/**
 * Append-only events. The import derives the first six from registry history,
 * never from a clock. The next ones arrive from a `creator:write` key (identity,
 * score and the skill's own entries) or from the drafts screen. The `mcf_send_*`
 * kinds are written by the database for a send Arcana placed; no MCP tool may
 * append them (`CreatorAppendableAction` leaves them out).
 */
export const CreatorActionKind = z.enum([
  'identity_conflict_locked', 'mcf_reserved', 'mcf_screen_verified', 'mcf_reconciliation_required',
  'sample_confirmed', 'mcf_reservation_cancelled',
  'identity_resolved', 'score_recorded',
  'message_sent_by_hand', 'status_moved', 'content_verified', 'escalated', 'preflight_recorded',
  'draft_submitted', 'draft_approved', 'draft_sent_by_hand', 'draft_withdrawn',
  'mcf_send_approved', 'mcf_send_placed', 'mcf_send_failed', 'mcf_send_uncertain', 'mcf_send_cancelled',
]);
export type CreatorActionKind = z.infer<typeof CreatorActionKind>;
export const CreatorActionLogEntry = z.object({
  eventKey: z.string().min(1).max(200),
  creatorRecordId: CreatorRecordId,
  action: CreatorActionKind,
  /** When the runner recorded it happening; null when the runner kept no time. */
  occurredAt: Timestamp.nullable(),
  reservationId: CreatorReservationId.nullable(),
  asin: CreatorAsin.nullable(),
  reasonCode: Code.nullable(),
  evidenceReference: z.string().nullable(),
  recordVersion: z.number().int().positive().nullable(),
  source: CreatorActionSource,
  recordedAt: Timestamp,
}).strict();
export type CreatorActionLogEntry = z.infer<typeof CreatorActionLogEntry>;

/** One Daily Action Queue row. `creatorRecordId` is null for an unresolved thread. */
export const CreatorDailyQueueItem = z.object({
  runDate: z.iso.date(),
  queueId: z.string().min(1),
  occurrence: z.number().int().positive(),
  creatorRecordId: CreatorRecordId.nullable(),
  brand: z.string(),
  campaignTab: z.string(),
  currentStatus: z.string(),
  computedScore: z.number().int().min(0).max(10),
  missing: z.array(CreatorQualificationCheck),
  dueDate: z.iso.date(),
  actionType: CreatorQueueAction,
  gateResult: CreatorGateResult,
  queueState: CreatorQueueState,
  reason: z.string().min(1),
  /** The registry lock on the record; null when the record is unresolved or not in the registry. */
  lockState: CreatorLockState.nullable(),
  source: CreatorSource,
}).strict().refine((item) => item.computedScore + item.missing.length === 10, 'score and missing checks disagree');
export type CreatorDailyQueueItem = z.infer<typeof CreatorDailyQueueItem>;

/** The nine sweep counts, camel-cased. */
export const CreatorSweepTally = z.object({
  mounted: Count, opened: Count, changed: Count, messagesExamined: Count, messagesSent: Count,
  noActionAcknowledgements: Count, heldOrEscalated: Count, archivedSpam: Count, unmatched: Count,
}).strict();
export type CreatorSweepTally = z.infer<typeof CreatorSweepTally>;
export const CreatorUnmatchedThread = z.object({
  threadKey: CreatorFingerprint, amazonTimestamp: Timestamp.nullable(), outcome: CreatorThreadOutcome, reason: Code.nullable(),
}).strict();
export type CreatorUnmatchedThread = z.infer<typeof CreatorUnmatchedThread>;
/**
 * One inbox sweep. `reconciled` is computed by the database: enumerated
 * (mounted) = no-action + changed + held/escalated + unmatched, and zero
 * unmatched. Opened is not part of it: an archived thread whose newest message
 * is unchanged may be skipped.
 */
export const CreatorSweepRun = z.object({
  runId: z.string().min(1),
  runDate: z.iso.date(),
  brand: z.string().nullable(),
  startedAt: Timestamp.nullable(),
  completedAt: Timestamp,
  counts: CreatorSweepTally,
  reconciled: z.boolean(),
  /** Threads in the checkpoint, by outcome. Null when the checkpoint listed no threads. */
  outcomes: z.record(CreatorThreadOutcome, Count).nullable(),
  /** Threads that did not resolve to one record, or were not opened or classified. */
  unresolved: z.array(CreatorUnmatchedThread),
  evidenceReference: z.string().nullable(),
  source: CreatorSource,
  importedAt: Timestamp,
}).strict();
export type CreatorSweepRun = z.infer<typeof CreatorSweepRun>;

/** `CCS-` plus 32 hex of SHA-256 over organisation, record and ASIN. No clock, 36 characters. */
export const CreatorSampleOrderKey = z.string().regex(/^CCS-[0-9a-f]{32}$/);
export type CreatorSampleOrderKey = z.infer<typeof CreatorSampleOrderKey>;
export const CreatorSampleLaneState = z.enum(['Reserved', 'Verified for Submit', 'Reconciliation Required', 'Confirmed', 'Cancelled']);
export type CreatorSampleLaneState = z.infer<typeof CreatorSampleLaneState>;
/**
 * Why a lane was released: the runner's six definitive reasons, plus two only an
 * order Arcana placed can reach: Amazon cancelled it after the create was
 * accepted, or the operator cancelled it in Amazon. The runner-file parse keeps
 * `CreatorCancellationReason` at six, so a runner file carrying either is refused.
 */
export const CreatorLaneCancellationReason = z.enum([
  ...CreatorCancellationReason.options, 'amazon_cancelled_after_submit', 'operator_cancelled_in_amazon',
]);
export type CreatorLaneCancellationReason = z.infer<typeof CreatorLaneCancellationReason>;
/** Who places the lane's order: the runner through Seller Central, or Arcana through SP-API. */
export const CreatorSampleOrderOwner = z.enum(['runner', 'arcana']);
export type CreatorSampleOrderOwner = z.infer<typeof CreatorSampleOrderOwner>;
/** What Amazon said about the order, with the operation and read time that said it. */
export const CreatorMcfObservation = z.object({
  status: FulfillmentOrderStatus, operation: z.literal('getFulfillmentOrder'), readAt: Timestamp,
}).strict();
export type CreatorMcfObservation = z.infer<typeof CreatorMcfObservation>;
/** One `shipments[].packages[]` entry. A null carrier status means the carrier has not scanned it. */
export const CreatorSamplePackage = z.object({
  packageNumber: z.number().int().nonnegative(),
  carrierCode: z.string().min(1).nullable(),
  trackingNumber: z.string().min(1).nullable(),
  estimatedArrivalAt: Timestamp.nullable(),
  carrierStatus: z.string().min(1).nullable(),
  carrierStatusReadAt: Timestamp.nullable(),
}).strict();
export type CreatorSamplePackage = z.infer<typeof CreatorSamplePackage>;
/** One sample lane: one creator record and one ASIN, ever. */
export const CreatorSampleShipment = z.object({
  creatorRecordId: CreatorRecordId,
  asin: CreatorAsin,
  derivedOrderKey: CreatorSampleOrderKey,
  sku: z.string().nullable(),
  campaignId: z.string().nullable(),
  reservationId: CreatorReservationId.nullable(),
  laneState: CreatorSampleLaneState,
  /** A lane read before the owner existed was the runner's. */
  orderOwner: CreatorSampleOrderOwner.default('runner'),
  /** The order id `confirm-mcf` or `reconcile-mcf` recorded; null until one did. */
  runnerOrderId: z.string().nullable(),
  feeCents: Count.nullable(),
  feeCapCents: Count.nullable(),
  reservedAt: Timestamp.nullable(),
  verifiedAt: Timestamp.nullable(),
  confirmedAt: Timestamp.nullable(),
  cancelledAt: Timestamp.nullable(),
  cancellationReason: CreatorLaneCancellationReason.nullable(),
  reconciliationReason: CreatorReconciliationReason.nullable(),
  mcf: CreatorMcfObservation.nullable(),
  /** Null until Amazon has been read; an empty list is Amazon saying there are none. */
  packages: z.array(CreatorSamplePackage).nullable(),
  source: CreatorSource,
  importedAt: Timestamp,
}).strict().refine((lane) => lane.orderOwner === 'arcana' || lane.cancellationReason === null
  || CreatorCancellationReason.safeParse(lane.cancellationReason).success, {
  path: ['cancellationReason'], message: 'only a lane Arcana placed can be cancelled after submit or in Amazon',
});
export type CreatorSampleShipment = z.infer<typeof CreatorSampleShipment>;

/** What one import wrote, per kind of row. */
export const CreatorImportKind = z.enum(['records', 'action_log', 'queue_items', 'sweep_runs', 'sample_shipments', 'preflights']);
export type CreatorImportKind = z.infer<typeof CreatorImportKind>;
/** The runner files the import reads from its directory. `preflight_results` is a proposed file (WP-334). */
export const CreatorImportFile = z.enum(['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations', 'preflight_results']);
export type CreatorImportFile = z.infer<typeof CreatorImportFile>;
/**
 * read = valid + invalid; valid = inserted + updated + unchanged + skipped.
 * `removed` is queue rows a newer run dropped. `skipped` is valid rows left
 * untouched on purpose; a run stored before it existed skipped none.
 */
export const CreatorImportCounts = z.object({
  read: Count, valid: Count, invalid: Count, inserted: Count, updated: Count, unchanged: Count, skipped: Count.default(0), removed: Count,
}).strict().refine((counts) => counts.read === counts.valid + counts.invalid
  && counts.valid === counts.inserted + counts.updated + counts.unchanged + counts.skipped, 'import counts do not reconcile');
export type CreatorImportCounts = z.infer<typeof CreatorImportCounts>;
export const CreatorImportFailure = z.enum([
  'directory_unreadable', 'no_runner_files', 'file_unreadable', 'file_shape_invalid', 'database_write_failed',
]);
export type CreatorImportFailure = z.infer<typeof CreatorImportFailure>;
export const CreatorImportRun = z.object({
  id: z.uuid(),
  startedAt: Timestamp,
  finishedAt: Timestamp,
  status: z.enum(['succeeded', 'failed']),
  failure: CreatorImportFailure.nullable(),
  failedFile: CreatorImportFile.nullable(),
  /** Files found in the directory. */
  files: z.array(CreatorImportFile),
  /** The run date of the queue file read; null when no queue file was read. */
  queueRunDate: z.iso.date().nullable(),
  /**
   * Null for a kind whose file was absent, and for every kind of a failed run.
   * A run recorded before `preflights` existed (WP-334) reads it as null: that
   * file was not read. Every other kind must be present.
   */
  counts: z.preprocess((value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !('preflights' in value)
    ? { ...value, preflights: null } : value,
  z.record(CreatorImportKind, CreatorImportCounts.nullable())),
  source: CreatorSource,
}).strict().refine((run) => (run.status === 'failed') === (run.failure !== null), 'a failure code belongs to a failed run only');
export type CreatorImportRun = z.infer<typeof CreatorImportRun>;

/** The score typed on the tracker, as `creators.record_score` last reported it. */
export const CreatorTrackerScore = z.object({
  creatorRecordId: CreatorRecordId, trackerScore: z.number().int().min(0).max(10), scoredOn: z.iso.date(),
}).strict();
export type CreatorTrackerScore = z.infer<typeof CreatorTrackerScore>;
/**
 * Registry records the newest queue run did not name, grouped by the tracker
 * status last reported for them. A null status was never reported: not
 * measured, not "no status". `recognised` is null with it.
 */
export const CreatorIdleGroup = z.object({
  status: z.string().nullable(), recognised: z.boolean().nullable(), records: Count,
}).strict().refine((group) => (group.status === null) === (group.recognised === null), 'only an unreported status has no recognition');
export type CreatorIdleGroup = z.infer<typeof CreatorIdleGroup>;

/** `/creators`: the latest queue run, the records it did not touch, and the last sweep. */
export const CreatorQueueSnapshot = z.object({
  lastImport: CreatorImportRun.nullable(),
  runDate: z.iso.date().nullable(),
  items: z.array(CreatorDailyQueueItem),
  registryRecords: Count,
  sweep: CreatorSweepRun.nullable(),
  /** Tracker scores for the records on this run; a record without one has none reported. */
  trackerScores: z.array(CreatorTrackerScore),
  /** Registry records not named by this run, by reported status. Empty when there is no run. */
  idle: z.array(CreatorIdleGroup),
}).strict();
export type CreatorQueueSnapshot = z.infer<typeof CreatorQueueSnapshot>;
/** `/creators/sweep`: the newest sweep and the one before it. */
export const CreatorSweepSnapshot = z.object({
  lastImport: CreatorImportRun.nullable(), latest: CreatorSweepRun.nullable(), previous: CreatorSweepRun.nullable(),
}).strict();
export type CreatorSweepSnapshot = z.infer<typeof CreatorSweepSnapshot>;
/** `/creators/samples`: every sample lane, newest activity first. */
export const CreatorSampleSnapshot = z.object({
  lastImport: CreatorImportRun.nullable(), shipments: z.array(CreatorSampleShipment),
}).strict();
export type CreatorSampleSnapshot = z.infer<typeof CreatorSampleSnapshot>;
