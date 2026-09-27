/**
 * Creator Connections: the JSON the local control runner reads and writes.
 *
 * The runner is `tools/creator-connections-control/creator_control.py` in the
 * sibling `amazon-agent` repository. It is reference code, not a dependency:
 * these schemas mirror the shapes its functions emit so an import can refuse a
 * file that drifted instead of guessing. Each schema names the function it
 * mirrors. Keys stay snake_case because they describe the runner's files.
 *
 * Every object is strict. The registry holds opaque HMAC fingerprints only; a
 * record that carries any other key (a raw email, an address, a display name)
 * fails validation and is counted and skipped rather than stored.
 *
 * Creator Connections has no Amazon API. Nothing here is an Amazon write, and
 * nothing here is Sponsored Products (`sp_write_*`) or a Creative (`08 ·
 * Creatives` means video assets, not creators).
 */
import { z } from 'zod';

/** `issue_record_id`: `CCR-{BRAND_CODE}-{YY}-{NNNN}`, immutable once issued. */
export const CreatorRecordId = z.string().regex(/^CCR-[A-Z0-9]+-\d{2}-\d{4,}$/, 'expected CCR-{BRAND}-{YY}-{NNNN}');
export type CreatorRecordId = z.infer<typeof CreatorRecordId>;
/** `fingerprint`: hex HMAC-SHA256, or the empty string when the value was absent. */
export const CreatorFingerprint = z.string().regex(/^[0-9a-f]{64}$/, 'expected a 64-character hex fingerprint');
export type CreatorFingerprint = z.infer<typeof CreatorFingerprint>;
const RunnerFingerprint = z.union([z.literal(''), CreatorFingerprint]);
export const CreatorAsin = z.string().regex(/^[A-Z0-9]{10}$/, 'expected a 10-character upper-case ASIN');
export type CreatorAsin = z.infer<typeof CreatorAsin>;
/** `reserve_mcf` issues `MCFR-` plus 16 hex; `active_reservation_id` issues `MCFR-LEGACY-` plus 12. */
export const CreatorReservationId = z.string().regex(/^MCFR-(?:[0-9A-Fa-f]{16}|LEGACY-[0-9A-F]{12})$/, 'expected an MCFR reservation id');
export type CreatorReservationId = z.infer<typeof CreatorReservationId>;
/** Python `datetime.now(timezone.utc).isoformat()`, microseconds optional. */
const RunnerTimestamp = z.iso.datetime({ offset: true });
const RunnerDate = z.iso.date();
const ReasonCode = z.string().regex(/^[a-z0-9_]+$/, 'expected a snake_case reason code').max(120);
const Reference = z.string().trim().min(1).max(500);
const Sku = z.string().trim().min(1).max(50);
const CampaignId = z.string().trim().min(1).max(200);
const Title = z.string().trim().min(1).max(500);

/** `score_record`: the ten checks, one point each. Only exactly 10/10 may be sampled. */
export const CreatorQualificationCheck = z.enum([
  'complete_fulfillment_details', 'requested_asin', 'exact_product_match', 'storefront_visible',
  'recent_post_verified', 'content_quality', 'category_fit', 'performance_or_revenue',
  'specific_asin_mentioned', 'low_spam_risk',
]);
export type CreatorQualificationCheck = z.infer<typeof CreatorQualificationCheck>;
const Missing = z.array(CreatorQualificationCheck).max(10)
  .refine((items) => new Set(items).size === items.length, 'a missing check repeats');

/** `score_record` output: `score` passed checks, `missing` the rest, in check order. */
export const CreatorRunnerScoreResult = z.object({
  score: z.number().int().min(0).max(10),
  checks: z.object(Object.fromEntries(CreatorQualificationCheck.options.map((check) => [check, z.boolean()])) as
    Record<CreatorQualificationCheck, z.ZodBoolean>).strict(),
  missing: Missing,
}).strict().refine((value) => value.score + value.missing.length === 10
  && value.missing.every((check) => value.checks[check] === false)
  && Object.values(value.checks).filter(Boolean).length === value.score, 'score, checks and missing disagree');
export type CreatorRunnerScoreResult = z.infer<typeof CreatorRunnerScoreResult>;

