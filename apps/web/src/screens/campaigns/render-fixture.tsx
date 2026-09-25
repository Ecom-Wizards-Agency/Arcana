import { createHash } from 'node:crypto';
import { generateCampaignName, buildCampaignRecipe, campaignRecipeCreationPlan, namingSettingsFromStrategy, parseCampaignName } from '@wizard-ads/campaigns';
import { campaignBidRationale, campaignBuilderEligibility, spCoordinatedCapabilities } from '@wizard-ads/core';
import { CampaignBuilderContext, CampaignBuilderRecipe, CampaignDraft, CampaignBuilderResult, CampaignCreationBatch, CampaignCreationProviderResult, CampaignCreationPlanV2, CampaignCreationNodeV2, serializeCampaignCreationNodeFingerprint, serializeCampaignCreationPlanFingerprint, spMarketplaceScopeForCountry, spMarketplaceBudgetCapability } from '@wizard-ads/shared';
import { CampaignCreationApprovalView, campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';
import { AssetLibrarySnapshot } from '@wizard-ads/shared/asset-library';

export const fixtureId = (value: number) => `27000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const fixtureTime = '2026-06-10T12:00:00.000Z';
const scope = spMarketplaceScopeForCountry('US', 'NA', 'USD')!;
export const builderContext = CampaignBuilderContext.parse({
  profile: { id: fixtureId(2), label: 'Synthetic account', countryCode: 'US', currencyCode: 'USD', marketplace: scope },
  products: [{ key: 'B000000270', asin: 'B000000270', sku: 'SKU-SYNTHETIC', name: 'Synthetic lantern', state: 'enabled', observedAt: fixtureTime }],
  groups: ['rank','discovery','profit','shield'].map((role,index) => ({ id: fixtureId(10 + index), name: `Synthetic ${role} group`, role, targetAcos: 0.31, floor: 0.12, ceiling: 0.96 })),
  naming: { variable_order: ['Goal','AdType','MatchType','ProductName','Keyword','Custom1'], delimiter: ' | ', suffix: 'QA', custom1_value: 'QA' },
  presets: [], keywordSets: [{ id: fixtureId(8), profileId: fixtureId(2), name: 'Synthetic keyword set', keywords: ['synthetic lantern'] }],
  searchTerms: ['synthetic lantern'], ngrams: ['synthetic'], bidEvidence: [{ keyword: 'synthetic lantern', clicks: 160, spend: 96, reportedCpc: 0.6, days: 30, start: '2026-05-01', end: '2026-05-30', source: 'fact_sp_target_daily', sourceRows: 30, sales: 320 }],
  sqpMeasured: false, exposureCeiling: 2.4, budget: spMarketplaceBudgetCapability(scope), capabilities: spCoordinatedCapabilities(scope), canEdit: true, today: '2026-06-10', defaults: { budget: null, topOfSearch: null },
});
export const builderRecipe = CampaignBuilderRecipe.parse({ adType: 'SP', productKeys: ['B000000270'], play: 'rank', groupId: fixtureId(10), dailyBudget: 7.25,
  keywords: [{ text: 'synthetic lantern', bid: 0.36, basis: 'manual' }], structure: 'keyword-product', topOfSearch: 140, audienceAdjustment: 0, naming: builderContext.naming, names: {} });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let sequence = 100;
export const fixturePlan = campaignRecipeCreationPlan(buildCampaignRecipe(builderRecipe, builderContext), {
  orgId: fixtureId(1), profileId: fixtureId(2), marketplaceId: scope.marketplaceId, currencyCode: 'USD', now: fixtureTime,
  expiresAt: '2026-06-11T12:00:00.000Z', uuid: () => fixtureId(sequence++), hasher: { algorithm: 'sha256', digest },
});
export const fixtureChecks = campaignBuilderEligibility({ plan: fixturePlan, budget: builderContext.budget, existingNames: [], naming: builderContext.naming,
  parsedNames: fixturePlan.nodes.flatMap((node) => node.kind === 'campaign.create' ? [{ name: node.payload.name, naming: builderContext.naming!, confidence: parseCampaignName(node.payload.name, namingSettingsFromStrategy(builderContext.naming!)).confidence }] : []),
  bounds: { floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }, audienceAdjustment: 0, capabilities: builderContext.capabilities });
export const savedDraft = CampaignDraft.parse({ id: fixtureId(3), orgId: fixtureId(1), profileId: fixtureId(2), createdBy: fixtureId(4), status: 'draft', revision: 1,
  plan: fixturePlan, recipe: builderRecipe, validation: null, updatedAt: fixtureTime,
  rationale: builderRecipe.keywords.map((keyword) => ({ keyword: keyword.text, frozenAt: fixtureTime, sentence: campaignBidRationale({ keyword: keyword.text, basis: keyword.basis, bid: keyword.bid, currency: 'USD', topOfSearch: 140, audienceAdjustment: 0, evidence: builderContext.bidEvidence[0]! }) })),
});
export const validationChecks = [...fixtureChecks, ...(['product', 'permission', 'count'] as const).map((id) => ({ id, label: id, source: 'Synthetic review evidence', status: 'passed' as const, blocking: false, currentValue: 'Verified', requiredAction: '' }))];
export const measuredCreationChecks = validationChecks.map((check) => ({ ...check, status: 'passed' as const, blocking: false, source: 'Synthetic measured creation evidence' }));
export const validatedDraft = CampaignDraft.parse({ ...savedDraft, status: 'validated', validation: { planFingerprint: fixturePlan.fingerprint, recipeFingerprint: digest(JSON.stringify(builderRecipe)), checkedAt: fixtureTime, checks: validationChecks } });
const blockedRecipe = { ...builderRecipe, dailyBudget: 0.3 };
const blockedPlan = campaignRecipeCreationPlan(buildCampaignRecipe(blockedRecipe, builderContext), {
  orgId: fixtureId(1), profileId: fixtureId(2), marketplaceId: scope.marketplaceId, currencyCode: 'USD', now: fixtureTime,
  expiresAt: '2026-06-11T12:00:00.000Z', uuid: () => fixtureId(sequence++), hasher: { algorithm: 'sha256', digest },
});
const blockedBudget = campaignBuilderEligibility({ plan: blockedPlan, budget: builderContext.budget, existingNames: [], naming: builderContext.naming, parsedNames: [], bounds: { floor: 0.12, ceiling: 0.96, exposureCeiling: 2.4, decimalPlaces: 2 }, audienceAdjustment: 0, capabilities: builderContext.capabilities }).find((check) => check.id === 'budget')!;
export const blockedDraft = CampaignDraft.parse({ ...validatedDraft, recipe: blockedRecipe, plan: blockedPlan, status: 'blocked', validation: { ...validatedDraft.validation!, planFingerprint: blockedPlan.fingerprint, recipeFingerprint: digest(JSON.stringify(blockedRecipe)), checks: validationChecks.map((check) => check.id === 'budget' ? blockedBudget : check) } });

/** V2 current provider evidence exists only in this synthetic rendering fixture. */
function currentReview() {
  const nodes = fixturePlan.nodes.map((node) => {
    let payload: unknown = node.payload;
    if (node.kind === 'campaign.create') { const { startDate, endDate, ...rest } = node.payload; payload = { ...rest, schedule: { type: 'calendar_dates', startDate, endDate } }; }
    if (node.kind === 'ad_group.create') payload = { ...node.payload, settings: { product: 'SP' } };
    const next = CampaignCreationNodeV2.parse({ ...node, schemaVersion: 'openspell.campaign-creation-node.v2', payload });
    return CampaignCreationNodeV2.parse({ ...next, fingerprint: digest(serializeCampaignCreationNodeFingerprint(next)) });
  });
  let plan = CampaignCreationPlanV2.parse({ ...fixturePlan, schemaVersion: 'openspell.campaign-creation-plan.v2', nodes,
    providerScope: { amazonProfileId: '270', connectionId: fixtureId(5), region: 'NA', marketplaceId: scope.marketplaceId, currencyCode: 'USD', accountType: 'seller' } });
  plan = CampaignCreationPlanV2.parse({ ...plan, fingerprint: digest(serializeCampaignCreationPlanFingerprint(plan)) });
  const source = { plan, profile: { id: builderContext.profile.id, label: builderContext.profile.label }, checkedAt: fixtureTime,
    current: { orgId: plan.orgId, profileId: plan.profileId, planFingerprint: plan.fingerprint, providerScope: plan.providerScope, assets: [],
      checks: plan.nodes.map((node) => ({ nodeId: node.nodeId, nodeFingerprint: node.fingerprint, result: 'passed' as const, reason: null, checkedAt: fixtureTime, validUntil: plan.expiresAt })) } };
  return CampaignCreationApprovalView.parse({ ...source, schemaVersion: 'openspell.campaign-creation-approval-view.v1', freshness: campaignCreationReviewFreshness(source),
    recordedContext: { guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' }, admission: { kind: 'none' } });
}
export const fixtureReview = currentReview();
export function creationBatchFixture(state: 'admitted' | 'partial' | 'complete' | 'uncertain' | 'ambiguous' | 'adopted', source = CampaignCreationPlanV2.parse(fixtureReview.plan)): CampaignCreationBatch {
  if (state === 'uncertain' || state === 'ambiguous') {
    const batch = creationBatchFixture('admitted',source); const row = batch.nodes[0]!;
    row.intent = creationBatchFixture('complete',source).nodes[0]!.intent;
    const firstAt = new Date(Date.parse(source.frozenAt)+36_000).toISOString();
    const at = new Date(Date.parse(source.frozenAt)+96_000).toISOString();
    row.observation = { id:fixtureId(390),mode:'identity',identityFingerprint:'a'.repeat(64),requestDigest:row.intent!.requestDigest,
      responseDigest:'b'.repeat(64),providerEntityId:null,complete:true,observation:state==='uncertain'?'uncertain':'ambiguous_readback',
      startedAt:at,observedAt:at,accounting:{pages:1,loaded:state==='uncertain'?0:2,parsed:state==='uncertain'?0:2,matched:state==='uncertain'?0:2},
      reason:state==='uncertain'?'No resource matched the exact identity in two complete observations at least 60 seconds apart. The original create outcome remains uncertain.'
        :'More than one resource matched the exact identity. Creation is refused.' };
    row.observations = state==='uncertain' ? [{...row.observation,id:fixtureId(389),observation:'not_found',startedAt:firstAt,observedAt:firstAt,reason:'No exact identity matched.'},row.observation] : [row.observation];
    for (const child of batch.nodes.slice(1)) child.refusal='dependency_failed';
    return CampaignCreationBatch.parse(batch);
  }
  if (state === 'adopted') {
    const batch = creationBatchFixture('complete',source); const parentBatchId=batch.id; batch.id=fixtureId(391);
    batch.lineage={parentBatchId,planFingerprint:source.fingerprint,nodeIds:batch.nodes.map((row)=>row.nodeId),inheritedResources:[]};
    for (const row of batch.nodes) if(row.result) row.result={...row.result,executionId:batch.id};
    const first=batch.nodes[0]!;first.intent=null;first.result=null;first.observation={...first.observation!,mode:'identity'};first.observations=[first.observation];
    return CampaignCreationBatch.parse(batch);
  }
  const batchId = fixtureId(290); const at = source.frozenAt; const hash = 'a'.repeat(64);
  return CampaignCreationBatch.parse({ id: batchId, draftId: savedDraft.id, draftRevision: 1, actorId: savedDraft.createdBy,
    plan: source, admittedAt: at, expiresAt: source.expiresAt, environmentGateVersion: fixtureId(291), profileGrantVersion: fixtureId(292),
    validation: { planFingerprint: source.fingerprint, recipeFingerprint: digest(JSON.stringify(builderRecipe)), checkedAt: at, checks: measuredCreationChecks },
    lineage: null, productChecks: source.nodes.flatMap((node) => node.kind === 'eligibility.require_product'
      ? [{ nodeId: node.nodeId, providerEntityId: node.payload.asin, observedAt: at }] : []),
    nodes: source.nodes.filter((node) => node.effect === 'irreversible_create').map((node,index) => {
      const failed = state === 'partial' && node.kind === 'target.create'; const providerEntityId = failed ? null : String(29000+index);
      const intent = { id: fixtureId(300+index), requestDigest: hash, nodeRequestDigest: hash, reservedAt: at,
        deadline: new Date(Date.parse(at)+35_000).toISOString() };
      return { nodeId: node.nodeId, nodeFingerprint: node.fingerprint, refusal: null, intent: state === 'admitted' ? null : intent,
        result: state === 'admitted' ? null : CampaignCreationProviderResult.parse({ effect: 'irreversible_create',planId:source.id,nodeId:node.nodeId,
          executionId:batchId,attemptId:intent.id,providerCallId:intent.id,nodeFingerprint:node.fingerprint,requestIndex:0,requestDigest:hash,nodeRequestDigest:hash,
          outcome:failed?'authoritative_rejected':'succeeded',providerEntityId,providerEntityVersion:null,providerCode:failed?'INVALID_ARGUMENT':null,
          sanitizedMessage:failed?'The keyword was refused. Review its separate retry.':null,providerRequestId:null,responseDigest:hash,startedAt:at,completedAt:at }),
        observation: state==='admitted'||failed?null:{id:fixtureId(350+index),mode:'provider_id',identityFingerprint:hash,
          providerEntityId,requestDigest:hash,responseDigest:hash,observation:'observed',complete:true,reason:null,
          accounting:{pages:1,loaded:1,parsed:1,matched:1},startedAt:at,observedAt:at} };
    }).map((row)=>({...row,observations:row.observation?[row.observation]:[]})) });
}
export function creationResult(complete: boolean) {
  const resources = fixturePlan.nodes.filter((node) => node.effect === 'irreversible_create').map((node) => ({ nodeId: node.nodeId,
    kind: node.kind === 'campaign.create' ? 'campaign' : node.kind === 'ad_group.create' ? 'ad_group' : node.kind === 'ad.create' ? 'product_ad' : 'keyword',
    requested: 1, succeeded: node.kind === 'target.create' && !complete ? 0 : 1, status: node.kind === 'target.create' && !complete ? 'failed' : 'created',
    responseCode: node.kind === 'target.create' && !complete ? '429' : null,
    message: node.kind === 'target.create' && !complete ? 'The keyword request was throttled. Review a separate retry.' : null }));
  return CampaignBuilderResult.parse({ snapshot: { status: complete ? 'succeeded' : 'partial_failed', accounting: {
    operatorApproved: 4, pendingDispatch: 0, attempted: 4, succeeded: complete ? 4 : 3, failed: complete ? 0 : 1, ambiguous: 0, refusedAtExecution: 0, blockedByDependency: 0,
    observed: complete ? 4 : 3, pendingObservation: 0, observationNotFound: 0, observationConflict: 0, readChecksRequested: 1, readChecksPending: 0, readChecksPassed: 1, readChecksRefused: 0, readChecksFailed: 0,
  } }, resources, retry: complete ? { requested: 1, created: 1, duplicated: 0 } : null, campaignState: 'paused', currencyCode: 'USD' });
}
export const assetSnapshot = AssetLibrarySnapshot.parse({ id: fixtureId(6), profileId: fixtureId(2), observedAt: fixtureTime, sourceRows: 1, persistedRows: 1, assets: [{
  observation: { scope: { region: 'NA', amazonProfileId: '270' }, identity: { assetId: 'synthetic-asset', version: '1' }, observedAt: fixtureTime, assetType: 'video', name: 'Synthetic product demonstration', processing: 'active', specChecks: { approvedPrograms: null, failedSpecChecks: null } },
  durationSeconds: null, thumbnailUrl: null, thumbnailExpiresAt: null, usedInCampaignIds: ['synthetic-campaign'],
}] });
export const ready = { view: 'ready' as const, context: builderContext, step: 'products' as const };

export const fixtureNaming = { ...builderContext.naming!, variable_order: ['Goal', 'AdType', 'MatchType', 'Keyword', 'Custom1', 'Counter'] };
export const fixtureReverseName = generateCampaignName(namingSettingsFromStrategy(fixtureNaming), { goal: 'Rank', campaignType: 'SKW', matchType: 'EXACT', productName: 'Synthetic lantern', keywordText: 'synthetic lantern', counter: 3 }, '2026-06-10');

export const fixtureCpcRationale = campaignBidRationale({ keyword: builderRecipe.keywords[0]!.text, basis: 'keyword_cpc', bid: builderRecipe.keywords[0]!.bid, currency: builderContext.profile.currencyCode, topOfSearch: builderRecipe.topOfSearch, audienceAdjustment: builderRecipe.audienceAdjustment, evidence: builderContext.bidEvidence[0]! });
