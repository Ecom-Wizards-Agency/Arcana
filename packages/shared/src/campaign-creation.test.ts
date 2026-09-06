/// <reference types="node" />

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ApproveCampaignCreationPlan,
  CampaignCreationAccounting,
  CampaignCreationAuthorizationReceipt,
  CampaignCreationExecutionEvidence,
  CampaignCreationExecutionSnapshot,
  CampaignCreationJobPayload,
  CampaignCreationNodeV1 as CampaignCreationNode,
  CampaignCreationPlanV1 as CampaignCreationPlan,
  CampaignCreationNode as RecordedCampaignCreationNode,
  CampaignCreationPlan as RecordedCampaignCreationPlan,
  CampaignCreationNodeV2,
  CampaignCreationPlanV2,
  SponsoredBrandsCreationFormatV2,
  CampaignCreationProviderResult,
  CampaignCreationResourceObservation,
  JobPayload,
  deriveCampaignCreationExecutionStatus,
  orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint,
  verifyCampaignCreationJobArtifacts,
  verifyCampaignCreationObservationArtifacts,
  verifyCampaignCreationPlanFingerprints,
  verifyCampaignCreationProviderCallArtifacts,
  requireCampaignCreationDispatchInputs,
  type CampaignCreationNodeV1 as CampaignCreationNodeType,
  type CampaignCreationPlanV1 as CampaignCreationPlanType,
} from './index.js';

const ORG_ID = '00000000-0000-4000-8000-000000000001';
const PROFILE_ID = '00000000-0000-4000-8000-000000000002';
const PLAN_ID = '00000000-0000-4000-8000-000000000003';
const EXECUTION_ID = '00000000-0000-4000-8000-000000000004';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000005';
const CALL_ID = '00000000-0000-4000-8000-000000000006';
const GENERATION_ID = '00000000-0000-4000-8000-000000000007';
const AUTHORIZATION_ID = '00000000-0000-4000-8000-000000000008';
const PRODUCT_NODE_ID = '00000000-0000-4000-8000-000000000011';
const CAMPAIGN_NODE_ID = '00000000-0000-4000-8000-000000000012';
const AD_GROUP_NODE_ID = '00000000-0000-4000-8000-000000000013';
const AD_NODE_ID = '00000000-0000-4000-8000-000000000014';
const TARGET_NODE_ID = '00000000-0000-4000-8000-000000000015';
const sha = (character: string): string => character.repeat(64);
const sha256 = {
  algorithm: 'sha256' as const,
  digest: (value: string): string => createHash('sha256').update(value).digest('hex'),
};

function spNodes(): CampaignCreationNodeType[] {
  return [
    CampaignCreationNode.parse({
      nodeId: PRODUCT_NODE_ID,
      kind: 'eligibility.require_product',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [],
      fingerprint: sha('1'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { asin: 'B000000000', sku: 'SYNTHETIC-SKU' },
    }),
    CampaignCreationNode.parse({
      nodeId: CAMPAIGN_NODE_ID,
      kind: 'campaign.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [PRODUCT_NODE_ID],
      fingerprint: sha('2'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        name: 'Synthetic campaign',
        state: 'paused',
        budget: { amount: 10, type: 'daily', currencyCode: 'USD' },
        startDate: '2026-08-31',
        endDate: null,
        portfolioId: null,
        settings: {
          product: 'SP',
          targetingType: 'manual',
          biddingStrategy: 'manual',
          placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 },
        },
      },
    }),
    CampaignCreationNode.parse({
      nodeId: AD_GROUP_NODE_ID,
      kind: 'ad_group.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [CAMPAIGN_NODE_ID],
      fingerprint: sha('3'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        campaign: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        name: 'Synthetic ad group',
        state: 'paused',
        defaultBid: 1.01,
      },
    }),
    CampaignCreationNode.parse({
      nodeId: AD_NODE_ID,
      kind: 'ad.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [PRODUCT_NODE_ID, AD_GROUP_NODE_ID],
      fingerprint: sha('4'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sp_product_ad',
        adGroup: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        product: { source: 'plan_node', kind: 'product', nodeId: PRODUCT_NODE_ID },
        state: 'paused',
      },
    }),
    CampaignCreationNode.parse({
      nodeId: TARGET_NODE_ID,
      kind: 'target.create',
      adProduct: 'SP',
      apiDialect: 'sp_legacy_v3',
      dependsOn: [AD_GROUP_NODE_ID],
      fingerprint: sha('5'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        targetType: 'keyword',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'positive',
        text: 'synthetic keyword',
        matchType: 'exact',
        bid: 1.01,
        state: 'paused',
      },
    }),
  ];
}

function counts() {
  return {
    totalNodes: 5,
    readChecks: 1,
    irreversibleCreates: 4,
    byKind: {
      'eligibility.require_product': 1,
      'eligibility.require_brand': 0,
      'eligibility.require_store': 0,
      'asset.require_existing': 0,
      'campaign.create': 1,
      'ad_group.create': 1,
      'target.create': 1,
      'ad.create': 1,
      'creative.create': 0,
    },
  } as const;
}

function spPlan(): CampaignCreationPlanType {
  return CampaignCreationPlan.parse({
    schemaVersion: 'openspell.campaign-creation-plan.v1',
    id: PLAN_ID,
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    marketplaceId: 'MARKETPLACE-1',
    adProduct: 'SP',
    apiDialect: 'sp_legacy_v3',
    generatedAt: '2026-08-30T00:00:00.000Z',
    frozenAt: '2026-08-30T00:01:00.000Z',
    expiresAt: '2026-08-30T01:01:00.000Z',
    nodes: spNodes(),
    counts: counts(),
    fingerprint: sha('a'),
    noRollbackAcknowledgement: {
      required: true,
      rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive',
    },
  });
}

function fingerprintedSpPlan(): CampaignCreationPlanType {
  const base = spPlan();
  const nodes = base.nodes.map((node) => ({
    ...node,
    fingerprint: sha256.digest(serializeCampaignCreationNodeFingerprint(node)),
  })) as CampaignCreationNodeType[];
  const withNodeFingerprints = CampaignCreationPlan.parse({
    ...base,
    nodes,
    fingerprint: sha('0'),
  });
  return CampaignCreationPlan.parse({
    ...withNodeFingerprints,
    fingerprint: sha256.digest(serializeCampaignCreationPlanFingerprint(withNodeFingerprints)),
  });
}

