import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import { resolveMethod, spCoordinatedCapabilities } from '@wizard-ads/core';
import { COORDINATED_METHOD, CoordinatedMethodInput, SP_MARKETPLACE_MONEY_RULES, type SpMarketplaceScope } from '@wizard-ads/shared';
import { SpWriteAction, SpWritePlan, serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint } from '@wizard-ads/shared/sp-writes';

const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
const zeroHash = '0'.repeat(64);

function calculation(scope: SpMarketplaceScope, entityType: 'keyword' | 'target', edge: 'minimum' | 'maximum' | 'infeasible') {
  const capabilities = spCoordinatedCapabilities(scope);
  const market = capabilities.marketplace!;
  const currentBid = Number(((market.bidMin + market.bidMax) / 2).toFixed(market.decimalPlaces));
  const rpc = edge === 'maximum' ? market.bidMax * 10 : market.bidMin / 1000;
  const settings = { targetAcos: 0.3, bidFloor: 0, bidCeiling: edge === 'infeasible' ? market.bidMin / 2 : market.bidMax * 3,
    bidIncreaseCap: 10, bidDecreaseCap: 1, exposureCeiling: market.bidMax * 10, minClicksPerPlacement: 1,
    placementEvidenceRequirements: 'single_target' };
  const profileId = randomUUID();
  return CoordinatedMethodInput.parse({
    runId: randomUUID(), profileId, methodId: COORDINATED_METHOD.id, methodVersion: COORDINATED_METHOD.version,
    window: { start: '2026-08-01', end: '2026-08-28' }, admittedAt: '2026-09-10T00:00:00Z',
    methodParameters: { targetAcos: settings.targetAcos, floors: { manualMinBid: settings.bidFloor }, ceilings: { manualMaxBid: settings.bidCeiling },
      caps: { maxIncrease: settings.bidIncreaseCap, maxDecrease: settings.bidDecreaseCap }, exposureCeiling: settings.exposureCeiling,
      minClicksPerPlacement: settings.minClicksPerPlacement, placementEvidenceRequirements: settings.placementEvidenceRequirements },
    resolvedSettings: Object.fromEntries(Object.entries(settings).map(([name, value]) => [name, { value, source: 'run', sourceLabel: 'Synthetic compiler boundary' }])),
    evidenceRows: [{ entityRef: { profileId, campaignId: 'synthetic-campaign', entityId: 'synthetic-target', entityType, adProduct: 'SP' },
      adProduct: 'SP', currentBid, metrics: { clicks: 100, sales: rpc * 100, orders: 10, cost: 1 },
      levels: { profile: { clicks: 100, sales: rpc * 100, orders: 10 } }, stock: { status: 'in_stock', asins: [] } }],
    campaignEvidence: { campaignId: 'synthetic-campaign', costType: 'cpc', complete: true, targetCount: 1,
      attributionMature: true, homogeneousProxyValidation: null, capabilities,
      currentControls: { strategy: 'manual', placements: { topOfSearch: 0, restOfSearch: 0, productPages: 0, amazonBusiness: null },
        shopperCohorts: [], offAmazonBudgetControlStrategy: null },
      placementFacts: ['top_of_search', 'rest_of_search', 'product_pages'].map((placement, index) => {
        const clicks = index === 2 ? 20 : 40;
        return { campaignId: 'synthetic-campaign', placement, clicks, sales: rpc * clicks, clickShare: clicks / 100 };
      }),
    },
  });
}

function compileBid(input: CoordinatedMethodInput, proposed: number) {
  const scope = input.campaignEvidence.capabilities.marketplace!;
  const target = input.evidenceRows[0]!;
  const keyword = target.entityRef.entityType === 'keyword';
  const routeKey = keyword ? 'sp.v3.keywords.update' : 'sp.v3.targets.update';
  const unsignedAction = SpWriteAction.parse({ actionId: randomUUID(), routeKey,
    entity: keyword ? { keywordId: target.entityRef.entityId } : { targetId: target.entityRef.entityId },
    changes: { bid: { expected: { amount: String(target.currentBid), currencyCode: scope.currencyCode },
      requested: { amount: String(proposed), currencyCode: scope.currencyCode } } },
    sources: [{ kind: 'apply_row', applyRowId: randomUUID(), changeKey: keyword ? 'keyword.bid' : 'target.bid' }], fingerprint: zeroHash });
  const action = { ...unsignedAction, fingerprint: hasher.digest(serializeSpWriteActionFingerprint(unsignedAction)) };
  const unsignedPlan = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v1', id: randomUUID(), orgId: randomUUID(), profileId: input.profileId,
    providerScope: { marketplaceId: scope.marketplaceId, region: scope.region, currencyCode: scope.currencyCode,
      amazonProfileId: 'synthetic-profile', connectionId: randomUUID(), apiDialect: 'sp_v3' },
    direction: 'forward', source: { kind: 'apply_batch', applyBatchId: randomUUID(), guardrailSnapshotFingerprint: zeroHash, provenanceSnapshotFingerprint: zeroHash },
    generatedAt: '2026-09-10T00:00:00Z', frozenAt: '2026-09-10T00:00:01Z', expiresAt: '2026-09-10T00:10:00Z', actions: [action],
    counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1, byRoute: { 'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0,
      'sp.v3.keywords.update': keyword ? 1 : 0, 'sp.v3.targets.update': keyword ? 0 : 1, 'sp.v3.product_ads.update': 0 } }, fingerprint: zeroHash });
  const plan = { ...unsignedPlan, fingerprint: hasher.digest(serializeSpWritePlanFingerprint(unsignedPlan)) };
  const adapter = createSpWriteAdapter({ region: scope.region,
    credentials: { clientId: 'synthetic', clientSecret: 'synthetic', refreshToken: 'synthetic' },
    fetch: async () => { throw new Error('Compiler tests must never perform I/O'); },
  }, { hasher });
  return adapter.preparePlan(plan);
}

for (const [marketplaceId, rule] of Object.entries(SP_MARKETPLACE_MONEY_RULES)) {
  for (const entityType of ['keyword', 'target'] as const) {
    it.each(['minimum', 'maximum', 'infeasible'] as const)(`${marketplaceId} ${entityType}: evaluator to real provider compiler at %s`, (edge) => {
      const input = calculation({ marketplaceId, region: rule.region, currencyCode: rule.currencyCode }, entityType, edge);
      const result = resolveMethod(input.methodId, input.methodVersion).evaluate(input);
      if (edge === 'infeasible') {
        expect(result).toMatchObject({ kind: 'hold', hold: { reason: 'NO_FEASIBLE_CONTROL_SET' } });
        expect(result).not.toHaveProperty('changes');
        return;
      }
      expect(result.kind).toBe('proposal');
      if (result.kind !== 'proposal') throw new Error('Expected writable proposal');
      expect(result.dependencySet!.changes).toHaveLength(1);
      const proposed = result.dependencySet!.changes[0]!.proposed;
      expect(proposed).toBe(Number(edge === 'minimum' ? rule.bidMin : rule.bidMax));
      expect(compileBid(input, Number(proposed))).toHaveLength(1);
      // The adjacent representable value outside either marketplace bound really is unwritable.
      const outside = Number((Number(proposed) + (edge === 'minimum' ? -1 : 1) * 10 ** -rule.scale).toFixed(rule.scale));
      expect(() => compileBid(input, outside)).toThrow();
    });
  }
}
