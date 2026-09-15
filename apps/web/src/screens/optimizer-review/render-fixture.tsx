import type { RecommendationRecord, RecommendationRunDetail, readOptimizerReview } from '@wizard-ads/db';
import type { Hold, OptimizerTargetOutcome } from '@wizard-ads/shared';
import { profile } from '../synthetic-render-fixtures';
import { workedPlacementRow, workedPlacementTrace } from './worked-example';
import type { ScreenData } from './view';

export const syntheticProfile = { ...profile, id: workedPlacementRow.profileId };
const { trace: _trace, dependencySet: _set, ...inputs } = workedPlacementRow.inputs;
export const referenceRows: RecommendationRecord[] = [
  { ...workedPlacementRow, entityName: 'Synthetic target A', inputs: { ...inputs, methodId: 'sp.reference-efficiency', methodVersion: 'reference.1' } },
  { ...workedPlacementRow, id: '55555555-5555-4555-8555-555555555555', entityId: 'synthetic-target-b', entityName: 'Synthetic target B', currentValue: 0.87, proposedValue: 0.69, inputs: { ...inputs, methodId: 'sp.reference-efficiency', methodVersion: 'reference.1' } },
];
export const tracedReference = { ...referenceRows[0]!, inputs: { ...referenceRows[0]!.inputs, trace: workedPlacementTrace } };
export const reviewHold: Hold = {
  reason: 'NO_FEASIBLE_CONTROL_SET', prose: 'The saved base-bid reduction limit and maximum exposure cannot both be satisfied.',
  affectedScope: [{ profileId: syntheticProfile.id, entityType: 'keyword', entityId: 'synthetic-blocked-target', campaignId: workedPlacementRow.campaignId! }],
  reconsiderWhen: 'Review the conflicting group limits before preparing another preview.',
};
export const unchangedTarget = { id: 'synthetic-unchanged-target', name: 'Synthetic unchanged target', campaignName: workedPlacementRow.campaignName, currentValue: 0.82, proposedValue: 0.82, reason: 'Rank gate · Recorded organic rank retained the bid' };
const run: RecommendationRunDetail = {
  id: workedPlacementRow.runId, orgId: workedPlacementRow.orgId, profileId: syntheticProfile.id, status: 'succeeded', lookbackDays: 28,
  windowStart: '2026-07-01', windowEnd: '2026-07-28', engineVersion: 'synthetic-v1', proposalsCount: 2,
  createdAt: new Date('2026-07-30T00:00:00.000Z'), finishedAt: new Date('2026-07-30T00:01:00.000Z'),
  groupId: null, groupRole: null, groupSnapshot: null, dueAt: null, scheduleContext: null, strategySnapshot: null,
  counts: { proposed: 2, accepted: 0, dismissed: 0, exported: 0, applied: 0, superseded: 0 },
};
const outcomes: OptimizerTargetOutcome[] = [
  ...referenceRows.map((row): OptimizerTargetOutcome => ({ entityRef: { profileId: row.profileId, entityType: 'keyword', entityId: row.entityId, campaignId: row.campaignId! }, currentBid: typeof row.currentValue === 'number' ? row.currentValue : null, method: { id: 'sp.reference-efficiency', version: 'reference.1' }, outcome: 'suggestion', reasonCode: 'high_acos', reason: 'Recorded efficiency proposal' })),
  { entityRef: { ...reviewHold.affectedScope[0]!, entityId: unchangedTarget.id }, currentBid: unchangedTarget.currentValue, method: { id: 'sp.reference-efficiency', version: 'reference.1' }, outcome: 'unchanged', reasonCode: 'rank_gate', reason: unchangedTarget.reason },
  { entityRef: reviewHold.affectedScope[0]!, currentBid: null, method: { id: 'sp.reference-efficiency', version: 'reference.1' }, outcome: 'blocked', reasonCode: reviewHold.reason, reason: reviewHold.prose, hold: reviewHold },
];
export const review: NonNullable<Awaited<ReturnType<typeof readOptimizerReview>>> = {
  batchId: '66666666-6666-4666-8666-666666666666', profileId: syntheticProfile.id, campaignCount: 1, status: 'succeeded', executionSnapshot: null,
  proposals: referenceRows,
  children: [{ run, campaignIds: [workedPlacementRow.campaignId!], proposals: referenceRows,
    diagnostics: { targetsRead: 4, targetsConsidered: 4, proposed: 2, suppressed: 1, declined: 1, blockedOutOfStock: 0, skippedInactive: 0, skippedMissingStrategy: 0, corridorsAvailable: 0, corridorsMissing: 4, preconditionNotes: 0, declinedReasons: { rank_gate: 1 } },
    holds: [reviewHold], examples: [], calculationSnapshots: [], evidenceAvailable: true, holdsComplete: true, methodAdmission: null,
    targetOutcomes: outcomes, unchanged: outcomes.filter((row) => row.outcome === 'unchanged'), blocked: outcomes.filter((row) => row.outcome === 'blocked'), outcomesComplete: true,
  }],
  totals: { proposals: 2, evaluated: 4, suggestions: 2, blocked: 1, unchanged: 1, retainedHolds: 1 },
  integrity: { expectedChildren: 1, loadedChildren: 1, expectedCampaigns: 1, loadedCampaigns: 1, loadedProposals: 2, completeEvidence: true },
};
export const ready = { view: 'ready', props: { profile: syntheticProfile, review, savedPreviews: [], details: false } } satisfies ScreenData;
