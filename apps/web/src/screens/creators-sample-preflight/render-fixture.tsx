/**
 * Pre-flights after frames 446:2 and 446:313. 0088 holds on all eight checks
 * with a preview read at 06:33:17; 0151 is held at check seven because its SKU
 * is merchant-fulfilled. Every value, key and evidence reference is synthetic,
 * and nothing here names a creator: Arcana holds fingerprints only.
 */
import {
  CREATOR_MCF_IRREVERSIBILITY, CreatorMcfCancelPreview, CreatorMcfSendPreview, creatorPreflightChecks, type CreatorMcfSendState, type CreatorPreflightCheck, type CreatorPreflightDetail,
  type CreatorSamplePreflight, type CreatorSampleShipment,
} from '@wizard-ads/shared';
import type { CreatorMcfLaneCancel, CreatorMcfLaneSend, CreatorMcfLaneView, CreatorMcfSendGate } from '@wizard-ads/db';
import type { SendData } from './send-model';
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
/** No grant, no worker and no key: the state every deployment starts in. */
export const GATE_OFF: CreatorMcfSendGate = {
  active: false, sendingOn: false, missing: ['grant', 'heartbeat'], actions: [], expiresAt: null, keyIds: [], spapiConnectionId: null, marketplaceId: null,
  maxFeeMinor: null, currency: null, unitsToday: null, maxUnitsPerDay: null, heartbeat: null, residue: { expiredLive: 0, custodyFreeLive: 0 },
};
export const sendOff: SendData = { canAct: true, orgId: '33400000-0000-4000-8000-0000000000a0', gate: GATE_OFF, key: { status: 'absent' }, mcf: null };
export const ready = { view: 'ready', props: { detail: base, now: NOW, send: sendOff } } satisfies ScreenData;
export const stale = { view: 'ready', props: { detail: { ...base, earlierRuns: 2 }, now: '2026-09-09T07:30:00.000Z', send: sendOff } } satisfies ScreenData;
export const heldAtStock = { view: 'ready', props: { now: NOW, send: sendOff, detail: { ...base, derivedOrderKey: HELD_KEY, creatorRecordId: held.creatorRecordId,
  asin: held.asin, lockState: null, preflight: held, lane: null } } } satisfies ScreenData;
export const refused = { view: 'ready', props: { detail: { ...base, lastImport: failedImport }, now: NOW, send: null } } satisfies ScreenData;
/** The lane is reserved, and no pre-flight was ever recorded for it. */
export const notMeasured = { view: 'ready', props: { now: NOW, send: sendOff, detail: { ...base, derivedOrderKey: ambiguous.derivedOrderKey,
  creatorRecordId: ambiguous.creatorRecordId, preflight: null, lane: ambiguous } } } satisfies ScreenData;
export const nothingHeld = { view: 'ready', props: { now: NOW, send: null, detail: { ...base, derivedOrderKey: 'CCS-00000000000000000000000000000999',
  creatorRecordId: null, asin: null, lockState: null, preflight: null, lane: null } } } satisfies ScreenData;
export const malformed = { view: 'missing', props: { key: null } } satisfies ScreenData;

// ---------------------------------------------------------------------------
// Arcana's send (WP-338g): a lane the runner reserved for 0088, a grant, a
// worker heartbeat and a key id, all synthetic. The mask is the only trace of
// an address anywhere in these fixtures.
// ---------------------------------------------------------------------------