/** `lock_conflicting_records`, `reserve_mcf`, `confirm_mcf` and `cancel_mcf` write these three. */
export const CreatorLockState = z.enum(['Unlocked', 'Conflict', 'Locked for MCF']);
export type CreatorLockState = z.infer<typeof CreatorLockState>;
/** `reserve_mcf` → Reserved; `verify_mcf` → Verified for Submit; `cancel_mcf` (uncertain) → Reconciliation Required. */
export const CreatorReservationState = z.enum(['Reserved', 'Verified for Submit', 'Reconciliation Required']);
export type CreatorReservationState = z.infer<typeof CreatorReservationState>;
/** `DEFINITIVE_MCF_CANCELLATION_REASONS`: the only codes that release a reservation. */
export const CreatorCancellationReason = z.enum([
  'amazon_rejected', 'definitive_not_created', 'expired_before_submit',
  'inventory_unavailable_before_submit', 'operator_aborted_before_submit', 'validation_failed_before_submit',
]);
export type CreatorCancellationReason = z.infer<typeof CreatorCancellationReason>;
/** `UNCERTAIN_MCF_CANCELLATION_REASONS`: an order may exist, so the lock stays. */
export const CreatorReconciliationReason = z.enum(['confirmation_missing', 'outcome_unknown', 'request_timeout']);
export type CreatorReconciliationReason = z.infer<typeof CreatorReconciliationReason>;

/**
 * `reserve_mcf` manifest, extended in place by `verify_mcf` and by an uncertain
 * `cancel_mcf`. A reservation written before ids existed carries only what it
 * had; `list_mcf_reservations` names it `MCFR-LEGACY-*`.
 */
export const CreatorRunnerReservation = z.object({
  reservation_id: CreatorReservationId.optional(),
  state: CreatorReservationState.optional(),
  creator_record_id: CreatorRecordId.optional(),
  campaign_id: CampaignId.optional(),
  tracker_source_ref: Reference.optional(),
  asin: CreatorAsin,
  sku: Sku.optional(),
  product_title: Title.optional(),
  quantity: z.literal(1).optional(),
  recipient_binding: CreatorFingerprint.optional(),
  visible_fee_cents: z.number().int().nonnegative().optional(),
  approved_fee_cap_cents: z.number().int().nonnegative().optional(),
  thread_evidence_reference: Reference.optional(),
  preflight_evidence_reference: Reference.optional(),
  inventory_evidence_reference: Reference.optional(),
  reserved_at: RunnerTimestamp.optional(),
  verified_at: RunnerTimestamp.optional(),
  verification_evidence_reference: Reference.optional(),
  verified_product_title: Title.optional(),
  verification_failure_codes: z.array(ReasonCode).optional(),
  reconciliation_reason: CreatorReconciliationReason.optional(),
  reconciliation_evidence_reference: Reference.optional(),
}).strict();
export type CreatorRunnerReservation = z.infer<typeof CreatorRunnerReservation>;

/** `confirm_mcf` appends the first shape; `reconcile_mcf` appends the evidence-bound second. */
export const CreatorRunnerSampleHistoryEntry = z.object({
  reservation_id: CreatorReservationId,
  campaign_id: CampaignId.nullable().optional(),
  tracker_source_ref: Reference.nullable().optional(),
  asin: CreatorAsin,
  sku: Sku,
  quantity: z.literal(1),
  order_id: z.string().trim().min(1).max(100),
  status: z.literal('Confirmed'),
  evidence_reference: Reference,
  confirmed_at: RunnerTimestamp,
  creator_record_id: CreatorRecordId.optional(),
  product_title: Title.optional(),
  recipient_binding: CreatorFingerprint.optional(),
  reconciliation_evidence_fp: CreatorFingerprint.optional(),
}).strict();
export type CreatorRunnerSampleHistoryEntry = z.infer<typeof CreatorRunnerSampleHistoryEntry>;

/** `cancel_mcf` appends one entry per definitively released reservation. */
export const CreatorRunnerReservationHistoryEntry = z.object({
  reservation_id: CreatorReservationId,
  campaign_id: CampaignId.nullable().optional(),
  tracker_source_ref: Reference.nullable().optional(),
  asin: CreatorAsin,
  sku: Sku.nullable().optional(),
  quantity: z.literal(1).nullable().optional(),
  status: z.literal('Cancelled'),
  reason_code: CreatorCancellationReason,
  evidence_reference: Reference,
  cancelled_at: RunnerTimestamp,
}).strict();
export type CreatorRunnerReservationHistoryEntry = z.infer<typeof CreatorRunnerReservationHistoryEntry>;

/**
 * One `Creator Registry` row as `issue_record_id` creates it and the other
 * commands mutate it. Fingerprints are the empty string when absent.
 */
