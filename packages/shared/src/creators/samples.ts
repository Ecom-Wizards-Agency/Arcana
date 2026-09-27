/**
 * Creator Connections round 3a (WP-334): the sample pre-flight, the product
 * switch pre-flight, and what a read-only Amazon observation found for a lane.
 *
 * Nothing here places, changes or cancels an Amazon order. A pre-flight is the
 * control runner's eight-check result, recorded; an observation is an SP-API
 * read (getFulfillmentOrder, listAllFulfillmentOrders, getPackageTrackingDetails)
 * with every recipient field dropped by the client before it arrives here.
 * Fingerprints only: no name, address, email, phone or link is accepted or kept.
 */
import { z } from 'zod';
import {
  FulfillmentOrderStatus, FulfillmentShipmentObservation,
} from '../spapi-fulfillment.js';
import { CreatorAsin, CreatorFingerprint, CreatorLockState, CreatorRecordId } from './runner.js';
import {
  CreatorDailyQueueItem, CreatorImportRun, CreatorSampleOrderKey, CreatorSamplePackage, CreatorSampleShipment, CreatorSource,
} from './model.js';

const Timestamp = z.iso.datetime({ offset: true });
const Code = z.string().regex(/^[a-z0-9_]+$/).max(120);
const Reference = z.string().trim().min(1).max(500);
const RunId = z.string().regex(/^[A-Za-z0-9:_.-]{1,80}$/, 'expected a run id of letters, digits and : _ . -');
const RunnerFingerprint = z.union([z.literal(''), CreatorFingerprint]);

// ---------------------------------------------------------------------------
// The eight checks (Figma 446:2), and which runner error belongs to which.
// ---------------------------------------------------------------------------

/** The eight pre-flight checks, in the order the frame numbers them. */
export const CreatorPreflightCheck = z.enum([
  'identity', 'qualification', 'agreement', 'recipient', 'no_prior_sample', 'quantity_shipping_fee', 'fulfillable_stock', 'form',
]);
export type CreatorPreflightCheck = z.infer<typeof CreatorPreflightCheck>;
export const CREATOR_PREFLIGHT_CHECK_LABELS: Record<CreatorPreflightCheck, string> = {
  identity: 'Identity resolves, exactly one active record',
  qualification: 'Approved for Sample, decision Send, ten of ten',
  agreement: 'Record, campaign, row, ASIN, SKU and product all agree',
  recipient: 'Recipient block complete and fingerprints match',
  no_prior_sample: 'No prior sample for this record and this ASIN',
  quantity_shipping_fee: 'One unit, Standard shipping, fee within the cap',
  fulfillable_stock: 'SKU is FBA and MCF-fulfillable with a unit to spare',
  form: 'No validation errors, mismatches or truncations',
};

const RECIPIENT_ERRORS = ['full_name_fp', 'email_fp', 'phone_fp', 'address_fp']
  .flatMap((key) => [`recipient_${key}_missing`, `recipient_${key}_mismatch`]);
const INVENTORY_ERRORS = [
  'selected_sku_not_fba_fulfilled', 'selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity',
  'mcf_inventory_check_missing', 'mcf_inventory_evidence_missing',
] as const;

/**
 * Every error code `mcf_preflight` (creator_control.py) can emit, by the check
 * it belongs to. A code outside this map is runner drift and is refused, never
 * filed under a guessed check.
 */
export const CREATOR_PREFLIGHT_ERROR_CHECK: Readonly<Record<string, CreatorPreflightCheck>> = Object.freeze({
  identity_not_resolved: 'identity', creator_record_id_missing: 'identity', creator_record_id_mismatch: 'identity',
  record_not_unlocked_for_preflight: 'identity',
  status_not_approved_for_sample: 'qualification', qualification_not_10_of_10: 'qualification', sample_decision_not_send: 'qualification',
  tracker_campaign_id_missing: 'agreement', campaign_id_mismatch: 'agreement', tracker_source_reference_missing: 'agreement',
  catalog_product_title_missing: 'agreement', catalog_campaign_id_missing: 'agreement', catalog_campaign_id_mismatch: 'agreement',
  asin_mismatch: 'agreement', catalog_asin_mismatch: 'agreement', sku_not_mapped_to_selected_asin: 'agreement',
  ...Object.fromEntries(RECIPIENT_ERRORS.map((code) => [code, 'recipient'])),
  recipient_binding_incomplete: 'recipient', incomplete_fulfillment_details: 'recipient',
  duplicate_sample_risk: 'no_prior_sample',
  quantity_invalid: 'quantity_shipping_fee', quantity_must_equal_1: 'quantity_shipping_fee', shipping_must_be_standard: 'quantity_shipping_fee',
  fee_missing_or_invalid: 'quantity_shipping_fee', fee_exceeds_approved_cap: 'quantity_shipping_fee',
  ...Object.fromEntries(INVENTORY_ERRORS.map((code) => [code, 'fulfillable_stock'])),
  page_validation_error: 'form', field_truncation_detected: 'form', thread_evidence_reference_missing: 'form',
  preflight_evidence_reference_missing: 'form',
} satisfies Record<string, CreatorPreflightCheck>);
export const CreatorPreflightError = z.enum(Object.keys(CREATOR_PREFLIGHT_ERROR_CHECK) as [string, ...string[]]);
export type CreatorPreflightError = z.infer<typeof CreatorPreflightError>;

