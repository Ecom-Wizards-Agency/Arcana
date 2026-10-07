/**
 * Creator Connections runner shapes to rows: the one mapping both the file
 * import (`apps/worker/src/creators-import.ts`) and the `creator:write` MCP tools
 * use, so a record, an event key, a lane or a queue row is the same row, with
 * the same content digest, whichever path wrote it first. Pure: no clock, no I/O.
 */
import { createHash } from 'node:crypto';
import {
  CreatorThreadOutcome, type CreatorRunnerQueueItem, type CreatorRunnerRegistryRecord, type CreatorRunnerReservationHistoryEntry,
  type CreatorRunnerSampleHistoryEntry, type CreatorSweepCheckpoint, type CreatorSweepThread,
} from '@wizard-ads/shared';
import type { CreatorEventWrite, CreatorQueueWrite, CreatorRecordWrite, CreatorShipmentWrite, CreatorSweepWrite } from './creators.js';

/** Unresolved thread detail kept per sweep, as the import keeps it. */
const UNRESOLVED_LIMIT = 200;

const nullable = (value: string) => value === '' ? null : value;
const upper = (value: string) => value.trim().toUpperCase();
/** `active_reservation_id` in creator_control.py, for a reservation written before ids existed. */
export function legacyReservationId(creatorRecordId: string, asin: string, reservedAt: string | undefined): string {
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
  const seed = [upper(normalized(creatorRecordId)), upper(normalized(asin)), normalized(reservedAt ?? '')].join('|');
  return `MCFR-LEGACY-${createHash('sha256').update(seed).digest('hex').slice(0, 12).toUpperCase()}`;
}
const newest = <T>(items: readonly T[], at: (item: T) => string) =>
  [...items].sort((left, right) => Date.parse(at(right)) - Date.parse(at(left)))[0];

export interface CreatorRegistryRows { record: CreatorRecordWrite; actions: CreatorEventWrite[]; lanes: CreatorShipmentWrite[] }

/** One registry row to the record, its registry-derived history and its sample lanes. Pure. */
export function creatorRegistryRows(record: CreatorRunnerRegistryRecord): CreatorRegistryRows {
  const id = record.creator_record_id;
  const actions: CreatorEventWrite[] = [];
  const lanes = new Map<string, CreatorShipmentWrite>();
  if (record.lock_state === 'Conflict') {
    actions.push({ eventKey: `conflict:${id}:${record.version}`, creatorRecordId: id, action: 'identity_conflict_locked', occurredAt: null,
      reservationId: null, asin: null, reasonCode: record.escalation_reason ?? null, evidenceReference: null, recordVersion: record.version });
  }
  const byAsin = new Map<string, { history: CreatorRunnerSampleHistoryEntry[]; cancelled: CreatorRunnerReservationHistoryEntry[] }>();
  const bucket = (asin: string) => byAsin.get(asin) ?? byAsin.set(asin, { history: [], cancelled: [] }).get(asin)!;
  for (const entry of record.sample_history ?? []) {
    bucket(entry.asin).history.push(entry);
    actions.push({ eventKey: `confirmed:${upper(entry.reservation_id)}`, creatorRecordId: id, action: 'sample_confirmed',
      occurredAt: entry.confirmed_at, reservationId: upper(entry.reservation_id), asin: entry.asin, reasonCode: null,
      evidenceReference: entry.evidence_reference, recordVersion: null });
  }
  for (const entry of record.mcf_reservation_history ?? []) {
    bucket(entry.asin).cancelled.push(entry);
    actions.push({ eventKey: `cancelled:${upper(entry.reservation_id)}`, creatorRecordId: id, action: 'mcf_reservation_cancelled',
      occurredAt: entry.cancelled_at, reservationId: upper(entry.reservation_id), asin: entry.asin, reasonCode: entry.reason_code,
      evidenceReference: entry.evidence_reference, recordVersion: null });
  }
  const reservation = record.mcf_reservation;
  for (const [asin, { history, cancelled }] of byAsin) {
    if (reservation?.asin === asin) continue;
    const confirmed = newest(history, (entry) => entry.confirmed_at);
    const released = newest(cancelled, (entry) => entry.cancelled_at);
    const lane = confirmed ?? released!;
    lanes.set(asin, {
      creatorRecordId: id, asin, sku: lane.sku ?? null, campaignId: lane.campaign_id ?? null, reservationId: upper(lane.reservation_id),
      laneState: confirmed ? 'Confirmed' : 'Cancelled', runnerOrderId: confirmed?.order_id ?? null, feeCents: null, feeCapCents: null,
      reservedAt: null, verifiedAt: null, confirmedAt: confirmed?.confirmed_at ?? null, cancelledAt: confirmed ? null : released!.cancelled_at,
      cancellationReason: confirmed ? null : released!.reason_code, reconciliationReason: null,
    });
  }
  if (reservation) {
    const reservationId = reservation.reservation_id === undefined
      ? legacyReservationId(id, reservation.asin, reservation.reserved_at) : upper(reservation.reservation_id);
    if (reservation.reserved_at) {
      actions.push({ eventKey: `reserved:${reservationId}`, creatorRecordId: id, action: 'mcf_reserved', occurredAt: reservation.reserved_at,
        reservationId, asin: reservation.asin, reasonCode: null, evidenceReference: reservation.preflight_evidence_reference ?? null, recordVersion: null });
    }
    if (reservation.verified_at) {
      actions.push({ eventKey: `verified:${reservationId}:${reservation.verified_at}`, creatorRecordId: id, action: 'mcf_screen_verified',
        occurredAt: reservation.verified_at, reservationId, asin: reservation.asin, reasonCode: null,
        evidenceReference: reservation.verification_evidence_reference ?? null, recordVersion: null });
    }
    if (reservation.state === 'Reconciliation Required') {
      actions.push({ eventKey: `reconciliation:${reservationId}`, creatorRecordId: id, action: 'mcf_reconciliation_required', occurredAt: null,
        reservationId, asin: reservation.asin, reasonCode: reservation.reconciliation_reason ?? null,
        evidenceReference: reservation.reconciliation_evidence_reference ?? null, recordVersion: record.version });
    }
    lanes.set(reservation.asin, {
      creatorRecordId: id, asin: reservation.asin, sku: reservation.sku ?? null, campaignId: reservation.campaign_id ?? null, reservationId,
      laneState: reservation.state ?? 'Reserved', runnerOrderId: null, feeCents: reservation.visible_fee_cents ?? null,
      feeCapCents: reservation.approved_fee_cap_cents ?? null, reservedAt: reservation.reserved_at ?? null, verifiedAt: reservation.verified_at ?? null,
      confirmedAt: null, cancelledAt: null, cancellationReason: null, reconciliationReason: reservation.reconciliation_reason ?? null,
    });
  }
  return {
    record: {
      creatorRecordId: id, brand: record.brand, campaignId: record.campaign_id,
      fingerprints: { storefront: nullable(record.storefront_key), thread: nullable(record.thread_key), fullName: nullable(record.full_name_fp),
        email: nullable(record.email_fp), phone: nullable(record.phone_fp), address: nullable(record.address_fp) },
      recordState: record.record_state, lockState: record.lock_state, escalationReason: record.escalation_reason ?? null,
      runnerVersion: record.version, createdOn: record.created_at, lastVerifiedOn: record.last_verified_at ?? null,
    },
    actions,
    lanes: [...lanes.values()],
  };
}

