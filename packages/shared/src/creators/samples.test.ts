/**
 * The pre-flight and observation contracts against the control runner's own
 * error vocabulary (creator_control.py `mcf_preflight`, `product_switch_preflight`,
 * `mcf_inventory_errors`) and the observation invariants. Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import {
  CREATOR_PREFLIGHT_CHECK_LABELS, CREATOR_PREFLIGHT_ERROR_CHECK, CREATOR_PREVIEW_VALIDITY_MS, CreatorMcfObservationWrite, CreatorPreflightCheck,
  CreatorPreflightResultInput, CreatorPreflightResultsFile, CreatorRunnerPreflightResult, CreatorRunnerSwitchResult, CreatorSwitchPreflightError,
  creatorPreflightChecks, creatorPreflightOutcome, creatorPreviewExpired,
} from './samples.js';

// Every literal `errors.append(...)` in the three runner functions, as of the reference read for WP-334.
const RUNNER_INVENTORY = ['selected_sku_not_fba_fulfilled', 'selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity',
  'mcf_inventory_check_missing', 'mcf_inventory_evidence_missing'];
const RUNNER_PREFLIGHT = ['identity_not_resolved', 'creator_record_id_missing', 'creator_record_id_mismatch', 'record_not_unlocked_for_preflight',
  'tracker_campaign_id_missing', 'campaign_id_mismatch', 'tracker_source_reference_missing', 'thread_evidence_reference_missing',
  'preflight_evidence_reference_missing', ...['full_name_fp', 'email_fp', 'phone_fp', 'address_fp'].flatMap((key) => [`recipient_${key}_missing`,
    `recipient_${key}_mismatch`]), 'recipient_binding_incomplete', 'catalog_product_title_missing', 'catalog_campaign_id_missing',
  'catalog_campaign_id_mismatch', 'status_not_approved_for_sample', 'qualification_not_10_of_10', 'sample_decision_not_send', 'asin_mismatch',
  'catalog_asin_mismatch', 'sku_not_mapped_to_selected_asin', 'quantity_invalid', 'quantity_must_equal_1', ...RUNNER_INVENTORY,
  'shipping_must_be_standard', 'fee_missing_or_invalid', 'fee_exceeds_approved_cap', 'duplicate_sample_risk', 'page_validation_error',
  'field_truncation_detected', 'incomplete_fulfillment_details'];
const RUNNER_SWITCH = ['identity_not_resolved', 'record_not_unlocked_for_product_switch', 'invalid_product_switch_phase', 'original_asin_mismatch',
  'alternate_asin_not_distinct', 'alternate_asin_not_in_campaign', 'original_mcf_blocker_not_verified', 'original_mcf_blocker_evidence_missing',
  'alternate_catalog_asin_mismatch', 'alternate_sku_not_mapped_to_asin', ...RUNNER_INVENTORY, 'creator_confirmation_asin_mismatch',
  'creator_confirmation_evidence_missing'];
const FP = 'a'.repeat(64);

const passing = { result: 'PASS', creator_record_id: 'CCR-SW-26-0088', computed_score: 10, errors: [], required_next_state: 'Locked for MCF',
  quantity: 1, visible_fee_cents: 620, approved_fee_cap_cents: 800, selected_asin: 'B0D9K3M2QP', selected_sku: 'SW-DERMA-05-FBA',
  product_title: 'Synthetic roller', campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker:synthetic:row-87', recipient_binding: FP };
const held = { ...passing, result: 'HOLD', errors: ['selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity'],
  required_next_state: 'Conflict or Held', selected_asin: 'B0D7Q1V8LM', selected_sku: 'SW-DERMA-03-FBM' };
const envelope = { command: 'preflight', run_id: 'preflight-0088-1', started_at: '2026-09-09T06:33:04Z', completed_at: '2026-09-09T06:33:19Z',
  inventory: null, preview: null, reads: [] };

describe('the eight pre-flight checks', () => {
  it('files every error the runner can emit under exactly one of the eight checks, and nothing else', () => {
    expect(RUNNER_PREFLIGHT).toHaveLength(41);
    expect(Object.keys(CREATOR_PREFLIGHT_ERROR_CHECK).sort()).toEqual([...new Set(RUNNER_PREFLIGHT)].sort());
    expect(CreatorPreflightCheck.options).toHaveLength(8);
    expect(Object.keys(CREATOR_PREFLIGHT_CHECK_LABELS)).toEqual(CreatorPreflightCheck.options);
    const perCheck = CreatorPreflightCheck.options.map((check) => Object.values(CREATOR_PREFLIGHT_ERROR_CHECK).filter((value) => value === check).length);
    expect(perCheck).toEqual([4, 3, 9, 10, 1, 5, 5, 4]);
    expect(perCheck.reduce((sum, value) => sum + value, 0)).toBe(41);
    expect([...CreatorSwitchPreflightError.options].sort()).toEqual([...new Set(RUNNER_SWITCH)].sort());
  });

  it('derives pass, hold and fail per check from the runner errors, with the read times recorded against them', () => {
    const checks = creatorPreflightChecks(['selected_sku_not_mcf_fulfillable', 'recipient_email_fp_mismatch'],
      [{ check: 'fulfillable_stock', readAt: '2026-09-09T06:31:11Z', evidenceReference: 'ev:mcf-inv-15' }]);
    expect(checks.map((check) => check.check)).toEqual(CreatorPreflightCheck.options);
    expect(checks.map((check) => check.outcome)).toEqual(['pass', 'pass', 'pass', 'fail', 'pass', 'pass', 'hold', 'pass']);
    expect(checks[6]).toEqual({ check: 'fulfillable_stock', outcome: 'hold', reasons: ['selected_sku_not_mcf_fulfillable'],
      readAt: '2026-09-09T06:31:11Z', evidenceReference: 'ev:mcf-inv-15' });
    // An unrecorded read time is null, not a time.
    expect(checks.filter((check) => check.readAt === null)).toHaveLength(7);
    expect(creatorPreflightOutcome([])).toBe('pass');
    expect(creatorPreflightOutcome(['duplicate_sample_risk'])).toBe('fail');
    expect(creatorPreflightOutcome(['mcf_inventory_evidence_missing', 'asin_mismatch'])).toBe('fail');
    expect(creatorPreflightOutcome(['fee_missing_or_invalid'])).toBe('hold');
  });
});

describe('the runner results', () => {
  it('accepts a pass and a hold, and refuses a result that contradicts itself', () => {
    expect(CreatorRunnerPreflightResult.safeParse(passing).success).toBe(true);
    expect(CreatorRunnerPreflightResult.safeParse(held).success).toBe(true);
    const contradictions = [{ ...passing, errors: ['asin_mismatch'] }, { ...held, result: 'PASS' }, { ...held, required_next_state: 'Locked for MCF' },
      { ...passing, errors: ['asin_mismatch', 'asin_mismatch'], result: 'HOLD', required_next_state: 'Conflict or Held' }];
    expect(contradictions.map((value) => CreatorRunnerPreflightResult.safeParse(value).success)).toEqual([false, false, false, false]);
  });

  it('refuses runner drift, an unfiled lane and anything that is not the runner\'s shape, including a recipient block', () => {
    const refused = [
      { ...held, errors: ['moon_phase_wrong'] },
      { ...passing, creator_record_id: null },
      { ...passing, selected_asin: '' },
      { ...passing, recipient: { full_name: 'x' } },
      { ...passing, recipient_binding: 'not-a-fingerprint' },
      { ...passing, quantity: '1.5' },
      { ...passing, quantity: ' 1' },
    ];
    expect(refused.map((value) => CreatorRunnerPreflightResult.safeParse(value).success)).toEqual([false, false, false, false, false, false, false]);
    // `mcf_preflight` echoes the proposal's quantity raw: a digit string is its integer, stored as a number.
    expect(CreatorRunnerPreflightResult.parse({ ...passing, quantity: '1' }).quantity).toBe(1);
    expect(CreatorRunnerPreflightResult.safeParse({ ...passing, recipient_binding: '' }).success).toBe(true);
  });

  it('checks the switch result\'s next state against its phase', () => {
    const offer = { result: 'PASS', phase: 'offer', creator_record_id: 'CCR-SW-26-0166', errors: [], required_next_state: 'Product Switch Pending',
      original_asin: 'B0D7Q1V8LM', alternate_asin: 'B0D9K3M2QP', alternate_sku: 'SW-DERMA-05-FBA' };
    expect(CreatorRunnerSwitchResult.safeParse(offer).success).toBe(true);
    expect(CreatorRunnerSwitchResult.safeParse({ ...offer, phase: 'confirm', required_next_state: 'Approved for Sample' }).success).toBe(true);
    expect(CreatorRunnerSwitchResult.safeParse({ ...offer, phase: 'confirm' }).success).toBe(false);
    expect(CreatorRunnerSwitchResult.safeParse({ ...offer, result: 'HOLD', errors: ['alternate_asin_not_in_campaign'],
      required_next_state: 'Conflict or Held' }).success).toBe(true);
    expect(CreatorRunnerSwitchResult.safeParse({ ...offer, result: 'HOLD', errors: ['duplicate_sample_risk'],
      required_next_state: 'Conflict or Held' }).success).toBe(false);
  });

  it('binds the stock read to the lane\'s ASIN, orders the run, and reads each check once', () => {
    const inventory = { asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', fulfillment_channel: 'AFN', mcf_fulfillable: true, fulfillable_quantity: 37,
      inventory_checked_at: '2026-09-09T06:33:17Z', fulfillment_evidence_reference: 'ev:mcf-inv-16' };
    const read = { check: 'identity', read_at: '2026-09-09T06:33:04Z', evidence_reference: null };
    expect(CreatorPreflightResultInput.safeParse({ ...envelope, result: passing, inventory, reads: [read] }).success).toBe(true);
    const refused = [
      { ...envelope, result: passing, inventory: { ...inventory, asin: 'B0D7Q1V8LM' } },
      { ...envelope, result: passing, started_at: '2026-09-09T06:34:00Z' },
      { ...envelope, result: passing, reads: [read, read] },
      { ...envelope, result: passing, run_id: 'has spaces' },
      { ...envelope, command: 'reserve-mcf', result: passing },
    ];
    expect(refused.map((value) => CreatorPreflightResultInput.safeParse(value).success)).toEqual([false, false, false, false, false]);
    expect(CreatorPreflightResultsFile.safeParse({ schema_version: 1, results: [{}] }).success).toBe(true);
    expect(CreatorPreflightResultsFile.safeParse({ schema_version: 2, results: [] }).success).toBe(false);
  });
});

describe('the preview validity and the observation', () => {
  it('expires a preview at its own validity, or thirty minutes after the read, and never one that was not read', () => {
    const preview = { operation: 'getFulfillmentPreview' as const, readAt: '2026-09-09T06:35:22Z', validUntil: null, isFulfillable: true,
      feeCents: 620, currency: 'EUR', constraints: [] };
    const read = Date.parse(preview.readAt);
    expect(CREATOR_PREVIEW_VALIDITY_MS).toBe(1_800_000);
    expect(creatorPreviewExpired(preview, new Date(read + CREATOR_PREVIEW_VALIDITY_MS))).toBe(false);
    expect(creatorPreviewExpired(preview, new Date(read + CREATOR_PREVIEW_VALIDITY_MS + 1))).toBe(true);
    expect(creatorPreviewExpired({ ...preview, validUntil: '2026-09-09T06:40:00Z' }, new Date('2026-09-09T06:40:01Z'))).toBe(true);
    expect(creatorPreviewExpired(null, new Date('2030-01-01T00:00:00Z'))).toBe(false);
  });

  it('lets only a found order carry a status, shipments and packages', () => {
    const base = { observationKey: 'job-1:CCS-0123456789abcdef0123456789abcdef', derivedOrderKey: 'CCS-0123456789abcdef0123456789abcdef',
      queriedOrderId: 'CCS-0123456789abcdef0123456789abcdef', operation: 'getFulfillmentOrder', readAt: '2026-09-09T07:02:18Z', jobId: 'job-1' };
    const outcomes = [
      { ...base, outcome: 'found', status: 'Processing', shipments: [], packages: [] },
      { ...base, outcome: 'not_found', status: null, shipments: null, packages: null },
      { ...base, outcome: 'not_found', status: 'Processing', shipments: null, packages: null },
      { ...base, outcome: 'found', status: 'Processing', shipments: null, packages: [] },
      { ...base, outcome: 'found', status: 'Processing', shipments: [], packages: [], destinationAddress: {} },
    ];
    expect(outcomes.map((value) => CreatorMcfObservationWrite.safeParse(value).success)).toEqual([true, true, false, false, false]);
  });
});
