import { createHash } from 'node:crypto';
import { ProviderCollectionConfig, ProviderEvidencePage, ProviderRecommendation, type ProviderEntity, type ProviderEstimate } from '@wizard-ads/shared';
import { PROVIDER_READ_CONTRACTS, type ProviderReadContract, type ProviderWireSchema } from './provider-contracts.js';
import { isRecord } from './read.js';

/** A protocol mismatch never exposes the provider's arbitrary error text. */
export class ProviderEvidenceProtocolError extends Error {
  constructor() { super('Provider evidence response or request does not match the pinned read contract'); }
}
export function providerReadContract(operation: string): ProviderReadContract {
  const contract = PROVIDER_READ_CONTRACTS.find((c) => c.operation === operation);
  if (!contract) throw new ProviderEvidenceProtocolError();
  return contract;
}
export function providerFingerprint(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : isRecord(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

/** Validate the pinned schema, keeping JSON errors out of logs and persistence. */
export function matchesProviderSchema(value: unknown, schema: ProviderWireSchema, depth = 0): boolean {
  if (depth > 30) return false;
  if (value === null) return schema.nullable === true;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.allOf && !schema.allOf.every((s) => matchesProviderSchema(value, s, depth + 1))) return false;
  // Published contracts contain overlapping oneOf branches without discriminators.
  // Require a matching branch; domain mapping remains conservative.
  if ((schema.oneOf ?? schema.anyOf) && !(schema.oneOf ?? schema.anyOf)!.some((s) => matchesProviderSchema(value, s, depth + 1))) return false;
  const type = schema.type ?? (schema.properties || schema.required || schema.additionalProperties ? 'object' : undefined);
  if (type === 'object') {
    if (!isRecord(value) || schema.required?.some((key) => value[key] === undefined)) return false;
    if (typeof schema.additionalProperties === 'object' && !Object.entries(value).every(([k, v]) => schema.properties?.[k] !== undefined || matchesProviderSchema(v, schema.additionalProperties as ProviderWireSchema, depth + 1))) return false;
    return Object.entries(schema.properties ?? {}).every(([key, s]) => value[key] === undefined || matchesProviderSchema(value[key], s, depth + 1));
  }
  if (type === 'array') return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? 10000) && value.every((v) => matchesProviderSchema(v, schema.items ?? {}, depth + 1));
  if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isSafeInteger(value)) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (type === 'string') return typeof value === 'string' && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? 10000);
  if (type === 'boolean') return typeof value === 'boolean';
  return true;
}

/** Allowlisted payload projection. Drop errors, URLs, authorization and unknown fields. */
function project(value: unknown, schema: ProviderWireSchema, depth = 0): unknown {
  if (depth > 30 || value === undefined) return null;
  if (typeof value === 'string') return /https?:\/\/|bearer\s|amzn[._-]|[A-Za-z0-9_+/-]{100,}/i.test(value) ? '[redacted]' : value.slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 10000).map((v) => project(v, schema.items ?? {}, depth + 1));
  if (!isRecord(value)) return value;
  const branches = [...(schema.allOf ?? []), ...(schema.oneOf ?? schema.anyOf ?? []).filter((s) => matchesProviderSchema(value, s))];
  const properties = (s: ProviderWireSchema): Record<string, ProviderWireSchema> => Object.assign({}, ...(s.allOf ?? []).map(properties), s.properties ?? {});
  const props = Object.assign({}, ...branches.map(properties), properties(schema)) as Record<string, ProviderWireSchema>;
  if (typeof schema.additionalProperties === 'object') for (const key of Object.keys(value)) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(key)) throw new ProviderEvidenceProtocolError();
    props[key] ??= schema.additionalProperties;
  }
  return Object.fromEntries(Object.entries(props).filter(([k]) => value[k] !== undefined && !/error|failure|token|url|secret|credential|authorization|cookie|^details$|^description$/i.test(k)).map(([k, s]) => [k, project(value[k], s, depth + 1)]));
}