function sbStoreSpotlightPlan(): CampaignCreationPlanType {
  const brandId = '00000000-0000-4000-8000-000000000020';
  const storeId = '00000000-0000-4000-8000-000000000021';
  const logoId = '00000000-0000-4000-8000-000000000022';
  const productIds = [
    '00000000-0000-4000-8000-000000000023',
    '00000000-0000-4000-8000-000000000024',
    '00000000-0000-4000-8000-000000000025',
  ];
  const campaignId = '00000000-0000-4000-8000-000000000026';
  const adGroupId = '00000000-0000-4000-8000-000000000027';
  const adId = '00000000-0000-4000-8000-000000000028';
  const pageIds = ['PAGE-1', 'PAGE-2', 'PAGE-3'];
  const nodes = orderCampaignCreationNodes([
    CampaignCreationNode.parse({
      nodeId: brandId,
      kind: 'eligibility.require_brand',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('1'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: {
        brandId: 'BRAND-1',
        brandEntityId: 'BRAND-ENTITY-1',
        brandName: 'Synthetic brand',
      },
    }),
    CampaignCreationNode.parse({
      nodeId: storeId,
      kind: 'eligibility.require_store',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('2'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { storeId: 'STORE-1', pageIds },
    }),
    CampaignCreationNode.parse({
      nodeId: logoId,
      kind: 'asset.require_existing',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('3'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: {
        assetId: 'ASSET-1',
        version: '1',
        purpose: 'logo',
      },
    }),
    ...productIds.map((nodeId, index) => CampaignCreationNode.parse({
      nodeId,
      kind: 'eligibility.require_product',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha(String(index + 4)),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { asin: `B00000000${index + 1}`, sku: null },
    })),
    CampaignCreationNode.parse({
      nodeId: campaignId,
      kind: 'campaign.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [brandId, storeId].sort(),
      fingerprint: sha('7'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        name: 'Synthetic Store campaign',
        state: 'paused',
        budget: { amount: 10, type: 'daily', currencyCode: 'USD' },
        startDate: '2026-08-31',
        endDate: null,
        portfolioId: null,
        settings: {
          product: 'SB',
          targetingType: 'manual',
          format: 'store_spotlight',
          brand: { source: 'plan_node', kind: 'brand', nodeId: brandId },
        },
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adGroupId,
      kind: 'ad_group.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [campaignId],
      fingerprint: sha('8'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        campaign: { source: 'plan_node', kind: 'campaign', nodeId: campaignId },
        name: 'Synthetic Store ad group',
        state: 'paused',
        defaultBid: null,
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adId,
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [brandId, storeId, logoId, ...productIds, adGroupId].sort(),
      fingerprint: sha('9'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_store_spotlight',
        name: 'Synthetic Store ad',
        adGroup: { source: 'plan_node', kind: 'ad_group', nodeId: adGroupId },
        brand: { source: 'plan_node', kind: 'brand', nodeId: brandId },
        landingPage: {
          type: 'store',
          store: { source: 'plan_node', kind: 'store', nodeId: storeId },
          pageId: null,
        },
        logoAsset: { source: 'plan_node', kind: 'asset', nodeId: logoId },
        headline: 'Synthetic headline',
        cards: productIds.map((productId, index) => ({
          headline: `Synthetic card ${index + 1}`,
          landingPage: {
            type: 'store',
            store: { source: 'plan_node', kind: 'store', nodeId: storeId },
            pageId: pageIds[index],
          },
          product: { source: 'plan_node', kind: 'product', nodeId: productId },
        })),
        state: 'paused',
      },
    }),
  ]);
  return CampaignCreationPlan.parse({
    schemaVersion: 'openspell.campaign-creation-plan.v1',
    id: '00000000-0000-4000-8000-000000000029',
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    marketplaceId: 'MARKETPLACE-1',
    adProduct: 'SB',
    apiDialect: 'unified_ads_v1',
    generatedAt: '2026-08-30T00:00:00.000Z',
    frozenAt: '2026-08-30T00:01:00.000Z',
    expiresAt: '2026-08-30T01:01:00.000Z',
    nodes,
    counts: {
      totalNodes: 9,
      readChecks: 6,
      irreversibleCreates: 3,
      byKind: {
        'eligibility.require_product': 3,
        'eligibility.require_brand': 1,
        'eligibility.require_store': 1,
        'asset.require_existing': 1,
        'campaign.create': 1,
        'ad_group.create': 1,
        'target.create': 0,
        'ad.create': 1,
        'creative.create': 0,
      },
    },
    fingerprint: sha('b'),
    noRollbackAcknowledgement: {
      required: true,
      rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive',
    },
  });
}

function sbProductVideoPlan(): CampaignCreationPlanType {
  const brandNodeId = '00000000-0000-4000-8000-000000000070';
  const videoAssetNodeId = '00000000-0000-4000-8000-000000000071';
  const campaignNodeId = '00000000-0000-4000-8000-000000000072';
  const adGroupNodeId = '00000000-0000-4000-8000-000000000073';
  const adNodeId = '00000000-0000-4000-8000-000000000074';
  const nodes = orderCampaignCreationNodes([
    CampaignCreationNode.parse({
      nodeId: brandNodeId,
      kind: 'eligibility.require_brand',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('1'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: {
        brandId: 'BRAND-VIDEO-1',
        brandEntityId: 'BRAND-ENTITY-VIDEO-1',
        brandName: 'Synthetic video brand',
      },
    }),
    CampaignCreationNode.parse({
      nodeId: videoAssetNodeId,
      kind: 'asset.require_existing',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('2'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { assetId: 'VIDEO-ASSET-1', version: '7', purpose: 'video' },
    }),
    CampaignCreationNode.parse({
      nodeId: campaignNodeId,
      kind: 'campaign.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [brandNodeId],
      fingerprint: sha('3'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        name: 'Synthetic video campaign',
        state: 'paused',
        budget: { amount: 10, type: 'daily', currencyCode: 'USD' },
        startDate: '2026-08-31',
        endDate: null,
        portfolioId: null,
        settings: {
          product: 'SB',
          targetingType: 'manual',
          format: 'product_video',
          brand: { source: 'plan_node', kind: 'brand', nodeId: brandNodeId },
        },
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adGroupNodeId,
      kind: 'ad_group.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [campaignNodeId],
      fingerprint: sha('4'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        campaign: { source: 'plan_node', kind: 'campaign', nodeId: campaignNodeId },
        name: 'Synthetic video ad group',
        state: 'paused',
        defaultBid: null,
      },
    }),
    CampaignCreationNode.parse({
      nodeId: adNodeId,
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [videoAssetNodeId, adGroupNodeId].sort(),
      fingerprint: sha('5'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_product_video',
        name: 'Synthetic product video ad',
        adGroup: { source: 'plan_node', kind: 'ad_group', nodeId: adGroupNodeId },
        brand: null,
        logoAsset: null,
        headline: null,
        enableCreativeAutoTranslation: null,
        landingPage: null,
        products: [],
        videoAsset: { source: 'plan_node', kind: 'asset', nodeId: videoAssetNodeId },
        state: 'paused',
      },
    }),
  ]);
  return CampaignCreationPlan.parse({
    schemaVersion: 'openspell.campaign-creation-plan.v1',
    id: '00000000-0000-4000-8000-000000000075',
    orgId: ORG_ID,
    profileId: PROFILE_ID,
    marketplaceId: 'MARKETPLACE-1',
    adProduct: 'SB',
    apiDialect: 'unified_ads_v1',
    generatedAt: '2026-08-30T00:00:00.000Z',
    frozenAt: '2026-08-30T00:01:00.000Z',
    expiresAt: '2026-08-30T01:01:00.000Z',
    nodes,
    counts: {
      totalNodes: 5,
      readChecks: 2,
      irreversibleCreates: 3,
      byKind: {
        'eligibility.require_product': 0,
        'eligibility.require_brand': 1,
        'eligibility.require_store': 0,
        'asset.require_existing': 1,
        'campaign.create': 1,
        'ad_group.create': 1,
        'target.create': 0,
        'ad.create': 1,
        'creative.create': 0,
      },
    },
    fingerprint: sha('c'),
    noRollbackAcknowledgement: {
      required: true,
      rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive',
    },
  });
}

function completedSpExecutionEvidence(plan: CampaignCreationPlanType | CampaignCreationPlanV2 = spPlan()) {
  const providerResults = plan.nodes.map((node, index) => ({
    effect: node.effect,
    planId: plan.id,
    nodeId: node.nodeId,
    executionId: EXECUTION_ID,
    attemptId: `00000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
    providerCallId: `00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}`,
    nodeFingerprint: node.fingerprint,
    requestIndex: node.effect === 'read_check' ? null : 0,
    ...(node.effect === 'irreversible_create' ? {
      requestDigest: sha(String((index + 6) % 10)),
      nodeRequestDigest: sha(String((index + 7) % 10)),
    } : {}),
    outcome: node.effect === 'read_check' ? 'passed' : 'succeeded',
    providerEntityId: node.kind === 'eligibility.require_product' ? node.payload.asin
      : node.kind === 'eligibility.require_brand' ? node.payload.brandId
        : node.kind === 'eligibility.require_store' ? node.payload.storeId
          : node.kind === 'asset.require_existing' ? node.payload.assetId
            : `ENTITY-${index + 1}`,
    providerEntityVersion: node.kind === 'asset.require_existing' ? node.payload.version : null,
    providerCode: null,
    sanitizedMessage: null,
    providerRequestId: 'REQUEST-1',
    responseDigest: sha(String((index + 1) % 10)),
    startedAt: `2026-08-30T00:02:${String(index * 2).padStart(2, '0')}.000Z`,
    completedAt: `2026-08-30T00:02:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
  }));
  const providerCallIntents = plan.nodes
    .map((node, index) => ({ node, index, result: providerResults[index] }))
    .filter(({ node }) => node.effect === 'irreversible_create')
    .map(({ node, index, result }) => ({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attemptId: result?.attemptId,
      providerCallId: result?.providerCallId,
      requestDigest: result?.requestDigest,
      positions: [{
        requestIndex: 0,
        nodeId: node.nodeId,
        nodeFingerprint: node.fingerprint,
        requestDigest: result?.nodeRequestDigest,
      }],
      recordedAt: `2026-08-30T00:02:${String(index * 2 - 1).padStart(2, '0')}.500Z`,
    }));
  const observations = plan.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => node.effect === 'irreversible_create')
    .map(({ node, index }) => ({
      providerResult: providerResults.find((result) => result.nodeId === node.nodeId),
      providerIntent: providerCallIntents.find((intent) => (
        intent.positions.some((position) => position.nodeId === node.nodeId)
      )),
      index,
      node,
    }))
    .map(({ node, index, providerIntent, providerResult }) => ({
      planId: plan.id,
      nodeId: node.nodeId,
      executionId: EXECUTION_ID,
      authorizationId: providerIntent?.authorizationId,
      generation: providerIntent?.generation,
      attemptId: providerIntent?.attemptId,
      providerCallId: providerIntent?.providerCallId,
      nodeFingerprint: node.fingerprint,
      requestDigest: providerIntent?.requestDigest,
      nodeRequestDigest: providerIntent?.positions[0]?.requestDigest,
      basis: 'provider_result_identity',
      providerEntityId: providerResult?.providerEntityId,
      observation: 'observed',
      amazonModerationStatus: 'not_applicable',
      deliveryStatus: 'not_delivering',
      observedAt: `2026-08-30T00:02:${String(index * 2 + 1).padStart(2, '0')}.250Z`,
      sourceSyncJobId: GENERATION_ID,
    }));
  return {
    plan,
    executionId: EXECUTION_ID,
    providerCallIntents,
    providerResults,
    nonProviderDispositions: [],
    observations,
    snapshot: {
      status: 'succeeded',
      accounting: {
        operatorApproved: plan.counts.irreversibleCreates,
        pendingDispatch: 0,
        attempted: plan.counts.irreversibleCreates,
        succeeded: plan.counts.irreversibleCreates,
        failed: 0,
        ambiguous: 0,
        refusedAtExecution: 0,
        blockedByDependency: 0,
        observed: plan.counts.irreversibleCreates,
        pendingObservation: 0,
        observationNotFound: 0,
        observationConflict: 0,
        readChecksRequested: plan.counts.readChecks,
        readChecksPending: 0,
        readChecksPassed: plan.counts.readChecks,
        readChecksRefused: 0,
        readChecksFailed: 0,
      },
    },
  };
}

function failedCampaignExecutionEvidence() {
  const completed = completedSpExecutionEvidence();
  const campaignResult = completed.providerResults.find(
    (result) => result.nodeId === CAMPAIGN_NODE_ID,
  );
  if (campaignResult === undefined) throw new Error('synthetic campaign result missing');
  const providerResults = [
    completed.providerResults[0],
    {
      ...campaignResult,
      outcome: 'authoritative_rejected',
      providerEntityId: null,
      providerCode: 'SYNTHETIC_FAILURE',
    },
  ];
  const providerCallIntents = completed.providerCallIntents.filter((intent) => (
    intent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
  ));
  const nonProviderDispositions = completed.plan.nodes
    .filter((node) => node.effect === 'irreversible_create' && node.nodeId !== CAMPAIGN_NODE_ID)
    .map((node) => ({
      planId: completed.plan.id,
      nodeId: node.nodeId,
      executionId: completed.executionId,
      nodeFingerprint: node.fingerprint,
      outcome: 'blocked_by_dependency',
      sanitizedReason: 'A required predecessor failed.',
    }));
  return {
    ...completed,
    providerCallIntents,
    providerResults,
    nonProviderDispositions,
    observations: [],
    snapshot: {
      status: 'failed',
      accounting: {
        operatorApproved: 4,
        pendingDispatch: 0,
        attempted: 1,
        succeeded: 0,
        failed: 1,
        ambiguous: 0,
        refusedAtExecution: 0,
        blockedByDependency: 3,
        observed: 0,
        pendingObservation: 0,
        observationNotFound: 0,
        observationConflict: 0,
        readChecksRequested: 1,
        readChecksPending: 0,
        readChecksPassed: 1,
        readChecksRefused: 0,
        readChecksFailed: 0,
      },
    },
  };
}

const NODE_VERSION_V2 = 'openspell.campaign-creation-node.v2' as const;
const PLAN_VERSION_V2 = 'openspell.campaign-creation-plan.v2' as const;
const IMAGE_NODE_ID = '00000000-0000-4000-8000-000000000030';
const VIDEO_NODE_ID = '00000000-0000-4000-8000-000000000031';
const CREATIVE_NODE_ID = '00000000-0000-4000-8000-000000000032';

function ref(kind: 'asset' | 'product' | 'ad_group' | 'store', nodeId: string) {
  return { source: 'plan_node', kind, nodeId } as const;
}

function v2PlanWithNodes(
  source: CampaignCreationPlanType | CampaignCreationPlanV2,
  rawNodes: unknown[],
): CampaignCreationPlanV2 {
  const nodes = orderCampaignCreationNodes(rawNodes.map((node) => CampaignCreationNodeV2.parse(node)));
  const byKind = { ...source.counts.byKind };
  for (const key of Object.keys(byKind) as (keyof typeof byKind)[]) {
    byKind[key] = nodes.filter((node) => node.kind === key).length;
  }
  const readChecks = nodes.filter((node) => node.effect === 'read_check').length;
  return CampaignCreationPlanV2.parse({
    ...source,
    schemaVersion: PLAN_VERSION_V2,
    nodes,
    counts: { totalNodes: nodes.length, readChecks, irreversibleCreates: nodes.length - readChecks, byKind },
  });
}

// Test fixture construction only: production must collect and review these
// explicit inputs, never silently upgrade an operator's recorded v1 artifact.
function v2Fixture(source: CampaignCreationPlanType): CampaignCreationPlanV2 {
  return v2PlanWithNodes(source, source.nodes.map((node) => {
    const common = { ...node, schemaVersion: NODE_VERSION_V2 };
    if (node.kind === 'campaign.create') {
      const { startDate, endDate, settings, ...payload } = node.payload;
      return { ...common, payload: {
        ...payload,
        schedule: settings.product === 'SB'
          ? { type: 'instants', startDateTime: '2026-08-31T07:00:00.000Z', endDateTime: null }
          : { type: 'calendar_dates', startDate, endDate },
        settings: settings.product === 'SB' ? {
          ...settings, costType: 'CPC', marketplaceScope: 'SINGLE_MARKETPLACE', marketplace: 'US',
          optimizations: { goalSettings: { kpi: 'CLICKS' }, bidSettings: { bidStrategy: 'MANUAL' } },
          purchasing: { type: 'auction' },
        } : settings.product === 'SD' ? { ...settings, costType: 'cpc' } : settings,
      } };
    }
    if (node.kind === 'ad_group.create') {
      return { ...common, payload: { ...node.payload, settings: node.adProduct === 'SD'
        ? { product: 'SD', creativeType: 'IMAGE', bidOptimization: 'clicks' }
        : { product: node.adProduct } } };
    }
    if (node.kind === 'ad.create' && node.payload.format === 'sb_store_spotlight') {
      return { ...common, payload: { ...node.payload, enableCreativeAutoTranslation: false } };
    }
    return common;
  }));
}

function v2AssetNode(adProduct: 'SB' | 'SD', purpose: 'image' | 'video'): CampaignCreationNodeV2 {
  return CampaignCreationNodeV2.parse({
    schemaVersion: NODE_VERSION_V2,
    nodeId: purpose === 'image' ? IMAGE_NODE_ID : VIDEO_NODE_ID,
    kind: 'asset.require_existing',
    adProduct,
    apiDialect: adProduct === 'SB' ? 'unified_ads_v1' : 'sd_legacy',
    dependsOn: [], fingerprint: sha('9'), effect: 'read_check', rollback: 'not_applicable',
    payload: { assetId: `SYNTHETIC-${purpose}-ASSET`, version: '3', purpose },
  });
}

function v2SbPlan(format: SponsoredBrandsCreationFormatV2): CampaignCreationPlanV2 {
  const source = v2Fixture(sbStoreSpotlightPlan());
  const needsImage = format === 'product_collection_classic' || format === 'brand_gallery';
  const nodes: unknown[] = source.nodes.map((node) => {
    if (node.kind === 'campaign.create' && node.payload.settings.product === 'SB') {
      return { ...node, payload: { ...node.payload, settings: {
        ...node.payload.settings, format,
        purchasing: format === 'brand_gallery'
          ? { type: 'reserved_share_of_voice', targetedPGDealId: 'SYNTHETIC-DEAL' }
          : { type: 'auction' },
      } } };
    }
    if (node.kind !== 'ad.create' || node.payload.format !== 'sb_store_spotlight') return node;
    const { name, state, adGroup, brand, logoAsset, headline, landingPage, cards } = node.payload;
    const base = { name, state, adGroup, brand };
    const products = cards.map((card) => card.product);
    const image = { asset: ref('asset', IMAGE_NODE_ID), formatProperties: [] };
    const logo = { asset: logoAsset, formatProperties: [] };
    let payload: unknown;
    switch (format) {
      case 'store_spotlight': return node;
      case 'product_collection_manual':
        payload = { ...base, format: `sb_${format}`, products, logoAsset, title: null, landingPage };
        break;
      case 'product_collection_automatic':
        payload = { ...base, format: `sb_${format}`, logoAsset, productExclusions: [] };
        break;
      case 'product_video':
        payload = { ...base, format: `sb_${format}`, products, logoAsset, headline, landingPage,
          enableCreativeAutoTranslation: false, videoAsset: ref('asset', VIDEO_NODE_ID) };
        break;
      case 'product_collection_classic':
        payload = { ...base, format: `sb_${format}`, products, brandLogos: [logo], customImages: [image],
          headline, landingPage, enableCreativeAutoTranslation: false };
        break;
      case 'brand_gallery':
        payload = { ...base, format: `sb_${format}`, brandLogo: logo, customImage: image,
          headline, landingPage, enableCreativeAutoTranslation: false,
          cards: cards.map((card) => ({ headline: card.headline, landingPage: card.landingPage, customImage: image })) };
        break;
    }
    return { ...node, payload, dependsOn: [...node.dependsOn,
      ...(needsImage ? [IMAGE_NODE_ID] : []), ...(format === 'product_video' ? [VIDEO_NODE_ID] : [])].sort() };
  });
  if (needsImage) nodes.push(v2AssetNode('SB', 'image'));
  if (format === 'product_video') nodes.push(v2AssetNode('SB', 'video'));
  return v2PlanWithNodes(source, nodes);
}

function v2SdPlan(format: 'sd_image' | 'sd_video'): CampaignCreationPlanV2 {
  const legacy = spPlan();
  const source = { ...legacy, adProduct: 'SD' as const, apiDialect: 'sd_legacy' as const };
  const nodes: unknown[] = legacy.nodes.map((node) => {
    const common = { ...node, schemaVersion: NODE_VERSION_V2, adProduct: 'SD', apiDialect: 'sd_legacy' };
    switch (node.kind) {
      case 'campaign.create': {
        const { startDate, endDate, ...payload } = node.payload;
        return { ...common, payload: { ...payload,
          schedule: { type: 'calendar_dates', startDate, endDate },
          settings: { product: 'SD', tactic: 'contextual', costType: 'cpc' } } };
      }
      case 'ad_group.create':
        return { ...common, payload: { ...node.payload, settings: { product: 'SD',
          creativeType: format === 'sd_image' ? 'IMAGE' : 'VIDEO', bidOptimization: 'clicks' } } };
      case 'ad.create':
        return { ...common, payload: { ...node.payload, format: 'sd_product_ad' } };
      case 'target.create':
        return { ...common, payload: { targetType: 'sd_product', parent: ref('ad_group', AD_GROUP_NODE_ID),
          polarity: 'positive', bid: 1.01, state: 'paused', asin: 'B000000000' } };
      default: return common;
    }
  });
  const purpose = format === 'sd_image' ? 'image' : 'video';
  const mediaId = purpose === 'image' ? IMAGE_NODE_ID : VIDEO_NODE_ID;
  nodes.push(v2AssetNode('SD', purpose), {
    schemaVersion: NODE_VERSION_V2, nodeId: CREATIVE_NODE_ID, kind: 'creative.create',
    adProduct: 'SD', apiDialect: 'sd_legacy', dependsOn: [AD_GROUP_NODE_ID, AD_NODE_ID, mediaId].sort(),
    fingerprint: sha('8'), effect: 'irreversible_create', rollback: 'none',
    payload: { format, adGroup: ref('ad_group', AD_GROUP_NODE_ID), headline: null,
      brandLogo: null, consentToTranslate: false,
      ...(format === 'sd_image' ? { images: { representation: 'rectangle_and_square',
        rectCustomImage: { asset: ref('asset', mediaId), croppingCoordinates: { top: 0, left: 0, width: 1200, height: 628 } },
        squareCustomImage: { asset: ref('asset', mediaId), croppingCoordinates: { top: 0, left: 0, width: 628, height: 628 } },
      } } : { videos: { representation: 'single_video', video: ref('asset', mediaId) } }),
    },
  });
  return v2PlanWithNodes(source, nodes);
}

function fingerprintedV2(plan: CampaignCreationPlanV2): CampaignCreationPlanV2 {
  const nodes = plan.nodes.map((node) => ({ ...node,
    fingerprint: sha256.digest(serializeCampaignCreationNodeFingerprint(node)) }));
  const prepared = CampaignCreationPlanV2.parse({ ...plan, nodes });
  return CampaignCreationPlanV2.parse({ ...prepared,
    fingerprint: sha256.digest(serializeCampaignCreationPlanFingerprint(prepared)) });
}

function v2Node<K extends CampaignCreationNodeV2['kind']>(plan: CampaignCreationPlanV2, kind: K) {
  const node = plan.nodes.find((candidate) => candidate.kind === kind);
  if (node === undefined) throw new Error(`synthetic ${kind} missing`);
  return node as Extract<CampaignCreationNodeV2, { kind: K }>;
}

function authorityFor(plan: CampaignCreationPlanType | CampaignCreationPlanV2) {
  const authorization = CampaignCreationAuthorizationReceipt.parse({
    authorizationId: AUTHORIZATION_ID, executionId: EXECUTION_ID, generation: GENERATION_ID,
    schemaVersion: plan.schemaVersion, planId: plan.id, planFingerprint: plan.fingerprint,
    orgId: plan.orgId, profileId: plan.profileId, marketplaceId: plan.marketplaceId,
    adProduct: plan.adProduct, apiDialect: plan.apiDialect, expiresAt: plan.expiresAt,
    expectedCounts: plan.counts, noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
    confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
    approvedBy: '00000000-0000-4000-8000-000000000009', approvedAt: '2026-08-30T00:01:15.000Z',
    gateSnapshotDigest: sha('d'),
  });
  const job = { type: 'campaign_creation.dispatch' as const, orgId: plan.orgId, profileId: plan.profileId,
    planId: plan.id, planFingerprint: plan.fingerprint, executionId: EXECUTION_ID,
    authorizationId: AUTHORIZATION_ID, generation: GENERATION_ID };
  return { authorization, job };
}

describe('versioned campaign creation inputs', () => {
  it.each(SponsoredBrandsCreationFormatV2.options)('records the distinct SB %s graph without claiming eligibility', (format) => {
    const plan = fingerprintedV2(v2SbPlan(format));
    expect(RecordedCampaignCreationPlan.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(verifyCampaignCreationPlanFingerprints(plan, sha256)).toEqual(plan);
    expect(requireCampaignCreationDispatchInputs(plan)).toEqual(plan);
    expect(plan).not.toHaveProperty('eligible');
    expect(plan.counts.irreversibleCreates).toBe(3);
    expect(plan.counts.byKind['creative.create']).toBe(0);
    expect(plan.counts.totalNodes).toBe(plan.nodes.length);
    expect(CampaignCreationExecutionEvidence.parse(completedSpExecutionEvidence(plan)).snapshot.status).toBe('succeeded');
  });

  it.each(['sd_image', 'sd_video'] as const)('records %s against its ad group with exact asset versions and create counts', (format) => {
    const plan = fingerprintedV2(v2SdPlan(format));
    expect(verifyCampaignCreationPlanFingerprints(plan, sha256)).toEqual(plan);
    expect(plan.counts).toMatchObject({ totalNodes: 7, readChecks: 2, irreversibleCreates: 5 });
    const creative = v2Node(plan, 'creative.create');
    expect(creative.payload).toHaveProperty('adGroup', ref('ad_group', AD_GROUP_NODE_ID));
    expect(creative.payload).not.toHaveProperty('ad');
    expect(creative.payload).not.toHaveProperty('state');
    expect(plan.nodes.at(-1)?.nodeId).toBe(creative.nodeId);
    expect(CampaignCreationExecutionEvidence.parse(completedSpExecutionEvidence(plan)).snapshot.status).toBe('succeeded');
  });

  it('requires explicit node versions and refuses a mixed plan without upgrading historical nodes', () => {
    const historical = spPlan();
    const current = v2Fixture(historical);
    const oldNode = historical.nodes[0];
    const newNode = current.nodes[0];
    if (oldNode === undefined || newNode === undefined) throw new Error('synthetic node missing');
    expect(RecordedCampaignCreationNode.parse(oldNode)).not.toHaveProperty('schemaVersion');
    expect(RecordedCampaignCreationNode.parse(newNode)).toHaveProperty('schemaVersion', NODE_VERSION_V2);
    expect(CampaignCreationNodeV2.safeParse(oldNode).success).toBe(false);
    expect(RecordedCampaignCreationNode.safeParse({ ...newNode, schemaVersion: 'unsupported' }).success).toBe(false);
    expect(serializeCampaignCreationNodeFingerprint(oldNode)).not.toBe(serializeCampaignCreationNodeFingerprint(newNode));
    expect(RecordedCampaignCreationPlan.safeParse({ ...current, nodes: [oldNode, ...current.nodes.slice(1)] }).success).toBe(false);
    expect(RecordedCampaignCreationPlan.safeParse({ ...historical, nodes: [newNode, ...historical.nodes.slice(1)] }).success).toBe(false);
  });

  it('preserves SP automatic targeting safety and requires reviewed default bids', () => {
    const plan = v2Fixture(spPlan());
    v2Node(plan, 'ad_group.create').payload.defaultBid = null;
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    expect(() => requireCampaignCreationDispatchInputs(plan)).toThrow();
    const old = spPlan();
    const oldGroup = old.nodes.find((node) => node.kind === 'ad_group.create');
    if (oldGroup?.kind !== 'ad_group.create') throw new Error('synthetic ad group missing');
    oldGroup.payload.defaultBid = null;
    expect(RecordedCampaignCreationPlan.parse(old)).toEqual(old);
    expect(() => requireCampaignCreationDispatchInputs(old)).toThrow(/explicit numeric/);
    expect(CampaignCreationExecutionEvidence.parse(completedSpExecutionEvidence(old)).snapshot.status).toBe('succeeded');

    const automatic = v2Fixture(spPlan());
    const settings = v2Node(automatic, 'campaign.create').payload.settings;
    if (settings.product !== 'SP') throw new Error('synthetic SP settings missing');
    settings.targetingType = 'auto';
    expect(CampaignCreationPlanV2.safeParse(automatic).success).toBe(false);
    const valid = v2PlanWithNodes(automatic, automatic.nodes.filter((node) => node.kind !== 'target.create'));
    expect(valid.counts.byKind['target.create']).toBe(0);
    expect(requireCampaignCreationDispatchInputs(valid)).toEqual(valid);
    const target = v2Node(v2Fixture(spPlan()), 'target.create');
    expect(CampaignCreationNodeV2.safeParse({ ...target, payload: {
      targetType: 'expression', parent: ref('ad_group', AD_GROUP_NODE_ID), scope: 'ad_group',
      polarity: 'positive', bid: 1, state: 'paused', expression: [{ type: 'close_match', value: null }],
    } }).success).toBe(false);
  });

  it.each(['costType', 'optimizations', 'marketplace', 'purchasing'] as const)('refuses an SB plan missing explicit %s', (field) => {
    const plan = v2SbPlan('product_collection_classic');
    const settings = v2Node(plan, 'campaign.create').payload.settings;
    Reflect.deleteProperty(settings, field);
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    expect(() => requireCampaignCreationDispatchInputs(plan)).toThrow();
  });

  it('uses create KPI fields and explicit instants instead of accepting a read-only goal or date default', () => {
    const plan = v2SbPlan('product_video');
    const campaign = v2Node(plan, 'campaign.create');
    const settings = campaign.payload.settings;
    if (settings.product !== 'SB') throw new Error('synthetic SB settings missing');
    Reflect.deleteProperty(settings.optimizations.goalSettings, 'kpi');
    Reflect.set(settings.optimizations.goalSettings, 'goal', 'PAGE_VISITS');
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    const corrected = v2SbPlan('product_video');
    v2Node(corrected, 'campaign.create').payload.schedule = {
      type: 'calendar_dates', startDate: '2026-08-31', endDate: null,
    };
    expect(CampaignCreationPlanV2.safeParse(corrected).success).toBe(false);
    const reverse = v2SbPlan('product_video');
    v2Node(reverse, 'campaign.create').payload.schedule = {
      type: 'instants', startDateTime: '2026-08-31T12:00:00+01:00', endDateTime: '2026-08-31T11:30:00+02:00',
    };
    expect(CampaignCreationPlanV2.safeParse(reverse).success).toBe(false);
  });

  it('enforces classic collection cardinalities and keeps landing-page products separate', () => {
    const plan = v2SbPlan('product_collection_classic');
    const ad = v2Node(plan, 'ad.create');
    if (ad.payload.format !== 'sb_product_collection_classic') throw new Error('synthetic classic collection missing');
    const product = ad.payload.products[0];
    if (product === undefined) throw new Error('synthetic product missing');
    ad.payload.landingPage = { type: 'asin_list', products: [product] };
    ad.payload.products = [];
    expect(CampaignCreationPlanV2.parse(plan)).toEqual(plan);
    ad.payload.landingPage.products = [];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    ad.payload.landingPage = { type: 'custom_url', url: 'https://example.com/synthetic-collection' };
    expect(CampaignCreationPlanV2.parse(plan)).toEqual(plan);
    // This is only a valid request shape; vendor eligibility still needs a live preflight.
    ad.payload.products = [product, product, product, product];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    ad.payload.products = [];
    ad.payload.brandLogos = [];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
  });

  it('requires Gallery reservation identity and image cards rather than Spotlight product cards', () => {
    const plan = v2SbPlan('brand_gallery');
    const ad = v2Node(plan, 'ad.create');
    const settings = v2Node(plan, 'campaign.create').payload.settings;
    if (ad.payload.format !== 'sb_brand_gallery' || settings.product !== 'SB') throw new Error('synthetic Gallery missing');
    settings.purchasing = { type: 'auction' };
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    settings.purchasing = { type: 'reserved_share_of_voice', targetedPGDealId: 'SYNTHETIC-DEAL' };
    const card = ad.payload.cards[0];
    if (card === undefined) throw new Error('synthetic card missing');
    Reflect.set(card, 'product', ref('product', PRODUCT_NODE_ID));
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    Reflect.deleteProperty(card, 'product');
    card.landingPage.pageId = 'UNCHECKED-PAGE';
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    card.landingPage.pageId = 'PAGE-1';
    ad.payload.cards = [card, card];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    ad.payload.cards = [card, card, card, card, card, card];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
  });

  it('rejects a Gallery card that crosses into another checked Store', () => {
    const plan = v2SbPlan('brand_gallery');
    const ad = v2Node(plan, 'ad.create');
    const originalStore = v2Node(plan, 'eligibility.require_store');
    if (ad.payload.format !== 'sb_brand_gallery') throw new Error('synthetic Gallery missing');
    const card = ad.payload.cards[0];
    if (card === undefined) throw new Error('synthetic Gallery card missing');
    card.landingPage = { type: 'store', pageId: 'OTHER-PAGE', store: ref('store', GENERATION_ID) };
    ad.dependsOn = [...ad.dependsOn, GENERATION_ID].sort();
    expect(() => v2PlanWithNodes(plan, [...plan.nodes, { ...originalStore, nodeId: GENERATION_ID,
      payload: { storeId: 'OTHER-SYNTHETIC-STORE', pageIds: ['OTHER-PAGE'] } }])).toThrow(/checked campaign Store/);
  });

  it('rejects SD defaulting, incompatible optimization and mismatched creative types', () => {
    const plan = v2SdPlan('sd_video');
    const group = v2Node(plan, 'ad_group.create');
    const campaign = v2Node(plan, 'campaign.create');
    if (group.payload.settings.product !== 'SD' || campaign.payload.settings.product !== 'SD') throw new Error('synthetic SD settings missing');
    group.payload.settings.bidOptimization = 'reach';
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    campaign.payload.settings.costType = 'vcpm';
    expect(CampaignCreationPlanV2.parse(plan)).toEqual(plan);
    group.payload.settings.creativeType = 'IMAGE';
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    Reflect.deleteProperty(group.payload.settings, 'creativeType');
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
  });

  it('rejects duplicate SD creatives, an ad parent and fabricated creative state', () => {
    const plan = v2SdPlan('sd_image');
    const creative = v2Node(plan, 'creative.create');
    expect(() => v2PlanWithNodes(plan, [...plan.nodes, { ...creative, nodeId: GENERATION_ID }])).toThrow(/one creative/);
    expect(CampaignCreationNodeV2.safeParse({ ...creative,
      payload: { ...creative.payload, adGroup: { source: 'plan_node', kind: 'ad', nodeId: AD_NODE_ID } },
    }).success).toBe(false);
    expect(CampaignCreationNodeV2.safeParse({ ...creative, payload: { ...creative.payload, state: 'paused' } }).success).toBe(false);
  });

  it('validates SD image crop identity, image purpose and explicit aspect-image selections', () => {
    const plan = v2SdPlan('sd_image');
    const creative = v2Node(plan, 'creative.create');
    if (creative.payload.format !== 'sd_image' || creative.payload.images.representation !== 'rectangle_and_square') throw new Error('synthetic images missing');
    const secondImage = { ...v2AssetNode('SD', 'image'), nodeId: GENERATION_ID,
      payload: { assetId: 'SECOND-SYNTHETIC-IMAGE', version: '8', purpose: 'image' } };
    creative.payload.images.squareCustomImage.asset = ref('asset', GENERATION_ID);
    creative.dependsOn = [...creative.dependsOn, GENERATION_ID].sort();
    expect(() => v2PlanWithNodes(plan, [...plan.nodes, secondImage])).toThrow(/same checked asset/);
    const image = { asset: ref('asset', IMAGE_NODE_ID), croppingCoordinates: null };
    creative.payload.images = { representation: 'aspect_images', horizontalImages: [image], squareImages: [], verticalImages: [] };
    creative.dependsOn = creative.dependsOn.filter((id) => id !== GENERATION_ID);
    expect(CampaignCreationPlanV2.parse(plan)).toEqual(plan);
    creative.payload.images.horizontalImages = [];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    creative.payload.images.horizontalImages = [image];
    const asset = plan.nodes.find((node) => node.nodeId === IMAGE_NODE_ID);
    if (asset?.kind !== 'asset.require_existing') throw new Error('synthetic image missing');
    asset.payload.purpose = 'video';
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
  });

  it('distinguishes SD single-video from aspect arrays and requires a product ad', () => {
    const plan = v2SdPlan('sd_video');
    const creative = v2Node(plan, 'creative.create');
    if (creative.payload.format !== 'sd_video') throw new Error('synthetic video missing');
    creative.payload.videos = { representation: 'aspect_videos', squareVideos: [], horizontalVideos: [],
      verticalVideos: [ref('asset', VIDEO_NODE_ID)] };
    expect(CampaignCreationPlanV2.parse(plan)).toEqual(plan);
    Reflect.set(creative.payload.videos, 'video', ref('asset', VIDEO_NODE_ID));
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    Reflect.deleteProperty(creative.payload.videos, 'video');
    creative.payload.videos.verticalVideos = [ref('asset', VIDEO_NODE_ID), ref('asset', VIDEO_NODE_ID)];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    creative.payload.videos.verticalVideos = [];
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    creative.payload.videos.verticalVideos = [ref('asset', VIDEO_NODE_ID)];
    creative.payload.headline = 'x'.repeat(51);
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    creative.payload.headline = null;
    creative.dependsOn = creative.dependsOn.filter((id) => id !== AD_NODE_ID);
    expect(CampaignCreationPlanV2.safeParse(plan).success).toBe(false);
    expect(() => v2PlanWithNodes(plan, plan.nodes.filter((node) => node.nodeId !== AD_NODE_ID))).toThrow(/product ad/);
  });

  it('binds cost, objective, destination, crop, asset version and deal changes to approval', () => {
    const plan = fingerprintedV2(v2SbPlan('brand_gallery'));
    const { authorization, job } = authorityFor(plan);
    expect(verifyCampaignCreationJobArtifacts(plan, authorization, job, '2026-08-30T00:03:00.000Z', sha256).plan).toEqual(plan);
    expect(() => verifyCampaignCreationJobArtifacts(plan,
      { ...authorization, schemaVersion: 'openspell.campaign-creation-plan.v1' }, job,
      '2026-08-30T00:03:00.000Z', sha256)).toThrow(/receipt does not match/);
    const mutations: ((changed: CampaignCreationPlanV2) => void)[] = [
      (changed) => { const settings = v2Node(changed, 'campaign.create').payload.settings;
        if (settings.product === 'SB') settings.costType = 'FIXED_PRICE'; },
      (changed) => { const settings = v2Node(changed, 'campaign.create').payload.settings;
        if (settings.product === 'SB') settings.optimizations.goalSettings.kpi = 'TOP_OF_SEARCH_IMPRESSION_SHARE'; },
      (changed) => { const settings = v2Node(changed, 'campaign.create').payload.settings;
        if (settings.product === 'SB' && settings.purchasing.type === 'reserved_share_of_voice') settings.purchasing.targetedPGDealId = 'CHANGED-SYNTHETIC-DEAL'; },
      (changed) => { const payload = v2Node(changed, 'ad.create').payload;
        if (payload.format === 'sb_brand_gallery') payload.landingPage.pageId = 'PAGE-1'; },
      (changed) => { const payload = v2Node(changed, 'ad.create').payload;
        if (payload.format === 'sb_brand_gallery') payload.customImage.formatProperties = [{ top: 0, left: 0, width: 1200, height: 628 }]; },
      (changed) => { const asset = changed.nodes.find((node) => node.nodeId === IMAGE_NODE_ID);
        if (asset?.kind === 'asset.require_existing') asset.payload.version = '4'; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(plan);
      mutate(changed);
      expect(() => verifyCampaignCreationPlanFingerprints(changed, sha256)).toThrow(/fingerprint does not match/);
      const freshlyHashed = fingerprintedV2(changed);
      expect(() => verifyCampaignCreationJobArtifacts(freshlyHashed, authorization, job,
        '2026-08-30T00:03:00.000Z', sha256)).toThrow(/receipt does not match/);
    }
  });

  it('checks v2 provider intents against observed parents and prevents duplicate creation after uncertainty', () => {
    const plan = fingerprintedV2(v2SdPlan('sd_video'));
    const { authorization, job } = authorityFor(plan);
    const completed = CampaignCreationExecutionEvidence.parse(completedSpExecutionEvidence(plan));
    const intent = completed.providerCallIntents.find((call) => call.positions.some((position) => position.nodeId === CREATIVE_NODE_ID));
    const observation = completed.observations.find((value) => value.nodeId === CREATIVE_NODE_ID);
    if (intent === undefined || observation === undefined) throw new Error('synthetic creative evidence missing');
    const current = CampaignCreationExecutionEvidence.parse({
      ...completed,
      providerCallIntents: completed.providerCallIntents.filter((call) => call.providerCallId !== intent.providerCallId),
      providerResults: completed.providerResults.filter((result) => result.nodeId !== CREATIVE_NODE_ID),
      observations: completed.observations.filter((value) => value.nodeId !== CREATIVE_NODE_ID),
      nonProviderDispositions: [{ planId: plan.id, nodeId: CREATIVE_NODE_ID, executionId: EXECUTION_ID,
        nodeFingerprint: v2Node(plan, 'creative.create').fingerprint, outcome: 'pending_dispatch', sanitizedReason: null }],
      snapshot: { status: 'running', accounting: { ...completed.snapshot.accounting,
        pendingDispatch: 1, attempted: 4, succeeded: 4, observed: 4 } },
    });
    expect(verifyCampaignCreationProviderCallArtifacts(plan, authorization, job, current, intent,
      '2026-08-30T00:03:00.000Z', sha256).intent).toEqual(intent);
    const waitingForParent = { ...current,
      observations: current.observations.map((value) => value.nodeId === AD_NODE_ID
        ? { ...value, observation: 'pending', providerEntityId: null } : value),
      snapshot: { status: 'running', accounting: { ...current.snapshot.accounting,
        observed: 3, pendingObservation: 1 } },
    };
    expect(() => verifyCampaignCreationProviderCallArtifacts(plan, authorization, job, waitingForParent,
      intent, '2026-08-30T00:03:00.000Z', sha256)).toThrow(/dependency that is not satisfied/);

    const uncertain = CampaignCreationExecutionEvidence.parse({
      ...completed,
      providerResults: completed.providerResults.map((result) => result.nodeId === CREATIVE_NODE_ID
        ? { ...result, outcome: 'ambiguous', providerEntityId: null } : result),
      observations: completed.observations.map((value) => value.nodeId === CREATIVE_NODE_ID
        ? { ...value, basis: 'intent_reconciliation', observation: 'pending', providerEntityId: null } : value),
      snapshot: { status: 'awaiting_observation', accounting: { ...completed.snapshot.accounting,
        succeeded: 4, ambiguous: 1, observed: 4, pendingObservation: 1 } },
    });
    expect(() => verifyCampaignCreationProviderCallArtifacts(plan, authorization, job, uncertain,
      { ...intent, providerCallId: CALL_ID, attemptId: ATTEMPT_ID },
      '2026-08-30T00:03:00.000Z', sha256)).toThrow(/not exclusively pending dispatch/);
    expect(CampaignCreationExecutionEvidence.safeParse({ ...completed,
      providerResults: completed.providerResults.map((result) => result.nodeId === VIDEO_NODE_ID
        ? { ...result, providerEntityVersion: 'OTHER-SYNTHETIC-VERSION' } : result),
    }).success).toBe(false);
  });

  it('refuses new v1 SB dispatch while preserving its fingerprinted history and observations', () => {
    const base = sbStoreSpotlightPlan();
    const hashedNodes = CampaignCreationPlan.parse({ ...base, nodes: base.nodes.map((node) => ({ ...node,
      fingerprint: sha256.digest(serializeCampaignCreationNodeFingerprint(node)) })) });
    const plan = CampaignCreationPlan.parse({ ...hashedNodes,
      fingerprint: sha256.digest(serializeCampaignCreationPlanFingerprint(hashedNodes)) });
    const { authorization, job } = authorityFor(plan);
    const completed = CampaignCreationExecutionEvidence.parse(completedSpExecutionEvidence(plan));
    const observation = completed.observations[0];
    if (observation === undefined) throw new Error('synthetic observation missing');
    expect(verifyCampaignCreationPlanFingerprints(plan, sha256)).toEqual(plan);
    expect(() => verifyCampaignCreationProviderCallArtifacts(plan, authorization, job, completed,
      completed.providerCallIntents[0], '2026-08-30T00:03:00.000Z', sha256)).toThrow(/omit required creation inputs/);
    expect(verifyCampaignCreationObservationArtifacts(plan, authorization,
      { ...job, type: 'campaign_creation.observe', attempt: 1 }, completed,
      observation, '2026-08-30T00:03:00.000Z', sha256).observation).toEqual(observation);
  });
});

describe('campaign creation plan', () => {
  it('preserves fixed v1 fingerprint goldens', () => {
    const plans = [spPlan(), sbStoreSpotlightPlan(), sbProductVideoPlan()];
    expect(plans.map((plan) => ({
      nodes: plan.nodes.map((node) => sha256.digest(serializeCampaignCreationNodeFingerprint(node))),
      plan: sha256.digest(serializeCampaignCreationPlanFingerprint(plan)),
    }))).toEqual([
      {
        nodes: [
          '81f87253f50e8082110e6438345e1b7480ff27958cb9ed71eb720743daa65250',
          '62c0269d8115eb61a6311a4419a6f053e1837b138cb9a3284ce3f77a4e380c60',
          '11fcf3e7142965259865ad0d71e110f0eb4c83997724e4fe1677ca833d60bbb5',
          '58a5944bd99f3e1f065eb25d87220f07cac2dda98b930061281f01ae6a498d7e',
          '877db34e38a3375b7eb46de570f20bea84aa081c59bfe3dda29f2e083a2927da',
        ],
        plan: 'f7a54d658a611be10cbae29bbaaf619974029d703144964eddd6e9b1344698af',
      },
      {
        nodes: [
          '6facffd058fcc8048a08c3f16d5921c3953720c586efa2a6225c310fa5c2ad7d',
          '06532f43110d8c4ce8a54864b3073ebfd72f5912dc2fa6a71bbd9cd5c2739985',
          'f5482ed711d0ab628cb59190ee049d839b0f7beca2cb3376ceebbe78ff7e817a',
          '27e42cc7ec533dd6a97bb3695df26b5f56160f2445cd2ef067f805167b81496a',
          'a2957420b255faa74dcd00a2f6831d679e3305b9c285bcb4ace71131747dd732',
          'cfcb192e25a4714defeda5b9f9ca6febea149859394fb54e731bf4f9c876c008',
          '2f19461c4af5d4aecfe2a836f8ff594dbf6662855ddbee24f294fc7e4716d185',
          'b6ca7214de2e1920f1aa2eb47e3f365fa2df645065f5abc145621f764a711dfd',
          '73667f7ca06edd8eb81aa2655b4437024e25668cf8a9c20f8dbbf7ad71e3c104',
        ],
        plan: '6024da352ffb1730141daf6ff967bd4b34ae2ec114dddf5c6f5512b3c88bb842',
      },
      {
        nodes: [
          '270b156e5e44cc543b480b59ac486a39bfb739ab116e4b85447df07a646e06a0',
          '87b66fc5437813365f92a9086edc6cac27fcf970bdef9a0df88e12c7b72dd6c5',
          '4114f6d77df0d96653d1e98b3eceac8f5276d72d42afa006668b44d818a1f318',
          'be5ae93a05fda4f5549b8d8068c877b7e7910216b2e9a89e39699bc056736064',
          '9aae22aafc636f4f2ef46eddef146368ed9dda9f9eca0edfd05b7024cf0989df',
        ],
        plan: 'e2b449ebab761b78a953b21459cee7176a4863f1cd6bb41e6f6887521bd90525',
      },
    ]);
    plans.forEach((plan) => expect(RecordedCampaignCreationPlan.parse(plan)).toEqual(plan));
  });
  it('round-trips a deterministic paused Sponsored Products dependency graph', () => {
    const plan = spPlan();
    expect(CampaignCreationPlan.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    expect(plan.nodes.map((node) => node.nodeId)).toEqual([
      PRODUCT_NODE_ID,
      CAMPAIGN_NODE_ID,
      AD_GROUP_NODE_ID,
      AD_NODE_ID,
      TARGET_NODE_ID,
    ]);
    expect(orderCampaignCreationNodes([...plan.nodes].reverse()).map((node) => node.nodeId))
      .toEqual(plan.nodes.map((node) => node.nodeId));
    expect(plan.nodes.filter((node) => node.effect === 'irreversible_create')
      .every((node) => node.rollback === 'none' && node.payload.state === 'paused')).toBe(true);
  });

  it('binds canonical node semantics and the complete approval envelope', () => {
    const plan = spPlan();
    const campaign = plan.nodes[1] as CampaignCreationNodeType;
    const nodePreimage = serializeCampaignCreationNodeFingerprint(campaign);
    const changedCampaign = CampaignCreationNode.parse({
      ...campaign,
      payload: { ...campaign.payload, name: 'Changed synthetic campaign' },
    });
    expect(serializeCampaignCreationNodeFingerprint(changedCampaign)).not.toBe(nodePreimage);

    const originalPreimage = serializeCampaignCreationPlanFingerprint(plan);
    expect(serializeCampaignCreationPlanFingerprint({ ...plan, orgId: GENERATION_ID }))
      .not.toBe(originalPreimage);
    expect(serializeCampaignCreationPlanFingerprint({
      ...plan,
      nodes: plan.nodes.map((node) => node.nodeId === CAMPAIGN_NODE_ID
        ? { ...node, fingerprint: sha('b') }
        : node),
    })).not.toBe(originalPreimage);
  });

  it('recomputes every stored fingerprint before a persisted plan is trusted', () => {
    expect(sha256.digest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const plan = fingerprintedSpPlan();
    expect(verifyCampaignCreationPlanFingerprints(plan, sha256)).toEqual(plan);

    const changedNodes = plan.nodes.map((node) => node.kind === 'campaign.create'
      ? {
          ...node,
          payload: { ...node.payload, name: 'Tampered synthetic campaign' },
        }
      : node);
    const tamperedNodePlan = CampaignCreationPlan.parse({ ...plan, nodes: changedNodes });
    expect(() => verifyCampaignCreationPlanFingerprints(tamperedNodePlan, sha256))
      .toThrow(/node .* fingerprint does not match/);

    const tamperedEnvelope = CampaignCreationPlan.parse({ ...plan, orgId: GENERATION_ID });
    expect(() => verifyCampaignCreationPlanFingerprints(tamperedEnvelope, sha256))
      .toThrow('campaign creation plan fingerprint does not match');
  });

  it('rejects count drift, non-canonical order, cycles, missing dependencies, and scope drift', () => {
    const plan = spPlan();
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      counts: { ...plan.counts, irreversibleCreates: 3 },
    }).success).toBe(false);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: [plan.nodes[0], plan.nodes[1], plan.nodes[2], plan.nodes[4], plan.nodes[3]],
    }).success).toBe(false);

    const cyclic = plan.nodes.map((node) => node.nodeId === CAMPAIGN_NODE_ID
      ? { ...node, dependsOn: [AD_GROUP_NODE_ID] }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: cyclic }).success).toBe(false);

    const missingReferenceDependency = plan.nodes.map((node) => node.nodeId === AD_GROUP_NODE_ID
      ? { ...node, dependsOn: [] }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: missingReferenceDependency }).success)
      .toBe(false);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      adProduct: 'SB',
    }).success).toBe(false);
  });

  it('rejects enabled creates and mismatched keyword polarity', () => {
    const campaign = spNodes()[1] as CampaignCreationNodeType;
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      payload: { ...campaign.payload, state: 'enabled' },
    }).success).toBe(false);

    const target = spNodes()[4] as CampaignCreationNodeType;
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: { ...target.payload, polarity: 'negative', matchType: 'exact', bid: null },
    }).success).toBe(false);

    const positiveCampaignKeyword = {
      ...target,
      dependsOn: [CAMPAIGN_NODE_ID],
      payload: {
        ...target.payload,
        parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        scope: 'campaign',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(positiveCampaignKeyword).success).toBe(false);

    expect(CampaignCreationNode.safeParse({
      ...positiveCampaignKeyword,
      payload: {
        ...positiveCampaignKeyword.payload,
        polarity: 'negative',
        matchType: 'negative_exact',
        bid: null,
      },
    }).success).toBe(true);

    expect(CampaignCreationNode.safeParse({
      ...positiveCampaignKeyword,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        scope: 'campaign',
        polarity: 'positive',
        expression: [{ type: 'asin_same_as', value: 'B000000009' }],
        bid: 1.01,
        state: 'paused',
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...positiveCampaignKeyword,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN_NODE_ID },
        scope: 'campaign',
        polarity: 'negative',
        expression: [{ type: 'asin_same_as', value: 'B000000009' }],
        bid: null,
        state: 'paused',
      },
    }).success).toBe(true);
  });

  it('requires daily Sponsored Products budgets in legacy and unified dialects', () => {
    const campaign = spNodes()[1];
    if (campaign?.kind !== 'campaign.create') throw new Error('synthetic campaign missing');

    for (const apiDialect of ['sp_legacy_v3', 'unified_ads_v1'] as const) {
      expect(CampaignCreationNode.safeParse({
        ...campaign,
        apiDialect,
        payload: {
          ...campaign.payload,
          budget: { ...campaign.payload.budget, type: 'lifetime' },
        },
      }).success).toBe(false);
      expect(CampaignCreationNode.safeParse({
        ...campaign,
        apiDialect,
        payload: {
          ...campaign.payload,
          budget: { ...campaign.payload.budget, type: 'daily' },
        },
      }).success).toBe(true);
    }
  });

  it('rejects positive manual targets in automatic Sponsored Products campaigns', () => {
    const plan = spPlan();
    const automaticNodes = plan.nodes.map((node) => {
      if (node.kind !== 'campaign.create' || node.payload.settings.product !== 'SP') return node;
      return CampaignCreationNode.parse({
        ...node,
        payload: {
          ...node.payload,
          settings: { ...node.payload.settings, targetingType: 'auto' },
        },
      });
    });
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: automaticNodes }).success).toBe(false);

    const negativeNodes = automaticNodes.map((node) => node.kind === 'target.create'
      ? CampaignCreationNode.parse({
          ...node,
          payload: {
            targetType: 'keyword',
            parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
            scope: 'ad_group',
            polarity: 'negative',
            text: 'synthetic negative keyword',
            matchType: 'negative_exact',
            bid: null,
            state: 'paused',
          },
        })
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: negativeNodes }).success).toBe(true);

    const productTargetNodes = automaticNodes.map((node) => node.kind === 'target.create'
      ? CampaignCreationNode.parse({ ...node, payload: {
          targetType: 'expression', parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
          scope: 'ad_group', polarity: 'positive', expression: [{ type: 'asin_same_as', value: 'B000000009' }],
          bid: 1.01, state: 'paused',
        } })
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: productTargetNodes }).success).toBe(false);
  });

  it.each(['close_match', 'loose_match', 'substitutes', 'complements'])(
    'refuses the Amazon-created %s clause instead of submitting a target POST or dropping its override', (type) => {
      const plan = spPlan();
      const target = plan.nodes.find((node) => node.kind === 'target.create');
      if (target === undefined) throw new Error('synthetic target missing');
      for (const bid of [null, 0.42]) {
        const autoTarget = { ...target, payload: {
          targetType: 'expression', parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
          scope: 'ad_group', polarity: 'positive', expression: [{ type, value: null }], bid, state: 'paused',
        } };
        const nodeResult = CampaignCreationNode.safeParse(autoTarget);
        expect(nodeResult.success).toBe(false);
        if (!nodeResult.success) {
          expect(nodeResult.error.issues.some((issue) => issue.message.includes('Amazon creates automatic targeting clauses'))).toBe(true);
        }
        for (const targetingType of ['manual', 'auto']) {
          const graph = { ...plan, nodes: plan.nodes.map((node) => {
            if (node.kind === 'target.create') return autoTarget;
            if (node.kind === 'campaign.create' && node.payload.settings.product === 'SP') {
              return { ...node, payload: { ...node.payload, settings: { ...node.payload.settings, targetingType } } };
            }
            return node;
          }) };
          expect(CampaignCreationPlan.safeParse(graph).success).toBe(false);
          expect(() => serializeCampaignCreationPlanFingerprint(graph as CampaignCreationPlanType)).toThrow();
          expect(graph.nodes).toHaveLength(plan.counts.totalNodes);
          expect(autoTarget.payload.bid).toBe(bid);
        }
      }
    },
  );

  it('creates a paused automatic SP graph with an explicit ad-group default bid and no target POST', () => {
    const plan = spPlan();
    const automaticNodes = plan.nodes.map((node) => node.kind === 'campaign.create' && node.payload.settings.product === 'SP'
      ? CampaignCreationNode.parse({ ...node, payload: {
          ...node.payload, settings: { ...node.payload.settings, targetingType: 'auto' },
        } })
      : node);
    const automatic = CampaignCreationPlan.parse({
      ...plan,
      nodes: automaticNodes.filter((node) => node.kind !== 'target.create'),
      counts: {
        ...plan.counts,
        totalNodes: plan.counts.totalNodes - 1,
        irreversibleCreates: plan.counts.irreversibleCreates - 1,
        byKind: { ...plan.counts.byKind, 'target.create': 0 },
      },
    });
    expect(automatic.nodes.map((node) => node.kind)).toEqual([
      'eligibility.require_product', 'campaign.create', 'ad_group.create', 'ad.create',
    ]);
    expect(automatic.nodes.find((node) => node.kind === 'ad_group.create')?.payload).toMatchObject({ defaultBid: 1.01 });
    expect(automatic.counts).toMatchObject({ totalNodes: 4, readChecks: 1, irreversibleCreates: 3, byKind: { 'target.create': 0 } });
    expect(automatic.nodes.filter((node) => node.effect === 'irreversible_create')
      .every((node) => 'state' in node.payload && node.payload.state === 'paused')).toBe(true);
    const nodes = automatic.nodes.map((node) => ({ ...node, fingerprint: sha256.digest(serializeCampaignCreationNodeFingerprint(node)) }));
    const fingerprinted = { ...automatic, nodes };
    fingerprinted.fingerprint = sha256.digest(serializeCampaignCreationPlanFingerprint(fingerprinted));
    expect(verifyCampaignCreationPlanFingerprints(fingerprinted, sha256)).toEqual(fingerprinted);
  });

  it('models current Unified SB manual and automatic collections without invented fields', () => {
    const ref = (kind: 'ad_group' | 'brand' | 'product' | 'asset', suffix: number) => ({
      source: 'plan_node' as const,
      kind,
      nodeId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    });
    const manual = {
      nodeId: '00000000-0000-4000-8000-000000000040',
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('4'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_product_collection_manual',
        name: 'Synthetic manual collection ad',
        adGroup: ref('ad_group', 41),
        brand: ref('brand', 42),
        products: [ref('product', 43), ref('product', 44), ref('product', 45)],
        logoAsset: null,
        title: null,
        landingPage: { type: 'asin_list' },
        state: 'paused',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(manual).success).toBe(true);

    const automatic = {
      ...manual,
      nodeId: '00000000-0000-4000-8000-000000000046',
      payload: {
        format: 'sb_product_collection_automatic',
        name: 'Synthetic automatic collection ad',
        adGroup: ref('ad_group', 41),
        brand: ref('brand', 42),
        logoAsset: null,
        productExclusions: [],
        state: 'paused',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(automatic).success).toBe(true);
    expect(CampaignCreationNode.safeParse({
      ...automatic,
      payload: { ...automatic.payload, headline: 'Amazon generates this field' },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...automatic,
      payload: {
        ...automatic.payload,
        productExclusions: Array.from({ length: 101 }, (_, index) => ref('product', 1000 + index)),
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({ ...manual, apiDialect: 'sb_legacy_v4' }).success)
      .toBe(false);

    const spotlight = sbStoreSpotlightPlan();
    const automaticTargeting = spotlight.nodes.map((node) => node.kind === 'campaign.create'
      ? {
          ...node,
          payload: {
            ...node.payload,
            settings: { ...node.payload.settings, targetingType: 'auto' },
          },
        }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...spotlight, nodes: automaticTargeting }).success)
      .toBe(false);
  });

  it('allows only one automatic Sponsored Brands collection ad per ad group', () => {
    const spotlight = sbStoreSpotlightPlan();
    const automaticNodes = spotlight.nodes.map((node) => {
      if (node.kind === 'campaign.create' && node.payload.settings.product === 'SB') {
        return CampaignCreationNode.parse({
          ...node,
          payload: {
            ...node.payload,
            settings: { ...node.payload.settings, format: 'product_collection_automatic' },
          },
        });
      }
      if (node.kind === 'ad.create' && node.payload.format === 'sb_store_spotlight') {
        return CampaignCreationNode.parse({
          ...node,
          payload: {
            format: 'sb_product_collection_automatic',
            name: 'Synthetic automatic collection ad',
            adGroup: node.payload.adGroup,
            brand: node.payload.brand,
            logoAsset: node.payload.logoAsset,
            productExclusions: [],
            state: 'paused',
          },
        });
      }
      return node;
    });
    const automaticPlan = CampaignCreationPlan.parse({
      ...spotlight,
      nodes: orderCampaignCreationNodes(automaticNodes),
    });
    const automaticAd = automaticPlan.nodes.find((node) => node.kind === 'ad.create');
    if (automaticAd?.kind !== 'ad.create'
      || automaticAd.payload.format !== 'sb_product_collection_automatic') {
      throw new Error('synthetic automatic collection ad missing');
    }
    const duplicateAd = CampaignCreationNode.parse({
      ...automaticAd,
      nodeId: '00000000-0000-4000-8000-000000000030',
      fingerprint: sha('d'),
      payload: { ...automaticAd.payload, name: 'Second synthetic automatic collection ad' },
    });
    expect(CampaignCreationPlan.safeParse({
      ...automaticPlan,
      nodes: orderCampaignCreationNodes([...automaticPlan.nodes, duplicateAd]),
      counts: {
        ...automaticPlan.counts,
        totalNodes: automaticPlan.counts.totalNodes + 1,
        irreversibleCreates: automaticPlan.counts.irreversibleCreates + 1,
        byKind: {
          ...automaticPlan.counts.byKind,
          'ad.create': automaticPlan.counts.byKind['ad.create'] + 1,
        },
      },
    }).success).toBe(false);
  });

  it('requires planned, preflighted parents and strictly forward-stage dependencies', () => {
    const adGroup = spNodes()[2];
    if (adGroup?.kind !== 'ad_group.create') throw new Error('synthetic ad group missing');
    expect(CampaignCreationNode.safeParse({
      ...adGroup,
      payload: {
        ...adGroup.payload,
        campaign: { source: 'existing', kind: 'campaign', amazonId: 'CAMPAIGN-1' },
      },
    }).success).toBe(false);

    const readCheck = spNodes()[0];
    expect(CampaignCreationNode.safeParse({
      ...readCheck,
      dependsOn: [CAMPAIGN_NODE_ID],
    }).success).toBe(false);

    const plan = spPlan();
    const backwards = plan.nodes.map((node) => node.nodeId === AD_NODE_ID
      ? { ...node, dependsOn: [PRODUCT_NODE_ID, AD_GROUP_NODE_ID, TARGET_NODE_ID].sort() }
      : node);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: orderCampaignCreationNodes(backwards as CampaignCreationNodeType[]),
    }).success).toBe(false);
  });

  it('rejects duplicate provider preflights and unsupported expression semantics', () => {
    const plan = spPlan();
    const duplicateProduct = CampaignCreationNode.parse({
      ...plan.nodes[0],
      nodeId: '00000000-0000-4000-8000-000000000010',
      fingerprint: sha('9'),
    });
    const duplicateNodes = orderCampaignCreationNodes([duplicateProduct, ...plan.nodes]);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: duplicateNodes,
      counts: {
        ...plan.counts,
        totalNodes: 6,
        readChecks: 2,
        byKind: { ...plan.counts.byKind, 'eligibility.require_product': 2 },
      },
    }).success).toBe(false);

    const spotlight = sbStoreSpotlightPlan();
    for (const kind of ['eligibility.require_store', 'asset.require_existing'] as const) {
      const original = spotlight.nodes.find((node) => node.kind === kind);
      if (original === undefined) throw new Error(`synthetic ${kind} preflight missing`);
      const duplicate = CampaignCreationNode.parse({
        ...original,
        nodeId: kind === 'eligibility.require_store'
          ? '00000000-0000-4000-8000-000000000030'
          : '00000000-0000-4000-8000-000000000031',
        fingerprint: sha(kind === 'eligibility.require_store' ? '8' : '9'),
      });
      expect(CampaignCreationPlan.safeParse({
        ...spotlight,
        nodes: orderCampaignCreationNodes([...spotlight.nodes, duplicate]),
        counts: {
          ...spotlight.counts,
          totalNodes: spotlight.counts.totalNodes + 1,
          readChecks: spotlight.counts.readChecks + 1,
          byKind: {
            ...spotlight.counts.byKind,
            [kind]: spotlight.counts.byKind[kind] + 1,
          },
        },
      }).success).toBe(false);
    }

    const target = spNodes()[4];
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'positive',
        expression: [{ type: 'negative_exact', value: 'synthetic' }],
        bid: 1.01,
        state: 'paused',
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'negative',
        expression: [{ type: 'close_match', value: null }],
        bid: null,
        state: 'paused',
      },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...target,
      payload: {
        targetType: 'expression',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
        scope: 'ad_group',
        polarity: 'positive',
        expression: [{ type: 'asin_same_as', value: null }],
        bid: 1.01,
        state: 'paused',
      },
    }).success).toBe(false);
  });

  it('models Unified SB targetDetails variants and rejects legacy target payloads', () => {
    const plan = sbStoreSpotlightPlan();
    const adGroup = plan.nodes.find((node) => node.kind === 'ad_group.create');
    if (adGroup === undefined) throw new Error('synthetic SB ad group missing');
    const target = CampaignCreationNode.parse({
      nodeId: '00000000-0000-4000-8000-000000000032',
      kind: 'target.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [adGroup.nodeId],
      fingerprint: sha('c'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        targetType: 'sb_theme',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'positive',
        matchType: 'keywords_related_to_your_landing_pages',
        bid: 1.01,
        state: 'paused',
      },
    });
    const withTheme = {
      ...plan,
      nodes: orderCampaignCreationNodes([...plan.nodes, target]),
      counts: {
        ...plan.counts,
        totalNodes: plan.counts.totalNodes + 1,
        irreversibleCreates: plan.counts.irreversibleCreates + 1,
        byKind: { ...plan.counts.byKind, 'target.create': 1 },
      },
    };
    expect(CampaignCreationPlan.safeParse(withTheme).success).toBe(true);

    for (const payload of [
      {
        targetType: 'sb_keyword',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'negative',
        text: 'synthetic keyword',
        matchType: 'exact',
        bid: null,
        state: 'paused',
      },
      {
        targetType: 'sb_product',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'positive',
        asin: 'B000000009',
        bid: 1.01,
        state: 'paused',
      },
      {
        targetType: 'sb_product_category',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        polarity: 'positive',
        categoryId: 'CATEGORY-1',
        brandId: null,
        priceGreaterThan: null,
        priceLessThan: 50,
        ratingGreaterThan: 4,
        ratingLessThan: null,
        bid: 1.01,
        state: 'paused',
      },
    ] as const) {
      expect(CampaignCreationNode.safeParse({ ...target, payload }).success).toBe(true);
    }

    const legacyKeyword = CampaignCreationNode.parse({
      ...target,
      payload: {
        targetType: 'keyword',
        parent: { source: 'plan_node', kind: 'ad_group', nodeId: adGroup.nodeId },
        scope: 'ad_group',
        polarity: 'positive',
        text: 'synthetic keyword',
        matchType: 'exact',
        bid: 1.01,
        state: 'paused',
      },
    });
    expect(CampaignCreationPlan.safeParse({
      ...withTheme,
      nodes: orderCampaignCreationNodes([...plan.nodes, legacyKeyword]),
    }).success).toBe(false);
  });

  it('keeps Sponsored Display tactic and target semantics closed', () => {
    const nodes = spNodes().map((node) => {
      const common = { ...node, adProduct: 'SD', apiDialect: 'sd_legacy' } as const;
      if (node.kind === 'campaign.create') {
        return CampaignCreationNode.parse({
          ...common,
          payload: { ...node.payload, settings: { product: 'SD', tactic: 'contextual' } },
        });
      }
      if (node.kind === 'ad.create') {
        return CampaignCreationNode.parse({
          ...common,
          payload: { ...node.payload, format: 'sd_product_ad' },
        });
      }
      if (node.kind === 'target.create') {
        return CampaignCreationNode.parse({
          ...common,
          payload: {
            targetType: 'sd_product',
            parent: { source: 'plan_node', kind: 'ad_group', nodeId: AD_GROUP_NODE_ID },
            polarity: 'positive',
            asin: 'B000000009',
            bid: 1.01,
            state: 'paused',
          },
        });
      }
      return CampaignCreationNode.parse(common);
    });
    const plan = CampaignCreationPlan.parse({
      ...spPlan(),
      adProduct: 'SD',
      apiDialect: 'sd_legacy',
      nodes,
    });
    const mismatchedTactic = plan.nodes.map((node) => node.kind === 'campaign.create'
      ? {
          ...node,
          payload: { ...node.payload, settings: { product: 'SD', tactic: 'audience' } },
        }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: mismatchedTactic }).success)
      .toBe(false);
  });

  it('uses one named Unified SB product-video shape and preserves Asset ID/version', () => {
    const plan = sbProductVideoPlan();
    expect(plan.counts.byKind['asset.require_existing']).toBe(1);
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      nodes: plan.nodes.map((node) => node.kind === 'asset.require_existing'
        ? { ...node, payload: { ...node.payload, purpose: 'image' } }
        : node),
    }).success).toBe(false);

    const ref = (kind: 'ad_group' | 'brand' | 'product' | 'store' | 'asset', suffix: number) => ({
      source: 'plan_node' as const,
      kind,
      nodeId: `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`,
    });
    const video = {
      nodeId: '00000000-0000-4000-8000-000000000060',
      kind: 'ad.create',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('6'),
      effect: 'irreversible_create',
      rollback: 'none',
      payload: {
        format: 'sb_product_video',
        name: 'Synthetic video ad',
        adGroup: ref('ad_group', 61),
        brand: null,
        logoAsset: null,
        headline: null,
        enableCreativeAutoTranslation: null,
        landingPage: null,
        products: [],
        videoAsset: ref('asset', 62),
        state: 'paused',
      },
    } as const;
    expect(CampaignCreationNode.safeParse(video).success).toBe(true);
    expect(CampaignCreationNode.safeParse({
      ...video,
      payload: { ...video.payload, name: undefined },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...video,
      payload: { ...video.payload, format: 'sb_brand_video' },
    }).success).toBe(false);

    const asset = CampaignCreationNode.parse({
      nodeId: '00000000-0000-4000-8000-000000000062',
      kind: 'asset.require_existing',
      adProduct: 'SB',
      apiDialect: 'unified_ads_v1',
      dependsOn: [],
      fingerprint: sha('7'),
      effect: 'read_check',
      rollback: 'not_applicable',
      payload: { assetId: 'VIDEO-ASSET-1', version: '7', purpose: 'video' },
    });
    if (asset.kind !== 'asset.require_existing') throw new Error('synthetic video asset missing');
    const changedAsset = CampaignCreationNode.parse({
      ...asset,
      payload: { ...asset.payload, version: '8' },
    });
    expect(serializeCampaignCreationNodeFingerprint(changedAsset))
      .not.toBe(serializeCampaignCreationNodeFingerprint(asset));
  });

  it('uses chronological instants and lowercase canonical UUIDs', () => {
    const plan = spPlan();
    expect(CampaignCreationPlan.safeParse({
      ...plan,
      generatedAt: '2026-08-30T00:00:00.001Z',
      frozenAt: '2026-08-30T00:00:00Z',
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...spNodes()[0],
      nodeId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    }).success).toBe(false);
    const campaign = spNodes()[1];
    if (campaign?.kind !== 'campaign.create') throw new Error('synthetic campaign missing');
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      payload: { ...campaign.payload, startDate: '2026-99-99' },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      payload: { ...campaign.payload, startDate: '2026-02-29' },
    }).success).toBe(false);
    expect(CampaignCreationNode.safeParse({
      ...campaign,
      adProduct: 'SD',
      apiDialect: 'sd_legacy',
      payload: {
        ...campaign.payload,
        settings: { product: 'SD', tactic: 'invented-provider-tactic' },
      },
    }).success).toBe(false);
  });

  it('binds Store Spotlight to three checked pages and purpose-correct Asset IDs', () => {
    const plan = sbStoreSpotlightPlan();
    expect(plan.counts.irreversibleCreates).toBe(3);
    const adIndex = plan.nodes.findIndex((node) => node.kind === 'ad.create');
    const logoIndex = plan.nodes.findIndex((node) => node.kind === 'asset.require_existing'
      && node.payload.purpose === 'logo');
    const wrongLogo = plan.nodes.map((node, index) => index === logoIndex
      ? { ...node, payload: { ...node.payload, purpose: 'image' } }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: wrongLogo }).success).toBe(false);

    const ad = plan.nodes[adIndex];
    if (ad?.kind !== 'ad.create') {
      throw new Error('synthetic Store Spotlight ad missing');
    }
    const spotlight = ad.payload;
    if (spotlight.format !== 'sb_store_spotlight') {
      throw new Error('synthetic Store Spotlight format missing');
    }
    const wrongPage = plan.nodes.map((node, index) => index === adIndex
      ? {
          ...ad,
          payload: {
            ...spotlight,
            cards: spotlight.cards.map((card, cardIndex) => cardIndex === 0
              ? {
                  ...card,
                  landingPage: { ...card.landingPage, pageId: 'UNCHECKED-PAGE' },
                }
              : card),
          },
        }
      : node);
    expect(CampaignCreationPlan.safeParse({ ...plan, nodes: wrongPage }).success).toBe(false);
  });
});

