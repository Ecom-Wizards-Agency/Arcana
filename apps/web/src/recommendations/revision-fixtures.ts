/** Synthetic client rendering and failure scenarios. Never import into a production route. */
import type { RecommendationRecord } from '@wizard-ads/db';
import {
  RecommendationDecisionResult, RecommendationRevisionSelection,
} from '@wizard-ads/shared/recommendation-revisions';
import { toRecommendationReview } from './view';

const BASE_ID = '11111111-1111-4111-8111-111111111111';
const EDITED_ID = '22222222-2222-4222-8222-222222222222';
const REVISION_ID = '33333333-3333-4333-8333-333333333333';

function proposal(id: string, revisionId: string | null): RecommendationRecord {
  return {
    id, proposalRevisionId: revisionId,
    orgId: '44444444-4444-4444-8444-444444444444',
    profileId: '55555555-5555-4555-8555-555555555555',
    runId: '66666666-6666-4666-8666-666666666666',
    reason: 'high_acos', entityType: 'keyword', entityId: `synthetic-${id}`,
    entityName: 'Synthetic keyword', adProduct: 'SP', campaignId: 'synthetic-campaign',
    adGroupId: 'synthetic-ad-group', campaignName: 'Synthetic campaign',
    adGroupName: 'Synthetic ad group', campaignPortfolioId: null, campaignKnown: true,
    field: 'bid', currentValue: '0.9', proposedValue: revisionId === null ? '0.72' : '0.7201',
    inputs: { rpc: null, clicks: 1, cvrSourceLevel: 'keyword', ceilingApplied: null, capClamped: false },
    status: 'accepted', decidedBy: null, decidedAt: null, exportBatchId: null,
    exportBatchTag: null, decisionNote: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

export function recommendationRevisionFixtures() {
  const rows = [proposal(BASE_ID, null), proposal(EDITED_ID, REVISION_ID)];
  const current = toRecommendationReview({ rows,
    population: { loaded: 2, total: 2, limit: 2, truncated: false },
  }, { strategySnapshot: null });
  const expectedRevisions = RecommendationRevisionSelection.parse(
    current.proposals.map((row) => ({ recommendationId: row.id, revisionId: row.proposalRevisionId })),
  );
  return {
    current,
    truncated: toRecommendationReview({ rows: [rows[0]!],
      population: { loaded: 1, total: 2, limit: 1, truncated: true },
    }, { strategySnapshot: null }),
    reviewedSelection: { ids: rows.map((row) => row.id), expectedRevisions },
    changedAfterDisplay: {
      offered: 2,
      ...RecommendationDecisionResult.parse({ updated: 0, refused: [
        { id: BASE_ID, status: 'unavailable' }, { id: EDITED_ID, status: 'revision_changed' },
      ] }),
    },
    hiddenSelection: {
      selectedIds: [EDITED_ID], visibleIds: [BASE_ID],
      // Keep this explicit selection or refuse the action until it is cleared.
      // An empty visible intersection must never become ids:null (whole run).
      expectedRevisions: RecommendationRevisionSelection.parse([expectedRevisions[1]]),
    },
  };
}