/** Every error code `product_switch_preflight` can emit. */
export const CreatorSwitchPreflightError = z.enum([
  'identity_not_resolved', 'record_not_unlocked_for_product_switch', 'invalid_product_switch_phase', 'original_asin_mismatch',
  'alternate_asin_not_distinct', 'alternate_asin_not_in_campaign', 'original_mcf_blocker_not_verified',
  'original_mcf_blocker_evidence_missing', 'alternate_catalog_asin_mismatch', 'alternate_sku_not_mapped_to_asin',
  ...INVENTORY_ERRORS, 'creator_confirmation_asin_mismatch', 'creator_confirmation_evidence_missing',
]);
export type CreatorSwitchPreflightError = z.infer<typeof CreatorSwitchPreflightError>;

/**
 * pass: no error. fail: two sources disagree, or the lane already shipped; a
 * person has to look. hold: something is missing or not yet true (stock, a
 * reference, a status), so the record waits and nothing is ordered.
 */
export const CreatorPreflightOutcome = z.enum(['pass', 'hold', 'fail']);
export type CreatorPreflightOutcome = z.infer<typeof CreatorPreflightOutcome>;
const failing = (code: string) => code.endsWith('_mismatch') || code === 'duplicate_sample_risk' || code === 'identity_not_resolved';
export function creatorPreflightOutcome(reasons: readonly string[]): CreatorPreflightOutcome {
  return reasons.length === 0 ? 'pass' : reasons.some(failing) ? 'fail' : 'hold';
}

// ---------------------------------------------------------------------------
// Runner outputs, snake_case: they mirror creator_control.py.
// ---------------------------------------------------------------------------

const uniqueCodes = <T extends z.ZodType<string>>(code: T) => z.array(code).max(80)
  .refine((items) => new Set(items).size === items.length, 'an error code repeats');

/**
 * `mcf_preflight` output. `creator_record_id` and `selected_asin` must name a
 * lane: a pre-flight that resolved no record cannot be filed anywhere, and is
 * refused rather than stored against a guess. `recipient_binding` is the
 * runner's HMAC over the recipient block, never the block.
 */
export const CreatorRunnerPreflightResult = z.object({
  result: z.enum(['PASS', 'HOLD']),
  creator_record_id: CreatorRecordId,
  computed_score: z.number().int().min(0).max(10),
  errors: uniqueCodes(CreatorPreflightError),
  required_next_state: z.enum(['Locked for MCF', 'Conflict or Held']),
  /** The runner echoes the proposal's quantity raw after int() accepted it, so a digit string is its integer. */
  quantity: z.union([z.number().int(), z.string().regex(/^[1-9][0-9]{0,5}$/).transform(Number)]).nullable(),
  visible_fee_cents: z.number().int().nonnegative().nullable(),
  approved_fee_cap_cents: z.number().int().nullable(),
  selected_asin: CreatorAsin,
  selected_sku: z.string().trim().max(50),
  product_title: z.string().trim().max(500),
  campaign_id: z.string().trim().max(200),
  tracker_source_ref: z.string().trim().max(500),
  recipient_binding: RunnerFingerprint,
}).strict().superRefine((value, context) => {
  if ((value.result === 'PASS') !== (value.errors.length === 0)) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'PASS means no errors, and any error means HOLD' });
  }
  if ((value.result === 'PASS') !== (value.required_next_state === 'Locked for MCF')) {
    context.addIssue({ code: 'custom', path: ['required_next_state'], message: 'the next state disagrees with the result' });
  }
});
export type CreatorRunnerPreflightResult = z.infer<typeof CreatorRunnerPreflightResult>;

