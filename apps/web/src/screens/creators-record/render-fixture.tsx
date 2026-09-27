/**
 * Frame 445:2 from CREATOR-FIXTURE.json: record CCR-SW-26-0134, resolved on
 * the storefront rung, with the tracker typing 10 where the runner computes 8.
 * Fingerprints are SHA-256 over synthetic labels; the refused candidate and
 * every event are synthetic. The fixture's refusal of 0091 is a display-name
 * string match, which Arcana cannot see (it holds no names); the runner's own
 * rule, one contact fingerprint where two are needed, stands in for it.
 */
import { createHash } from 'node:crypto';
import type { CreatorDraft, CreatorRecord, CreatorRecordDetail, CreatorRecordEvent, CreatorSampleShipment } from '@wizard-ads/shared';
import { failedImport, items, lastImport } from '../creators-daily-queue/render-fixture';
import { ambiguous } from '../creators-sample-shipments/render-fixture';
import type { ScreenData } from './view';

export const fingerprint = (label: string) => createHash('sha256').update(`synthetic:${label}`).digest('hex');

export const record: CreatorRecord = {
  creatorRecordId: 'CCR-SW-26-0134', brand: 'Sonic Wave', campaignId: 'campaign-synthetic-01',
  fingerprints: { storefront: fingerprint('storefront-0134'), thread: fingerprint('thread-0134'), fullName: fingerprint('name-0134'),
    email: null, phone: null, address: fingerprint('address-0134') },
  recordState: 'Active', lockState: 'Unlocked', escalationReason: null, runnerVersion: 3, createdOn: '2026-09-02', lastVerifiedOn: '2026-09-07',
  status: 'Verification Confirmed',
  qualification: { score: 8, missing: ['recent_post_verified', 'performance_or_revenue'], checks: {
    complete_fulfillment_details: true, requested_asin: true, exact_product_match: true, storefront_visible: true, recent_post_verified: false,
    content_quality: true, category_fit: true, performance_or_revenue: false, specific_asin_mentioned: true, low_spam_risk: true } },
  qualifiedOn: '2026-09-09', source: 'control-runner', importedAt: '2026-09-09T06:14:00.000Z',
};

const event = (change: Partial<CreatorRecordEvent> & Pick<CreatorRecordEvent, 'eventKey' | 'action'>): CreatorRecordEvent => ({
  occurredAt: null, recordedAt: '2026-09-09T06:14:00.000Z', reservationId: null, asin: null, reasonCode: null, evidenceReference: null,
  recordVersion: null, relatedRecordIds: [], draftId: null, actorUserId: null, source: 'mcp', ...change,
});
export const DRAFT_ID = '33300000-0000-4000-8000-0000000000d1';
/** Newest first, as the read returns them; the oldest came from the file import and kept no time. */
export const events: CreatorRecordEvent[] = [
  event({ eventKey: 'draft:approved-0134', action: 'draft_approved', occurredAt: '2026-09-09T07:05:00.000Z', recordedAt: '2026-09-09T07:05:00.000Z',
    reasonCode: 'first_base_verification', draftId: DRAFT_ID, source: 'web', actorUserId: '10000000-0000-4000-8000-000000000001' }),
  event({ eventKey: 'score:0134:20260909', action: 'score_recorded', occurredAt: '2026-09-09T06:21:00.000Z', recordedAt: '2026-09-09T06:21:00.000Z',
    reasonCode: 'tracker_score_disagrees' }),
  event({ eventKey: 'msg:0134:2', action: 'message_sent_by_hand', occurredAt: '2026-09-07T06:38:00.000Z', recordedAt: '2026-09-07T06:40:00.000Z',
    evidenceReference: 'ev:thread-0134-2' }),
  event({ eventKey: 'identity:0134', action: 'identity_resolved', occurredAt: '2026-09-05T06:41:00.000Z', recordedAt: '2026-09-05T06:41:00.000Z',
    reasonCode: 'storefront' }),
  event({ eventKey: 'registry:0134:v2:cancel', action: 'mcf_reservation_cancelled', source: 'control-runner', recordedAt: '2026-09-04T06:14:00.000Z',
    reservationId: 'MCFR-LEGACY-0A1B2C3D4E5F', asin: 'B0D7Q1V8LM', reasonCode: 'expired_before_submit', recordVersion: 2 }),
];
export const shipment: CreatorSampleShipment = {
  ...ambiguous, creatorRecordId: 'CCR-SW-26-0134', asin: 'B0D7Q1V8LM', derivedOrderKey: 'CCS-0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  reservationId: 'MCFR-LEGACY-0A1B2C3D4E5F', laneState: 'Cancelled', verifiedAt: null, cancelledAt: '2026-09-04T06:00:00.000Z',
  cancellationReason: 'expired_before_submit', reconciliationReason: null,
};
export const draft: CreatorDraft = {
  id: DRAFT_ID, creatorRecordId: 'CCR-SW-26-0134', threadKey: fingerprint('thread-0134'), templateKey: 'first_base_verification',
  body: 'Hi {first name}, synthetic reply text for the verification follow-up.', draftDate: '2026-09-09', status: 'approved',
  createdBy: '10000000-0000-4000-8000-000000000001', createdAt: '2026-09-09T06:50:00.000Z', approvedBy: '10000000-0000-4000-8000-000000000001',
  approvedAt: '2026-09-09T07:05:00.000Z', closedBy: null, closedAt: null, source: 'mcp',
};