/** The queue output to rows, with the import's occurrence numbering. */
export function creatorQueueRows(items: readonly CreatorRunnerQueueItem[]): CreatorQueueWrite[] {
  const occurrences = new Map<string, number>();
  return items.map((item) => {
    const occurrence = (occurrences.get(item.queue_id) ?? 0) + 1;
    occurrences.set(item.queue_id, occurrence);
    return {
      runDate: item.run_date, queueId: item.queue_id, occurrence, creatorRecordId: item.creator_record_id === 'UNRESOLVED' ? null : item.creator_record_id,
      brand: item.brand, campaignTab: item.campaign_tab, currentStatus: item.current_status, computedScore: item.computed_score, missing: item.missing,
      dueDate: item.due_date, actionType: item.action_type, gateResult: item.gate_result, queueState: item.queue_state, reason: item.reason,
    };
  });
}

/** The sweep checkpoint to its row, as the import maps it. */
export function creatorSweepRow(checkpoint: CreatorSweepCheckpoint, threads: readonly CreatorSweepThread[]): CreatorSweepWrite {
  const outcomes = threads.length === 0 ? null : Object.fromEntries(CreatorThreadOutcome.options.map((outcome) =>
    [outcome, threads.filter((thread) => thread.outcome === outcome).length])) as Record<CreatorThreadOutcome, number>;
  const c = checkpoint.counts;
  return {
    runId: checkpoint.run_id, runDate: checkpoint.run_date, brand: checkpoint.brand, startedAt: checkpoint.started_at, completedAt: checkpoint.completed_at,
    counts: { mounted: c.mounted, opened: c.opened, changed: c.changed, messagesExamined: c.messages_examined, messagesSent: c.messages_sent,
      noActionAcknowledgements: c.no_action_acknowledgements, heldOrEscalated: c.held_or_escalated, archivedSpam: c.archived_spam, unmatched: c.unmatched },
    outcomes,
    unresolved: threads.filter((thread) => ['unmatched', 'unopened', 'unclassified'].includes(thread.outcome)).slice(0, UNRESOLVED_LIMIT)
      .map((thread) => ({ threadKey: thread.thread_key, amazonTimestamp: thread.amazon_timestamp, outcome: thread.outcome, reason: thread.reason })),
    evidenceReference: checkpoint.evidence_reference,
  };
}

