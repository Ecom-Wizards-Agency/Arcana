import { createHash } from 'node:crypto';
import { ProviderGraphAssociation, ProviderGraphIdentity, ProviderGraphObservation, ProviderGraphReadResult,
  ProviderGraphResource, ProviderGraphScope } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readId } from './read.js';
import { parseSbAdProbeRow, parseSbAssetReference } from './sb-ad-assets.js';

/** Official SB v4 and SD v3 specifications; product-specific reads only. */
export const PROVIDER_GRAPH_ENDPOINTS = {
  sb_ads: { path: '/sb/v4/ads/list', key: 'ads', id: 'adId', kind: 'ad', product: 'SB' },
  sb_creatives: { path: '/sb/ads/creatives/list', key: 'creatives', id: 'adId', kind: 'creative', product: 'SB' },
  sd_campaigns_extended: { path: '/sd/campaigns/extended', key: '', id: 'campaignId', kind: 'campaign', product: 'SD' },
  sd_ad_groups_extended: { path: '/sd/adGroups/extended', key: '', id: 'adGroupId', kind: 'ad_group', product: 'SD' },
  sd_ads: { path: '/sd/productAds', key: '', id: 'adId', kind: 'ad', product: 'SD' },
  sd_ads_extended: { path: '/sd/productAds/extended', key: '', id: 'adId', kind: 'ad', product: 'SD' },
  sd_targets: { path: '/sd/targets', key: '', id: 'targetId', kind: 'target', product: 'SD' },
  sd_targets_extended: { path: '/sd/targets/extended', key: '', id: 'targetId', kind: 'target', product: 'SD' },
  sd_negatives: { path: '/sd/negativeTargets', key: '', id: 'targetId', kind: 'negative', product: 'SD' },
  sd_negatives_extended: { path: '/sd/negativeTargets/extended', key: '', id: 'targetId', kind: 'negative', product: 'SD' },
  sd_creatives: { path: '/sd/creatives', key: '', id: 'creativeId', kind: 'creative', product: 'SD' },
} as const satisfies Record<ProviderGraphResource, unknown>;

/** Worker supplies authenticated transport. No default fetch and no authority inferred from credentials. */
export interface ProviderGraphReadTransport {
  read(request: { scope: ProviderGraphScope; method: 'GET' | 'POST'; path: string;
    mediaType: string; body?: Record<string, unknown>; query?: Record<string, string> }): Promise<unknown>;
}

function graphId(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  return readId(row, key);
}

type ReadInput = { scope: ProviderGraphScope; resource: ProviderGraphResource; observedAt: string;
  adId?: string; pageSize?: number; maxPages?: number; enabled?: boolean };

function fingerprint(row: unknown): string {
  // Hash only; no arbitrary provider fields are returned or persisted.
  return createHash('sha256').update(JSON.stringify(row)).digest('hex');
}

function parseRow(raw: unknown, input: ReadInput): {
  observation: ProviderGraphObservation; associations: ProviderGraphAssociation[];
} {
  if (!isRecord(raw)) throw new Error('invalid_row');
  const endpoint = PROVIDER_GRAPH_ENDPOINTS[input.resource];
  const id = graphId(raw, endpoint.id);
  if (id === null) throw new Error('missing_identity');
  if (input.resource === 'sb_creatives' && id !== input.adId) throw new Error('wrong_ad');
  const version = input.resource === 'sb_creatives' ? graphId(raw, 'creativeVersion') : null;
  if (input.resource === 'sb_creatives' && version === null) throw new Error('missing_identity');
  const identity = ProviderGraphIdentity.parse({ adProduct: endpoint.product, kind: endpoint.kind,
    providerId: id, version });
  const updated = raw['lastUpdateTime'] ?? raw['lastUpdatedDate']
    ?? (isRecord(raw['extendedData']) ? raw['extendedData']['lastUpdateDate'] : undefined);
  const sourceEventAt = typeof updated === 'number' && Number.isFinite(updated)
    ? new Date(updated).toISOString() : input.observedAt;
  if (Date.parse(sourceEventAt) > Date.parse(input.observedAt)) throw new Error('invalid_row');
  const state = typeof raw['state'] === 'string' ? raw['state'].toLowerCase() : 'unknown';
  const observation = ProviderGraphObservation.parse({ scope: input.scope, identity, source: 'product_api',
    contractVersion: endpoint.product === 'SB' ? 'sb-v4-2026-09' : 'sd-v3-2026-09', sourceEventAt,
    observedAt: input.observedAt, revision: null, payloadFingerprint: fingerprint(raw), operation: 'upsert',
    state: ['enabled', 'paused', 'archived'].includes(state) ? state : 'unknown' });
  const associations: ProviderGraphAssociation[] = [];
  const link = (kind: ProviderGraphIdentity['kind'], providerId: string, relation: ProviderGraphAssociation['relation'], assetVersion: string | null = null): void => {
    associations.push(ProviderGraphAssociation.parse({ scope: input.scope, from: identity,
      to: { adProduct: endpoint.product, kind, providerId, version: assetVersion }, relation,
      sourceEventAt, revision: null, payloadFingerprint: observation.payloadFingerprint, operation: 'upsert' }));
  };
  if (input.resource === 'sb_ads') {
    const ad = parseSbAdProbeRow(raw, 'SB graph ad');
    link('campaign', ad.campaignId, 'parent'); link('ad_group', ad.adGroupId, 'parent');
    for (const asset of ad.videoAssets) if (asset.kind === 'asset_library' && asset.version !== null) {
      link('asset', asset.assetId, 'asset', asset.version);
    }
    for (const asin of ad.asins) link('product', asin, 'advertised_product');
  } else if (input.resource === 'sb_creatives') {
    link('ad', id, 'parent');
  } else {
    for (const [field, kind] of [['campaignId', 'campaign'], ['adGroupId', 'ad_group']] as const) {
      if (field === endpoint.id) continue;
      const parent = graphId(raw, field);
      if (parent !== null) link(kind, parent, 'parent');
      else if (field === 'adGroupId' && endpoint.kind !== 'campaign' && endpoint.kind !== 'ad_group') {
        throw new Error('invalid_association');
      }
    }
    const asin = graphId(raw, 'asin'); if (asin !== null) link('product', asin, 'advertised_product');
  }
  // Only documented asset-bearing creative fields; arbitrary nested IDs are never promoted to assets.
  const properties = raw['creativeProperties'] ?? raw['properties'];
  if (isRecord(properties)) {
    for (const field of ['brandLogo', 'rectCustomImage', 'squareCustomImage', 'video']) {
      const asset = properties[field];
      if (!isRecord(asset)) continue;
      const assetId = graphId(asset, 'assetId'); const assetVersion = graphId(asset, 'assetVersion');
      if (assetId !== null && assetVersion !== null) link('asset', assetId, 'asset', assetVersion);
    }
    const videoAssetIds = properties['videoAssetIds'];
    if (Array.isArray(videoAssetIds)) for (const value of videoAssetIds) {
      if (typeof value !== 'string') throw new Error('invalid_association');
      const asset = parseSbAssetReference(value);
      if (asset.kind === 'asset_library' && asset.version !== null) link('asset', asset.assetId, 'asset', asset.version);
    }
  }
  return { observation, associations };
}