export const CreatorRunnerRegistryRecord = z.object({
  creator_record_id: CreatorRecordId,
  brand: z.string().trim().max(200),
  campaign_id: z.string().trim().max(200),
  thread_key: RunnerFingerprint,
  storefront_key: RunnerFingerprint,
  full_name_fp: RunnerFingerprint,
  email_fp: RunnerFingerprint,
  phone_fp: RunnerFingerprint,
  address_fp: RunnerFingerprint,
  record_state: z.string().trim().min(1).max(40).default('Active'),
  lock_state: CreatorLockState,
  escalation_reason: ReasonCode.optional(),
  version: z.number().int().positive(),
  created_at: RunnerDate,
  last_verified_at: RunnerDate.optional(),
  mcf_reservation: CreatorRunnerReservation.optional(),
  sample_history: z.array(CreatorRunnerSampleHistoryEntry).optional(),
  mcf_reservation_history: z.array(CreatorRunnerReservationHistoryEntry).optional(),
}).strict().superRefine((record, context) => {
  // `reserve_mcf` locks with a reservation; `lock_conflicting_records` may later
  // move that record to Conflict without removing it. Unlocked never holds one.
  if (record.lock_state === 'Locked for MCF' && record.mcf_reservation === undefined) {
    context.addIssue({ code: 'custom', path: ['mcf_reservation'], message: 'a record Locked for MCF holds its reservation' });
  }
  if (record.lock_state === 'Unlocked' && record.mcf_reservation !== undefined) {
    context.addIssue({ code: 'custom', path: ['mcf_reservation'], message: 'an unlocked record holds no reservation' });
  }
  const reserved = record.mcf_reservation?.creator_record_id;
  if (reserved !== undefined && reserved !== record.creator_record_id) {
    context.addIssue({ code: 'custom', path: ['mcf_reservation', 'creator_record_id'], message: 'the reservation names another record' });
  }
});
export type CreatorRunnerRegistryRecord = z.infer<typeof CreatorRunnerRegistryRecord>;

/**
 * `new_registry` / `load_registry` envelope. Records stay `unknown` here so one
 * bad record is counted and skipped without refusing the rest of the file.
 */
export const CreatorRunnerRegistry = z.object({
  schema_version: z.literal(1),
  sequence_by_brand: z.record(z.string().regex(/^[A-Z0-9]+-\d{2}$/), z.number().int().nonnegative()).default({}),
  records: z.array(z.unknown()),
}).strict();
export type CreatorRunnerRegistry = z.infer<typeof CreatorRunnerRegistry>;

/** Every `action_type` `queue_item` can emit. */
export const CreatorQueueAction = z.enum([
  'IDENTITY_RESOLUTION', 'BACKGROUND_CHECK', 'SEND_TAILORED_VERIFICATION_FOLLOW_UP', 'ESCALATE_UNRESPONSIVE',
  'RECONCILE_QUALIFICATION', 'MCF_PREFLIGHT', 'RECONCILE_PRODUCT_SWITCH', 'ESCALATE_PRODUCT_SWITCH_UNRESPONSIVE',
  'SEND_PRODUCT_SWITCH_FOLLOW_UP', 'ESCALATE_CONTENT_UNRESPONSIVE', 'SEND_CONTENT_FOLLOW_UP',
]);
export type CreatorQueueAction = z.infer<typeof CreatorQueueAction>;
/** A queue item never grants send authority: PENDING_APPROVAL is the best a message can be. */
export const CreatorGateResult = z.enum(['BLOCKED', 'HOLD', 'PENDING_APPROVAL']);
export type CreatorGateResult = z.infer<typeof CreatorGateResult>;
/** The two closed `queue_state` values. */
export const CreatorQueueState = z.enum(['Queued', 'Escalated']);
export type CreatorQueueState = z.infer<typeof CreatorQueueState>;

/** One `queue_item` result. `creator_record_id` is `UNRESOLVED` for an unregistered thread. */
export const CreatorRunnerQueueItem = z.object({
  queue_id: z.string().regex(/^\d{8}-(?:CCR-[A-Z0-9]+-\d{2}-\d{4,}|UNRESOLVED)$/),
  run_date: RunnerDate,
  creator_record_id: z.union([CreatorRecordId, z.literal('UNRESOLVED')]),
  brand: z.string().trim().max(200),
  campaign_tab: z.string().trim().max(200),
  current_status: z.string().trim().max(120),
  computed_score: z.number().int().min(0).max(10),
  missing: Missing,
  due_date: RunnerDate,
  action_type: CreatorQueueAction,
  gate_result: CreatorGateResult,
  queue_state: CreatorQueueState,
  reason: z.string().trim().min(1).max(500),
}).strict().superRefine((item, context) => {
  if (item.computed_score + item.missing.length !== 10) context.addIssue({ code: 'custom', path: ['missing'], message: 'score and missing checks disagree' });
  if (item.queue_id !== `${item.run_date.replaceAll('-', '')}-${item.creator_record_id}`) {
    context.addIssue({ code: 'custom', path: ['queue_id'], message: 'queue_id is not {run_date}-{creator_record_id}' });
  }
  if ((item.creator_record_id === 'UNRESOLVED') !== (item.action_type === 'IDENTITY_RESOLUTION' && item.reason === 'missing_creator_record_id')) {
    context.addIssue({ code: 'custom', path: ['creator_record_id'], message: 'only identity resolution is unresolved' });
  }
});
export type CreatorRunnerQueueItem = z.infer<typeof CreatorRunnerQueueItem>;

