import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SpWriteAction, SpWritePlan, serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint,
  verifySpWritePlanFingerprints, type SpCompleteCampaignBiddingState } from './sp-writes.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const empty = '0'.repeat(64);
const baseline: SpCompleteCampaignBiddingState = { strategy: 'manual', placements: {
  topOfSearch: 100, restOfSearch: 0, productPages: 0, amazonBusiness: null,
}, shopperCohorts: [], offAmazonBudgetControlStrategy: null };

function plan() {
  const middle = { ...baseline, placements: { ...baseline.placements, topOfSearch: 300 } };
  const final = { ...middle, placements: { ...middle.placements, restOfSearch: 100 } };
  const drafts = [
    { actionId: id(11), routeKey: 'sp.v3.keywords.update', entity: { keywordId: 'synthetic-keyword' },
      sources: [{ kind: 'apply_row', applyRowId: id(21), changeKey: 'keyword.bid' }],
      changes: { bid: { expected: { amount: '0.6', currencyCode: 'USD' }, requested: { amount: '0.3', currencyCode: 'USD' } } } },
    { actionId: id(12), routeKey: 'sp.v3.campaigns.update', entity: { campaignId: 'synthetic-campaign' },
      sources: [{ kind: 'apply_row', applyRowId: id(22), changeKey: 'campaign.placement.top_of_search' }],
      changes: { placement: { expected: baseline, requested: middle, approvedPlacementKeys: ['top_of_search'] } } },
    { actionId: id(13), routeKey: 'sp.v3.campaigns.update', entity: { campaignId: 'synthetic-campaign' },
      sources: [{ kind: 'apply_row', applyRowId: id(23), changeKey: 'campaign.placement.rest_of_search' }],
      changes: { placement: { expected: middle, requested: final, approvedPlacementKeys: ['rest_of_search'] } } },
  ];
  const actions = drafts.map((draft) => {
    const action = SpWriteAction.parse({ ...draft, fingerprint: empty });
    return { ...action, fingerprint: hash(serializeSpWriteActionFingerprint(action)) };
  });
  const value = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v3', id: id(1), orgId: id(2), profileId: id(3),
    providerScope: { amazonProfileId: 'synthetic-profile', connectionId: id(4), region: 'NA', marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' },
    direction: 'forward', source: { kind: 'apply_batch', applyBatchId: id(5), guardrailSnapshotFingerprint: empty, provenanceSnapshotFingerprint: empty },
    generatedAt: '2026-08-01T00:00:00Z', frozenAt: '2026-08-01T00:00:00Z', expiresAt: '2026-08-01T00:10:00Z', actions,
    dependencySets: [{ dependencySetId: 'synthetic-set', recommendationId: id(6), dependencySetSha256: empty,
      actionIds: actions.map((action) => action.actionId), precedenceReasons: ['Observe the lower bid first.', 'Observe the first placement before the second.'] }],
    counts: { logicalChanges: 3, providerRows: 3, uniqueEntities: 2, byRoute: { 'sp.v3.campaigns.update': 2, 'sp.v3.ad_groups.update': 0,
      'sp.v3.keywords.update': 1, 'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } }, fingerprint: empty });
  return { ...value, fingerprint: hash(serializeSpWritePlanFingerprint(value)) };
}

describe('ordered control plan v3', () => {
  it('binds three steps, two entities and the full intermediate placement state', () => {
    const value = verifySpWritePlanFingerprints(plan(), { algorithm: 'sha256', digest: hash });
    expect(value.actions.map((action) => action.routeKey)).toEqual(['sp.v3.keywords.update', 'sp.v3.campaigns.update', 'sp.v3.campaigns.update']);
    expect(value.counts).toMatchObject({ logicalChanges: 3, providerRows: 3, uniqueEntities: 2 });
    expect(value.dependencySets?.[0]?.actionIds).toEqual(value.actions.map((action) => action.actionId));
  });
  it('rejects reordering and changing the complete predecessor state', () => {
    const reordered = plan();
    reordered.actions.reverse();
    expect(SpWritePlan.safeParse(reordered).success).toBe(false);
    const broken = plan();
    const action = broken.actions[2]!;
    if (action.routeKey !== 'sp.v3.campaigns.update' || action.changes.placement === undefined) throw new Error('fixture');
    action.changes.placement.expected = baseline;
    action.changes.placement.requested = { ...baseline, placements: { ...baseline.placements, restOfSearch: 100 } };
    expect(SpWritePlan.safeParse(broken).success).toBe(false);
  });
  it('keeps legacy plans and unsupported inverse plans outside v3 dependency execution', () => {
    expect(SpWritePlan.safeParse({ ...plan(), schemaVersion: 'openspell.sp-write-plan.v1' }).success).toBe(false);
    expect(SpWritePlan.safeParse({ ...plan(), schemaVersion: 'openspell.sp-write-plan.v2' }).success).toBe(false);
    expect(SpWritePlan.safeParse({ ...plan(), dependencySets: undefined }).success).toBe(false);
    expect(SpWritePlan.safeParse({ ...plan(), direction: 'inverse' }).success).toBe(false);
  });
  it('fingerprints every dependency reason and rejects a fractional placement', () => {
    const tampered = plan();
    tampered.dependencySets![0]!.precedenceReasons[0] = 'Changed after approval.';
    expect(() => verifySpWritePlanFingerprints(tampered, { algorithm: 'sha256', digest: hash })).toThrow(/fingerprint mismatch/);
    const fractional = plan();
    const action = fractional.actions[1]!;
    if (action.routeKey !== 'sp.v3.campaigns.update' || action.changes.placement === undefined) throw new Error('fixture');
    action.changes.placement.requested.placements.topOfSearch = 300.5;
    expect(SpWritePlan.safeParse(fractional).success).toBe(false);
  });
});
