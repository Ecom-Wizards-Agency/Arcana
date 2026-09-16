import { CampaignCreationBatchObservation, type CampaignCreationSha256Hasher } from '@wizard-ads/shared';
import { SP_WRITE_ENDPOINTS } from './endpoints.js';
import { identity, JsonNumber, object, parse, type JsonObject } from './sp-creation-json.js';
import { compareSpCreationResource } from './sp-creation-readback.js';
import type { SpCreationCompiledCall } from './sp-creation-codec.js';

/** Private protocol boundary. A complete scan is required before absence or uniqueness is evidence. */
export function spCreationIdentityQuery(call: SpCreationCompiledCall, providerEntityId: string | null) {
  const endpoint = SP_WRITE_ENDPOINTS[call.kind];
  const item = (JSON.parse(call.body) as Record<string, Record<string, unknown>[]>)[endpoint.requestKey]![0]!;
  let keys: Record<string, string>;
  let filters: Record<string, unknown>;
  const exact = (text: string) => ({ include: [text], queryTermMatchType: 'EXACT_MATCH' });
  const text = (key: string) => {
    const value = item[key];
    if (typeof value !== 'string' || !value) throw new Error('Creation identity unavailable');
    return value;
  };
  const idKey = call.kind === 'campaigns' ? 'campaignId' : call.kind === 'adGroups' ? 'adGroupId'
    : call.kind === 'productAds' ? 'adId' : 'keywordId';
  if (providerEntityId !== null) {
    keys = { [idKey]: providerEntityId };
    filters = { [endpoint.idFilterKey]: { include: [providerEntityId] } };
  } else if (call.kind === 'campaigns') {
    keys = { name: text('name') }; filters = { nameFilter: exact(keys.name!) };
  } else if (call.kind === 'adGroups') {
    keys = { campaignId: text('campaignId'), name: text('name') };
    filters = { campaignIdFilter: { include: [keys.campaignId] }, nameFilter: exact(keys.name!) };
  } else if (call.kind === 'productAds') {
    const product = typeof item.sku === 'string' ? 'sku' : 'asin';
    keys = { adGroupId: text('adGroupId'), [product]: text(product) };
    filters = { adGroupIdFilter: { include: [keys.adGroupId] } };
  } else if (call.kind === 'keywords') {
    keys = { adGroupId: text('adGroupId'), keywordText: text('keywordText'), matchType: text('matchType') };
    filters = { adGroupIdFilter: { include: [keys.adGroupId] }, keywordTextFilter: exact(keys.keywordText!),
      matchTypeFilter: [keys.matchType] };
  } else throw new Error('Unsupported creation discovery');
  return { item, keys, idKey, path: `${endpoint.path}/list`, responseKey: endpoint.responseKey,
    body: { ...filters, stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 100,
      includeExtendedDataFields: true } };
}

export async function discoverSpCreation(call: SpCreationCompiledCall, providerEntityId: string | null,
  options: { now(): number; hasher: CampaignCreationSha256Hasher;
    read(path: string, body: string, remainingMs: number): Promise<{ status: number; body: Uint8Array }> }): Promise<CampaignCreationBatchObservation> {
  const query = spCreationIdentityQuery(call, providerEntityId);
  const started = options.now(); const deadline = started + 30_000;
  const tokens = new Set<string>(); const ids = new Set<string>();
  const matches: JsonObject[] = []; const digests: string[] = [];
  let pages = 0, loaded = 0, parsed = 0;
  let total: number | undefined; let token: string | undefined;
  let complete = false;
  let reason: string | null;
  try {
    do {
      if (pages >= 100 || options.now() >= deadline) throw new Error('Identity pagination did not finish.');
      const body = JSON.stringify({ ...query.body, ...(token ? { nextToken: token } : {}) });
      const response = await options.read(query.path, body, Math.max(1, deadline - options.now()));
      pages += 1; digests.push(options.hasher.digest(JSON.stringify([body, response.status, Array.from(response.body)])));
      if (response.status !== 200) throw new Error('The identity read failed; absence is not established.');
      const root = parse(response.body);
      if (!object(root) || Object.keys(root).some((key) => ![query.responseKey, 'nextToken', 'totalResults'].includes(key))) throw new Error('The identity response is invalid.');
      const rows = root[query.responseKey];
      if (!Array.isArray(rows)) throw new Error('The identity response has no complete resource list.');
      loaded += rows.length;
      for (const row of rows) {
        if (!object(row) || !identity(row[query.idKey]) || Object.keys(query.keys).some((key) => typeof row[key] !== 'string')) {
          throw new Error('A listed resource has an invalid identity.');
        }
        const id = row[query.idKey] as string;
        if (ids.has(id)) throw new Error('Identity pagination repeated a resource.');
        ids.add(id); parsed += 1;
        if (Object.entries(query.keys).every(([key, value]) => row[key] === value)) matches.push(row);
      }
      if (root.totalResults !== undefined) {
        if (!(root.totalResults instanceof JsonNumber) || !/^\d+$/.test(root.totalResults.source)) throw new Error('The identity response count is invalid.');
        const current = Number(root.totalResults.source);
        if (!Number.isSafeInteger(current) || (total !== undefined && total !== current)) throw new Error('Identity pagination changed its total count.');
        total = current;
      }
      if (root.nextToken !== undefined && typeof root.nextToken !== 'string') throw new Error('The identity pagination token is invalid.');
      token = root.nextToken as string | undefined;
      if (token) {
        if (tokens.has(token)) throw new Error('Identity pagination repeated a token.');
        tokens.add(token);
      }
    } while (token);
    if (total !== undefined && total !== loaded) throw new Error('Listed and reported identity counts disagree.');
    complete = true; reason = null;
  } catch (error) {
    reason = error instanceof Error && /^(?:Identity |The identity |A listed |Listed and )/.test(error.message)
      ? error.message : 'The identity read failed; absence is not established.';
  }
  let observation: CampaignCreationBatchObservation['observation'] = 'pending';
  let foundId = providerEntityId;
  if (complete) {
    if (matches.length === 0) { observation = 'not_found'; reason = 'No resource matched the exact identity in this complete observation.'; }
    else if (matches.length > 1) { observation = 'ambiguous_readback'; foundId = null; reason = 'More than one resource matched the exact identity. Creation is refused.'; }
    else {
      foundId = matches[0]![query.idKey] as string;
      observation = compareSpCreationResource(call.kind, query.item, matches[0]!);
      reason = observation === 'observed' ? null : observation === 'conflict'
        ? 'The exact resource exists, but its configuration differs from the approved draft.'
        : 'The exact resource exists, but its configuration could not be verified.';
    }
  }
  return CampaignCreationBatchObservation.parse({ id: crypto.randomUUID(), mode: providerEntityId === null ? 'identity' : 'provider_id',
    identityFingerprint: options.hasher.digest(JSON.stringify([call.providerScope, call.kind, query.keys])),
    requestDigest: call.requestDigest, responseDigest: options.hasher.digest(JSON.stringify(digests)),
    providerEntityId: foundId, observation, complete, reason, startedAt: new Date(started).toISOString(),
    observedAt: new Date(Math.max(started, options.now())).toISOString(), accounting: { pages, loaded, parsed, matched: matches.length } });
}