export const KEY_ID = '5e'.repeat(32);
const CONNECTION = '33800000-0000-4000-8000-000000000c01';
export const SEND_ID = '33800000-0000-4000-8000-000000000501';
/** The runner reserved 0088's lane; nothing is ordered yet. */
export const reservedLane: CreatorSampleShipment = { ...shipped, laneState: 'Reserved', runnerOrderId: null, confirmedAt: null, mcf: null, packages: null };
export const GATE_ON: CreatorMcfSendGate = {
  active: true, sendingOn: true, missing: [], actions: ['send'], expiresAt: '2026-10-09T00:00:00.000Z', keyIds: [KEY_ID], spapiConnectionId: CONNECTION,
  marketplaceId: 'ATVPDKIKX0DER', maxFeeMinor: 1500, currency: 'USD', unitsToday: 2, maxUnitsPerDay: 5,
  heartbeat: { beatAt: '2026-09-09T06:39:10.000Z', previewEnabled: true, dispatchEnabled: true, scopeCovers: true, workerRevision: 'synthetic-rev',
    lastAuthorizationFailureAt: null },
  residue: { expiredLive: 0, custodyFreeLive: 0 },
};
/** A public JWK shape only; nothing here seals. The DOM test generates a real key pair at run time. */
export const KEY = { status: 'ok', keyId: KEY_ID, jwk: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) } } as const satisfies SendData['key'];

export const PREVIEW = CreatorMcfSendPreview.parse({
  previewId: '33800000-0000-4000-8000-0000000000a1', sendId: SEND_ID, derivedOrderKey: shipped.derivedOrderKey, reservationId: shipped.reservationId,
  spapiConnectionId: CONNECTION, marketplaceId: 'ATVPDKIKX0DER', readAt: '2026-09-09T06:36:00.000Z', validUntil: '2026-09-09T07:06:00.000Z',
  workerRevision: 'synthetic-rev', kind: 'preview', preflightRunId: passing.runId, preflightCompletedAt: passing.completedAt, asin: passing.asin,
  items: [{ sellerSku: 'SW-DERMA-05-FBA', sellerFulfillmentOrderItemId: `${shipped.derivedOrderKey}-1`, quantity: 1 }], totalUnits: 1,
  shippingSpeedCategory: 'Standard', fulfillmentAction: 'Ship', fulfillmentPolicy: 'FillOrKill', featureConstraints: [], existingOrder: 'none',
  isFulfillable: true, fees: { parts: [{ feeName: 'FBAPerUnitFulfillmentFee', amountMinor: 520 }, { feeName: 'FBATransportationFee', amountMinor: 100 }],
    totalMinor: 620, currency: 'USD' },
  unfulfillableReasons: [], earliestArrivalDate: '2026-09-12', latestArrivalDate: '2026-09-15', laneFeeCapMinor: 800, grantFeeCapMinor: 1500,
  grantCurrency: 'USD', envelopeSha256: '7c'.repeat(32), keyId: KEY_ID, irreversibility: CREATOR_MCF_IRREVERSIBILITY,
});

export const SEND: CreatorMcfLaneSend = {
  sendId: SEND_ID, state: 'preview_ready', stateReason: null, stateChangedAt: '2026-09-09T06:36:05.000Z', mask: { countryCode: 'US', postalPrefix: '94', lines: 2 },
  custodyExpiresAt: '2026-09-09T08:35:00.000Z', escalatedAt: null, escalationReason: null, approvedAt: null, claimDeadline: null, units: null,
  intentReservedAt: null, providerOutcome: null, providerReason: null, providerStatus: null, providerCodes: null, amazonStatus: null, acceptedAt: null,
  placedAt: null, createdAt: '2026-09-09T06:35:00.000Z',
  latestPreview: { previewId: PREVIEW.previewId, fingerprint: '9d'.repeat(32), preview: PREVIEW, readAt: PREVIEW.readAt, validUntil: PREVIEW.validUntil },
  events: [], cancel: null, latestCancelPreview: null, cancelPreviewPending: false, cancelPreviewRefusal: null,
};

// ---------------------------------------------------------------------------
// The guarded cancel (WP-338i): a grant carrying 'cancel', a getOrder read at
// 06:38:00 valid until 06:43:00 (NOW is 06:40:00), and a cancel at each step.
// ---------------------------------------------------------------------------

