/**
 * Render data for page `13 · Creator Connections`, derived from the design's
 * single reconciled synthetic fixture (`CREATOR-FIXTURE.json`, as of 9 Sep
 * 2026). The counts, tiles, sweep numbers and named records are the fixture's;
 * rows the fixture only counts carry placeholder ids and are not asserted.
 * Nothing here is from a real run.
 */
import type { CreatorDailyQueueItem, CreatorImportRun, CreatorQueueAction, CreatorQueueSnapshot, CreatorSweepRun } from '@wizard-ads/shared';
import type { ScreenData } from './view';

export const AS_OF = { date: '2026-09-09', sweepRun: '2026-09-09T06:12:00.000Z', trackerRead: '2026-09-09T06:14:00.000Z' } as const;
export const BRAND = 'Sonic Wave';
export const TRACKER_TAB = 'Derma stamp 2026';

const counts = (read: number) => ({ read, valid: read, invalid: 0, inserted: 0, updated: 0, unchanged: read, removed: 0 });
export const lastImport: CreatorImportRun = {
  id: '33200000-0000-4000-8000-0000000000a1', startedAt: '2026-09-09T06:13:58.000Z', finishedAt: AS_OF.trackerRead, status: 'succeeded',
  failure: null, failedFile: null, files: ['registry', 'queue', 'sweep_checkpoint', 'mcf_reservations'], queueRunDate: AS_OF.date,
  counts: { records: counts(272), action_log: counts(0), queue_items: counts(34), sweep_runs: counts(1), sample_shipments: counts(2) },
  source: 'control-runner',
};
export const failedImport: CreatorImportRun = {
  ...lastImport, id: '33200000-0000-4000-8000-0000000000a2', status: 'failed', failure: 'file_shape_invalid', failedFile: 'queue', queueRunDate: null,
  counts: { records: null, action_log: null, queue_items: null, sweep_runs: null, sample_shipments: null },
};

/** `sweep` in the fixture: 359 + 37 + 9 + 7 = 412, and seven unmatched, so it did not reconcile. */
export const sweep: CreatorSweepRun = {
  runId: 'sweep-20260909-0612', runDate: AS_OF.date, brand: BRAND, startedAt: null, completedAt: AS_OF.sweepRun,
  counts: { mounted: 412, opened: 412, changed: 37, messagesExamined: 96, messagesSent: 0, noActionAcknowledgements: 359, heldOrEscalated: 9,
    archivedSpam: 5, unmatched: 7 },
  reconciled: false, outcomes: null, unresolved: [], evidenceReference: 'ev:sweep-0909', source: 'control-runner', importedAt: AS_OF.trackerRead,
};

const ALL_MISSING = ['complete_fulfillment_details', 'requested_asin', 'exact_product_match', 'storefront_visible', 'recent_post_verified',
  'content_quality', 'category_fit', 'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk'] as const;
let placeholder = 300;
let unresolved = 0;
function row(action: CreatorQueueAction, change: Partial<CreatorDailyQueueItem> = {}): CreatorDailyQueueItem {
  const id = change.creatorRecordId === undefined ? `CCR-SW-26-0${placeholder++}` : change.creatorRecordId;
  const queueId = `20260909-${id ?? 'UNRESOLVED'}`;
  const occurrence = id === null ? ++unresolved : 1;
  const missing = change.missing ?? [];
  return {
    runDate: AS_OF.date, queueId, occurrence, creatorRecordId: id, brand: BRAND, campaignTab: TRACKER_TAB,
    currentStatus: 'First-Base Pass', computedScore: 10 - missing.length, missing, dueDate: AS_OF.date, actionType: action, gateResult: 'HOLD',
    queueState: 'Queued', reason: 'synthetic_placeholder', lockState: 'Unlocked', source: 'control-runner', ...change,
  };
}
const times = <T,>(n: number, make: (index: number) => T) => Array.from({ length: n }, (_, index) => make(index));

/**
 * 34 rows, each one a shape `creator_control.py` `queue_item` can emit. Where
 * CREATOR-FIXTURE.json asks for a row the runner cannot produce, the runner
 * wins and the drift is listed here for the design round:
 * - IDENTITY_RESOLUTION is emitted only for an unresolved thread (BLOCKED,
 *   Escalated), so its three rows carry no record id. The two Conflict-locked
 *   records (0117, 0203) appear under the work their status produces.
 * - RECONCILE_PRODUCT_SWITCH is emitted only BLOCKED and Escalated (no verified
 *   alternate); a switch with an alternate that is due becomes
 *   SEND_PRODUCT_SWITCH_FOLLOW_UP. So 6 becomes 5 + 1, and 0166 (due
 *   2026-09-10) is not in the day's queue.
 * - Held or blocked is every HOLD and BLOCKED gate: 20, not the fixture's 8.
 *   Queued/Escalated is 24/10, not 31/3. Records without action: 241, not 238.
 * In the queue (34), awaiting approval (14) and locked (2) match the fixture.
 */
