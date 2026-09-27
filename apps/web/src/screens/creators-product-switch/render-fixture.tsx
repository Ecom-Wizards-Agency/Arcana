/**
 * Frame 447:219: record CCR-SW-26-0166, whose original ASIN B0D7Q1V8LM is on
 * a merchant-fulfilled SKU that Amazon cannot ship as a sample. Three
 * alternates were checked in live stock: B0D9K3M2QP clears every check and is
 * offered; B0D6H9YY41 is held (merchant-fulfilled, nothing fulfillable) and
 * B0DB4X2NRT is excluded because the catalog disagrees with the campaign.
 * Every id, key, SKU, count and reference is synthetic; the frame's display
 * name and message body are not carried, because Arcana holds neither.
 */
import {
  creatorPreflightChecks, creatorPreflightOutcome, type CreatorDailyQueueItem, type CreatorProductSwitchDetail, type CreatorSamplePreflight,
  type CreatorSwitchPreflight,
} from '@wizard-ads/shared';
import { failedImport, lastImport } from '../creators-daily-queue/render-fixture';
import type { ScreenData } from './view';

export const RECORD = 'CCR-SW-26-0166';
export const ORIGINAL = 'B0D7Q1V8LM';
export const OFFERED = 'B0D9K3M2QP';
/** The original lane's derived order key: synthetic hex in the database's shape. */
export const KEY = 'CCS-7d3e1a09b5c24f68e0a1b2c3d4e5f607';

const ORIGINAL_ERRORS = ['selected_sku_not_mcf_fulfillable'];
export const originalPreflight: CreatorSamplePreflight = {
  id: '33400000-0000-4000-8000-0000000001a1', runId: 'preflight-0166-20260909', creatorRecordId: RECORD, asin: ORIGINAL, derivedOrderKey: KEY,
  result: 'HOLD', computedScore: 10, errors: ORIGINAL_ERRORS, requiredNextState: 'Conflict or Held',
  checks: creatorPreflightChecks(ORIGINAL_ERRORS, [{ check: 'fulfillable_stock', readAt: '2026-09-09T06:36:00.000Z', evidenceReference: 'ev:mcf-inv-17' }]),
  sku: 'SW-DERMA-03-FBM', campaignId: 'campaign-synthetic-01', productTitle: 'Synthetic derma stamp', trackerSourceRef: 'tracker:synthetic-0166',
  quantity: 1, feeCents: null, feeCapCents: 800, recipientBound: true,
  inventory: { asin: ORIGINAL, sku: 'SW-DERMA-03-FBM', fulfillmentChannel: 'merchant-fulfilled', mcfFulfillable: false, fulfillableQuantity: 0,
    checkedAt: '2026-09-09T06:36:00.000Z', evidenceReference: 'ev:mcf-inv-17' },
  preview: null,
  startedAt: '2026-09-09T06:35:40.000Z', completedAt: '2026-09-09T06:36:10.000Z', recordedAt: '2026-09-09T06:40:00.000Z', source: 'control-runner',
};

function alternate(index: number, asin: string, sku: string | null, errors: string[], inventory: CreatorSwitchPreflight['inventory']): CreatorSwitchPreflight {
  return {
    id: `33400000-0000-4000-8000-0000000002a${index}`, runId: `switch-0166-${asin}`, creatorRecordId: RECORD, phase: 'offer', originalAsin: ORIGINAL,
    alternateAsin: asin, alternateSku: sku, result: errors.length === 0 ? 'PASS' : 'HOLD', outcome: creatorPreflightOutcome(errors), errors,
    requiredNextState: errors.length === 0 ? 'Product Switch Pending' : 'Conflict or Held', inventory,
    originalUnavailableReason: 'not_mcf_fulfillable', originalBlockerEvidenceReference: 'ev:mcf-inv-17',
    startedAt: '2026-09-08T13:40:00.000Z', completedAt: '2026-09-08T13:41:00.000Z', recordedAt: '2026-09-08T13:45:00.000Z', source: 'control-runner',
  };
}
const read = (asin: string, sku: string, channel: string, mcf: boolean, units: number | null): CreatorSwitchPreflight['inventory'] => ({
  asin, sku, fulfillmentChannel: channel, mcfFulfillable: mcf, fulfillableQuantity: units, checkedAt: '2026-09-08T13:40:30.000Z',
  evidenceReference: `ev:mcf-inv-${asin}`,
});

