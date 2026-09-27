import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CreatorImportCounts, CreatorImportRun, CreatorQualification, CreatorSampleOrderKey, CreatorSampleShipment } from './model.js';
import { CreatorQualificationCheck } from './runner.js';

const counts = { read: 5, valid: 4, invalid: 1, inserted: 2, updated: 1, unchanged: 1, removed: 0 };
const kinds = { records: counts, action_log: null, queue_items: null, sweep_runs: null, sample_shipments: null };

describe('Creator Connections model contracts', () => {
  it('keeps the ten checks, the score and the missing list as one result', () => {
    const missing = ['recent_post_verified', 'performance_or_revenue'] as const;
    const checks = Object.fromEntries(CreatorQualificationCheck.options.map((check) => [check, !(missing as readonly string[]).includes(check)]));
    expect(CreatorQualification.safeParse({ score: 8, checks, missing }).success).toBe(true);
    expect(CreatorQualification.safeParse({ score: 10, checks, missing }).success).toBe(false);
    expect(CreatorQualification.safeParse({ score: 8, checks: { ...checks, low_spam_risk: false }, missing }).success).toBe(false);
  });
  it('reconciles import counts: read = valid + invalid, valid = inserted + updated + unchanged', () => {
    expect(CreatorImportCounts.safeParse(counts).success).toBe(true);
    expect(CreatorImportCounts.safeParse({ ...counts, invalid: 0 }).success).toBe(false);
    expect(CreatorImportCounts.safeParse({ ...counts, unchanged: 2 }).success).toBe(false);
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
    const shipment = { creatorRecordId: 'CCR-SW-26-0072', asin: 'B0D9K3M2QP', derivedOrderKey: `CCS-${'0'.repeat(32)}`, sku: 'SW-DERMA-05-FBA',
      campaignId: null, reservationId: 'MCFR-9F2C41AB77E0D3B5', laneState: 'Reconciliation Required', runnerOrderId: null, feeCents: 620,
      feeCapCents: null, reservedAt: null, verifiedAt: null, confirmedAt: null, cancelledAt: null, cancellationReason: null,
      reconciliationReason: 'outcome_unknown', mcf: null, packages: null, source: 'control-runner', importedAt: '2026-09-09T06:14:00Z' };
    expect(CreatorSampleShipment.parse(shipment).packages).toBeNull();
    expect(CreatorSampleShipment.safeParse({ ...shipment, mcf: { status: 'Shipped', operation: 'getFulfillmentOrder', readAt: '2026-09-09T06:14:00Z' } }).success).toBe(false);
  });
});
