import type { CreatorDailyQueueItem, CreatorQueueAction } from '@wizard-ads/shared';

/** The frame's group order; action types it does not draw follow in runner order. */
export const ACTION_ORDER: readonly CreatorQueueAction[] = [
  'IDENTITY_RESOLUTION', 'BACKGROUND_CHECK', 'SEND_TAILORED_VERIFICATION_FOLLOW_UP', 'RECONCILE_QUALIFICATION', 'MCF_PREFLIGHT',
  'RECONCILE_PRODUCT_SWITCH', 'SEND_CONTENT_FOLLOW_UP', 'SEND_PRODUCT_SWITCH_FOLLOW_UP', 'ESCALATE_UNRESPONSIVE',
  'ESCALATE_PRODUCT_SWITCH_UNRESPONSIVE', 'ESCALATE_CONTENT_UNRESPONSIVE',
];
export const ACTION_LABEL: Record<CreatorQueueAction, string> = {
  IDENTITY_RESOLUTION: 'Identity resolution', BACKGROUND_CHECK: 'Background check',
  SEND_TAILORED_VERIFICATION_FOLLOW_UP: 'Verification follow-up', ESCALATE_UNRESPONSIVE: 'Escalate: no verification reply',
  RECONCILE_QUALIFICATION: 'Reconcile qualification', MCF_PREFLIGHT: 'MCF pre-flight', RECONCILE_PRODUCT_SWITCH: 'Reconcile product switch',
  ESCALATE_PRODUCT_SWITCH_UNRESPONSIVE: 'Escalate: no product-switch reply', SEND_PRODUCT_SWITCH_FOLLOW_UP: 'Product-switch follow-up',
  ESCALATE_CONTENT_UNRESPONSIVE: 'Escalate: no content reply', SEND_CONTENT_FOLLOW_UP: 'Content follow-up',
};

export interface QueueTiles { total: number; awaitingApproval: number; heldOrBlocked: number; locked: number; queued: number; escalated: number }

/**
 * The four tiles, from the runner's own gates (`queue_item`): awaiting approval
 * is every PENDING_APPROVAL gate, the only gate a message send can have; held or
 * blocked is every HOLD and BLOCKED gate, so the two split the queue. Locked
 * counts rows whose registry record is in Conflict; a record Locked for MCF is
 * mid-order, not in conflict. `Queued` is one of the two queue states and never
 * labels a total that holds an Escalated row.
 */
export function queueTiles(items: readonly CreatorDailyQueueItem[]): QueueTiles {
  return {
    total: items.length,
    awaitingApproval: items.filter((item) => item.gateResult === 'PENDING_APPROVAL').length,
    heldOrBlocked: items.filter((item) => item.gateResult === 'BLOCKED' || item.gateResult === 'HOLD').length,
    locked: items.filter((item) => item.lockState === 'Conflict').length,
    queued: items.filter((item) => item.queueState === 'Queued').length,
    escalated: items.filter((item) => item.queueState === 'Escalated').length,
  };
}

export function groupByAction(items: readonly CreatorDailyQueueItem[]) {
  return ACTION_ORDER.map((action) => ({ action, items: items.filter((item) => item.actionType === action) }))
    .filter((group) => group.items.length > 0);
}

/** Registered records the queue did not name today. */
export function recordsWithoutAction(items: readonly CreatorDailyQueueItem[], registryRecords: number): number {
  return registryRecords - new Set(items.flatMap((item) => item.creatorRecordId === null ? [] : [item.creatorRecordId])).size;
}