/** `main()` for `queue`: the whole written output file. Counts are checked against the raw items. */
export const CreatorRunnerQueueResult = z.object({
  run_date: RunnerDate,
  items: z.array(z.unknown()),
  counts: z.object({ queued: z.number().int().nonnegative(), escalated: z.number().int().nonnegative() }).strict(),
}).strict().refine((result) => result.counts.queued + result.counts.escalated === result.items.length,
  'queued plus escalated does not equal the item count');
export type CreatorRunnerQueueResult = z.infer<typeof CreatorRunnerQueueResult>;

/** `list_mcf_reservations`: active locks without contact data. */
export const CreatorRunnerActiveReservation = z.object({
  creator_record_id: CreatorRecordId,
  reservation_id: CreatorReservationId,
  state: z.union([CreatorReservationState, z.literal('Legacy Reserved')]),
  campaign_id: z.string().trim().max(200).nullable(),
  asin: CreatorAsin,
  sku: z.string().trim().max(50),
  product_title: z.string().trim().max(500),
  quantity: z.literal(1),
  reserved_at: z.union([z.literal(''), RunnerTimestamp]),
}).strict();
export type CreatorRunnerActiveReservation = z.infer<typeof CreatorRunnerActiveReservation>;
export const CreatorRunnerReservationList = z.object({
  result: z.literal('PASS'),
  active_reservations: z.array(z.unknown()),
  count: z.number().int().nonnegative(),
}).strict().refine((list) => list.count === list.active_reservations.length, 'count does not equal the listed reservations');
export type CreatorRunnerReservationList = z.infer<typeof CreatorRunnerReservationList>;

/**
 * The nine counts a sweep reports (skill `amazon-creator-connections`,
 * SKILL.md §9). The runner has no sweep command; the skill's per-client
 * message-watermark checkpoint carries these.
 */
export const CreatorSweepCounts = z.object({
  mounted: z.number().int().nonnegative(),
  opened: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
  messages_examined: z.number().int().nonnegative(),
  messages_sent: z.number().int().nonnegative(),
  no_action_acknowledgements: z.number().int().nonnegative(),
  held_or_escalated: z.number().int().nonnegative(),
  archived_spam: z.number().int().nonnegative(),
  unmatched: z.number().int().nonnegative(),
}).strict().refine((counts) => counts.archived_spam <= counts.changed, {
  path: ['archived_spam'], message: 'archived spam is a subset of the changed threads',
});
export type CreatorSweepCounts = z.infer<typeof CreatorSweepCounts>;

/** Per-thread classification after the newest message was read. */
export const CreatorThreadOutcome = z.enum(['unchanged', 'actioned', 'held', 'escalated', 'unmatched', 'unopened', 'unclassified']);
export type CreatorThreadOutcome = z.infer<typeof CreatorThreadOutcome>;

/** One thread's checkpoint: the newest-message signature, hashed, never the message. */
export const CreatorSweepThread = z.object({
  thread_key: CreatorFingerprint,
  creator_record_id: CreatorRecordId.nullable(),
  sender_role: z.enum(['creator', 'brand', 'amazon']),
  amazon_timestamp: RunnerTimestamp.nullable(),
  body_hash: CreatorFingerprint,
  outcome: CreatorThreadOutcome,
  reason: ReasonCode.nullable(),
}).strict().superRefine((thread, context) => {
  if (thread.outcome === 'unmatched' && thread.creator_record_id !== null) {
    context.addIssue({ code: 'custom', path: ['creator_record_id'], message: 'an unmatched thread has no record' });
  }
});
export type CreatorSweepThread = z.infer<typeof CreatorSweepThread>;

/**
 * PROPOSED contract, not yet produced by anything. SKILL.md §9 names the
 * per-thread signature and the nine counts but defines no run file; its
 * configured `<client>-message-watermarks.json` has no published shape. A skill
 * change in `amazon-agent` must write this file (`sweep-checkpoint.json` in the
 * import directory) before a sweep can be imported. Until then the import counts
 * the sweep as not produced and the sweep screen shows it as not measured.
 */
export const CreatorSweepCheckpoint = z.object({
  schema_version: z.literal(1),
  run_id: z.string().regex(/^[A-Za-z0-9:_.-]{1,80}$/),
  run_date: RunnerDate,
  brand: z.string().trim().max(200).nullable(),
  started_at: RunnerTimestamp.nullable(),
  completed_at: RunnerTimestamp,
  evidence_reference: Reference.nullable(),
  counts: CreatorSweepCounts,
  threads: z.array(z.unknown()),
}).strict();
export type CreatorSweepCheckpoint = z.infer<typeof CreatorSweepCheckpoint>;
