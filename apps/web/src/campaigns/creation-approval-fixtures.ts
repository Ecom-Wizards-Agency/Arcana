/** Synthetic server-side rendering scenarios. No production reader imports this module. */
import { createHash } from 'node:crypto';
import { CampaignCreationAuthorizationReceipt, CampaignCreationExecutionEvidence,
  CampaignCreationNodeKind, CampaignCreationNodeV2, CampaignCreationPlanV2,
  orderCampaignCreationNodes, serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint } from '@wizard-ads/shared';
import { CampaignCreationApprovalSource } from '@wizard-ads/shared/campaign-creation-approval';
import { projectCampaignCreationApproval } from './creation-approval-loader';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const zero = '0'.repeat(64);
const checkedAt = '2026-09-06T12:05:00.000Z';
const observedAt = '2026-09-06T12:04:00.000Z';
const ref = (kind: string, value: number) => ({ source: 'plan_node', kind, nodeId: id(value) });
type Format = 'sp_manual' | 'sp_auto' | 'sb_video_detail' | 'sb_video_store' | 'sd_image' | 'sd_video';

function recordedSource(format: Format): CampaignCreationApprovalSource {
  const product = format.startsWith('sp_') ? 'SP' : format.startsWith('sb_') ? 'SB' : 'SD';
  const dialect = product === 'SP' ? 'sp_legacy_v3' : product === 'SB' ? 'unified_ads_v1' : 'sd_legacy';
  const base = { schemaVersion: 'openspell.campaign-creation-node.v2', adProduct: product,
    apiDialect: dialect, fingerprint: zero };
  const read = { ...base, effect: 'read_check', rollback: 'not_applicable', dependsOn: [] };
  const create = { ...base, effect: 'irreversible_create', rollback: 'none' };
  const video = format !== 'sd_image';
  const raw: unknown[] = [{ ...read, nodeId: id(10), kind: 'eligibility.require_product',
    payload: { asin: 'B000000001', sku: 'SYNTHETIC-SKU' } }];
  if (product !== 'SP') raw.push({ ...read, nodeId: id(11), kind: 'asset.require_existing',
    payload: { assetId: video ? 'SYNTHETIC-VIDEO' : 'SYNTHETIC-IMAGE', version: '3', purpose: video ? 'video' : 'image' } });
  if (product === 'SB') raw.push({ ...read, nodeId: id(16), kind: 'eligibility.require_brand',
    payload: { brandId: 'SYNTHETIC-BRAND', brandEntityId: null, brandName: 'Synthetic brand' } });
  if (format === 'sb_video_store') raw.push({ ...read, nodeId: id(17), kind: 'eligibility.require_store',
    payload: { storeId: 'SYNTHETIC-STORE', pageIds: ['SYNTHETIC-PAGE'] } });
  raw.push({ ...create, nodeId: id(12), kind: 'campaign.create',
    dependsOn: [id(product === 'SB' ? 16 : 10)], payload: {
      name: `Synthetic ${format} campaign`, state: 'paused',
      budget: { amount: 20, type: 'daily', currencyCode: 'USD' }, portfolioId: null,
      schedule: product === 'SB'
        ? { type: 'instants', startDateTime: '2026-09-07T07:00:00.000Z', endDateTime: null }
        : { type: 'calendar_dates', startDate: '2026-09-07', endDate: null },
      settings: product === 'SP'
        ? { product, targetingType: format === 'sp_auto' ? 'auto' : 'manual', biddingStrategy: 'manual',
          placementBidding: { topOfSearch: 25, productPages: 0, restOfSearch: 10 } }
        : product === 'SB'
          ? { product, targetingType: 'manual', format: 'product_video', brand: ref('brand', 16),
            costType: 'CPC', marketplaceScope: 'SINGLE_MARKETPLACE', marketplace: 'US',
            optimizations: { goalSettings: { kpi: 'CLICKS' }, bidSettings: { bidStrategy: 'MANUAL' } },
            purchasing: { type: 'auction' } }
          : { product, tactic: 'contextual', costType: 'cpc' },
    } },
  { ...create, nodeId: id(13), kind: 'ad_group.create', dependsOn: [id(12)], payload: {
    campaign: ref('campaign', 12), name: 'Synthetic ad group', state: 'paused', defaultBid: product === 'SB' ? null : 1.1,
    settings: product === 'SD' ? { product, creativeType: video ? 'VIDEO' : 'IMAGE', bidOptimization: 'clicks' } : { product },
  } });
  if (product === 'SB') {
    raw.push({ ...create, nodeId: id(14), kind: 'ad.create',
      dependsOn: [10, 11, 13, 16, ...(format === 'sb_video_store' ? [17] : [])].map(id), payload: {
        format: 'sb_product_video', name: 'Synthetic video ad', adGroup: ref('ad_group', 13),
        brand: ref('brand', 16), logoAsset: null, headline: null, enableCreativeAutoTranslation: false,
        products: [ref('product', 10)], videoAsset: ref('asset', 11), state: 'paused',
        landingPage: format === 'sb_video_store'
          ? { type: 'store', store: ref('store', 17), pageId: 'SYNTHETIC-PAGE' }
          : { type: 'detail_page', product: ref('product', 10) },
      } });
  } else {
    raw.push({ ...create, nodeId: id(14), kind: 'ad.create', dependsOn: [id(10), id(13)], payload: {
      format: product === 'SP' ? 'sp_product_ad' : 'sd_product_ad', adGroup: ref('ad_group', 13),
      product: ref('product', 10), state: 'paused',
    } });
  }
  if (format === 'sp_manual') raw.push({ ...create, nodeId: id(15), kind: 'target.create', dependsOn: [id(13)],
    payload: { targetType: 'keyword', parent: ref('ad_group', 13), scope: 'ad_group', polarity: 'positive',
      text: 'synthetic keyword', matchType: 'exact', bid: null, state: 'paused' } });
  // Amazon creates SP automatic clauses; the preview must not count imaginary target.create calls.
  if (product === 'SD') raw.push({ ...create, nodeId: id(18), kind: 'creative.create', dependsOn: [id(11), id(13), id(14)],
    payload: { format, adGroup: ref('ad_group', 13), headline: null, brandLogo: null, consentToTranslate: false,
      ...(video ? { videos: { representation: 'single_video', video: ref('asset', 11) } }
        : { images: { representation: 'rectangle_and_square',
          rectCustomImage: { asset: ref('asset', 11), croppingCoordinates: { top: 0, left: 0, width: 1200, height: 628 } },
          squareCustomImage: { asset: ref('asset', 11), croppingCoordinates: { top: 0, left: 0, width: 628, height: 628 } },
        } }),
    } });
  const nodes = orderCampaignCreationNodes(raw.map((node) => CampaignCreationNodeV2.parse(node)))
    .map((node) => ({ ...node, fingerprint: sha(serializeCampaignCreationNodeFingerprint(node)) }));
  const readChecks = nodes.filter((node) => node.effect === 'read_check').length;
  const plan = CampaignCreationPlanV2.parse({ schemaVersion: 'openspell.campaign-creation-plan.v2',
    id: id(1), orgId: id(2), profileId: id(3), marketplaceId: 'ATVPDKIKX0DER', adProduct: product, apiDialect: dialect,
    providerScope: { amazonProfileId: '900000000001', connectionId: id(4), region: 'NA',
      marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', accountType: 'seller' },
    generatedAt: '2026-09-06T12:00:00.000Z', frozenAt: '2026-09-06T12:01:00.000Z',
    expiresAt: '2026-09-06T13:00:00.000Z', nodes, fingerprint: zero,
    counts: { totalNodes: nodes.length, readChecks, irreversibleCreates: nodes.length - readChecks,
      byKind: Object.fromEntries(CampaignCreationNodeKind.options.map((kind) => [kind, nodes.filter((node) => node.kind === kind).length])) },
    noRollbackAcknowledgement: { required: true, rollback: 'none', compensatingAction: 'separate_reviewed_pause_or_archive' },
  });
  plan.fingerprint = sha(serializeCampaignCreationPlanFingerprint(plan));
  return CampaignCreationApprovalSource.parse({ plan, profile: { id: plan.profileId, label: 'Synthetic profile' }, checkedAt,
    current: { orgId: plan.orgId, profileId: plan.profileId, planFingerprint: plan.fingerprint, providerScope: plan.providerScope,
      checks: nodes.map((node) => ({ nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
        result: 'passed', reason: null, checkedAt: observedAt, validUntil: '2026-09-06T12:10:00.000Z' })),
      assets: nodes.filter((node) => node.kind === 'asset.require_existing').map((node) => ({
        nodeId: node.nodeId, moderation: 'unknown', observation: {
          scope: { region: 'NA', amazonProfileId: plan.providerScope.amazonProfileId },
          identity: { assetId: node.payload.assetId, version: node.payload.version }, observedAt,
          assetType: video ? 'video' : 'image', name: 'Synthetic selected asset', processing: 'active',
          specChecks: { approvedPrograms: null, failedSpecChecks: null },
        },
      })) }, admission: { kind: 'unavailable' } });
}

function queued(source: CampaignCreationApprovalSource): CampaignCreationApprovalSource {
  const { plan } = source;
  const receipt = CampaignCreationAuthorizationReceipt.parse({ authorizationId: id(20), executionId: id(21), generation: id(22),
    schemaVersion: plan.schemaVersion, planId: plan.id, planFingerprint: plan.fingerprint, orgId: plan.orgId,
    profileId: plan.profileId, marketplaceId: plan.marketplaceId, adProduct: plan.adProduct, apiDialect: plan.apiDialect,
    expiresAt: plan.expiresAt, expectedCounts: plan.counts, noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
    confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1', approvedBy: id(23),
    approvedAt: '2026-09-06T12:03:00.000Z', gateSnapshotDigest: zero });
  const execution = CampaignCreationExecutionEvidence.parse({ plan, executionId: receipt.executionId,
    providerCallIntents: [], providerResults: [], observations: [],
    nonProviderDispositions: plan.nodes.filter((node) => node.effect === 'irreversible_create').map((node) => ({
      planId: plan.id, executionId: receipt.executionId, nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
      outcome: 'pending_dispatch', sanitizedReason: null })),
    snapshot: { status: 'queued', accounting: { operatorApproved: plan.counts.irreversibleCreates,
      pendingDispatch: plan.counts.irreversibleCreates, attempted: 0, succeeded: 0, failed: 0, ambiguous: 0,
      refusedAtExecution: 0, blockedByDependency: 0, observed: 0, pendingObservation: 0,
      observationNotFound: 0, observationConflict: 0, readChecksRequested: plan.counts.readChecks,
      readChecksPending: plan.counts.readChecks, readChecksPassed: 0, readChecksRefused: 0, readChecksFailed: 0 } },
  });
  return CampaignCreationApprovalSource.parse({ ...source, admission: { kind: 'recorded', receipt, execution } });
}

/** Each invocation returns independent objects; all timestamps and identities are synthetic. */
export function campaignCreationApprovalFixtures() {
  const sources = {
    spManual: recordedSource('sp_manual'), spAutomatic: recordedSource('sp_auto'),
    sbVideoDetail: recordedSource('sb_video_detail'), sbVideoStore: recordedSource('sb_video_store'),
    sdImage: recordedSource('sd_image'), sdVideo: recordedSource('sd_video'),
  };
  const changed = (change: (source: CampaignCreationApprovalSource) => void) => {
    const source = structuredClone(sources.sdVideo);
    change(source);
    return CampaignCreationApprovalSource.parse(source);
  };
  const queuedSource = queued(sources.spManual);
  const scenarios = { ...sources,
    knownUnapproved: changed((source) => { source.admission = { kind: 'none' }; }),
    expired: changed((source) => { source.checkedAt = source.plan.expiresAt; }),
    staleChecks: changed((source) => { source.checkedAt = '2026-09-06T12:10:00.000Z'; }),
    unknownEligibility: changed((source) => {
      source.current.checks[0] = { ...source.current.checks[0]!, result: 'unknown', reason: 'unverified' };
    }),
    ineligible: changed((source) => {
      source.current.checks[0] = { ...source.current.checks[0]!, result: 'blocked', reason: 'ineligible' };
    }),
    assetMissing: changed((source) => { source.current.assets[0]!.observation = null; }),
    assetProcessing: changed((source) => { source.current.assets[0]!.observation!.processing = 'processing'; }),
    assetVersionMismatch: changed((source) => { source.current.assets[0]!.observation!.identity.version = '4'; }),
    queued: queuedSource,
    admittedStatusUnavailable: CampaignCreationApprovalSource.parse({ ...queuedSource,
      admission: queuedSource.admission.kind === 'recorded' ? { ...queuedSource.admission, execution: null } : queuedSource.admission }),
  };
  const views = Object.fromEntries(Object.entries(scenarios).map(([name, source]) => [name,
    projectCampaignCreationApproval({ orgId: source.plan.orgId, profileId: source.plan.profileId, planId: source.plan.id }, source),
  ]));
  return { sources: scenarios, views,
    // Display sequence only, not an invented HTTP or confirmation contract. Never infer a retry from unknown admission.
    interruptedRead: [views.spManual!, views.admittedStatusUnavailable!, views.queued!],
  };
}