/** `product_switch_preflight` output, for one alternate ASIN. */
export const CreatorRunnerSwitchResult = z.object({
  result: z.enum(['PASS', 'HOLD']),
  phase: z.string().trim().max(40),
  creator_record_id: CreatorRecordId,
  errors: uniqueCodes(CreatorSwitchPreflightError),
  required_next_state: z.enum(['Conflict or Held', 'Product Switch Pending', 'Approved for Sample']),
  original_asin: CreatorAsin,
  alternate_asin: CreatorAsin,
  alternate_sku: z.string().trim().max(50),
}).strict().superRefine((value, context) => {
  if ((value.result === 'PASS') !== (value.errors.length === 0)) {
    context.addIssue({ code: 'custom', path: ['result'], message: 'PASS means no errors, and any error means HOLD' });
  }
  const expected = value.errors.length > 0 ? 'Conflict or Held' : value.phase === 'offer' ? 'Product Switch Pending' : 'Approved for Sample';
  if (value.required_next_state !== expected) {
    context.addIssue({ code: 'custom', path: ['required_next_state'], message: 'the next state disagrees with the result and phase' });
  }
});
export type CreatorRunnerSwitchResult = z.infer<typeof CreatorRunnerSwitchResult>;

/**
 * The `product_catalog[asin]` entry the runner checked stock against: the live
 * stock read. `fulfillable_quantity` is what Amazon can fulfil, not what the
 * listing can sell; null when it was not read.
 */
export const CreatorRunnerInventoryRead = z.object({
  asin: CreatorAsin,
  sku: z.string().trim().min(1).max(50).nullable(),
  fulfillment_channel: z.string().trim().min(1).max(40).nullable(),
  mcf_fulfillable: z.boolean().nullable(),
  fulfillable_quantity: z.number().int().nonnegative().nullable(),
  inventory_checked_at: Timestamp.nullable(),
  fulfillment_evidence_reference: Reference.nullable(),
}).strict();
export type CreatorRunnerInventoryRead = z.infer<typeof CreatorRunnerInventoryRead>;

/** The fulfillability preview as the skill read it (getFulfillmentPreview). */
export const CreatorRunnerPreviewRead = z.object({
  operation: z.literal('getFulfillmentPreview'),
  read_at: Timestamp,
  /** When the skill stops treating this preview as current; null leaves it to Arcana's validity window. */
  valid_until: Timestamp.nullable(),
  is_fulfillable: z.boolean(),
  fee_cents: z.number().int().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  /** `unfulfillablePreviewItems` reasons and feature constraints, as codes. */
  constraints: z.array(Code).max(20),
}).strict();
export type CreatorRunnerPreviewRead = z.infer<typeof CreatorRunnerPreviewRead>;

/** When one check read its value, and the evidence reference the read left. */
export const CreatorRunnerCheckRead = z.object({
  check: CreatorPreflightCheck, read_at: Timestamp, evidence_reference: Reference.nullable(),
}).strict();
export type CreatorRunnerCheckRead = z.infer<typeof CreatorRunnerCheckRead>;

const runEnvelope = { run_id: RunId, started_at: Timestamp, completed_at: Timestamp };
const inOrder = (value: { started_at: string; completed_at: string }, context: z.RefinementCtx) => {
  if (Date.parse(value.started_at) > Date.parse(value.completed_at)) {
    context.addIssue({ code: 'custom', path: ['completed_at'], message: 'the run ends before it starts' });
  }
};

/**
 * `creators.preflight_result`, and one entry of the import's
 * `preflight-results.json`: the runner's `preflight` or `preflight-switch`
 * result with the reads it was made from. Idempotent by `run_id`.
 */