/** In the read's order: offered first, then by ASIN. */
export const alternates: CreatorSwitchPreflight[] = [
  alternate(1, OFFERED, 'SW-DERMA-05-FBA', [], read(OFFERED, 'SW-DERMA-05-FBA', 'Amazon-fulfilled', true, 37)),
  alternate(2, 'B0D6H9YY41', 'SW-DERMA-01-FBM', ['selected_sku_not_fba_fulfilled', 'selected_sku_not_mcf_fulfillable', 'insufficient_mcf_fulfillable_quantity'],
    read('B0D6H9YY41', 'SW-DERMA-01-FBM', 'merchant-fulfilled', false, 0)),
  alternate(3, 'B0DB4X2NRT', 'SW-SERUM-02-FBA', ['alternate_asin_not_in_campaign', 'alternate_catalog_asin_mismatch'],
    read('B0DB4X2NRT', 'SW-SERUM-02-FBA', 'Amazon-fulfilled', true, 88)),
];

export const queueItem: CreatorDailyQueueItem = {
  runDate: '2026-09-09', queueId: `20260909-${RECORD}`, occurrence: 1, creatorRecordId: RECORD, brand: 'Sonic Wave', campaignTab: 'Derma stamp 2026',
  currentStatus: 'Product Switch Pending', computedScore: 10, missing: [], dueDate: '2026-09-10', actionType: 'SEND_PRODUCT_SWITCH_FOLLOW_UP',
  gateResult: 'PENDING_APPROVAL', queueState: 'Queued',
  // The runner's reason, `approval;confirmation_{ASIN}`, joined at runtime.
  reason: ['message_send_requires_current_approval', `await_exact_confirmation_${OFFERED}`].join(';'), lockState: 'Unlocked', source: 'control-runner',
};

export const detail: CreatorProductSwitchDetail = {
  lastImport, derivedOrderKey: KEY, creatorRecordId: RECORD, originalAsin: ORIGINAL, lockState: 'Unlocked', status: 'Product Switch Pending',
  originalPreflight, alternates, queueItem,
};

export const ready = { view: 'ready', props: { detail } } satisfies ScreenData;
/**
 * No sample pre-flight on the original lane: the blocker comes from the switch
 * pre-flights. The held alternate's stock was not read, so its units are not
 * read, never 0; and the queue run did not name the record.
 */
export const withoutOriginalPreflight = { view: 'ready', props: { detail: {
  ...detail, originalPreflight: null, queueItem: null, status: null,
  alternates: [alternates[0]!, { ...alternates[1]!, inventory: null }, alternates[2]!],
} } } satisfies ScreenData;
/** The record is known and the original held, but no switch pre-flight ran: not measured, not "no alternates". */
export const notMeasured = { view: 'ready', props: { detail: { ...detail, alternates: [] } } } satisfies ScreenData;
/** Nothing Arcana holds carries the key. */
export const empty = { view: 'ready', props: { detail: {
  lastImport, derivedOrderKey: 'CCS-00000000000000000000000000000abc', creatorRecordId: null, originalAsin: null, lockState: null, status: null,
  originalPreflight: null, alternates: [], queueItem: null,
} } } satisfies ScreenData;
export const missing = { view: 'missing', props: { key: null } } satisfies ScreenData;
export const refused = { view: 'ready', props: { detail: { ...detail, lastImport: failedImport } } } satisfies ScreenData;
