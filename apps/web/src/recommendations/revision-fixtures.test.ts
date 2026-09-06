import { describe, expect, it } from 'vitest';
import { RecommendationStatus } from '@wizard-ads/shared';
import { recommendationRevisionFixtures } from './revision-fixtures';

describe('revision-aware recommendation fixtures', () => {
  it('binds base and edited displayed values to the exact submitted revision identities', () => {
    const fixture = recommendationRevisionFixtures();
    expect(fixture.reviewedSelection.expectedRevisions).toEqual(
      fixture.current.proposals.map((row) => ({ recommendationId: row.id, revisionId: row.proposalRevisionId })),
    );
    expect(fixture.current.proposals[0]?.proposalRevisionId).toBeNull();
    expect(fixture.current.proposals[1]?.proposalRevisionId).not.toBeNull();
    expect(fixture.current.proposals[1]?.proposedValue).toBe('0.7201');
    expect(fixture.truncated.population).toEqual({ loaded: 1, total: 2, limit: 1, truncated: true });
  });

  it('models stale and missing refusals without turning them into stored proposal statuses', () => {
    const fixture = recommendationRevisionFixtures();
    expect(fixture.changedAfterDisplay.updated + fixture.changedAfterDisplay.refused.length)
      .toBe(fixture.changedAfterDisplay.offered);
    expect(fixture.changedAfterDisplay.refused.every((row) =>
      !RecommendationStatus.safeParse(row.status).success)).toBe(true);
    expect(fixture.current.proposals.every((row) => row.status === 'accepted')).toBe(true);
  });

  it('retains a hidden selection and its revision instead of encoding whole-run export', () => {
    const { hiddenSelection } = recommendationRevisionFixtures();
    expect(hiddenSelection.selectedIds.filter((id) => hiddenSelection.visibleIds.includes(id))).toEqual([]);
    expect(hiddenSelection.selectedIds).toHaveLength(1);
    expect(hiddenSelection.expectedRevisions.map((row) => row.recommendationId))
      .toEqual(hiddenSelection.selectedIds);
  });
});
