import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CreatorActionLogEntry, CreatorActionSource, CreatorImportCounts, CreatorImportRun, CreatorLaneCancellationReason, CreatorQualification,
  CreatorSampleOrderKey, CreatorSampleShipment, CreatorSource,
} from './model.js';
import { CreatorCancellationReason, CreatorQualificationCheck } from './runner.js';
import { CreatorSamplePreflight, CreatorSwitchPreflight } from './samples.js';

const counts = { read: 5, valid: 4, invalid: 1, inserted: 2, updated: 1, unchanged: 1, removed: 0 };
const kinds = { records: counts, action_log: null, queue_items: null, sweep_runs: null, sample_shipments: null };
/** A lane row as stored before WP-338m: no order owner. */
const lane = { creatorRecordId: 'CCR-SW-26-0072', asin: 'B0D9K3M2QP', derivedOrderKey: `CCS-${'0'.repeat(32)}`, sku: 'SW-DERMA-05-FBA',
  campaignId: null, reservationId: 'MCFR-9F2C41AB77E0D3B5', laneState: 'Reconciliation Required', runnerOrderId: null, feeCents: 620,
  feeCapCents: null, reservedAt: null, verifiedAt: null, confirmedAt: null, cancelledAt: null, cancellationReason: null,
  reconciliationReason: 'outcome_unknown', mcf: null, packages: null, source: 'control-runner', importedAt: '2026-09-09T06:14:00Z' };