export const CreatorPreflightResultInput = z.discriminatedUnion('command', [
  z.object({
    command: z.literal('preflight'), ...runEnvelope,
    result: CreatorRunnerPreflightResult,
    inventory: CreatorRunnerInventoryRead.nullable(),
    preview: CreatorRunnerPreviewRead.nullable(),
    reads: z.array(CreatorRunnerCheckRead).max(8),
  }).strict().superRefine((value, context) => {
    inOrder(value, context);
    if (new Set(value.reads.map((read) => read.check)).size !== value.reads.length) {
      context.addIssue({ code: 'custom', path: ['reads'], message: 'a check is read twice' });
    }
    if (value.inventory !== null && value.inventory.asin !== value.result.selected_asin) {
      context.addIssue({ code: 'custom', path: ['inventory', 'asin'], message: 'the stock read is for another ASIN' });
    }
  }),
  z.object({
    command: z.literal('preflight-switch'), ...runEnvelope,
    result: CreatorRunnerSwitchResult,
    /** The alternate's live stock read. */
    inventory: CreatorRunnerInventoryRead.nullable(),
    original_unavailable_reason: z.enum(['not_mcf_fulfillable', 'out_of_stock', 'not_found']).nullable(),
    original_blocker_evidence_reference: Reference.nullable(),
  }).strict().superRefine((value, context) => {
    inOrder(value, context);
    if (value.inventory !== null && value.inventory.asin !== value.result.alternate_asin) {
      context.addIssue({ code: 'custom', path: ['inventory', 'asin'], message: 'the stock read is for another ASIN' });
    }
  }),
]);
export type CreatorPreflightResultInput = z.infer<typeof CreatorPreflightResultInput>;

/**
 * PROPOSED file contract, not yet produced by the skill: `preflight-results.json`
 * in the import directory. Entries stay `unknown` so one bad entry is counted
 * and skipped without refusing the rest.
 */
export const CreatorPreflightResultsFile = z.object({
  schema_version: z.literal(1), results: z.array(z.unknown()),
}).strict();
export type CreatorPreflightResultsFile = z.infer<typeof CreatorPreflightResultsFile>;

// ---------------------------------------------------------------------------
// What Arcana stores and the screens read. camelCase.
// ---------------------------------------------------------------------------

export const CreatorPreflightCheckResult = z.object({
  check: CreatorPreflightCheck,
  outcome: CreatorPreflightOutcome,
  /** The runner's error codes for this check, in the runner's order. */
  reasons: z.array(Code),
  /** Null when the skill recorded no read time for this check: not read, not "at midnight". */
  readAt: Timestamp.nullable(),
  evidenceReference: z.string().nullable(),
}).strict();
export type CreatorPreflightCheckResult = z.infer<typeof CreatorPreflightCheckResult>;

export const CreatorInventoryRead = z.object({
  asin: CreatorAsin, sku: z.string().nullable(), fulfillmentChannel: z.string().nullable(), mcfFulfillable: z.boolean().nullable(),
  fulfillableQuantity: z.number().int().nonnegative().nullable(), checkedAt: Timestamp.nullable(), evidenceReference: z.string().nullable(),
}).strict();
export type CreatorInventoryRead = z.infer<typeof CreatorInventoryRead>;
export const CreatorPreviewRead = z.object({
  operation: z.literal('getFulfillmentPreview'), readAt: Timestamp, validUntil: Timestamp.nullable(), isFulfillable: z.boolean(),
  feeCents: z.number().int().nonnegative().nullable(), currency: z.string().nullable(), constraints: z.array(Code),
}).strict();
export type CreatorPreviewRead = z.infer<typeof CreatorPreviewRead>;

/**
 * One recorded sample pre-flight. Append-only: a new run is a new row. `id` is
 * the stable identity a later order request points at; `derivedOrderKey` is the
 * database's `app.creator_sample_order_key`, the sellerFulfillmentOrderId a
 * later create sends unchanged.
 */
export const CreatorSamplePreflight = z.object({
  id: z.uuid(),
  runId: RunId,
  creatorRecordId: CreatorRecordId,
  asin: CreatorAsin,
  derivedOrderKey: CreatorSampleOrderKey,
  result: z.enum(['PASS', 'HOLD']),
  computedScore: z.number().int().min(0).max(10),
  errors: z.array(Code),
  requiredNextState: z.string(),
  /** All eight, in order. */
  checks: z.array(CreatorPreflightCheckResult).length(8),
  sku: z.string().nullable(),
  campaignId: z.string().nullable(),
  productTitle: z.string().nullable(),
  trackerSourceRef: z.string().nullable(),
  quantity: z.number().int().nullable(),
  feeCents: z.number().int().nonnegative().nullable(),
  feeCapCents: z.number().int().nullable(),
  /** The runner bound a complete recipient block to a fingerprint. The block itself is never here. */
  recipientBound: z.boolean(),
  inventory: CreatorInventoryRead.nullable(),
  preview: CreatorPreviewRead.nullable(),
  startedAt: Timestamp,
  completedAt: Timestamp,
  recordedAt: Timestamp,
  source: CreatorSource,
}).strict();
export type CreatorSamplePreflight = z.infer<typeof CreatorSamplePreflight>;

