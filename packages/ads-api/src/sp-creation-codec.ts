/**
 * Deterministic SP creation request preparation. No credentials, I/O or admission.
 *
 * One node produces one candidate request. The worker must verify its compound
 * authority, atomically reserve the exact intent, and use one HTTP attempt. A
 * prepared request is not evidence that authority exists or that Amazon ran it.
 */
import {
  CampaignCreationExecutionEvidence,
  CampaignCreationSha256,
  requireCampaignCreationDispatchInputs,
  verifyCampaignCreationPlanFingerprints,
  type CampaignCreationNodeV2,
  type CampaignCreationPlan,
  type CampaignCreationPlanV2,
  type CampaignCreationProviderCallPosition,
  type CampaignCreationProviderScope,
  type CampaignCreationSha256Hasher,
} from '@wizard-ads/shared';
import { SP_WRITE_ENDPOINTS, type SpWriteKind } from './endpoints.js';
import { assertSpProviderMoneyScope, spMoneyNumber } from './sp-money.js';
import type {
  SpAdGroupCreateInput,
  SpCampaignCreateInput,
  SpCampaignNegativeKeywordCreateInput,
  SpCampaignNegativeTargetCreateInput,
  SpKeywordCreateInput,
  SpNegativeKeywordCreateInput,
  SpNegativeTargetCreateInput,
  SpProductAdCreateInput,
  SpTargetCreateInput,
} from './writes.js';

type CreateItem = SpCampaignCreateInput | SpAdGroupCreateInput | SpProductAdCreateInput
  | SpKeywordCreateInput | SpNegativeKeywordCreateInput | SpCampaignNegativeKeywordCreateInput
  | SpTargetCreateInput | SpNegativeTargetCreateInput | SpCampaignNegativeTargetCreateInput;

export type SpCreationCompiledCall = Readonly<{
  kind: SpWriteKind;
  method: 'POST';
  path: string;
  mediaType: string;
  body: string;
  providerScope: Readonly<CampaignCreationProviderScope>;
  requestDigest: string;
  positions: readonly [Readonly<CampaignCreationProviderCallPosition>];
}>;

function refuse(reason: string): never {
  throw new Error(`SP creation request refused: ${reason}`);
}

function digest(preimage: string, hasher: CampaignCreationSha256Hasher): string {
  if (hasher.algorithm !== 'sha256') refuse('invalid_hasher');
  return CampaignCreationSha256.parse(hasher.digest(preimage));
}