export const detail: CreatorRecordDetail = {
  lastImport, record, trackerScore: { score: 10, scoredOn: '2026-09-09' },
  identity: { rung: 'storefront', recordedAt: '2026-09-05T06:41:00.000Z', source: 'mcp' },
  refusedCandidates: [
    { creatorRecordId: 'CCR-SW-26-0091', lockState: 'Unlocked', shared: ['fullName'], rule: 'one_contact_fingerprint' },
    { creatorRecordId: 'CCR-SW-26-0144', lockState: 'Unlocked', shared: ['thread'], rule: 'thread_on_other_campaign' },
  ],
  matching: [],
  queueItem: items.find((item) => item.creatorRecordId === 'CCR-SW-26-0134')!,
  events, shipments: [shipment], drafts: [draft],
};

export const ready = { view: 'ready', props: { detail, canDecide: true } } satisfies ScreenData;
export const refused = { view: 'ready', props: { detail: { ...detail, lastImport: failedImport }, canDecide: true } } satisfies ScreenData;
/** A record the import registered and nothing has scored, resolved or logged: not measured, never 0 / 10. */
export const notMeasured = { view: 'ready', props: { detail: {
  ...detail, record: { ...record, status: null, qualification: null, qualifiedOn: null }, trackerScore: null, identity: null, refusedCandidates: [],
  queueItem: null, events: [], shipments: [], drafts: [],
}, canDecide: true } } satisfies ScreenData;
/** 0117 and 0203 share a storefront: both are locked in Conflict. */
export const conflicted = { view: 'ready', props: { detail: {
  ...detail, record: { ...record, creatorRecordId: 'CCR-SW-26-0117', lockState: 'Conflict', status: 'New Inquiry' }, identity: null,
  refusedCandidates: [], matching: [{ creatorRecordId: 'CCR-SW-26-0203', lockState: 'Conflict', shared: ['storefront'] }],
  queueItem: items.find((item) => item.creatorRecordId === 'CCR-SW-26-0117')!, events: [], shipments: [], drafts: [draft],
}, canDecide: true } } satisfies ScreenData;
export const missing = { view: 'missing', props: { id: 'CCR-SW-26-0999' } } satisfies ScreenData;
export const malformed = { view: 'missing', props: { id: null } } satisfies ScreenData;
