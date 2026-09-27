/**
 * Pre-flights after frames 446:2 and 446:313. 0088 holds on all eight checks
 * with a preview read at 06:33:17; 0151 is held at check seven because its SKU
 * is merchant-fulfilled. Every value, key and evidence reference is synthetic,
 * and nothing here names a creator: Arcana holds fingerprints only.
 */
import { creatorPreflightChecks, type CreatorPreflightCheck, type CreatorPreflightDetail, type CreatorSamplePreflight } from '@wizard-ads/shared';
import { failedImport, lastImport } from '../creators-daily-queue/render-fixture';
import { ambiguous, shipped } from '../creators-sample-shipments/render-fixture';
import type { ScreenData } from './view';

const reads = (record: string, times: readonly (string | null)[]) => (['identity', 'qualification', 'agreement', 'recipient', 'no_prior_sample',
  'quantity_shipping_fee', 'fulfillable_stock', 'form'] as const satisfies readonly CreatorPreflightCheck[])
  .flatMap((check, index) => times[index] === null ? [] : [{ check, readAt: `2026-09-09T${times[index]}.000Z`, evidenceReference: `ev:${check}-${record}` }]);

export const passing: CreatorSamplePreflight = {
  id: '33400000-0000-4000-8000-000000000088', runId: 'preflight-0088-20260909', creatorRecordId: 'CCR-SW-26-0088', asin: 'B0D9K3M2QP',
  derivedOrderKey: shipped.derivedOrderKey, result: 'PASS', computedScore: 10, errors: [], requiredNextState: 'Locked for MCF',
  checks: creatorPreflightChecks([], reads('0088', ['06:33:04', '06:33:05', '06:33:07', '06:33:09', '06:33:11', '06:33:14', '06:33:17', '06:33:19'])),
  sku: 'SW-DERMA-05-FBA', campaignId: 'Derma stamp 2026', productTitle: 'Derma stamp roller, 0.5mm', trackerSourceRef: 'tracker row 87',
  quantity: 1, feeCents: 620, feeCapCents: 800, recipientBound: true,
  inventory: { asin: 'B0D9K3M2QP', sku: 'SW-DERMA-05-FBA', fulfillmentChannel: 'AFN', mcfFulfillable: true, fulfillableQuantity: 37,
    checkedAt: '2026-09-09T06:33:17.000Z', evidenceReference: 'ev:mcf-inv-16' },
  preview: { operation: 'getFulfillmentPreview', readAt: '2026-09-09T06:33:17.000Z', validUntil: null, isFulfillable: true, feeCents: 620, currency: 'EUR',
    constraints: [] },
  startedAt: '2026-09-09T06:33:04.000Z', completedAt: '2026-09-09T06:33:19.000Z', recordedAt: '2026-09-09T06:34:00.000Z', source: 'mcp',
};

const HELD_KEY = 'CCS-0151a9c3e5f7092b4d6f8a1c3e5b7d90';
export const held: CreatorSamplePreflight = {
  ...passing, id: '33400000-0000-4000-8000-000000000151', runId: 'preflight-0151-20260909', creatorRecordId: 'CCR-SW-26-0151', asin: 'B0D7Q1V8LM',
  derivedOrderKey: HELD_KEY, result: 'HOLD', errors: ['selected_sku_not_mcf_fulfillable'], requiredNextState: 'Conflict or Held',
  // The eighth check left no read time and no error: it passed, and only its read time was not recorded.
  checks: creatorPreflightChecks(['selected_sku_not_mcf_fulfillable'],
    reads('0151', ['06:31:02', '06:31:03', '06:31:04', '06:31:06', '06:31:07', '06:31:09', '06:31:11', null])),
  sku: 'SW-DERMA-03-FBM', trackerSourceRef: 'tracker row 118', productTitle: 'Derma stamp roller, 0.3mm', feeCents: null, recipientBound: true,
  inventory: { asin: 'B0D7Q1V8LM', sku: 'SW-DERMA-03-FBM', fulfillmentChannel: 'MFN', mcfFulfillable: false, fulfillableQuantity: 0,
    checkedAt: '2026-09-09T06:31:11.000Z', evidenceReference: 'ev:mcf-inv-15' },
  preview: null, startedAt: '2026-09-09T06:31:02.000Z', completedAt: '2026-09-09T06:31:11.000Z',
};

const base: CreatorPreflightDetail = {
  lastImport, derivedOrderKey: passing.derivedOrderKey, creatorRecordId: passing.creatorRecordId, asin: passing.asin, lockState: 'Unlocked',
  preflight: passing, earlierRuns: 0, lane: shipped,
};
/** Six minutes after the preview read: inside the thirty-minute window. */
export const NOW = '2026-09-09T06:40:00.000Z';
export const ready = { view: 'ready', props: { detail: base, now: NOW } } satisfies ScreenData;
export const stale = { view: 'ready', props: { detail: { ...base, earlierRuns: 2 }, now: '2026-09-09T07:30:00.000Z' } } satisfies ScreenData;
export const heldAtStock = { view: 'ready', props: { now: NOW, detail: { ...base, derivedOrderKey: HELD_KEY, creatorRecordId: held.creatorRecordId,
  asin: held.asin, lockState: null, preflight: held, lane: null } } } satisfies ScreenData;
export const refused = { view: 'ready', props: { detail: { ...base, lastImport: failedImport }, now: NOW } } satisfies ScreenData;
/** The lane is reserved, and no pre-flight was ever recorded for it. */
export const notMeasured = { view: 'ready', props: { now: NOW, detail: { ...base, derivedOrderKey: ambiguous.derivedOrderKey,
  creatorRecordId: ambiguous.creatorRecordId, preflight: null, lane: ambiguous } } } satisfies ScreenData;
export const nothingHeld = { view: 'ready', props: { now: NOW, detail: { ...base, derivedOrderKey: 'CCS-00000000000000000000000000000999',
  creatorRecordId: null, asin: null, lockState: null, preflight: null, lane: null } } } satisfies ScreenData;
export const malformed = { view: 'missing', props: { key: null } } satisfies ScreenData;
