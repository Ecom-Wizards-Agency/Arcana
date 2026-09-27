import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CreatorRunnerActiveReservation, CreatorRunnerQueueItem, CreatorRunnerQueueResult, CreatorRunnerRegistry,
  CreatorRunnerRegistryRecord, CreatorRunnerReservationList, CreatorRunnerScoreResult, CreatorSweepCheckpoint,
  CreatorSweepCounts, CreatorSweepThread, CreatorQualificationCheck, CreatorCancellationReason, CreatorRunnerReservationHistoryEntry,
} from './runner.js';

/** Synthetic fingerprints: a hash of a label, never of contact data. */
const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');
const unlocked = {
  creator_record_id: 'CCR-SW-26-0134', brand: 'Synthetic brand', campaign_id: 'campaign-synthetic-1',
  thread_key: fp('thread-0134'), storefront_key: fp('storefront-0134'), full_name_fp: '', email_fp: fp('email-0134'),
  phone_fp: '', address_fp: '', record_state: 'Active', lock_state: 'Unlocked', version: 3, created_at: '2026-09-01',
};
const locked = {
  ...unlocked, creator_record_id: 'CCR-SW-26-0072', lock_state: 'Locked for MCF', version: 7,
  mcf_reservation: {
    reservation_id: 'MCFR-9F2C41AB77E0D3B5', state: 'Reconciliation Required', creator_record_id: 'CCR-SW-26-0072',
    campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker-row-synthetic-72', asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA',
    product_title: 'Synthetic product', quantity: 1, recipient_binding: fp('recipient-0072'), visible_fee_cents: 620,
    approved_fee_cap_cents: 800, thread_evidence_reference: 'evidence/synthetic/thread', preflight_evidence_reference: 'evidence/synthetic/preflight',
    inventory_evidence_reference: 'evidence/synthetic/inventory', reserved_at: '2026-09-08T06:40:00.123456+00:00',
    verified_at: '2026-09-08T06:43:00+00:00', verification_evidence_reference: 'evidence/synthetic/screen', verified_product_title: 'Synthetic product',
    reconciliation_reason: 'outcome_unknown', reconciliation_evidence_reference: 'evidence/synthetic/timeout',
  },
};
const withHistory = {
  ...unlocked, creator_record_id: 'CCR-SW-26-0045',
  sample_history: [{ reservation_id: 'MCFR-00000000000000A1', campaign_id: null, tracker_source_ref: null, asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA',
    quantity: 1, order_id: 'synthetic-order-1', status: 'Confirmed', evidence_reference: 'evidence/synthetic/order', confirmed_at: '2026-09-02T08:00:00+00:00' }],
  mcf_reservation_history: [{ reservation_id: 'MCFR-00000000000000A0', campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker-row-synthetic-45',
    asin: 'B0D7Q1V8LM', sku: 'SW-DERMA-03-FBM', quantity: 1, status: 'Cancelled', reason_code: 'inventory_unavailable_before_submit',
    evidence_reference: 'evidence/synthetic/cancel', cancelled_at: '2026-09-01T09:00:00+00:00' }],
};
const queueItem = {
  queue_id: '20260909-CCR-SW-26-0134', run_date: '2026-09-09', creator_record_id: 'CCR-SW-26-0134', brand: 'Synthetic brand',
  campaign_tab: 'Synthetic tab', current_status: 'Verification Confirmed', computed_score: 8,
  missing: ['recent_post_verified', 'performance_or_revenue'], due_date: '2026-09-09', action_type: 'RECONCILE_QUALIFICATION',
  gate_result: 'BLOCKED', queue_state: 'Escalated', reason: 'status_score_drift',
};

