import {
  CampaignBuilderRecipe, CampaignCreationPlanV1, CampaignCreationNodeV1, orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint, serializeCampaignCreationPlanFingerprint,
  type CampaignBuilderContext, type CampaignCreationSha256Hasher,
} from '@wizard-ads/shared';
import { buildCampaignPlan } from './plan.js';
import { namingSettingsFromStrategy } from './naming.js';
import type { CampaignPlan } from './types.js';

export function buildCampaignRecipe(raw: CampaignBuilderRecipe, context: Pick<CampaignBuilderContext, 'profile' | 'products' | 'today'>): CampaignPlan {
  const recipe = CampaignBuilderRecipe.parse(raw);
  if (recipe.adType !== 'SP') throw new Error('This ad type is unavailable in the capability snapshot');
  const products = recipe.productKeys.map((key) => {
    const product = context.products.find((candidate) => candidate.key === key);
    if (!product) throw new Error('A selected product is no longer in the advertised-product mirror');
    return product;
  });
  const purpose = { rank: 'RANK_SKW', discovery: 'DISCOVERY', profit: 'HALO', shield: 'SHIELD' }[recipe.play];
  const plan = buildCampaignPlan({ client: context.profile.label, marketplace: context.profile.countryCode,
    naming: namingSettingsFromStrategy(recipe.naming), defaults: { dailyBudget: recipe.dailyBudget,
      keywordBid: recipe.keywords[0]!.bid, state: 'paused', childState: 'paused', topOfSearchPlacement: recipe.topOfSearch },
    campaigns: products.map((product) => ({
      campaignType: recipe.structure === 'keyword-product' ? 'SKW' : recipe.play === 'discovery' ? 'Phrase' : 'Halo',
      campaignPurpose: purpose, goal: recipe.play[0]!.toUpperCase() + recipe.play.slice(1),
      matchType: recipe.play === 'discovery' || recipe.play === 'shield' ? 'PHRASE' : 'EXACT',
      productName: product.name, sku: product.sku ? [product.sku] : [], asin: [product.asin],
      keywords: recipe.keywords.map((keyword) => keyword.text), targetDescriptor: recipe.play,
      keywordsPerCampaign: recipe.structure === 'keyword-product' ? 1 : recipe.keywords.length,
      transposeKeywords: recipe.structure === 'keyword-product',
    })),
  }, { today: context.today });
  for (const [index, campaign] of plan.campaigns.entries()) {
    campaign.name = recipe.names[String(index)] ?? campaign.name;
    for (const keyword of campaign.adGroup.keywords) {
      const requested = recipe.keywords.find((item) => item.text === keyword.text);
      if (!requested) throw new Error('Generated keyword differs from the requested draft');
      keyword.bid = requested.bid;
    }
  }
  const expected = products.length * (recipe.structure === 'keyword-product' ? recipe.keywords.length : 1);
  if (plan.campaigns.length !== expected || plan.campaigns.reduce((count, campaign) => count + campaign.adGroup.keywords.length, 0) !== products.length * recipe.keywords.length) throw new Error('Campaign plan counts do not reconcile');
  return plan;
}

