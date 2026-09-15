/** Asset Library v3. Public OpenAPI contract; all effects are explicitly injected. */
import { createHash } from 'node:crypto';
import {
  AssetLibraryBatchStatus, AssetLibraryObservation, AssetLibraryRegistration,
  AssetLibraryRegistrationOutcome, AssetLibraryScope, AssetLibrarySearchRequest,
  AssetLibrarySearchResult, AssetLibraryUploadManifest,
  type AssetLibraryIdentity,
} from '@wizard-ads/shared/asset-library';
import { hostFor } from './regions.js';
import { AdsApiParseError } from './errors.js';
import { httpRequestOnce, HttpAttemptError, type HeaderFactory } from './http.js';
import type { FetchLike } from './types.js';
import { isRecord } from './read.js';

export const ASSET_LIBRARY_CONTRACT = 'creative-assets.v3' as const;
export interface AssetLibraryClientOptions {
  scope: AssetLibraryScope;
  fetch: FetchLike;
  headers: HeaderFactory;
  now: () => number;
  /** Exact reviewed storage origins. Empty by default; never inferred from a response URL. */
  uploadOrigins?: readonly string[];
}

/** Shared package-internal scoped transport; one attempt, sanitized errors, no write retries. */
export class ScopedAssetHttp {
  readonly scope: AssetLibraryScope;
  constructor(readonly options: AssetLibraryClientOptions) { this.scope = AssetLibraryScope.parse(options.scope); }
  async request(method: 'GET' | 'POST', path: string, body?: unknown, accept = 'application/json', contentType = 'application/json') {
    const response = await httpRequestOnce({ fetch: this.options.fetch }, {
      method, url: `${hostFor(this.scope.region)}${path}`, redirect: 'error', maxResponseBytes: 8 * 1024 * 1024,
      headers: async (force, signal) => {
        const headers = await this.options.headers(force, signal);
        const normalized = new Headers(headers);
        if (normalized.get('Amazon-Advertising-API-Scope') !== this.scope.amazonProfileId) throw new Error('Asset scope mismatch');
        normalized.set('Accept', accept);
        if (body !== undefined) normalized.set('Content-Type', contentType);
        return Object.fromEntries(normalized.entries());
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let raw: unknown = null;
    if (response.status === 200) {
      try { raw = JSON.parse(new TextDecoder().decode(response.body)); }
      catch { throw new AdsApiParseError('Asset response is not JSON'); }
    }
    return { status: response.status, raw };
  }
}
const fail = (message: string): never => { throw new AdsApiParseError(message); };
function record(raw: unknown): Record<string, unknown> { return isRecord(raw) ? raw : fail('Asset response object missing'); }
function text(row: Record<string, unknown>, key: string): string {
  const value = row[key]; return typeof value === 'string' && value.length > 0 ? value : fail(`Asset response ${key} missing`);
}
function array(row: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(row[key]) ? row[key] : fail(`Asset response ${key} missing`);
}
const optionalText = (row: Record<string, unknown>, key: string) => row[key] == null ? null : text(row, key);
function optionalNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return value == null ? null : typeof value === 'number' && Number.isFinite(value) ? value : fail('Invalid asset media number');
}
function checks(raw: unknown) {
  if (raw == null) return null;
  if (!Array.isArray(raw)) return fail('Asset checks are not an array');
  return raw.map((item) => {
    const row = record(item);
    return { program: text(row, 'specProgramName'), specifications: array(row, 'specifications').map((item) => {
      const spec = record(item);
      if (typeof spec['isPassed'] !== 'boolean') return fail('Asset check outcome missing');
      return { stringId: optionalText(spec, 'stringId'), passed: spec['isPassed'] };
    }) };
  });
}
function observation(raw: unknown, scope: AssetLibraryScope, observedAt: string): AssetLibraryObservation {
  const row = record(raw);
  const metadata = row['fileMetadata'] == null ? {} : record(row['fileMetadata']);
  const state = optionalText(row, 'status')?.toLowerCase();
  const type = optionalText(row, 'assetType')?.toLowerCase();
  return AssetLibraryObservation.parse({ scope, identity: { assetId: text(row, 'assetId'), version: text(row, 'version') }, observedAt,
    name: optionalText(row, 'name'), assetType: type === 'image' || type === 'video' ? type : 'unknown',
    processing: state === 'active' || state === 'processing' || state === 'archived' || state === 'inactive' ? state : 'unknown',
    specChecks: { approvedPrograms: row['specCheckApprovedPrograms'] ?? null, failedSpecChecks: checks(row['failedSpecChecks']) },
    mediaMetadata: { byteLength: optionalNumber(metadata, 'fileSize'), contentType: optionalText(metadata, 'contentType'),
      width: optionalNumber(metadata, 'width') ?? optionalNumber(metadata, 'resolutionWidth'),
      height: optionalNumber(metadata, 'height') ?? optionalNumber(metadata, 'resolutionHeight'), durationSeconds: optionalNumber(metadata, 'duration') },
  });
}
/** Opaque, transient handle. Its signed URL never appears in serialized outcomes. */
export interface AssetLibraryUploadedContent { readonly manifest: AssetLibraryUploadManifest }
interface UploadState { url: string; expiresAt: number; attempted: boolean; outcome?: AssetLibraryRegistrationOutcome }
export type AssetLibraryUploadOutcome = { kind: 'uploaded'; content: AssetLibraryUploadedContent }
  | { kind: 'not_attempted'; reason: 'invalid_input' | 'upload_origin_not_allowed' }
  | { kind: 'uncertain'; reason: 'upload_failed' };
export type AssetLibraryBatchStart = { kind: 'accepted'; requestId: string; submitted: number }
  | { kind: 'uncertain'; submitted: number } | { kind: 'not_attempted'; submitted: number };

export class AssetLibraryClient {
  get scope(): AssetLibraryScope { return this.http.scope; }
  private readonly http: ScopedAssetHttp;
  private readonly uploads = new WeakMap<AssetLibraryUploadedContent, UploadState>();
  private readonly batches = new Map<string, { urls: string[]; submitted: number }>();
  constructor(private readonly options: AssetLibraryClientOptions) { this.http = new ScopedAssetHttp(options); }
  async search(request: AssetLibrarySearchRequest): Promise<AssetLibrarySearchResult> {
    const input = AssetLibrarySearchRequest.parse(request);
    const { pageSize, ...filters } = input;
    const assets: AssetLibraryObservation[] = [];
    const seen = new Set<string>(); let token: string | null = null; let total: number | null = null; let pages = 0;
    const observedAt = new Date(this.options.now()).toISOString();
    do {
      if (pages >= 1000) return fail('Asset search exceeded bounded traversal');
      const { status, raw } = await this.http.request('POST', '/assets/search', { ...filters,
        pageCriteria: { size: pageSize, ...(token === null ? {} : { identifier: { pageNumber: pages, token } }) } },
      'application/vnd.creativeassetssearchassetsresponse.v3+json');
      if (status !== 200) return fail('Asset search refused');
      const row = record(raw); const rows = array(row, 'assetList'); const count = row['totalRecords'];
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || (total !== null && count !== total)) return fail('Asset search count changed');
      total = count; pages++;
      assets.push(...rows.map((item) => observation(item, this.http.scope, observedAt)));
      token = optionalText(row, 'token');
      if (token !== null && (seen.has(token) || rows.length === 0)) return fail('Asset search continuation repeated or empty');
      if (token !== null) seen.add(token);
    } while (token !== null);
    return AssetLibrarySearchResult.parse({ scope: this.http.scope, assets,
      counts: { pages, providerRows: assets.length, returnedRows: assets.length, totalRecords: total } });
  }
  async lookup(identity: AssetLibraryIdentity): Promise<AssetLibraryObservation> {
    const query = new URLSearchParams({ assetId: identity.assetId, version: identity.version });
    const { status, raw } = await this.http.request('GET', `/assets?${query}`, undefined, 'application/vnd.creativeassetsgetresponse.v3+json');
    if (status !== 200) return fail('Asset lookup refused');
    const row = record(raw); const global = record(row['assetGlobal']); const versions = array(row, 'assetVersionList');
    if (text(global, 'assetId') !== identity.assetId || versions.length !== 1) return fail('Asset exact lookup identity mismatch');
    const version = record(versions[0]); const identifier = record(version['assetIdentifier']);
    if (text(identifier, 'assetId') !== identity.assetId || text(identifier, 'version') !== identity.version) return fail('Asset exact lookup version mismatch');
    return observation({ ...version, assetId: identity.assetId, version: identity.version,
      assetType: global['assetType'], status: version['assetStatus'] }, this.http.scope, new Date(this.options.now()).toISOString());
  }
  async upload(manifest: AssetLibraryUploadManifest, bytes: Uint8Array): Promise<AssetLibraryUploadOutcome> {
    if (!validateAssetLibraryUpload(manifest, bytes)) return { kind: 'not_attempted', reason: 'invalid_input' };
    if (!this.options.uploadOrigins?.length) return { kind: 'not_attempted', reason: 'upload_origin_not_allowed' };
    const expiresAt = this.options.now() + 15 * 60 * 1000;
    try {
      const result = await this.http.request('POST', '/assets/upload', { fileName: manifest.fileName }, 'application/vnd.creativeassetsuploadresponse.v3+json');
      if (result.status !== 200) return { kind: 'uncertain', reason: 'upload_failed' };
      const url = text(record(result.raw), 'url'); const target = new URL(url);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash || !this.options.uploadOrigins.includes(target.origin)) {
        return { kind: 'not_attempted', reason: 'upload_origin_not_allowed' };
      }
      const upload = await httpRequestOnce({ fetch: this.options.fetch }, { method: 'PUT', url, redirect: 'error', maxResponseBytes: 0,
        headers: async () => ({ 'Content-Type': manifest.contentType }), body: Uint8Array.from(bytes).buffer });
      if (upload.status < 200 || upload.status >= 300) return { kind: 'uncertain', reason: 'upload_failed' };
      const content = Object.freeze({ manifest: Object.freeze({ ...manifest }) });
      this.uploads.set(content, { url, expiresAt, attempted: false });
      return { kind: 'uploaded', content };
    } catch { return { kind: 'uncertain', reason: 'upload_failed' }; }
  }
  async register(content: AssetLibraryUploadedContent, registration: AssetLibraryRegistration): Promise<AssetLibraryRegistrationOutcome> {
    const scope = this.http.scope; const state = this.uploads.get(content);
    if (state?.outcome !== undefined) return state.outcome;
    const parsed = AssetLibraryRegistration.safeParse(registration);
    if (!state || state.attempted || state.expiresAt <= this.options.now() || !parsed.success
      || (registration.assetType === 'VIDEO') !== (content.manifest.contentType === 'video/mp4')) {
      return { kind: 'not_attempted', scope, reason: 'invalid_input' };
    }
    state.attempted = true;
    try {
      const { status, raw } = await this.http.request('POST', '/assets/register', registrationBody(parsed.data, state.url),
        'application/vnd.creativeassetsregisterresponse.v3+json');
      if ([400, 401, 403, 404, 429].includes(status)) return state.outcome = AssetLibraryRegistrationOutcome.parse({ kind: 'refused', scope, status });
      if (status !== 200) return state.outcome = { kind: 'uncertain', scope, reason: 'unexpected_status' };
      const row = record(raw);
      return state.outcome = AssetLibraryRegistrationOutcome.parse({ kind: 'accepted', scope,
        identity: { assetId: text(row, 'assetId'), version: text(row, 'versionId') }, failedSpecChecks: checks(row['failedSpecChecks']) });
    } catch (error) {
      return state.outcome = error instanceof HttpAttemptError
        ? error.phase === 'headers' ? { kind: 'not_attempted', scope, reason: 'headers_failed' }
          : { kind: 'uncertain', scope, reason: error.phase === 'body' ? 'body_failed' : 'transport_failed' }
        : { kind: 'uncertain', scope, reason: 'invalid_response' };
    }
  }
  async startBatch(inputs: readonly { content: AssetLibraryUploadedContent; registration: AssetLibraryRegistration }[]): Promise<AssetLibraryBatchStart> {
    const submitted = inputs.length; const states = inputs.map((item) => this.uploads.get(item.content));
    if (submitted < 1 || submitted > 50 || new Set(inputs.map((item) => item.content)).size !== submitted
      || states.some((state) => !state || state.attempted || state.expiresAt <= this.options.now())
      || inputs.some((item) => !AssetLibraryRegistration.safeParse(item.registration).success
        || item.registration.brandEntityIds !== undefined
        || (item.registration.assetType === 'VIDEO') !== (item.content.manifest.contentType === 'video/mp4'))) return { kind: 'not_attempted', submitted };
    const urls = states.map((state) => state!.url);
    states.forEach((state) => { state!.attempted = true; });
    try {
      const { status, raw } = await this.http.request('POST', '/assets/batchRegister', { assetDetailsList: inputs.map((item, index) => {
        const body = registrationBody(item.registration, urls[index]!); const { tags, ...rest } = body;
        return { ...rest, ...(tags === undefined ? {} : { tagList: tags }) };
      }) }, 'application/vnd.assetsbatchregisterresponse.v1+json', 'application/vnd.assetsbatchregisterrequest.v1+json');
      if (status !== 200) return { kind: 'uncertain', submitted };
      const requestId = text(record(raw), 'requestId');
      if (this.batches.has(requestId)) return { kind: 'uncertain', submitted };
      this.batches.set(requestId, { urls, submitted }); return { kind: 'accepted', requestId, submitted };
    } catch { return { kind: 'uncertain', submitted }; }
  }
  async batchStatus(requestId: string): Promise<AssetLibraryBatchStatus> {
    const batch = this.batches.get(requestId);
    if (!batch) return fail('Batch ownership is unknown');
    const { status, raw } = await this.http.request('GET', `/assets/batchRegister/${encodeURIComponent(requestId)}`, undefined,
      'application/vnd.creativeassetsgetbatchregisterresponse.v3+json');
    if (status !== 200) return fail('Batch status refused');
    const row = record(raw);
    const items: AssetLibraryBatchStatus['items'] = [];
    for (const [key, kind] of [['successfullyRegisteredAssets', 'accepted'], ['inProgressAssetDetails', 'processing'], ['failedAssetDetails', 'refused']] as const) {
      for (const rawItem of array(row, key)) {
        const item = record(rawItem); const index = batch.urls.indexOf(text(item, 'url'));
        if (index < 0) return fail('Batch returned an unrequested asset');
        if (kind === 'accepted') {
          const identity = record(item['assetIdentifier']);
          items.push({ index, kind, identity: { assetId: text(identity, 'assetId'), version: text(identity, 'version') } });
        } else items.push({ index, kind });
      }
    }
    return AssetLibraryBatchStatus.parse({ scope: this.http.scope, requestId, status: text(row, 'registrationStatus').toLowerCase(), items,
      counts: { submitted: batch.submitted, accepted: items.filter((item) => item.kind === 'accepted').length,
        processing: items.filter((item) => item.kind === 'processing').length, refused: items.filter((item) => item.kind === 'refused').length } });
  }
}
function registrationBody(input: AssetLibraryRegistration, url: string): Record<string, unknown> {
  return { url, name: input.name, assetType: input.assetType, assetSubTypeList: input.assetSubTypes,
    ...(input.asins === undefined ? {} : { asinList: input.asins }), ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.linkedVersion === undefined ? {} : { versionInfo: { linkedAssetId: input.linkedVersion.assetId, versionNotes: input.linkedVersion.notes } }),
    ...(input.brandEntityIds === undefined ? {} : { associatedSubEntityList: input.brandEntityIds.map((brandEntityId) => ({ brandEntityId })) }),
    ...(input.skipSubtypeDetection === undefined ? {} : { skipAssetSubTypesDetection: input.skipSubtypeDetection }) };
}
function validMedia(input: AssetLibraryUploadManifest, bytes: Uint8Array): boolean {
  const extension = input.fileName.split('.').at(-1)?.toLowerCase();
  if (input.contentType === 'image/png') return extension === 'png' && bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((value, index) => bytes[index] === value);
  if (input.contentType === 'image/jpeg') return (extension === 'jpg' || extension === 'jpeg') && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return extension === 'mp4' && bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4,8)) === 'ftyp';
}

export function validateAssetLibraryUpload(manifest: AssetLibraryUploadManifest, bytes: Uint8Array): boolean {
  return AssetLibraryUploadManifest.safeParse(manifest).success && bytes.length===manifest.byteLength
    && createHash('sha256').update(bytes).digest('hex')===manifest.sha256 && validMedia(manifest,bytes);
}