/** Complete means every page was read and every row decoded; it never authorizes mirror deletion. */
export async function readProviderGraph(transport: ProviderGraphReadTransport, input: ReadInput): Promise<ProviderGraphReadResult> {
  if (input.enabled !== true) throw new Error('Provider graph source is disabled');
  ProviderGraphScope.parse(input.scope); ProviderGraphResource.parse(input.resource);
  if (!Number.isFinite(Date.parse(input.observedAt))) throw new Error('Invalid graph observation time');
  if (input.resource === 'sb_creatives' && !input.adId) throw new Error('SB creatives require the exact ad ID');
  const pageSize = input.pageSize ?? 100; const maxPages = input.maxPages ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('Invalid graph page bounds');
  const endpoint = PROVIDER_GRAPH_ENDPOINTS[input.resource];
  const observations: ProviderGraphObservation[] = []; const associations: ProviderGraphAssociation[] = [];
  const refusals: ProviderGraphReadResult['refusals'] = []; let sourceRows = 0; let pages = 0;
  let nextToken: string | null = null; let complete = false; const seenTokens = new Set<string>();
  let expectedTotal: number | null = null;
  for (; pages < maxPages;) {
    const sb = endpoint.product === 'SB';
    const raw = await transport.read({ scope: input.scope, path: endpoint.path, method: sb ? 'POST' : 'GET',
      mediaType: input.resource === 'sb_creatives' ? 'application/vnd.sbAdCreativeResource.v4+json'
        : sb ? 'application/vnd.sbadresource.v4+json' : 'application/json',
      ...(sb ? { body: { maxResults: pageSize, ...(nextToken ? { nextToken } : {}),
        ...(input.resource === 'sb_creatives' ? { adId: input.adId } : {}) } }
        : { query: { startIndex: String(sourceRows), count: String(pageSize) } }) });
    pages++;
    const rows = sb && isRecord(raw) ? raw[endpoint.key] : raw;
    if (!Array.isArray(rows)) throw new AdsApiParseError('Provider graph response has no entity array');
    const pageOffset = sourceRows; sourceRows += rows.length;
    for (let index = 0; index < rows.length; index++) {
      try { const parsed = parseRow(rows[index], input); observations.push(parsed.observation); associations.push(...parsed.associations); }
      catch (error) {
        const message = error instanceof Error ? error.message : '';
        const reason = message === 'missing_identity' || message === 'wrong_ad' || message === 'invalid_association'
          ? message : 'invalid_row';
        refusals.push({ index: pageOffset + index, reason });
      }
    }
    if (!sb) { if (rows.length < pageSize) { complete = true; break; } continue; }
    if (!isRecord(raw)) throw new AdsApiParseError('Provider graph response has no envelope');
    const total = raw['totalResults'];
    if (total !== undefined) {
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < sourceRows
        || (expectedTotal !== null && expectedTotal !== total)) throw new AdsApiParseError('Provider graph total count changed or is invalid');
      expectedTotal = total;
    }
    const token = raw['nextToken'];
    if (token === undefined || token === null || token === '') { complete = expectedTotal === null || expectedTotal === sourceRows; break; }
    if (typeof token !== 'string' || seenTokens.has(token)) throw new AdsApiParseError('Invalid provider graph continuation');
    seenTokens.add(token); nextToken = token;
  }
  return ProviderGraphReadResult.parse({ observations, associations, sourceRows, parsed: observations.length,
    refusals, pages, completeness: complete && refusals.length === 0 ? 'complete' : 'partial' });
}