/** One recorded product-switch pre-flight for one alternate ASIN. */
export const CreatorSwitchPreflight = z.object({
  id: z.uuid(),
  runId: RunId,
  creatorRecordId: CreatorRecordId,
  phase: z.string(),
  originalAsin: CreatorAsin,
  alternateAsin: CreatorAsin,
  alternateSku: z.string().nullable(),
  result: z.enum(['PASS', 'HOLD']),
  outcome: CreatorPreflightOutcome,
  errors: z.array(Code),
  requiredNextState: z.string(),
  inventory: CreatorInventoryRead.nullable(),
  originalUnavailableReason: z.enum(['not_mcf_fulfillable', 'out_of_stock', 'not_found']).nullable(),
  originalBlockerEvidenceReference: z.string().nullable(),
  startedAt: Timestamp,
  completedAt: Timestamp,
  recordedAt: Timestamp,
  source: CreatorSource,
}).strict();
export type CreatorSwitchPreflight = z.infer<typeof CreatorSwitchPreflight>;

/**
 * A preview without its own expiry is current for this long after it was read.
 * Fee and fulfillability are point-in-time: stock can sell through between the
 * read and a submit, so a later write must re-read rather than trust this one.
 */
export const CREATOR_PREVIEW_VALIDITY_MS = 30 * 60 * 1000;
/** Whether a preview read is past its validity at `now`. A pre-flight without a preview has nothing to expire. */
export function creatorPreviewExpired(preview: CreatorPreviewRead | null, now: Date): boolean {
  if (preview === null) return false;
  const until = preview.validUntil === null ? Date.parse(preview.readAt) + CREATOR_PREVIEW_VALIDITY_MS : Date.parse(preview.validUntil);
  return now.getTime() > until;
}

// ---------------------------------------------------------------------------
// Observation: what a read-only Amazon read found for one lane.
// ---------------------------------------------------------------------------

/** After this many consecutive not-found reads, an ambiguous lane stays locked and a person looks (447:2). */
export const CREATOR_MCF_NOT_FOUND_ESCALATION = 3;
/**
 * found: Amazon has an order under the id asked. not_found: it has none yet.
 * escalated: an ambiguous submit read as not found three times running.
 * The lane state is the runner's; no settlement changes it or releases a lock.
 */
export const CreatorMcfSettlement = z.enum(['found', 'not_found', 'escalated']);
export type CreatorMcfSettlement = z.infer<typeof CreatorMcfSettlement>;
export const CreatorMcfOperation = z.enum(['getFulfillmentOrder', 'listAllFulfillmentOrders']);
export type CreatorMcfOperation = z.infer<typeof CreatorMcfOperation>;

/** One append-only observation row. */
export const CreatorMcfObservationEvent = z.object({
  observationKey: z.string().min(1).max(200),
  creatorRecordId: CreatorRecordId,
  asin: CreatorAsin,
  derivedOrderKey: CreatorSampleOrderKey,
  /** The seller fulfillment order id asked about: the derived key, or the id the runner recorded. */
  queriedOrderId: z.string().min(1).max(100),
  operation: CreatorMcfOperation,
  outcome: z.enum(['found', 'not_found']),
  status: FulfillmentOrderStatus.nullable(),
  shipments: z.array(FulfillmentShipmentObservation).nullable(),
  packages: z.array(CreatorSamplePackage).nullable(),
  readAt: Timestamp,
  recordedAt: Timestamp,
}).strict().refine((event) => (event.outcome === 'found') === (event.status !== null), 'only a found order has a status');
export type CreatorMcfObservationEvent = z.infer<typeof CreatorMcfObservationEvent>;