export const items: CreatorDailyQueueItem[] = [
  ...times(3, () => row('IDENTITY_RESOLUTION', { creatorRecordId: null, currentStatus: '', gateResult: 'BLOCKED', queueState: 'Escalated',
    lockState: null, reason: 'missing_creator_record_id' })),
  row('BACKGROUND_CHECK', { creatorRecordId: 'CCR-SW-26-0117', currentStatus: 'New Inquiry', lockState: 'Conflict',
    missing: [...ALL_MISSING.slice(4)], reason: 'new_inquiry_requires_visible_evidence' }),
  ...times(5, () => row('BACKGROUND_CHECK', { currentStatus: 'New Inquiry', missing: [...ALL_MISSING.slice(4)], reason: 'new_inquiry_requires_visible_evidence' })),
  row('SEND_TAILORED_VERIFICATION_FOLLOW_UP', { creatorRecordId: 'CCR-SW-26-0203', currentStatus: 'First-Base Pass', gateResult: 'PENDING_APPROVAL',
    lockState: 'Conflict', missing: ['complete_fulfillment_details'], reason: 'message_send_requires_current_approval;missing_complete_fulfillment_details' }),
  ...times(10, () => row('SEND_TAILORED_VERIFICATION_FOLLOW_UP', { currentStatus: 'Verification Sent', gateResult: 'PENDING_APPROVAL',
    missing: ['complete_fulfillment_details'], reason: 'message_send_requires_current_approval;missing_complete_fulfillment_details' })),
  row('RECONCILE_QUALIFICATION', { creatorRecordId: 'CCR-SW-26-0134', currentStatus: 'Verification Confirmed', gateResult: 'BLOCKED', queueState: 'Escalated',
    missing: ['recent_post_verified', 'performance_or_revenue'], reason: 'status_score_drift' }),
  row('RECONCILE_QUALIFICATION', { currentStatus: 'Approved for Sample', gateResult: 'BLOCKED', queueState: 'Escalated', missing: ['low_spam_risk'], reason: 'status_score_drift' }),
  ...(['CCR-SW-26-0088', 'CCR-SW-26-0151', 'CCR-SW-26-0072', 'CCR-SW-26-0209'] as const).map((id) => row('MCF_PREFLIGHT', {
    creatorRecordId: id, currentStatus: 'Approved for Sample', lockState: id === 'CCR-SW-26-0072' ? 'Locked for MCF' : 'Unlocked',
    reason: 'paid_order_requires_preflight_and_authorized_executor' })),
  ...times(5, () => row('RECONCILE_PRODUCT_SWITCH', { currentStatus: 'Product Switch Pending', gateResult: 'BLOCKED', queueState: 'Escalated',
    reason: 'missing_verified_alternate_asin' })),
  row('SEND_PRODUCT_SWITCH_FOLLOW_UP', { currentStatus: 'Product Switch Pending', gateResult: 'PENDING_APPROVAL',
    // The runner's reason, `approval;confirmation_{ASIN}`, joined at runtime.
    reason: ['message_send_requires_current_approval', 'await_exact_confirmation_B0D9K3M2QP'].join(';') }),
  ...times(2, () => row('SEND_CONTENT_FOLLOW_UP', { currentStatus: 'Delivered / Awaiting Content', gateResult: 'PENDING_APPROVAL',
    reason: 'message_send_requires_current_approval;track_performance_and_request_video_link' })),
];

export const snapshot: CreatorQueueSnapshot = { lastImport, runDate: AS_OF.date, items, registryRecords: 272, sweep };
export const ready = { view: 'ready', props: { snapshot } } satisfies ScreenData;
/** Frame 443:244: the last read failed, so nothing is shown as today's. */
export const refused = { view: 'ready', props: { snapshot: { ...snapshot, lastImport: failedImport } } } satisfies ScreenData;
/** Frame 443:406: a queue run with no rows, over records that did not move. */
export const workedToZero = { view: 'ready', props: { snapshot: { ...snapshot, items: [] } } } satisfies ScreenData;
/** An import that read the registry but no queue file: the day is not measured, not zero. */
export const noQueueFile = { view: 'ready', props: { snapshot: { ...snapshot, runDate: null, items: [],
  lastImport: { ...lastImport, files: ['registry'], queueRunDate: null, counts: { ...lastImport.counts, queue_items: null, sweep_runs: null } } } } } satisfies ScreenData;
export const notImported = { view: 'ready', props: { snapshot: { lastImport: null, runDate: null, items: [], registryRecords: 0, sweep: null } } } satisfies ScreenData;
