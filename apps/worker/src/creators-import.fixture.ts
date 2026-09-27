/**
 * Synthetic control-runner outputs for the import tests. Fingerprints are hashes
 * of labels; every id, ASIN and count is invented or taken from the synthetic
 * design fixture. No value here came from a real run.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CREATOR_IMPORT_FILES } from './creators-import.js';

export const fp = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');
const base = (id: string) => ({
  creator_record_id: id, brand: 'Synthetic brand', campaign_id: 'campaign-synthetic-1', thread_key: fp(`${id}:thread`),
  storefront_key: fp(`${id}:storefront`), full_name_fp: '', email_fp: '', phone_fp: '', address_fp: '', record_state: 'Active',
  lock_state: 'Unlocked', version: 1, created_at: '2026-09-01',
});

export function syntheticRunnerFiles() {
  const registry = {
    schema_version: 1,
    sequence_by_brand: { 'SW-26': 209 },
    records: [
      { ...base('CCR-SW-26-0134'), version: 3, last_verified_at: '2026-09-07' },
      { ...base('CCR-SW-26-0117'), lock_state: 'Conflict', escalation_reason: 'multiple_active_records_match', version: 2 },
      { ...base('CCR-SW-26-0203'), lock_state: 'Conflict', escalation_reason: 'multiple_active_records_match', version: 2 },
      { ...base('CCR-SW-26-0072'), lock_state: 'Locked for MCF', version: 7, mcf_reservation: {
        reservation_id: 'MCFR-9F2C41AB77E0D3B5', state: 'Reconciliation Required', creator_record_id: 'CCR-SW-26-0072', campaign_id: 'campaign-synthetic-1',
        tracker_source_ref: 'tracker-row-synthetic-72', asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', product_title: 'Synthetic product', quantity: 1,
        recipient_binding: fp('recipient-0072'), visible_fee_cents: 620, approved_fee_cap_cents: 800, thread_evidence_reference: 'evidence/synthetic/thread',
        preflight_evidence_reference: 'evidence/synthetic/preflight', inventory_evidence_reference: 'evidence/synthetic/inventory',
        reserved_at: '2026-09-08T06:40:00+00:00', verified_at: '2026-09-08T06:43:00+00:00', verification_evidence_reference: 'evidence/synthetic/screen',
        verified_product_title: 'Synthetic product', reconciliation_reason: 'outcome_unknown', reconciliation_evidence_reference: 'evidence/synthetic/timeout' } },
      { ...base('CCR-SW-26-0045'), version: 5,
        sample_history: [{ reservation_id: 'MCFR-00000000000000A1', campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker-row-synthetic-45',
          asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', quantity: 1, order_id: 'synthetic-order-45', status: 'Confirmed',
          evidence_reference: 'evidence/synthetic/order-45', confirmed_at: '2026-09-02T08:00:00+00:00' }],
        mcf_reservation_history: [{ reservation_id: 'MCFR-00000000000000A0', campaign_id: 'campaign-synthetic-1', tracker_source_ref: 'tracker-row-synthetic-45',
          asin: 'B0D7Q1V8LM', sku: 'SW-DERMA-03-FBM', quantity: 1, status: 'Cancelled', reason_code: 'inventory_unavailable_before_submit',
          evidence_reference: 'evidence/synthetic/cancel-45', cancelled_at: '2026-09-01T09:00:00+00:00' }] },
      // Legacy reservation: no id, no state. `list-mcf` names it MCFR-LEGACY-*.
      { ...base('CCR-SW-26-0031'), lock_state: 'Locked for MCF', version: 4, mcf_reservation: { asin: 'B0D9K3M2QP', reserved_at: '2026-08-20T10:00:00+00:00' } },
      // Invalid: a raw contact field has no place in the registry.
      { ...base('CCR-SW-26-0099'), [['ph', 'one'].join('')]: 'synthetic' },
    ],
  };
  const item = (id: string, change: Record<string, unknown>) => ({
    queue_id: `20260909-${id}`, run_date: '2026-09-09', creator_record_id: id, brand: 'Synthetic brand', campaign_tab: 'Synthetic tab',
    current_status: 'New Inquiry', computed_score: 10, missing: [], due_date: '2026-09-09', action_type: 'BACKGROUND_CHECK', gate_result: 'HOLD',
    queue_state: 'Queued', reason: 'new_inquiry_requires_visible_evidence', ...change,
  });
  const unresolved = { queue_id: '20260909-UNRESOLVED', creator_record_id: 'UNRESOLVED', action_type: 'IDENTITY_RESOLUTION', gate_result: 'BLOCKED',
    queue_state: 'Escalated', reason: 'missing_creator_record_id', current_status: '' };
  const queue = {
    run_date: '2026-09-09',
    items: [
      item('CCR-SW-26-0134', { current_status: 'Verification Confirmed', computed_score: 8, missing: ['recent_post_verified', 'performance_or_revenue'],
        action_type: 'RECONCILE_QUALIFICATION', gate_result: 'BLOCKED', queue_state: 'Escalated', reason: 'status_score_drift' }),
      item('UNRESOLVED', unresolved),
      item('UNRESOLVED', unresolved),
      item('CCR-SW-26-0072', { current_status: 'Approved for Sample', action_type: 'MCF_PREFLIGHT', reason: 'paid_order_requires_preflight_and_authorized_executor' }),
      // Invalid: the score and the missing checks disagree.
      item('CCR-SW-26-0045', { computed_score: 9 }),
    ],
    counts: { queued: 2, escalated: 3 },
  };
  const thread = (label: string, outcome: string, change: Record<string, unknown> = {}) => ({
    thread_key: fp(`thread:${label}`), creator_record_id: outcome === 'unmatched' ? null : 'CCR-SW-26-0134', sender_role: 'creator',
    amazon_timestamp: '2026-09-09T05:00:00Z', body_hash: fp(`body:${label}`), outcome, reason: outcome === 'unmatched' ? 'multiple_active_records_match' : null, ...change,
  });
  const sweep = {
    schema_version: 1, run_id: 'sweep-20260909-0612', run_date: '2026-09-09', brand: 'Synthetic brand', started_at: '2026-09-09T05:58:00Z',
    completed_at: '2026-09-09T06:12:00Z', evidence_reference: 'ev:sweep-0909',
    counts: { mounted: 412, opened: 412, changed: 37, messages_examined: 96, messages_sent: 0, no_action_acknowledgements: 359, held_or_escalated: 9,
      archived_spam: 5, unmatched: 7 },
    threads: [thread('a', 'unchanged'), thread('b', 'actioned'), thread('c', 'unmatched'), thread('d', 'unmatched')],
  };
  const reservations = {
    result: 'PASS', count: 2,
    active_reservations: [
      { creator_record_id: 'CCR-SW-26-0072', reservation_id: 'MCFR-9F2C41AB77E0D3B5', state: 'Reconciliation Required', campaign_id: 'campaign-synthetic-1',
        asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', product_title: 'Synthetic product', quantity: 1, reserved_at: '2026-09-08T06:40:00+00:00' },
      { creator_record_id: 'CCR-SW-26-0031', reservation_id: 'MCFR-LEGACY-85794FBD4E17', state: 'Legacy Reserved', campaign_id: null,
        asin: 'B0D9K3M2QP', sku: '', product_title: '', quantity: 1, reserved_at: '2026-08-20T10:00:00+00:00' },
    ],
  };
  return { registry, queue, sweep, reservations };
}

export async function writeRunnerFiles(dir: string, files: Partial<ReturnType<typeof syntheticRunnerFiles>> = syntheticRunnerFiles()) {
  await mkdir(dir, { recursive: true });
  const names = { registry: CREATOR_IMPORT_FILES.registry, queue: CREATOR_IMPORT_FILES.queue, sweep: CREATOR_IMPORT_FILES.sweep_checkpoint,
    reservations: CREATOR_IMPORT_FILES.mcf_reservations } as const;
  for (const [key, value] of Object.entries(files)) await writeFile(join(dir, names[key as keyof typeof names]), JSON.stringify(value));
}