/** Draft graph projection only. It carries no provider scope and cannot dispatch. */
export function campaignRecipeCreationPlan(bulk: CampaignPlan, input: { orgId: string; profileId: string; marketplaceId: string; currencyCode: string; now: string; expiresAt: string; uuid: () => string; hasher: CampaignCreationSha256Hasher }): CampaignCreationPlanV1 {
  const nodes: CampaignCreationNodeV1[] = [];
  const products = new Map<string, string>();
  const placeholder = '0'.repeat(64);
  const base = () => ({ nodeId: input.uuid(), adProduct: 'SP' as const, apiDialect: 'sp_legacy_v3' as const, fingerprint: placeholder });
  const ref = (kind: 'campaign' | 'ad_group' | 'product', nodeId: string) => ({ source: 'plan_node' as const, kind, nodeId });
  for (const campaign of bulk.campaigns) {
    const campaignId = input.uuid(); const groupId = input.uuid();
    nodes.push(CampaignCreationNodeV1.parse({ ...base(), nodeId: campaignId, effect: 'irreversible_create', rollback: 'none', kind: 'campaign.create', dependsOn: [],
      payload: { name: campaign.name, state: 'paused', budget: { type: 'daily', amount: campaign.dailyBudget, currencyCode: input.currencyCode },
        startDate: bulk.today, endDate: null, portfolioId: null, settings: { product: 'SP', targetingType: 'manual',
          biddingStrategy: campaign.biddingStrategy === 'Fixed bids' ? 'manual' : 'legacy_for_sales',
          placementBidding: { topOfSearch: campaign.placements.find((placement) => placement.placement === 'Placement Top')?.percentage ?? 0, restOfSearch: 0, productPages: 0 } } } }));
    nodes.push(CampaignCreationNodeV1.parse({ ...base(), nodeId: groupId, effect: 'irreversible_create', rollback: 'none', kind: 'ad_group.create', dependsOn: [campaignId],
      payload: { campaign: ref('campaign', campaignId), name: campaign.adGroup.name, state: 'paused', defaultBid: campaign.adGroup.defaultBid } }));
    for (const product of campaign.adGroup.productAds) {
      let productId = products.get(product.asin);
      if (!productId) {
        productId = input.uuid(); products.set(product.asin, productId);
        nodes.push(CampaignCreationNodeV1.parse({ ...base(), nodeId: productId, kind: 'eligibility.require_product', effect: 'read_check', rollback: 'not_applicable', dependsOn: [], payload: { asin: product.asin, sku: product.sku || null } }));
      }
      nodes.push(CampaignCreationNodeV1.parse({ ...base(), kind: 'ad.create', effect: 'irreversible_create', rollback: 'none', dependsOn: [groupId, productId].sort(),
        payload: { format: 'sp_product_ad', adGroup: ref('ad_group', groupId), product: ref('product', productId), state: 'paused' } }));
    }
    for (const keyword of campaign.adGroup.keywords) nodes.push(CampaignCreationNodeV1.parse({ ...base(), kind: 'target.create', effect: 'irreversible_create', rollback: 'none', dependsOn: [groupId],
      payload: { targetType: 'keyword', parent: ref('ad_group', groupId), scope: 'ad_group', polarity: 'positive', text: keyword.text, matchType: keyword.matchType.toLowerCase(), bid: keyword.bid, state: 'paused' } }));
  }
  const ordered = orderCampaignCreationNodes(nodes).map((node) => CampaignCreationNodeV1.parse({ ...node, fingerprint: input.hasher.digest(serializeCampaignCreationNodeFingerprint(node)) }));
  const byKind = { 'eligibility.require_product': 0, 'eligibility.require_brand': 0, 'eligibility.require_store': 0, 'asset.require_existing': 0, 'campaign.create': 0, 'ad_group.create': 0, 'target.create': 0, 'ad.create': 0, 'creative.create': 0 };
  ordered.forEach((node) => { byKind[node.kind]++; });
  const readChecks = ordered.filter((node) => node.effect === 'read_check').length;
  const plan = CampaignCreationPlanV1.parse({ schemaVersion: 'openspell.campaign-creation-plan.v1', id: input.uuid(), orgId: input.orgId, profileId: input.profileId,
    marketplaceId: input.marketplaceId, adProduct: 'SP', apiDialect: 'sp_legacy_v3', generatedAt: input.now, frozenAt: input.now, expiresAt: input.expiresAt,
    nodes: ordered, counts: { totalNodes: ordered.length, readChecks, irreversibleCreates: ordered.length - readChecks, byKind }, fingerprint: placeholder,
    noRollbackAcknowledgement: { required: true, rollback: 'none', compensatingAction: 'separate_reviewed_pause_or_archive' } });
  return CampaignCreationPlanV1.parse({ ...plan, fingerprint: input.hasher.digest(serializeCampaignCreationPlanFingerprint(plan)) });
}