/** What the observe job writes for one lane after one read. */
export const CreatorMcfObservationWrite = z.object({
  observationKey: z.string().min(1).max(200),
  derivedOrderKey: CreatorSampleOrderKey,
  queriedOrderId: z.string().min(1).max(100),
  operation: CreatorMcfOperation,
  outcome: z.enum(['found', 'not_found']),
  status: FulfillmentOrderStatus.nullable(),
  shipments: z.array(FulfillmentShipmentObservation).nullable(),
  packages: z.array(CreatorSamplePackage).nullable(),
  readAt: Timestamp,
  jobId: z.string().min(1).max(100).nullable(),
}).strict().refine((event) => (event.outcome === 'found') === (event.status !== null)
  && (event.outcome === 'found') === (event.shipments !== null) && (event.outcome === 'found') === (event.packages !== null),
'a found order carries its status, shipments and packages; a missing one carries none');
export type CreatorMcfObservationWrite = z.infer<typeof CreatorMcfObservationWrite>;

/** The lane's current settlement, derived from its observation rows. Null until Amazon has been asked. */
export const CreatorMcfSettlementState = z.object({
  settlement: CreatorMcfSettlement,
  /** Consecutive not-found reads while the lane is Reconciliation Required (the current ambiguous episode). */
  notFoundProbes: z.number().int().nonnegative(),
  lastProbeAt: Timestamp,
}).strict();
export type CreatorMcfSettlementState = z.infer<typeof CreatorMcfSettlementState>;

// ---------------------------------------------------------------------------
// Screen snapshots.
// ---------------------------------------------------------------------------

/** `/creators/samples/[key]/preflight`: the newest pre-flight for one lane, and how many ran before it. */
export const CreatorPreflightDetail = z.object({
  lastImport: CreatorImportRun.nullable(),
  derivedOrderKey: CreatorSampleOrderKey,
  /** The record and ASIN the key belongs to; null when nothing Arcana holds carries this key. */
  creatorRecordId: CreatorRecordId.nullable(),
  asin: CreatorAsin.nullable(),
  lockState: CreatorLockState.nullable(),
  preflight: CreatorSamplePreflight.nullable(),
  earlierRuns: z.number().int().nonnegative(),
  lane: CreatorSampleShipment.nullable(),
}).strict();
export type CreatorPreflightDetail = z.infer<typeof CreatorPreflightDetail>;

/** `/creators/samples/fulfillment/[key]`: one lane, its settlement, and the reads that made it. */
export const CreatorFulfillmentDetail = z.object({
  lastImport: CreatorImportRun.nullable(),
  derivedOrderKey: CreatorSampleOrderKey,
  lane: CreatorSampleShipment.nullable(),
  lockState: CreatorLockState.nullable(),
  settlement: CreatorMcfSettlementState.nullable(),
  /** Shipment-level state from the newest found read; null until an order was found. */
  shipments: z.array(FulfillmentShipmentObservation).nullable(),
  /** Newest first, at most twenty. */
  observations: z.array(CreatorMcfObservationEvent),
  observationsTotal: z.number().int().nonnegative(),
}).strict();
export type CreatorFulfillmentDetail = z.infer<typeof CreatorFulfillmentDetail>;

/** `/creators/samples/[key]/product-switch`: why the original lane cannot ship, and every alternate checked. */
export const CreatorProductSwitchDetail = z.object({
  lastImport: CreatorImportRun.nullable(),
  derivedOrderKey: CreatorSampleOrderKey,
  creatorRecordId: CreatorRecordId.nullable(),
  originalAsin: CreatorAsin.nullable(),
  lockState: CreatorLockState.nullable(),
  /** The tracker status the newest queue run saw. */
  status: z.string().nullable(),
  /** The newest sample pre-flight on the original lane, when one ran. */
  originalPreflight: CreatorSamplePreflight.nullable(),
  /** The newest switch pre-flight per alternate ASIN, offered first. */
  alternates: z.array(CreatorSwitchPreflight),
  /** The newest queue run's row for this record, when it named it. */
  queueItem: CreatorDailyQueueItem.nullable(),
}).strict();
export type CreatorProductSwitchDetail = z.infer<typeof CreatorProductSwitchDetail>;

/** The eight checks for a runner result, in order, with the reads recorded against them. */
export function creatorPreflightChecks(errors: readonly string[],
  reads: readonly { check: CreatorPreflightCheck; readAt: string; evidenceReference: string | null }[]): CreatorPreflightCheckResult[] {
  return CreatorPreflightCheck.options.map((check) => {
    const reasons = errors.filter((code) => CREATOR_PREFLIGHT_ERROR_CHECK[code] === check);
    const read = reads.find((entry) => entry.check === check);
    return { check, outcome: creatorPreflightOutcome(reasons), reasons, readAt: read?.readAt ?? null, evidenceReference: read?.evidenceReference ?? null };
  });
}