export function buildProviderEvidenceRequest(raw: ProviderCollectionConfig, nextToken: string | null) {
  const config = ProviderCollectionConfig.parse(raw);
  const contract = providerReadContract(config.operation);
  if (contract.family !== config.family) throw new ProviderEvidenceProtocolError();
  if (contract.path.includes('/global/') && config.scope.countryCode === undefined) throw new ProviderEvidenceProtocolError();
  assertCountryScope(config.request, config.scope.countryCode);
  const body = { ...config.request };
  let path = contract.path;
  const query = new URLSearchParams();
  if (nextToken !== null) {
    // HTTP method does not determine cursor placement: SB Insights is POST/query.
    const cursorNames = ['nextToken', 'nextCursor', 'cursor'];
    const queryCursor = contract.parameters.find((p) => p.location === 'query' && cursorNames.includes(p.name));
    const bodyCursor = cursorNames.find((name) => contract.request.properties?.[name] !== undefined);
    if (queryCursor) body[queryCursor.name] = nextToken;
    else if (bodyCursor) body[bodyCursor] = nextToken;
    else throw new ProviderEvidenceProtocolError();
  }
  for (const param of contract.parameters) {
    const value = body[param.name];
    if (value === undefined) { if (param.required) throw new ProviderEvidenceProtocolError(); continue; }
    if (!matchesProviderSchema(value, param.schema)) throw new ProviderEvidenceProtocolError();
    if (param.location === 'path') path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
    else query.set(param.name, Array.isArray(value) ? value.join(',') : String(value));
    delete body[param.name];
  }
  if (path.includes('{') || !matchesProviderSchema(body, contract.request)) throw new ProviderEvidenceProtocolError();
  return { contract, path: path + (query.size ? `?${query}` : ''), body };
}

/** Global HTTP routes are deliberately limited to one bound country per source. */
function assertCountryScope(value: unknown, country: string | undefined): void {
  if (Array.isArray(value)) { value.forEach((v) => assertCountryScope(v, country)); return; }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (country === undefined && ['countryCode','countryCodes','countryValues','countrySuggestedBids','countryBidAnalyses','countryKeywords'].includes(key)) throw new ProviderEvidenceProtocolError();
    if (country !== undefined) {
      if (key === 'countryCode' && child !== country) throw new ProviderEvidenceProtocolError();
      if (key === 'countryCodes' && Array.isArray(child) && child.some((c) => c !== country)) throw new ProviderEvidenceProtocolError();
      if (['countryCodes','countryValues','countrySuggestedBids','countryBidAnalyses','countryKeywords'].includes(key) && isRecord(child) && Object.keys(child).some((c) => c !== country)) throw new ProviderEvidenceProtocolError();
    }
    assertCountryScope(child, country);
  }
}

const str = (v: unknown): string | null => {
  if (typeof v === 'number') { if (!Number.isSafeInteger(v) || v < 0) throw new ProviderEvidenceProtocolError(); return String(v); }
  if (typeof v !== 'string' || v.length === 0) return null;
  if (/https?:\/\/|bearer\s|[\r\n]/i.test(v) || v.length > 4096) throw new ProviderEvidenceProtocolError();
  return v;
};
const date = (v: unknown): string | null => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;
const scalar = (v: unknown): string | number | null => typeof v === 'string' || typeof v === 'number' && Number.isFinite(v) ? v : null;