/** Sending on, and the grant carries the cancel action too. */
export const CANCEL_GATE: CreatorMcfSendGate = { ...GATE_ON, actions: ['send', 'cancel'] };
export const CANCEL_PREVIEW = CreatorMcfCancelPreview.parse({
  previewId: '33800000-0000-4000-8000-0000000000c1', sendId: SEND_ID, derivedOrderKey: shipped.derivedOrderKey, reservationId: shipped.reservationId,
  spapiConnectionId: CONNECTION, marketplaceId: 'ATVPDKIKX0DER', readAt: '2026-09-09T06:38:00.000Z', validUntil: '2026-09-09T06:43:00.000Z',
  workerRevision: 'synthetic-rev', kind: 'cancel_preview', existingOrder: { status: 'Received' },
  items: [{ sellerSku: 'SW-DERMA-05-FBA', sellerFulfillmentOrderItemId: `${shipped.derivedOrderKey}-1`, quantity: 1 }], totalUnits: 1,
});
export const LATEST_CANCEL_PREVIEW: NonNullable<CreatorMcfLaneSend['latestCancelPreview']> = {
  previewId: CANCEL_PREVIEW.previewId, fingerprint: 'c4'.repeat(32), preview: CANCEL_PREVIEW, readAt: CANCEL_PREVIEW.readAt,
  validUntil: CANCEL_PREVIEW.validUntil,
};
/** Approved at 06:39:00 on a placed send; the worker has until 06:54:00 to take it. */
export const OPEN_CANCEL: CreatorMcfLaneCancel = {
  cancelId: '33800000-0000-4000-8000-0000000000c2', originState: 'placed', approvedAt: '2026-09-09T06:39:00.000Z', claimDeadline: '2026-09-09T06:54:00.000Z',
  reservedAt: null, providerOutcome: null, providerReason: null, providerStatus: null, providerCodes: null, endedAt: null, ending: null, endingReason: null,
};
/** The ledger's `not_sent` ending, typed through the web's own union until the ledger's type names it. */
export const NOT_SENT = 'not_sent' as unknown as CreatorMcfLaneCancel['ending'];
/** A placed send as the ledger shows it once Amazon holds the order as Received. */
export const PLACED: Partial<CreatorMcfLaneSend> = {
  state: 'placed', amazonStatus: 'Received', placedAt: '2026-09-09T06:30:00.000Z', custodyExpiresAt: null, latestPreview: null,
};

type LaneOverrides = Partial<CreatorMcfLaneView['lane']>;
/** The page with the send section: gate on and key parsed unless overridden. */
export function withSend(send: Partial<CreatorMcfLaneSend> | null, options: { lane?: LaneOverrides; data?: Partial<SendData>;
  detail?: Partial<CreatorPreflightDetail>; now?: string } = {}) {
  const lane = { ...reservedLane, ...(options.detail?.lane ?? {}) };
  const view: CreatorMcfLaneView = {
    lane: { creatorRecordId: lane.creatorRecordId, asin: lane.asin, derivedOrderKey: lane.derivedOrderKey, sku: lane.sku, reservationId: lane.reservationId,
      laneState: lane.laneState, orderOwner: lane.orderOwner, feeCapCents: lane.feeCapCents, mcfStatus: null, settlement: null, ...options.lane },
    send: send === null ? null : { ...SEND, ...send },
  };
  const data: SendData = { canAct: true, orgId: sendOff.orgId, gate: GATE_ON, key: KEY, mcf: view, ...options.data };
  return { view: 'ready', props: { now: options.now ?? NOW, send: data, detail: { ...base, ...options.detail, lane } } } satisfies ScreenData;
}

/** An event that moved the send into `state`, with its codes. */
export const arrived = (state: CreatorMcfSendState, codes: string[], at = '2026-09-09T06:38:00.000Z', before: CreatorMcfSendState = 'approved') =>
  [{ event: state, actorType: 'worker' as const, beforeState: before, afterState: state, reason: null, codes, httpStatus: null, at }];