describe('Creator Connections model contracts', () => {
  it('keeps the ten checks, the score and the missing list as one result', () => {
    const missing = ['recent_post_verified', 'performance_or_revenue'] as const;
    const checks = Object.fromEntries(CreatorQualificationCheck.options.map((check) => [check, !(missing as readonly string[]).includes(check)]));
    expect(CreatorQualification.safeParse({ score: 8, checks, missing }).success).toBe(true);
    expect(CreatorQualification.safeParse({ score: 10, checks, missing }).success).toBe(false);
    expect(CreatorQualification.safeParse({ score: 8, checks: { ...checks, low_spam_risk: false }, missing }).success).toBe(false);
  });
  it('reconciles import counts: read = valid + invalid, valid = inserted + updated + unchanged + skipped', () => {
    expect(CreatorImportCounts.parse(counts)).toEqual({ ...counts, skipped: 0 });
    expect(CreatorImportCounts.safeParse({ ...counts, invalid: 0 }).success).toBe(false);
    expect(CreatorImportCounts.safeParse({ ...counts, unchanged: 2 }).success).toBe(false);
    const skipped = { ...counts, read: 6, valid: 5, skipped: 1 };
    expect(CreatorImportCounts.parse(skipped).skipped).toBe(1);
    expect(CreatorImportCounts.safeParse({ ...skipped, skipped: 2 }).success).toBe(false);
    expect(CreatorImportCounts.safeParse({ ...counts, skipped: 1 }).success).toBe(false);
  });
  it('reads a stored import run from before skipped existed: every kind skipped none, and the counts still reconcile', () => {
    const run = { id: '33200000-0000-4000-8000-000000000002', startedAt: '2026-09-09T06:14:00Z', finishedAt: '2026-09-09T06:14:01Z',
      status: 'succeeded', failure: null, failedFile: null, files: ['registry', 'mcf_reservations'], queueRunDate: null,
      counts: { ...kinds, sample_shipments: { ...counts, read: 3, valid: 3, invalid: 0, inserted: 0, updated: 0, unchanged: 3 } }, source: 'control-runner' };
    const parsed = CreatorImportRun.parse(run);
    expect(parsed.counts.records).toEqual({ ...counts, skipped: 0 });
    expect(parsed.counts.sample_shipments?.skipped).toBe(0);
    expect(parsed.counts.preflights).toBeNull();
    expect(CreatorImportRun.safeParse({ ...run, counts: { ...kinds, records: { ...counts, skipped: 1 } } }).success).toBe(false);
  });
  it('pairs a failure code with a failed run only, and keeps absent files null rather than zero', () => {
    const run = { id: '33200000-0000-4000-8000-000000000001', startedAt: '2026-09-09T06:14:00Z', finishedAt: '2026-09-09T06:14:01Z',
      status: 'succeeded', failure: null, failedFile: null, files: ['registry'], queueRunDate: null, counts: kinds, source: 'control-runner' };
    expect(CreatorImportRun.parse(run).counts.action_log).toBeNull();
    expect(CreatorImportRun.safeParse({ ...run, failure: 'file_unreadable' }).success).toBe(false);
    expect(CreatorImportRun.safeParse({ ...run, status: 'failed' }).success).toBe(false);
    expect(CreatorImportRun.safeParse({ ...run, counts: { records: counts } }).success).toBe(false);
  });
  it('derives the sample order key from organisation, record and ASIN, with no date, inside the 40-character order id limit', () => {
    const key = `CCS-${createHash('sha256').update('33200000-0000-4000-8000-000000000001|CCR-SW-26-0072|B0D9K3M2QP').digest('hex').slice(0, 32)}`;
    expect(CreatorSampleOrderKey.parse(key)).toHaveLength(36);
    expect(CreatorSampleOrderKey.safeParse('CC-SW-DERMA05-0072-B0D9K3M2QP-260908').success).toBe(false);
  });
  it('keeps an unread Amazon order unread: no MCF status and no packages', () => {
    const shipment = lane;
    expect(CreatorSampleShipment.parse(shipment).packages).toBeNull();
    expect(CreatorSampleShipment.safeParse({ ...shipment, mcf: { status: 'Shipped', operation: 'getFulfillmentOrder', readAt: '2026-09-09T06:14:00Z' } }).success).toBe(false);
  });
  it('reads a lane from before the order owner existed as the runner\'s, and takes an Arcana-placed lane', () => {
    expect(CreatorSampleShipment.parse(lane).orderOwner).toBe('runner');
    expect(CreatorSampleShipment.parse({ ...lane, orderOwner: 'arcana' }).orderOwner).toBe('arcana');
    expect(CreatorSampleShipment.safeParse({ ...lane, orderOwner: 'amazon' }).success).toBe(false);
    expect(CreatorSampleShipment.safeParse({ ...lane, orderOwner: null }).success).toBe(false);
  });
  it('releases a lane for the runner\'s six reasons and the two only an Arcana-placed order reaches', () => {
    expect(CreatorLaneCancellationReason.options).toEqual([...CreatorCancellationReason.options, 'amazon_cancelled_after_submit', 'operator_cancelled_in_amazon']);
    const cancelled = { ...lane, orderOwner: 'arcana', laneState: 'Cancelled', cancelledAt: '2026-09-10T08:00:00Z', reconciliationReason: null };
    for (const cancellationReason of CreatorLaneCancellationReason.options) {
      expect(CreatorSampleShipment.safeParse({ ...cancelled, cancellationReason }).success, cancellationReason).toBe(true);
    }
    expect(CreatorSampleShipment.parse({ ...cancelled, cancellationReason: 'operator_cancelled_in_amazon' }).cancellationReason).toBe('operator_cancelled_in_amazon');
    expect(CreatorSampleShipment.safeParse({ ...cancelled, cancellationReason: 'outcome_unknown' }).success).toBe(false);
    // A runner lane keeps the runner's six; a lane read without an owner is the runner's.
    const runnerLane = { ...cancelled, orderOwner: 'runner' };
    expect(CreatorSampleShipment.safeParse({ ...runnerLane, cancellationReason: 'expired_before_submit' }).success).toBe(true);
    for (const cancellationReason of ['amazon_cancelled_after_submit', 'operator_cancelled_in_amazon']) {
      expect(CreatorSampleShipment.safeParse({ ...runnerLane, cancellationReason }).success, cancellationReason).toBe(false);
      const { orderOwner: _owner, ...unowned } = { ...runnerLane, cancellationReason };
      expect(CreatorSampleShipment.safeParse(unowned).success, cancellationReason).toBe(false);
    }
  });
  it('lets only the action log name the MCF worker as its writer', () => {
    expect(CreatorSource.options).toEqual(['control-runner', 'mcp', 'web']);
    expect(CreatorActionSource.options).toEqual(['control-runner', 'mcp', 'web', 'worker']);
    const entry = { eventKey: 'mcf-send:synthetic-1:approved', creatorRecordId: 'CCR-SW-26-0072', action: 'mcf_send_approved',
      occurredAt: '2026-09-09T06:38:00Z', reservationId: 'MCFR-9F2C41AB77E0D3B5', asin: 'B0D9K3M2QP', reasonCode: null, evidenceReference: null,
      recordVersion: null, source: 'worker', recordedAt: '2026-09-09T06:38:01Z' };
    expect(CreatorActionLogEntry.parse(entry).source).toBe('worker');
    for (const action of ['mcf_send_placed', 'mcf_send_failed', 'mcf_send_uncertain', 'mcf_send_cancelled']) {
      expect(CreatorActionLogEntry.safeParse({ ...entry, action }).success, action).toBe(true);
    }
    expect(CreatorActionLogEntry.safeParse({ ...entry, action: 'mcf_send_dispatched' }).success).toBe(false);
    expect(CreatorSampleShipment.safeParse({ ...lane, source: 'worker' }).success).toBe(false);
    expect(CreatorSamplePreflight.shape.source.safeParse('worker').success).toBe(false);
    expect(CreatorSwitchPreflight.shape.source.safeParse('worker').success).toBe(false);
    expect(CreatorImportRun.safeParse({ id: '33200000-0000-4000-8000-000000000003', startedAt: '2026-09-09T06:14:00Z',
      finishedAt: '2026-09-09T06:14:01Z', status: 'succeeded', failure: null, failedFile: null, files: [], queueRunDate: null,
      counts: kinds, source: 'worker' }).success).toBe(false);
  });
});