describe('registry cache (creator_control.py new_registry, issue_record_id, reserve_mcf, confirm_mcf, cancel_mcf)', () => {
  it('accepts unlocked, reserved and historied records with fingerprints only', () => {
    const registry = CreatorRunnerRegistry.parse({ schema_version: 1, sequence_by_brand: { 'SW-26': 209 }, records: [unlocked, locked, withHistory] });
    const parsed = registry.records.map((record) => CreatorRunnerRegistryRecord.safeParse(record));
    expect(parsed.filter((result) => result.success)).toHaveLength(3);
    expect(parsed[1]!.data?.mcf_reservation?.state).toBe('Reconciliation Required');
    expect(parsed[2]!.data?.sample_history).toHaveLength(1);
    expect(parsed[2]!.data?.mcf_reservation_history).toHaveLength(1);
  });
  it('refuses a record carrying a raw contact key, whatever else it holds', () => {
    const key = ['e', 'mail'].join('');
    const result = CreatorRunnerRegistryRecord.safeParse({ ...unlocked, [key]: 'synthetic value' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.code)).toContain('unrecognized_keys');
  });
  it('refuses a lock without its reservation, a reservation without its lock, and a reservation for another record', () => {
    expect(CreatorRunnerRegistryRecord.safeParse({ ...unlocked, lock_state: 'Locked for MCF' }).success).toBe(false);
    expect(CreatorRunnerRegistryRecord.safeParse({ ...locked, lock_state: 'Unlocked' }).success).toBe(false);
    // lock_conflicting_records moves a reserved record to Conflict and keeps the reservation.
    expect(CreatorRunnerRegistryRecord.safeParse({ ...locked, lock_state: 'Conflict', escalation_reason: 'multiple_active_records_match' }).success).toBe(true);
    expect(CreatorRunnerRegistryRecord.safeParse({ ...locked, mcf_reservation: { ...locked.mcf_reservation, creator_record_id: 'CCR-SW-26-0001' } }).success).toBe(false);
  });
  it('refuses a malformed id, fingerprint, ASIN or lock state', () => {
    for (const change of [{ creator_record_id: 'SW-26-0134' }, { thread_key: 'not-a-fingerprint' }, { lock_state: 'Locked' }, { version: 0 }]) {
      expect(CreatorRunnerRegistryRecord.safeParse({ ...unlocked, ...change }).success, JSON.stringify(change)).toBe(false);
    }
    expect(CreatorRunnerRegistryRecord.safeParse({ ...locked, mcf_reservation: { ...locked.mcf_reservation, asin: 'b0d9k3m2qp' } }).success).toBe(false);
  });
  it('refuses a runner cancellation carrying either reason only an Arcana-placed order can reach', () => {
    const [released] = withHistory.mcf_reservation_history;
    expect(CreatorCancellationReason.options).toHaveLength(6);
    expect(CreatorRunnerReservationHistoryEntry.safeParse(released).success).toBe(true);
    const refused = ['amazon_cancelled_after_submit', 'operator_cancelled_in_amazon'];
    for (const reason_code of refused) {
      expect(CreatorRunnerReservationHistoryEntry.safeParse({ ...released, reason_code }).success, reason_code).toBe(false);
      expect(CreatorRunnerRegistryRecord.safeParse({ ...withHistory, mcf_reservation_history: [{ ...released, reason_code }] }).success, reason_code).toBe(false);
    }
  });
  it('refuses another schema version and keeps bad records inside the envelope for counting', () => {
    expect(CreatorRunnerRegistry.safeParse({ schema_version: 2, sequence_by_brand: {}, records: [] }).success).toBe(false);
    expect(CreatorRunnerRegistry.parse({ schema_version: 1, records: [{}, unlocked] }).records).toHaveLength(2);
  });
});