function requestItem(
  plan: CampaignCreationPlanV2,
  node: CampaignCreationNodeV2,
  evidence: CampaignCreationExecutionEvidence,
): { kind: SpWriteKind; item: CreateItem } {
  const nodes = new Map(plan.nodes.map((entry) => [entry.nodeId, entry]));
  const results = new Map(evidence.providerResults.map((entry) => [entry.nodeId, entry]));
  const observations = new Map(evidence.observations.map((entry) => [entry.nodeId, entry]));

  // Checking every declared dependency also retains read checks which are not
  // themselves written into the body, such as a campaign's product preflight.
  const checkedIdentity = (nodeId: string): string => {
    const dependency = nodes.get(nodeId);
    const result = results.get(nodeId);
    if (dependency === undefined || result === undefined || result.providerEntityId === null) {
      return refuse('dependency_not_satisfied');
    }
    if (dependency.effect === 'read_check') {
      if (result.effect !== 'read_check' || result.outcome !== 'passed') {
        return refuse('read_dependency_not_passed');
      }
      return result.providerEntityId;
    }
    const observation = observations.get(nodeId);
    if (result.effect !== 'irreversible_create' || result.outcome !== 'succeeded'
      || observation?.observation !== 'observed'
      || observation.providerEntityId !== result.providerEntityId) {
      return refuse('create_dependency_not_observed');
    }
    return result.providerEntityId;
  };

  for (const dependencyId of node.dependsOn) checkedIdentity(dependencyId);

  const campaignIdentity = (nodeId: string): string => {
    if (nodes.get(nodeId)?.kind !== 'campaign.create') return refuse('campaign_reference_mismatch');
    return checkedIdentity(nodeId);
  };
  const adGroupIdentity = (nodeId: string): { campaignId: string; adGroupId: string } => {
    const group = nodes.get(nodeId);
    if (group?.kind !== 'ad_group.create') return refuse('ad_group_reference_mismatch');
    return {
      campaignId: campaignIdentity(group.payload.campaign.nodeId),
      adGroupId: checkedIdentity(nodeId),
    };
  };

  switch (node.kind) {
    case 'campaign.create': {
      const { settings, schedule } = node.payload;
      if (settings.product !== 'SP' || schedule.type !== 'calendar_dates') {
        return refuse('unsupported_campaign');
      }
      if (settings.biddingStrategy === 'rule_based') return refuse('rule_based_recipe_unverified');
      if (node.payload.portfolioId !== null) return refuse('portfolio_preflight_unavailable');
      const strategies = {
        manual: 'MANUAL', legacy_for_sales: 'LEGACY_FOR_SALES', auto_for_sales: 'AUTO_FOR_SALES',
      } as const;
      const item: SpCampaignCreateInput = {
        name: node.payload.name,
        state: 'PAUSED',
        targetingType: settings.targetingType === 'auto' ? 'AUTO' : 'MANUAL',
        budget: { budget: spMoneyNumber(String(node.payload.budget.amount), plan.providerScope, 'budget'), budgetType: 'DAILY' },
        startDate: schedule.startDate,
        ...(schedule.endDate === null ? {} : { endDate: schedule.endDate }),
        dynamicBidding: {
          strategy: strategies[settings.biddingStrategy],
          placementBidding: [
            { placement: 'PLACEMENT_TOP', percentage: settings.placementBidding.topOfSearch },
            { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: settings.placementBidding.productPages },
            { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: settings.placementBidding.restOfSearch },
          ],
        },
      };
      return { kind: 'campaigns', item };
    }
    case 'ad_group.create': {
      if (node.payload.defaultBid === null) return refuse('missing_default_bid');
      return { kind: 'adGroups', item: {
        campaignId: campaignIdentity(node.payload.campaign.nodeId),
        name: node.payload.name, state: 'PAUSED',
        defaultBid: spMoneyNumber(String(node.payload.defaultBid), plan.providerScope, 'bid'),
      } satisfies SpAdGroupCreateInput };
    }
    case 'ad.create': {
      if (node.payload.format !== 'sp_product_ad') return refuse('unsupported_ad');
      const product = nodes.get(node.payload.product.nodeId);
      if (product?.kind !== 'eligibility.require_product') return refuse('product_reference_mismatch');
      checkedIdentity(product.nodeId);
      const parent = adGroupIdentity(node.payload.adGroup.nodeId);
      if (plan.providerScope.accountType === 'seller' && product.payload.sku !== null) {
        return { kind: 'productAds', item: { ...parent, state: 'PAUSED', sku: product.payload.sku } };
      }
      if (plan.providerScope.accountType === 'vendor') {
        return { kind: 'productAds', item: { ...parent, state: 'PAUSED', asin: product.payload.asin } };
      }
      return refuse('product_ad_account_type_unverified');
    }
    case 'target.create': {
      const target = node.payload;
      if (target.targetType !== 'keyword' && target.targetType !== 'expression') {
        return refuse('unsupported_target');
      }
      const parent = target.scope === 'ad_group'
        ? adGroupIdentity(target.parent.nodeId)
        : { campaignId: campaignIdentity(target.parent.nodeId) };
      if (target.targetType === 'keyword') {
        const base = { ...parent, keywordText: target.text, state: 'PAUSED' as const };
        if (target.polarity === 'negative') {
          const matchType = target.matchType === 'negative_exact' ? 'NEGATIVE_EXACT' : 'NEGATIVE_PHRASE';
          return { kind: target.scope === 'campaign' ? 'campaignNegativeKeywords' : 'negativeKeywords',
            item: { ...base, matchType } };
        }
        if (!('adGroupId' in parent)) return refuse('positive_keyword_parent_mismatch');
        const matchTypes = { exact: 'EXACT', phrase: 'PHRASE', broad: 'BROAD' } as const;
        if (target.matchType !== 'exact' && target.matchType !== 'phrase' && target.matchType !== 'broad') {
          return refuse('positive_keyword_match_type_mismatch');
        }
        return { kind: 'keywords', item: { ...parent, ...base,
          matchType: matchTypes[target.matchType],
          ...(target.bid === null ? {} : { bid: spMoneyNumber(String(target.bid), plan.providerScope, 'bid') }),
        } satisfies SpKeywordCreateInput };
      }
      if (target.expression.length > 1000) return refuse('expression_count_exceeds_provider_limit');
      const expression = target.expression.map((predicate) => ({
        type: predicate.type.toUpperCase(), value: predicate.value,
      }));
      if (target.polarity === 'negative') {
        return { kind: target.scope === 'campaign' ? 'campaignNegativeTargets' : 'negativeTargets',
          item: { ...parent, expression, state: 'PAUSED' } };
      }
      if (!('adGroupId' in parent)) return refuse('positive_target_parent_mismatch');
      return { kind: 'targets', item: { ...parent, state: 'PAUSED', expression,
        expressionType: 'MANUAL',
        ...(target.bid === null ? {} : { bid: spMoneyNumber(String(target.bid), plan.providerScope, 'bid') }),
      } satisfies SpTargetCreateInput };
    }
    default:
      return refuse('unsupported_create_node');
  }
}