function normalize(row: unknown, schema: ProviderWireSchema, config: ProviderCollectionConfig, c: ProviderReadContract, retrievedAt: string): ProviderRecommendation {
  assertCountryScope(row, config.scope.countryCode);
  if (c.path.includes('/global/') && config.scope.countryCode === undefined) throw new ProviderEvidenceProtocolError();
  const projected = project(row, schema);
  const payload = isRecord(projected) ? projected : { value: projected };
  if (Object.keys(payload).length === 0 || payload['value'] === null) throw new ProviderEvidenceProtocolError();
  if (c.family.includes('forecast') && !Object.keys(payload).some((key) => /forecasts/i.test(key))) throw new ProviderEvidenceProtocolError();
  const r = isRecord(row) ? row : {};
  const scope = config.scope;
  if (r['profileId'] !== undefined && r['profileId'] !== scope.amazonProfileId || r['marketplaceId'] !== undefined && r['marketplaceId'] !== scope.marketplaceId) throw new ProviderEvidenceProtocolError();
  const campaignId = str(r['campaignId']) ?? str(config.request['campaignId']);
  const adGroupId = str(r['adGroupId']) ?? str(config.request['adGroupId']);
  if (config.request['campaignId'] !== undefined && campaignId !== str(config.request['campaignId']) || config.request['adGroupId'] !== undefined && adGroupId !== str(config.request['adGroupId'])) throw new ProviderEvidenceProtocolError();
  const filters = Array.isArray(config.request['filters']) ? config.request['filters'].filter(isRecord) : [];
  for (const filter of filters) {
    if (!isRecord(filter)) throw new ProviderEvidenceProtocolError();
    const field = filter['field']; const values = filter['values'];
    const actual = field === 'CAMPAIGN_ID' ? campaignId : field === 'AD_GROUP_ID' ? adGroupId : field === 'AD_PRODUCT' ? r['adProduct'] : field === 'RECOMMENDATION_ID' ? r['recommendationId'] : null;
    if (actual !== null && Array.isArray(values) && (filter['include'] === false ? values.some((value) => value === actual) : !values.some((value) => value === actual))) throw new ProviderEvidenceProtocolError();
  }
  const campaigns = config.request['campaigns'];
  if (campaignId !== null && Array.isArray(campaigns) && campaigns.some((v) => isRecord(v) && v['campaignId'] !== undefined) && !campaigns.some((v) => isRecord(v) && v['campaignId'] === campaignId)) throw new ProviderEvidenceProtocolError();
  const entityId = str(r['targetId']) ?? str(r['keywordId']) ?? str(r['adId']) ?? adGroupId ?? campaignId;
  const adProduct = c.operation.startsWith('sp.') ? 'SP' : c.operation.startsWith('sb.') ? 'SB' : c.operation.startsWith('sd.') ? 'SD' : r['adProduct'];
  if (adProduct !== 'SP' && adProduct !== 'SB' && adProduct !== 'SD') throw new ProviderEvidenceProtocolError();
  if (r['adProduct'] !== undefined && r['adProduct'] !== adProduct) throw new ProviderEvidenceProtocolError();
  const entityType: ProviderEntity['entityType'] = r['targetId'] ? 'target' : r['keywordId'] ? 'keyword' : r['adId'] ? 'creative' : adGroupId ? 'ad-group' : campaignId ? 'campaign' : 'unknown';
  const kind = str(r['recommendationType']) ?? c.operation;
  const action = /forecast/i.test(c.family) ? 'forecast' : /headline/i.test(c.operation) ? 'headline' : /bid/i.test(kind) ? 'bid' : /budget/i.test(kind) ? 'budget' : c.family === 'rule-evidence' ? 'eligibility' : /research/.test(c.family) ? 'research' : 'unknown';
  const estimates: ProviderEstimate[] = [];
  // Preserve scalar estimates and explicit forecast metric ranges; unknown dimensions stay null.
  function collect(v: unknown, path: string, estimated: boolean, horizon: string | null = null) {
    if (estimates.length >= 100) throw new ProviderEvidenceProtocolError();
    if (isRecord(v) && typeof v['timePeriodInDays'] === 'number') horizon = `${v['timePeriodInDays']} days`;
    if (isRecord(v) && typeof v['metric'] === 'string' && isRecord(v['value']) && /forecast/i.test(path)) {
      estimates.push({ label: 'Amazon estimate', metric: v['metric'].slice(0, 256), value: null, low: typeof v['value']['min'] === 'number' ? v['value']['min'] : null, high: typeof v['value']['max'] === 'number' ? v['value']['max'] : null, units: v['metric'].toLowerCase(), currency: null, horizon: /weekly/i.test(path) ? 'weekly' : /daily/i.test(path) ? 'daily' : horizon, attribution: null });
      return;
    }
    if (typeof v === 'number' && estimated) estimates.push({ label: 'Amazon estimate', metric: path.slice(0, 256), value: v, low: null, high: null, units: null, currency: null, horizon, attribution: null });
    else if (isRecord(v)) {
      for (const [k, child] of Object.entries(v)) if (k !== 'timePeriodInDays') collect(child, path ? `${path}.${k}` : k, estimated || /estimated|forecast/i.test(k), horizon);
    } else if (Array.isArray(v)) v.forEach((child, i) => collect(child, `${path}[${i}]`, estimated, horizon));
  }
  collect(payload, '', false);
  const generatedAt = date(r['generatedAt'] ?? r['generationTime'] ?? r['forecastTimestamp']);
  const expiresAt = date(r['expiresAt'] ?? r['expirationDate']);
  const providerId = str(r['recommendationId'] ?? r['headlineId'] ?? r['recId']);
  // Pagination/filter changes must not renew a stable provider observation.
  // ID-less aggregates need request context to distinguish their subjects.
  const version = providerFingerprint({ operation: c.operation, contract: c.contractHash, scope, ...(providerId === null ? { request: config.request } : {}), entityId, campaignId, adGroupId, generatedAt, expiresAt, payload });
  return ProviderRecommendation.parse({ family: config.family, namespace: c.operation, providerId: providerId ?? version, identityMethod: providerId ? 'provider' : 'payload-sha256', version, apiVersion: c.accept, contractHash: c.contractHash, transport: 'http', scope,
    entity: { adProduct, entityType, entityId, campaignId, adGroupId, mapping: 'unresolved' }, kind, action,
    current: { value: scalar(payload['currentValue'] ?? payload['currentBudget'] ?? payload['currentBid']), units: null, currency: null },
    proposed: { value: scalar(payload['recommendedValue'] ?? payload['suggestedBudget'] ?? payload['dailyBudget'] ?? payload['suggestedBid'] ?? payload['headline']), units: null, currency: null },
    estimates, objective: null, horizon: null, attribution: null, eligibility: 'unknown', generatedAt,
    expiresAt, retrievedAt, observedAt: generatedAt ?? retrievedAt, payload,
  });
}