describe('campaign creation approval and evidence', () => {
  it('binds approval to the exact tenant, plan, product, counts, expiry, and no-rollback facts', () => {
    const plan = spPlan();
    expect(ApproveCampaignCreationPlan.parse({
      schemaVersion: plan.schemaVersion,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
      marketplaceId: plan.marketplaceId,
      adProduct: plan.adProduct,
      apiDialect: plan.apiDialect,
      expiresAt: plan.expiresAt,
      expectedCounts: plan.counts,
      noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
    }).expectedCounts.irreversibleCreates).toBe(4);
    expect(CampaignCreationAuthorizationReceipt.parse({
      authorizationId: AUTHORIZATION_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
      schemaVersion: plan.schemaVersion,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
      marketplaceId: plan.marketplaceId,
      adProduct: plan.adProduct,
      apiDialect: plan.apiDialect,
      expiresAt: plan.expiresAt,
      expectedCounts: plan.counts,
      noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: '00000000-0000-4000-8000-000000000009',
      approvedAt: '2026-08-30T00:01:30.000Z',
      gateSnapshotDigest: sha('d'),
    }).authorizationId).toBe(AUTHORIZATION_ID);
    expect(CampaignCreationAuthorizationReceipt.safeParse({
      authorizationId: AUTHORIZATION_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
      schemaVersion: plan.schemaVersion,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
      marketplaceId: plan.marketplaceId,
      adProduct: plan.adProduct,
      apiDialect: plan.apiDialect,
      expiresAt: plan.expiresAt,
      expectedCounts: plan.counts,
      noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: '00000000-0000-4000-8000-000000000009',
      approvedAt: plan.expiresAt,
      gateSnapshotDigest: sha('d'),
    }).success).toBe(false);
    expect(ApproveCampaignCreationPlan.safeParse({
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
    }).success).toBe(false);
  });

  it('joins the exact frozen plan, receipt, job, generation, and call intent at runtime', () => {
    const plan = fingerprintedSpPlan();
    const authorization = {
      authorizationId: AUTHORIZATION_ID,
      executionId: EXECUTION_ID,
      generation: GENERATION_ID,
      schemaVersion: plan.schemaVersion,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      orgId: plan.orgId,
      profileId: plan.profileId,
      marketplaceId: plan.marketplaceId,
      adProduct: plan.adProduct,
      apiDialect: plan.apiDialect,
      expiresAt: plan.expiresAt,
      expectedCounts: plan.counts,
      noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: '00000000-0000-4000-8000-000000000009',
      approvedAt: '2026-08-30T00:01:15.000Z',
      gateSnapshotDigest: sha('d'),
    } as const;
    const job = {
      type: 'campaign_creation.dispatch',
      orgId: plan.orgId,
      profileId: plan.profileId,
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
    } as const;
    const node = plan.nodes.find((candidate) => candidate.effect === 'irreversible_create');
    if (node === undefined) throw new Error('synthetic create node missing');
    const intent = {
      planId: plan.id,
      planFingerprint: plan.fingerprint,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attemptId: ATTEMPT_ID,
      providerCallId: CALL_ID,
      requestDigest: sha('e'),
      positions: [{
        requestIndex: 0,
        nodeId: node.nodeId,
        nodeFingerprint: node.fingerprint,
        requestDigest: sha('f'),
      }],
      recordedAt: '2026-08-30T00:02:01.500Z',
    } as const;
    const completed = completedSpExecutionEvidence(plan);
    const currentEvidence = {
      ...completed,
      providerCallIntents: [],
      providerResults: completed.providerResults.filter((result) => result.effect === 'read_check'),
      nonProviderDispositions: plan.nodes
        .filter((candidate) => candidate.effect === 'irreversible_create')
        .map((candidate) => ({
          planId: plan.id,
          nodeId: candidate.nodeId,
          executionId: EXECUTION_ID,
          nodeFingerprint: candidate.fingerprint,
          outcome: 'pending_dispatch' as const,
          sanitizedReason: null,
        })),
      observations: [],
      snapshot: {
        status: 'running' as const,
        accounting: {
          operatorApproved: plan.counts.irreversibleCreates,
          pendingDispatch: plan.counts.irreversibleCreates,
          attempted: 0,
          succeeded: 0,
          failed: 0,
          ambiguous: 0,
          refusedAtExecution: 0,
          blockedByDependency: 0,
          observed: 0,
          pendingObservation: 0,
          observationNotFound: 0,
          observationConflict: 0,
          readChecksRequested: plan.counts.readChecks,
          readChecksPending: 0,
          readChecksPassed: plan.counts.readChecks,
          readChecksRefused: 0,
          readChecksFailed: 0,
        },
      },
    };

    expect(verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      job,
      '2026-08-30T00:03:00.000Z',
      sha256,
    ).authorization.authorizationId).toBe(AUTHORIZATION_ID);
    expect(verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      intent,
      '2026-08-30T00:03:00.000Z',
      sha256,
    ).intent.providerCallId).toBe(CALL_ID);

    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      { ...authorization, planId: GENERATION_ID },
      job,
      '2026-08-30T00:02:00.000Z',
      sha256,
    )).toThrow(/receipt does not match/);
    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      { ...job, authorizationId: GENERATION_ID },
      '2026-08-30T00:02:00.000Z',
      sha256,
    )).toThrow(/job does not match/);
    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      { ...job, generation: AUTHORIZATION_ID },
      '2026-08-30T00:02:00.000Z',
      sha256,
    )).toThrow(/job does not match/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      { ...intent, generation: AUTHORIZATION_ID },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/intent does not match/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      {
        ...intent,
        positions: [{ ...intent.positions[0], nodeFingerprint: sha('0') }],
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/position does not match/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      completed,
      {
        ...intent,
        attemptId: '00000000-0000-4000-8000-000000000090',
        providerCallId: '00000000-0000-4000-8000-000000000091',
        recordedAt: '2026-08-30T00:02:10.000Z',
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/not exclusively pending/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      { ...authorization, approvedAt: '2026-08-30T00:02:02.000Z' },
      job,
      completed,
      { ...intent, recordedAt: '2026-08-30T00:02:03.000Z' },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/outside the authority window/);
    const adGroupNode = plan.nodes.find((candidate) => candidate.nodeId === AD_GROUP_NODE_ID);
    if (adGroupNode === undefined) throw new Error('synthetic ad-group node missing');
    const pendingCampaignObservation = completed.observations.find(
      (observation) => observation.nodeId === CAMPAIGN_NODE_ID,
    );
    if (pendingCampaignObservation === undefined) {
      throw new Error('synthetic campaign observation missing');
    }
    const pendingNodeIds = new Set([AD_GROUP_NODE_ID, AD_NODE_ID, TARGET_NODE_ID]);
    const successfulCampaignAwaitingObservation = {
      ...completed,
      providerCallIntents: completed.providerCallIntents.filter((providerIntent) => (
        providerIntent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
      )),
      providerResults: completed.providerResults.filter((result) => (
        result.nodeId === PRODUCT_NODE_ID || result.nodeId === CAMPAIGN_NODE_ID
      )),
      nonProviderDispositions: plan.nodes
        .filter((candidate) => pendingNodeIds.has(candidate.nodeId))
        .map((candidate) => ({
          planId: plan.id,
          nodeId: candidate.nodeId,
          executionId: EXECUTION_ID,
          nodeFingerprint: candidate.fingerprint,
          outcome: 'pending_dispatch' as const,
          sanitizedReason: null,
        })),
      observations: [{
        ...pendingCampaignObservation,
        observation: 'pending' as const,
        deliveryStatus: 'unknown' as const,
      }],
      snapshot: {
        status: 'running' as const,
        accounting: {
          operatorApproved: 4,
          pendingDispatch: 3,
          attempted: 1,
          succeeded: 1,
          failed: 0,
          ambiguous: 0,
          refusedAtExecution: 0,
          blockedByDependency: 0,
          observed: 0,
          pendingObservation: 1,
          observationNotFound: 0,
          observationConflict: 0,
          readChecksRequested: 1,
          readChecksPending: 0,
          readChecksPassed: 1,
          readChecksRefused: 0,
          readChecksFailed: 0,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(
      successfulCampaignAwaitingObservation,
    ).snapshot.status).toBe('running');
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      successfulCampaignAwaitingObservation,
      {
        ...intent,
        positions: [{
          requestIndex: 0,
          nodeId: adGroupNode.nodeId,
          nodeFingerprint: adGroupNode.fingerprint,
          requestDigest: sha('7'),
        }],
        recordedAt: '2026-08-30T00:02:03.500Z',
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/dependency that is not satisfied/);
    expect(() => verifyCampaignCreationProviderCallArtifacts(
      plan,
      authorization,
      job,
      currentEvidence,
      {
        ...intent,
        positions: [{
          requestIndex: 0,
          nodeId: adGroupNode.nodeId,
          nodeFingerprint: adGroupNode.fingerprint,
          requestDigest: sha('7'),
        }],
      },
      '2026-08-30T00:03:00.000Z',
      sha256,
    )).toThrow(/dependency that is not satisfied/);
    expect(() => verifyCampaignCreationJobArtifacts(
      plan,
      authorization,
      job,
      plan.expiresAt,
      sha256,
    )).toThrow(/expired/);
    const observeJob = { ...job, type: 'campaign_creation.observe', attempt: 1 } as const;
    expect(verifyCampaignCreationJobArtifacts(
      plan,
      { ...authorization },
      observeJob,
      '2026-08-31T00:00:00.000Z',
      sha256,
    ).job.type).toBe('campaign_creation.observe');
    const campaignObservation = completed.observations.find((candidate) => (
      candidate.nodeId === CAMPAIGN_NODE_ID
    ));
    if (campaignObservation === undefined) {
      throw new Error('synthetic campaign observation missing');
    }
    const advancedObservation = {
      ...campaignObservation,
      observedAt: '2026-08-30T00:04:00.000Z',
      sourceSyncJobId: '00000000-0000-4000-8000-000000000093',
    };
    expect(verifyCampaignCreationObservationArtifacts(
      plan,
      authorization,
      observeJob,
      completed,
      advancedObservation,
      '2026-08-31T00:00:00.000Z',
      sha256,
    ).observation.providerEntityId).toBe(campaignObservation.providerEntityId);
    expect(() => verifyCampaignCreationObservationArtifacts(
      plan,
      authorization,
      observeJob,
      completed,
      { ...advancedObservation, providerEntityId: 'UNRELATED-CAMPAIGN' },
      '2026-08-31T00:00:00.000Z',
      sha256,
    )).toThrow(/not exactly correlated/);
  });

  it('requires provider identity for passed checks, successful creates, and observations', () => {
    const common = {
      planId: PLAN_ID,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: EXECUTION_ID,
      attemptId: ATTEMPT_ID,
      providerCallId: CALL_ID,
      nodeFingerprint: sha('a'),
      requestIndex: 0,
      requestDigest: sha('c'),
      nodeRequestDigest: sha('d'),
      providerEntityVersion: null,
      providerCode: null,
      sanitizedMessage: null,
      providerRequestId: null,
      responseDigest: sha('e'),
      startedAt: '2026-08-30T00:02:00.000Z',
      completedAt: '2026-08-30T00:02:01.000Z',
    };
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'succeeded',
      providerEntityId: null,
    }).success).toBe(false);
    expect(CampaignCreationProviderResult.parse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'succeeded',
      providerEntityId: 'CAMPAIGN-1',
    }).providerEntityId).toBe('CAMPAIGN-1');
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'succeeded',
      providerEntityId: 'CAMPAIGN-1',
      startedAt: '2026-08-30T00:02:00.001Z',
      completedAt: '2026-08-30T00:02:00Z',
    }).success).toBe(false);
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'refused',
      providerEntityId: null,
    }).success).toBe(false);
    expect(CampaignCreationProviderResult.safeParse({
      ...common,
      effect: 'irreversible_create',
      outcome: 'ambiguous',
      providerEntityId: 'UNCORRELATED-ENTITY',
      responseDigest: null,
    }).success).toBe(false);

    const observation = {
      planId: PLAN_ID,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attemptId: ATTEMPT_ID,
      providerCallId: CALL_ID,
      nodeFingerprint: sha('a'),
      requestDigest: sha('c'),
      nodeRequestDigest: sha('d'),
      basis: 'provider_result_identity',
      providerEntityId: null,
      observation: 'pending',
      amazonModerationStatus: 'not_applicable',
      deliveryStatus: 'unknown',
      observedAt: '2026-08-30T00:03:00.000Z',
      sourceSyncJobId: GENERATION_ID,
    } as const;
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      observation: 'observed',
    }).success).toBe(false);
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      deliveryStatus: 'delivering',
    }).success).toBe(false);
    expect(CampaignCreationResourceObservation.safeParse({
      ...observation,
      basis: 'intent_reconciliation',
      observation: 'observed',
      providerEntityId: 'UNRELATED-CAMPAIGN',
    }).success).toBe(false);
  });

  it('keeps operator, provider, observation, and read-check counts closed', () => {
    const valid = {
      operatorApproved: 4,
      pendingDispatch: 0,
      attempted: 3,
      succeeded: 2,
      failed: 0,
      ambiguous: 1,
      refusedAtExecution: 0,
      blockedByDependency: 1,
      observed: 2,
      pendingObservation: 1,
      observationNotFound: 0,
      observationConflict: 0,
      readChecksRequested: 1,
      readChecksPending: 0,
      readChecksPassed: 1,
      readChecksRefused: 0,
      readChecksFailed: 0,
    };
    expect(CampaignCreationAccounting.parse(valid).blockedByDependency).toBe(1);
    expect(CampaignCreationAccounting.safeParse({ ...valid, observed: 3 }).success).toBe(false);
    expect(CampaignCreationAccounting.safeParse({ ...valid, blockedByDependency: 0 }).success)
      .toBe(false);
    expect(deriveCampaignCreationExecutionStatus(valid)).toBe('awaiting_observation');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'succeeded',
      accounting: valid,
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'partial_failed',
      accounting: { ...valid, pendingObservation: 0, observationConflict: 1 },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'blocked',
      accounting: {
        ...valid,
        attempted: 4,
        succeeded: 4,
        ambiguous: 0,
        blockedByDependency: 0,
        observed: 4,
        pendingObservation: 0,
      },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'refused',
      accounting: {
        ...valid,
        attempted: 4,
        succeeded: 4,
        ambiguous: 0,
        blockedByDependency: 0,
        observed: 4,
        pendingObservation: 0,
      },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'awaiting_observation',
      accounting: { ...valid, pendingDispatch: 1, blockedByDependency: 0 },
    }).success).toBe(false);
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'running',
      accounting: valid,
    }).success).toBe(false);

    const queued = {
      operatorApproved: 4,
      pendingDispatch: 4,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      ambiguous: 0,
      refusedAtExecution: 0,
      blockedByDependency: 0,
      observed: 0,
      pendingObservation: 0,
      observationNotFound: 0,
      observationConflict: 0,
      readChecksRequested: 1,
      readChecksPending: 1,
      readChecksPassed: 0,
      readChecksRefused: 0,
      readChecksFailed: 0,
    };
    expect(deriveCampaignCreationExecutionStatus(queued)).toBe('queued');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'running',
      accounting: queued,
    }).success).toBe(false);

    const mixedConflict = {
      ...queued,
      pendingDispatch: 0,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      blockedByDependency: 2,
      observationConflict: 1,
      readChecksPending: 0,
      readChecksPassed: 1,
    };
    expect(deriveCampaignCreationExecutionStatus(mixedConflict)).toBe('ambiguous');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      status: 'partial_failed',
      accounting: mixedConflict,
    }).success).toBe(false);

    const terminalBase = {
      ...queued,
      pendingDispatch: 0,
      readChecksPending: 0,
      readChecksPassed: 1,
    };
    expect(deriveCampaignCreationExecutionStatus({
      ...terminalBase,
      refusedAtExecution: 1,
      blockedByDependency: 3,
    })).toBe('refused');
    expect(deriveCampaignCreationExecutionStatus({
      ...terminalBase,
      blockedByDependency: 4,
    })).toBe('blocked');
    expect(deriveCampaignCreationExecutionStatus({
      ...terminalBase,
      attempted: 1,
      failed: 1,
      blockedByDependency: 3,
    })).toBe('failed');
  });

  it('reconciles every exact node, provider position, disposition, and observation', () => {
    const evidence = completedSpExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.parse(evidence).snapshot.status).toBe('succeeded');

    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.slice(0, -1),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: [...evidence.providerResults, evidence.providerResults[0]],
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      observations: [...evidence.observations, evidence.observations[0]],
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result, index) => index === 1
        ? { ...result, nodeFingerprint: sha('f') }
        : result),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      observations: evidence.observations.map((observation, index) => index === 0
        ? { ...observation, providerCallId: CALL_ID }
        : observation),
    }).success).toBe(false);

    const notFound = {
      ...evidence,
      observations: evidence.observations.map((observation) => observation.nodeId === TARGET_NODE_ID
        ? {
            ...observation,
            providerEntityId: null,
            observation: 'not_found',
            deliveryStatus: 'unknown',
          }
        : observation),
      snapshot: {
        status: 'awaiting_observation',
        accounting: {
          ...evidence.snapshot.accounting,
          observed: 3,
          observationNotFound: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(notFound).snapshot.accounting.observationNotFound)
      .toBe(1);
    expect(CampaignCreationExecutionEvidence.parse(notFound).snapshot.status)
      .toBe('awaiting_observation');

    expect(CampaignCreationExecutionEvidence.safeParse({
      ...notFound,
      observations: evidence.observations.map((observation) => (
        observation.nodeId === CAMPAIGN_NODE_ID
          ? {
              ...observation,
              providerEntityId: null,
              observation: 'not_found',
              deliveryStatus: 'unknown',
            }
          : observation
      )),
    }).success).toBe(false);
  });

  it('requires write-ahead intent and keeps an unresolved create quarantined', () => {
    const evidence = completedSpExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.filter((intent) => (
        !intent.positions.some((position) => position.nodeId === TARGET_NODE_ID)
      )),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.map((intent, index) => index === 1
        ? { ...intent, authorizationId: '00000000-0000-4000-8000-000000000092' }
        : intent),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => (
        result.nodeId === TARGET_NODE_ID && result.effect === 'irreversible_create'
          ? { ...result, requestDigest: sha('9') }
          : result
      )),
    }).success).toBe(false);

    const firstIntent = evidence.providerCallIntents[0];
    if (firstIntent === undefined) throw new Error('synthetic provider intent missing');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: [
        ...evidence.providerCallIntents,
        {
          ...firstIntent,
          attemptId: '00000000-0000-4000-8000-000000000090',
          providerCallId: '00000000-0000-4000-8000-000000000091',
        },
      ],
    }).success).toBe(false);

    const unresolved = {
      ...evidence,
      providerResults: evidence.providerResults.filter((result) => (
        result.nodeId !== TARGET_NODE_ID
      )),
      observations: evidence.observations.map((observation) => (
        observation.nodeId === TARGET_NODE_ID
          ? {
              ...observation,
              providerEntityId: null,
              basis: 'intent_reconciliation' as const,
              observation: 'not_found' as const,
              deliveryStatus: 'unknown' as const,
            }
          : observation
      )),
      snapshot: {
        status: 'awaiting_observation' as const,
        accounting: {
          ...evidence.snapshot.accounting,
          succeeded: 3,
          ambiguous: 1,
          observed: 3,
          observationNotFound: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(unresolved).snapshot.status)
      .toBe('awaiting_observation');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...unresolved,
      snapshot: { ...unresolved.snapshot, status: 'partial_failed' },
    }).success).toBe(false);

    const crashAfterIntent = {
      ...unresolved,
      observations: unresolved.observations.filter((observation) => (
        observation.nodeId !== TARGET_NODE_ID
      )),
      snapshot: {
        status: 'awaiting_observation' as const,
        accounting: {
          ...unresolved.snapshot.accounting,
          pendingObservation: 1,
          observationNotFound: 0,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(crashAfterIntent).snapshot.accounting
      .pendingObservation).toBe(1);

    const successAwaitingFirstObservation = {
      ...evidence,
      observations: evidence.observations.filter((observation) => (
        observation.nodeId !== TARGET_NODE_ID
      )),
      snapshot: {
        status: 'awaiting_observation' as const,
        accounting: {
          ...evidence.snapshot.accounting,
          observed: 3,
          pendingObservation: 1,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(successAwaitingFirstObservation).snapshot.status)
      .toBe('awaiting_observation');

    const campaignResult = evidence.providerResults.find(
      (result) => result.nodeId === CAMPAIGN_NODE_ID,
    );
    if (campaignResult === undefined) throw new Error('synthetic campaign result missing');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.map((intent) => (
        intent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
          ? { ...intent, recordedAt: campaignResult.completedAt }
          : intent
      )),
    }).success).toBe(false);
  });

  it('represents staged running work while a created dependency awaits observation', () => {
    const evidence = completedSpExecutionEvidence();
    const campaignObservation = evidence.observations.find(
      (observation) => observation.nodeId === CAMPAIGN_NODE_ID,
    );
    if (campaignObservation === undefined) throw new Error('synthetic campaign observation missing');
    const pendingNodeIds = new Set([AD_GROUP_NODE_ID, AD_NODE_ID, TARGET_NODE_ID]);
    const staged = {
      ...evidence,
      providerCallIntents: evidence.providerCallIntents.filter((intent) => (
        intent.positions.some((position) => position.nodeId === CAMPAIGN_NODE_ID)
      )),
      providerResults: evidence.providerResults.filter(
        (result) => result.nodeId === PRODUCT_NODE_ID || result.nodeId === CAMPAIGN_NODE_ID,
      ),
      nonProviderDispositions: evidence.plan.nodes
        .filter((node) => pendingNodeIds.has(node.nodeId))
        .map((node) => ({
          planId: evidence.plan.id,
          nodeId: node.nodeId,
          executionId: evidence.executionId,
          nodeFingerprint: node.fingerprint,
          outcome: 'pending_dispatch' as const,
          sanitizedReason: null,
        })),
      observations: [{
        ...campaignObservation,
        observation: 'pending' as const,
        deliveryStatus: 'unknown' as const,
      }],
      snapshot: {
        status: 'running' as const,
        accounting: {
          operatorApproved: 4,
          pendingDispatch: 3,
          attempted: 1,
          succeeded: 1,
          failed: 0,
          ambiguous: 0,
          refusedAtExecution: 0,
          blockedByDependency: 0,
          observed: 0,
          pendingObservation: 1,
          observationNotFound: 0,
          observationConflict: 0,
          readChecksRequested: 1,
          readChecksPending: 0,
          readChecksPassed: 1,
          readChecksRefused: 0,
          readChecksFailed: 0,
        },
      },
    };
    expect(CampaignCreationExecutionEvidence.parse(staged).snapshot.status).toBe('running');
    expect(CampaignCreationExecutionSnapshot.safeParse({
      ...staged.snapshot,
      accounting: {
        ...staged.snapshot.accounting,
        pendingDispatch: 0,
        blockedByDependency: 3,
      },
    }).success).toBe(false);
  });

  it('enforces preflight identity, provider-identity uniqueness, and canonical evidence order', () => {
    const evidence = completedSpExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result, index) => index === 0
        ? { ...result, providerEntityId: 'B999999999' }
        : result),
    }).success).toBe(false);
    const sbEvidence = completedSpExecutionEvidence(sbProductVideoPlan());
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...sbEvidence,
      providerResults: sbEvidence.providerResults.map((result) => result.effect === 'read_check'
        && result.providerEntityVersion !== null
        ? { ...result, providerEntityVersion: 'wrong-version' }
        : result),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: [...evidence.providerResults].reverse(),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => (
        result.nodeId === AD_NODE_ID
          ? { ...result, providerCallId: CALL_ID, requestIndex: 0 }
          : result.nodeId === TARGET_NODE_ID
            ? { ...result, providerCallId: CALL_ID, requestIndex: 2 }
            : result
      )),
    }).success).toBe(false);

    const plan = spPlan();
    const secondTarget = CampaignCreationNode.parse({
      ...plan.nodes.find((node) => node.nodeId === TARGET_NODE_ID),
      nodeId: '00000000-0000-4000-8000-000000000016',
      fingerprint: sha('6'),
    });
    const twoTargetPlan = CampaignCreationPlan.parse({
      ...plan,
      nodes: orderCampaignCreationNodes([...plan.nodes, secondTarget]),
      counts: {
        ...plan.counts,
        totalNodes: 6,
        irreversibleCreates: 5,
        byKind: { ...plan.counts.byKind, 'target.create': 2 },
      },
    });
    const duplicateIdentity = completedSpExecutionEvidence(twoTargetPlan);
    const targetNodeIds = new Set([TARGET_NODE_ID, secondTarget.nodeId]);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...duplicateIdentity,
      providerResults: duplicateIdentity.providerResults.map((result) => targetNodeIds.has(result.nodeId)
        ? { ...result, providerEntityId: 'TARGET-SAME' }
        : result),
      observations: duplicateIdentity.observations.map((observation) => targetNodeIds.has(observation.nodeId)
        ? { ...observation, providerEntityId: 'TARGET-SAME' }
        : observation),
    }).success).toBe(false);

    const targetIntents = duplicateIdentity.providerCallIntents.filter((intent) => (
      intent.positions.some((position) => targetNodeIds.has(position.nodeId))
    ));
    const firstTargetIntent = targetIntents[0];
    if (firstTargetIntent === undefined || targetIntents.length !== 2) {
      throw new Error('synthetic target call intents missing');
    }
    const batchedRequestDigest = sha('8');
    const batchedPositions = targetIntents.map((intent, requestIndex) => {
      const position = intent.positions[0];
      if (position === undefined) throw new Error('synthetic target call position missing');
      return { ...position, requestIndex };
    });
    const batchedIntent = {
      ...firstTargetIntent,
      requestDigest: batchedRequestDigest,
      positions: batchedPositions,
    };
    const batchedEvidence = {
      ...duplicateIdentity,
      providerCallIntents: [
        ...duplicateIdentity.providerCallIntents.filter((intent) => (
          !intent.positions.some((position) => targetNodeIds.has(position.nodeId))
        )),
        batchedIntent,
      ],
      providerResults: duplicateIdentity.providerResults.map((result) => {
        const requestIndex = batchedPositions.findIndex(
          (position) => position.nodeId === result.nodeId,
        );
        if (requestIndex < 0 || result.effect !== 'irreversible_create') return result;
        const position = batchedPositions[requestIndex];
        if (position === undefined) throw new Error('synthetic batched position missing');
        return {
          ...result,
          attemptId: batchedIntent.attemptId,
          providerCallId: batchedIntent.providerCallId,
          requestIndex,
          requestDigest: batchedRequestDigest,
          nodeRequestDigest: position.requestDigest,
        };
      }),
      observations: duplicateIdentity.observations.map((observation) => {
        const position = batchedPositions.find((candidate) => (
          candidate.nodeId === observation.nodeId
        ));
        if (position === undefined) return observation;
        return {
          ...observation,
          attemptId: batchedIntent.attemptId,
          providerCallId: batchedIntent.providerCallId,
          requestDigest: batchedRequestDigest,
          nodeRequestDigest: position.requestDigest,
        };
      }),
    };
    expect(CampaignCreationExecutionEvidence.parse(batchedEvidence).providerCallIntents.at(-1)
      ?.positions).toHaveLength(2);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...batchedEvidence,
      providerCallIntents: batchedEvidence.providerCallIntents.map((intent) => (
        intent.providerCallId === batchedIntent.providerCallId
          ? { ...intent, positions: [...intent.positions].reverse() }
          : intent
      )),
    }).success).toBe(false);
  });

  it('enforces execution dependencies and provider/observation chronology', () => {
    const evidence = completedSpExecutionEvidence();
    const campaignResult = evidence.providerResults.find(
      (result) => result.nodeId === CAMPAIGN_NODE_ID,
    );
    if (campaignResult === undefined) throw new Error('synthetic campaign result missing');
    const afterExpiryResults = evidence.providerResults.map((result, index) => ({
      ...result,
      startedAt: `2026-08-30T02:00:${String(index * 2).padStart(2, '0')}.000Z`,
      completedAt: `2026-08-30T02:00:${String(index * 2 + 1).padStart(2, '0')}.000Z`,
    }));
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: afterExpiryResults,
      observations: evidence.observations.map((observation) => ({
        ...observation,
        observedAt: '2026-08-30T02:01:00.000Z',
      })),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => result.nodeId === TARGET_NODE_ID
        ? {
            ...result,
            startedAt: evidence.plan.expiresAt,
            completedAt: '2026-08-30T01:01:01.000Z',
          }
        : result),
      observations: evidence.observations.map((observation) => (
        observation.nodeId === TARGET_NODE_ID
          ? { ...observation, observedAt: '2026-08-30T01:01:02.000Z' }
          : observation
      )),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      providerResults: evidence.providerResults.map((result) => result.nodeId === AD_GROUP_NODE_ID
        ? { ...result, startedAt: campaignResult.startedAt }
        : result),
    }).success).toBe(false);
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...evidence,
      observations: evidence.observations.map((observation, index) => index === 0
        ? { ...observation, observedAt: campaignResult.startedAt }
        : observation),
    }).success).toBe(false);

    const failed = failedCampaignExecutionEvidence();
    expect(CampaignCreationExecutionEvidence.parse(failed).snapshot.status).toBe('failed');
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...failed,
      snapshot: { ...failed.snapshot, status: 'partial_failed' },
    }).success).toBe(false);

    const adGroupResult = evidence.providerResults.find(
      (result) => result.nodeId === AD_GROUP_NODE_ID,
    );
    const adGroupObservation = evidence.observations.find(
      (observation) => observation.nodeId === AD_GROUP_NODE_ID,
    );
    if (adGroupResult === undefined || adGroupObservation === undefined) {
      throw new Error('synthetic ad-group evidence missing');
    }
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...failed,
      providerResults: [...failed.providerResults, adGroupResult],
      nonProviderDispositions: failed.nonProviderDispositions.filter(
        (disposition) => disposition.nodeId !== AD_GROUP_NODE_ID,
      ),
      observations: [adGroupObservation],
    }).success).toBe(false);

    const campaignDisposition = {
      planId: failed.plan.id,
      nodeId: CAMPAIGN_NODE_ID,
      executionId: failed.executionId,
      nodeFingerprint: campaignResult.nodeFingerprint,
      outcome: 'blocked_by_dependency',
      sanitizedReason: 'No dependency actually failed.',
    } as const;
    expect(CampaignCreationExecutionEvidence.safeParse({
      ...failed,
      providerResults: failed.providerResults.slice(0, 1),
      nonProviderDispositions: [campaignDisposition, ...failed.nonProviderDispositions],
    }).success).toBe(false);
  });

  it('reserves future creation jobs without making them claimable by current workers', () => {
    const dispatch = {
      type: 'campaign_creation.dispatch',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      planId: PLAN_ID,
      planFingerprint: sha('a'),
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
    } as const;
    expect(CampaignCreationJobPayload.parse(dispatch)).toEqual(dispatch);
    expect(JobPayload.safeParse(dispatch).success).toBe(false);
    expect(CampaignCreationJobPayload.safeParse({
      type: 'campaign_creation.observe',
      orgId: ORG_ID,
      profileId: PROFILE_ID,
      planId: PLAN_ID,
      planFingerprint: sha('a'),
      executionId: EXECUTION_ID,
      authorizationId: AUTHORIZATION_ID,
      generation: GENERATION_ID,
      attempt: 8,
    }).success).toBe(false);
  });
});
