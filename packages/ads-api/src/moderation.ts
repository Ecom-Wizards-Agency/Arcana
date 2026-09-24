/** Moderation v4, Unified Pre-moderation v1 and SD v3 public OpenAPI boundaries. */
import { AssetModerationContext, AssetModerationObservation, type AssetModerationStatus } from '@wizard-ads/shared';
import { ScopedAssetHttp, type AssetLibraryClientOptions } from './asset-library.js';
import { AdsApiParseError } from './errors.js';
import { isRecord } from './read.js';

export const MODERATION_RESULTS_PATH = '/moderation/results';
export const SD_MODERATION_PATH = '/sd/moderation/creatives';
export const PRE_MODERATION_COLLECTION = Object.freeze({
  supported: false, reason: 'The documented /preModeration operation submits validation; no read-only status operation is documented.',
});
const fail = (message: string): never => { throw new AdsApiParseError(message); };
function record(raw: unknown) { return isRecord(raw) ? raw : fail('Moderation response object missing'); }
function id(raw: unknown): string {
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) return String(raw);
  return fail('Moderation identity missing or unsafe');
}
function token(raw: unknown): string | null { return raw == null || raw === '' ? null : typeof raw === 'string' ? raw : fail('Moderation continuation invalid'); }
function array(raw: unknown): unknown[] { return Array.isArray(raw) ? raw : fail('Moderation results missing'); }
/** Provider wording survives; operational identifiers, links, emails and credential material do not. */
export function sanitizeModerationReason(value: string, identifiers: readonly string[] = []): string {
  let result = value.replace(/https?:\/\/[^\s<>]+/gi, '[redacted URL]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted email]')
    .replace(/\b(?:bearer\s+)[^\s,;]+/gi, '[redacted credential]')
    .replace(/\b(?:token|secret|password|authorization|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[redacted credential]')
    .replace(/\b(?:amzn1\.[A-Za-z0-9_.:-]+|[A-Z0-9]{20,})\b/g, '[redacted identifier]');
  for (const identifier of [...identifiers].filter((item) => item.length >= 3).sort((a,b) => b.length-a.length)) result = result.split(identifier).join('[redacted identifier]');
  return [...result].filter((character) => { const code = character.charCodeAt(0); return code >= 32 || code === 9 || code === 10 || code === 13; }).join('').slice(0, 4000);
}
function reasons(raw: unknown, identifiers: string[]): string[] {
  if (raw == null) return [];
  return array(raw).flatMap((item) => {
    const row = record(item); const description = row['policyDescription'] ?? row['specDescription'];
    return description == null ? [] : typeof description === 'string'
      ? [sanitizeModerationReason(description, identifiers)] : fail('Moderation reason is invalid');
  });
}
function status(raw: unknown): AssetModerationStatus {
  switch (raw) {
    case 'APPROVED': return 'approved';
    case 'REJECTED': return 'rejected';
    case 'IN_PROGRESS': case 'PENDING_REVIEW': return 'pending';
    default: return 'unknown';
  }
}
export interface ModerationReadResult {
  observations: AssetModerationObservation[];
  counts: { pages: number; received: number; parsed: number; refused: number; returned: number; requested?: number; missing?: number };
}
const programs = ['SB_PRODUCT_COLLECTION', 'SB_STORE_SPOTLIGHT', 'SB_VIDEO', 'SPONSORED_DISPLAY', 'SPONSORED_PRODUCTS'];
export class ModerationClient {
  private readonly http: ScopedAssetHttp;
  constructor(private readonly options: AssetLibraryClientOptions) { this.http = new ScopedAssetHttp(options); }
  private context(input: AssetModerationContext) {
    const context = AssetModerationContext.parse(input);
    if (context.scope.region !== this.http.scope.region || context.scope.amazonProfileId !== this.http.scope.amazonProfileId) return fail('Moderation scope mismatch');
    return context;
  }
  async readAd(input: { context: AssetModerationContext; adId: string; adVersion: string }): Promise<ModerationReadResult> {
    const context = this.context(input.context);
    if (!programs.includes(context.program)) return fail('Unsupported moderation program');
    const observations: AssetModerationObservation[] = []; const identities = new Set<string>(); const tokens = new Set<string>();
    const observedAt = new Date(this.options.now()).toISOString(); let nextToken: string | null = null; let pages = 0; let received = 0;
    do {
      if (pages >= 100) return fail('Moderation traversal exceeded bound');
      const result = await this.http.request('POST', MODERATION_RESULTS_PATH,
        { adProgramType: context.program, id: id(input.adId), idType: 'AD_ID', maxResults: 10,
          versionIdFilter: [id(input.adVersion)], ...(nextToken === null ? {} : { nextToken }) },
        'application/vnd.moderationresultsresponse.v4.0+json', 'application/vnd.moderationresultsrequest.v4.1+json');
      if (result.status !== 200) return fail('Moderation read refused');
      const envelope = record(result.raw); const rows = array(envelope['moderationResults']); pages++; received += rows.length;
      for (const raw of rows) {
        const row = record(raw); const adId = id(row['id']); const adVersion = id(row['versionId']);
        if (adId !== input.adId || adVersion !== input.adVersion || row['idType'] !== 'AD_ID' || identities.has(`${adId}:${adVersion}`)) return fail('Moderation response identity mismatch');
        identities.add(`${adId}:${adVersion}`);
        observations.push(AssetModerationObservation.parse({ context, subject: { kind: 'ad', adId, adVersion }, assetIdentity: null,
          stage: 'final', source: 'moderation_v4', status: status(row['moderationStatus']),
          reasons: reasons(row['policyViolations'], [adId, adVersion, context.scope.amazonProfileId]), observedAt, contractVersion: 'wp313.v1' }));
      }
      nextToken = token(envelope['nextToken']);
      if (nextToken !== null && (tokens.has(nextToken) || rows.length === 0)) return fail('Moderation continuation repeated or empty');
      if (nextToken !== null) tokens.add(nextToken);
    } while (nextToken !== null);
    return { observations, counts: { pages, received, parsed: observations.length, refused: 0, returned: observations.length } };
  }
  async readSd(input: { context: AssetModerationContext; creativeIds: readonly string[]; language: string }): Promise<ModerationReadResult> {
    const context = this.context(input.context);
    if (context.program !== 'SPONSORED_DISPLAY' || input.creativeIds.length === 0 || new Set(input.creativeIds).size !== input.creativeIds.length
      || !/^[a-z]{2}[-_][A-Z]{2}$/.test(input.language)) return fail('Invalid SD moderation request');
    const expected = new Set(input.creativeIds.map(id)); const seen = new Set<string>(); const observations: AssetModerationObservation[] = [];
    const observedAt = new Date(this.options.now()).toISOString(); let pages = 0; let received = 0;
    for (;;) {
      if (pages >= 1000) return fail('SD moderation traversal exceeded bound');
      const query = new URLSearchParams({ language: input.language, startIndex: String(received), count: '100', creativeIdFilter: [...expected].join(',') });
      const result = await this.http.request('GET', `${SD_MODERATION_PATH}?${query}`);
      if (result.status !== 200) return fail('SD moderation read refused');
      const rows = array(result.raw); pages++; received += rows.length;
      for (const raw of rows) {
        const row = record(raw); const creativeId = id(row['creativeId']);
        if (!expected.has(creativeId) || seen.has(creativeId)) return fail('SD moderation identity mismatch');
        seen.add(creativeId);
        observations.push(AssetModerationObservation.parse({ context, subject: { kind: 'creative', creativeId, creativeVersion: null },
          assetIdentity: null, stage: 'final', source: 'sd_moderation', status: status(row['moderationStatus']),
          reasons: reasons(row['policyViolations'], [creativeId, context.scope.amazonProfileId]), observedAt, contractVersion: 'wp313.v1' }));
      }
      if (rows.length < 100) break;
    }
    // Requested identities and returned source rows have different grains.
    return { observations, counts: { pages, received, parsed: observations.length, refused: 0,
      returned: observations.length, requested: expected.size, missing: expected.size-seen.size } };
  }
}
/** Ingest an already authorized response. There is deliberately no POST submission method. */
export function parsePreModerationEvidence(raw: unknown, input: {
  context: AssetModerationContext; locale: string;
  components: readonly { kind: 'image' | 'video'; id: string; componentType: string }[]; observedAt: string;
}): ModerationReadResult {
  const context = AssetModerationContext.parse(input.context); const row = record(raw);
  const allowed = ['SPONSORED_BRANDS', 'SPONSORED_BRANDS_SPOTLIGHT', 'SPONSORED_BRANDS_VIDEO', 'SPONSORED_DISPLAY', 'SPONSORED_DISPLAY_NOT_SOLD_ON_AMAZON'];
  if (!allowed.includes(context.program) || row['adProgram'] !== context.program || row['locale'] !== input.locale) return fail('Pre-moderation context mismatch');
  const requestId = id(row['preModerationId']); const expected = new Map(input.components.map((item) => [`${item.kind}:${item.id}`, item]));
  if (expected.size !== input.components.length || expected.size === 0) return fail('Pre-moderation input identity mismatch');
  const seen = new Set<string>(); const observations: AssetModerationObservation[] = [];
  for (const kind of ['image', 'video'] as const) {
    const rows = row[`${kind}Components`] == null ? [] : array(row[`${kind}Components`]);
    for (const rawItem of rows) {
      const item = record(rawItem); const componentId = id(item['id']); const key = `${kind}:${componentId}`;
      if (!expected.has(key) || seen.has(key) || item['componentType'] !== expected.get(key)!.componentType) return fail('Pre-moderation component mismatch');
      seen.add(key);
      observations.push(AssetModerationObservation.parse({ context, subject: { kind: 'component', componentId, requestId }, assetIdentity: null,
        stage: 'pre_moderation', source: 'unified_pre_moderation_v1', status: status(item['preModerationStatus']),
        reasons: [...reasons(item['policyViolations'], [componentId, requestId]), ...reasons(item['specViolations'], [componentId, requestId])],
        observedAt: input.observedAt, contractVersion: 'wp313.v1' }));
    }
  }
  if (seen.size !== expected.size) return fail('Pre-moderation component count mismatch');
  for (const key of ['asinComponents','dateComponents','textComponents','thirdPartyComponents','urlComponents']) {
    if (row[key] !== undefined && array(row[key]).length > 0) return fail('Unsupported pre-moderation components');
  }
  return { observations, counts: { pages: 1, received: seen.size, parsed: seen.size, refused: 0, returned: seen.size } };
}