/** Collection grain: top-level list items; aggregate/research/forecast objects remain one evidence envelope. */
export function parseProviderEvidenceResponse(config: ProviderCollectionConfig, value: unknown, retrievedAt: string): ProviderEvidencePage {
  const c = providerReadContract(config.operation);
  let schema = c.response;
  const batchCampaigns = c.operation === 'sb.SBCampaignPerformanceForecasts';
  if (batchCampaigns) {
    if (!isRecord(value) || !isRecord(value['campaigns'])) throw new ProviderEvidenceProtocolError();
    value = value['campaigns']; schema = schema.properties?.['campaigns'] ?? {};
  }
  const envelopeSchema = { ...schema, ...(schema.type === 'array' ? { items: {} } : {}), ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, v.type === 'array' ? { ...v, items: {} } : v])) } : {}) };
  if (!matchesProviderSchema(value, envelopeSchema)) throw new ProviderEvidenceProtocolError();
  const object = isRecord(value) ? value : {};
  let nextToken = str(object['nextToken'] ?? object['nextCursor']);
  if (nextToken !== null && nextToken.length > 4096) throw new ProviderEvidenceProtocolError();
  const rows: ProviderRecommendation[] = [];
  let source = 0; let refused = 0;
  const indexes = new Set<number>();
  const campaignIds = new Set<string>();
  const indexed = Object.values(schema.properties ?? {}).some((s) => s.type === 'array' && s.items?.properties?.['index'] !== undefined);
  const requested = batchCampaigns && Array.isArray(config.request['campaigns']) ? config.request['campaigns'] : Array.isArray(config.request['campaignIds']) ? config.request['campaignIds'] : null;
  // These keyed responses require one success/error per campaign. Paginated
  // campaign recommendation filters can return zero or many rows per campaign.
  const keyedBatch = ['sp.GetOptimizationRuleEligibility', 'sp.GetRuleNotification'].includes(c.operation);
  const reconcileBatch = indexed || keyedBatch;
  const add = (v: unknown, s: ProviderWireSchema, error = false) => {
    source++;
    if (isRecord(v) && v['index'] !== undefined) {
      const i = v['index'];
      if (typeof i !== 'number' || !Number.isSafeInteger(i) || i < 0 || indexes.has(i) || requested !== null && i >= requested.length) throw new ProviderEvidenceProtocolError();
      indexes.add(i);
      if (requested !== null && v['campaignId'] !== undefined && v['campaignId'] !== requested[i]) throw new ProviderEvidenceProtocolError();
    }
    if (requested !== null && !indexed && isRecord(v)) {
      const id = str(v['campaignId']);
      if (id === null || !requested.some((candidate) => str(candidate) === id) || keyedBatch && campaignIds.has(id)) throw new ProviderEvidenceProtocolError();
      campaignIds.add(id);
    }
    if (error) { if (!matchesProviderSchema(v, s)) throw new ProviderEvidenceProtocolError(); refused++; return; }
    try {
      if (!matchesProviderSchema(v, s)) throw new ProviderEvidenceProtocolError();
      const item = batchCampaigns && isRecord(v) ? v['campaign'] : v;
      rows.push(normalize(item, batchCampaigns ? s.properties?.['campaign'] ?? {} : s, config, c, retrievedAt));
    } catch (e) { if (!(e instanceof ProviderEvidenceProtocolError)) throw e; refused++; }
  };
  if (Array.isArray(value)) value.forEach((v) => add(v, schema.items ?? {}));
  else {
    const arrays = Object.entries(schema.properties ?? {}).filter(([key, s]) => s.type === 'array' && Array.isArray(object[key]));
    const errors = arrays.filter(([key]) => /error|failure/i.test(key));
    const successes = arrays.filter(([key]) => !/error|failure/i.test(key));
    // Multiple non-error arrays are different grains; retain them in one envelope.
    if (successes.length === 1 && (errors.length || Object.keys(schema.properties ?? {}).filter((key) => object[key] !== undefined).every((key) => ['nextToken', 'nextCursor', 'previousCursor', 'totalResults', 'totalCount', 'requestId', 'countryCode', successes[0]![0]].includes(key)))) {
      for (const [key, s] of arrays) (object[key] as unknown[]).forEach((v) => add(v, s.items ?? {}, /error|failure/i.test(key)));
    } else if (Object.keys(object).length) add(value, schema);
    else throw new ProviderEvidenceProtocolError();
  }
  if (requested !== null && reconcileBatch && (indexed ? indexes.size : campaignIds.size) !== requested.length) throw new ProviderEvidenceProtocolError();
  if (source > config.maxRows) throw new ProviderEvidenceProtocolError();
  if (nextToken === '') nextToken = null;
  const totals = ['totalResults', 'totalCount'].filter((key) => schema.properties?.[key] !== undefined && object[key] !== undefined).map((key) => object[key]);
  if (totals.some((total) => typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total !== totals[0])) throw new ProviderEvidenceProtocolError();
  return ProviderEvidencePage.parse({ rows, source, refused, expectedTotal: totals[0] ?? null, nextToken, status: refused || object['forecastStatus'] !== undefined && object['forecastStatus'] !== 'COMPLETE' ? 'partial' : 'complete' });
}