describe('queue output (creator_control.py queue_item and main() queue)', () => {
  it('accepts an item whose score, missing checks and queue id agree', () => {
    expect(CreatorRunnerQueueItem.parse(queueItem).computed_score).toBe(8);
    const unresolved = { ...queueItem, queue_id: '20260909-UNRESOLVED', creator_record_id: 'UNRESOLVED', action_type: 'IDENTITY_RESOLUTION', reason: 'missing_creator_record_id' };
    expect(CreatorRunnerQueueItem.safeParse(unresolved).success).toBe(true);
  });
  it('refuses score drift inside one item, a queue id from another day, and unresolved non-identity work', () => {
    expect(CreatorRunnerQueueItem.safeParse({ ...queueItem, computed_score: 9 }).success).toBe(false);
    expect(CreatorRunnerQueueItem.safeParse({ ...queueItem, queue_id: '20260908-CCR-SW-26-0134' }).success).toBe(false);
    expect(CreatorRunnerQueueItem.safeParse({ ...queueItem, queue_id: '20260909-UNRESOLVED', creator_record_id: 'UNRESOLVED' }).success).toBe(false);
    expect(CreatorRunnerQueueItem.safeParse({ ...queueItem, gate_result: 'PASS' }).success).toBe(false);
  });
  it('checks the queued and escalated counts against the raw items', () => {
    expect(CreatorRunnerQueueResult.safeParse({ run_date: '2026-09-09', items: [queueItem], counts: { queued: 0, escalated: 1 } }).success).toBe(true);
    expect(CreatorRunnerQueueResult.safeParse({ run_date: '2026-09-09', items: [queueItem], counts: { queued: 1, escalated: 1 } }).success).toBe(false);
  });
  it('mirrors score_record: ten named checks, one point each', () => {
    expect(CreatorQualificationCheck.options).toHaveLength(10);
    const checks = Object.fromEntries(CreatorQualificationCheck.options.map((check) => [check, !queueItem.missing.includes(check)]));
    expect(CreatorRunnerScoreResult.safeParse({ score: 8, checks, missing: queueItem.missing }).success).toBe(true);
    expect(CreatorRunnerScoreResult.safeParse({ score: 8, checks, missing: ['low_spam_risk', 'category_fit'] }).success).toBe(false);
  });
});

describe('reservation list (creator_control.py list_mcf_reservations)', () => {
  const active = { creator_record_id: 'CCR-SW-26-0072', reservation_id: 'MCFR-LEGACY-0123456789AB', state: 'Legacy Reserved',
    campaign_id: null, asin: 'B0D9K3M2QP', sku: '', product_title: '', quantity: 1, reserved_at: '' };
  it('accepts legacy and current reservations and checks the count', () => {
    expect(CreatorRunnerActiveReservation.safeParse(active).success).toBe(true);
    expect(CreatorRunnerReservationList.safeParse({ result: 'PASS', active_reservations: [active], count: 1 }).success).toBe(true);
    expect(CreatorRunnerReservationList.safeParse({ result: 'PASS', active_reservations: [active], count: 2 }).success).toBe(false);
  });
});

describe('sweep checkpoint (skill SKILL.md §9 message watermarks)', () => {
  const counts = { mounted: 412, opened: 412, changed: 37, messages_examined: 96, messages_sent: 0, no_action_acknowledgements: 359,
    held_or_escalated: 9, archived_spam: 5, unmatched: 7 };
  it('accepts the nine counts and refuses archived spam outside the changed threads', () => {
    expect(CreatorSweepCounts.parse(counts).mounted).toBe(412);
    expect(CreatorSweepCounts.safeParse({ ...counts, archived_spam: 38 }).success).toBe(false);
    expect(CreatorSweepCounts.safeParse({ ...counts, mounted: undefined }).success).toBe(false);
  });
  it('keeps thread signatures hashed and refuses an unmatched thread that names a record', () => {
    const thread = { thread_key: fp('thread-x'), creator_record_id: null, sender_role: 'creator', amazon_timestamp: '2026-09-09T05:00:00Z',
      body_hash: fp('body-x'), outcome: 'unmatched', reason: 'multiple_active_records_match' };
    expect(CreatorSweepThread.safeParse(thread).success).toBe(true);
    expect(CreatorSweepThread.safeParse({ ...thread, creator_record_id: 'CCR-SW-26-0134' }).success).toBe(false);
    expect(CreatorSweepThread.safeParse({ ...thread, body: 'raw message' }).success).toBe(false);
    expect(CreatorSweepCheckpoint.safeParse({ schema_version: 1, run_id: 'sweep-20260909-0612', run_date: '2026-09-09', brand: null,
      started_at: null, completed_at: '2026-09-09T06:12:00Z', evidence_reference: null, counts, threads: [thread] }).success).toBe(true);
  });
});