export function prepareSpCreationCall(
  input: { plan: CampaignCreationPlan; currentEvidence: CampaignCreationExecutionEvidence; nodeId: string },
  hasher: CampaignCreationSha256Hasher,
): SpCreationCompiledCall {
  const plan = requireCampaignCreationDispatchInputs(verifyCampaignCreationPlanFingerprints(input.plan, hasher));
  if (plan.adProduct !== 'SP' || plan.apiDialect !== 'sp_legacy_v3') refuse('unsupported_product_or_dialect');
  assertSpProviderMoneyScope(plan.providerScope);
  const evidence = CampaignCreationExecutionEvidence.parse(input.currentEvidence);
  if (JSON.stringify(evidence.plan) !== JSON.stringify(plan)) refuse('evidence_plan_mismatch');
  const node = plan.nodes.find((entry) => entry.nodeId === input.nodeId);
  if (node === undefined || node.effect !== 'irreversible_create') refuse('unknown_create_node');
  if (evidence.providerCallIntents.some((intent) => intent.positions.some((position) => position.nodeId === node.nodeId))
    || evidence.providerResults.some((result) => result.nodeId === node.nodeId)
    || evidence.nonProviderDispositions.find((entry) => entry.nodeId === node.nodeId)?.outcome !== 'pending_dispatch') {
    refuse('node_not_exclusively_pending_dispatch');
  }

  const { kind, item } = requestItem(plan, node, evidence);
  const endpoint = SP_WRITE_ENDPOINTS[kind];
  const body = JSON.stringify({ [endpoint.requestKey]: [item] });
  const scope = Object.freeze({ ...plan.providerScope });
  const requestContext = [plan.id, plan.fingerprint, plan.orgId, plan.profileId, scope,
    'POST', endpoint.path, endpoint.mediaType];
  const position = Object.freeze({ requestIndex: 0, nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
    requestDigest: digest(JSON.stringify(['openspell.sp-creation-node-request.v1', ...requestContext,
      node.nodeId, node.fingerprint, item]), hasher),
  });
  const positions: readonly [Readonly<CampaignCreationProviderCallPosition>] = Object.freeze([position]);
  return Object.freeze({ kind, method: 'POST', path: endpoint.path, mediaType: endpoint.mediaType, body,
    providerScope: scope,
    requestDigest: digest(JSON.stringify(['openspell.sp-creation-http-request.v1', ...requestContext, positions, body]), hasher),
    positions,
  });
}
