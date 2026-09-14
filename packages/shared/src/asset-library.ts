import { z } from 'zod';
import { AmazonId, Region } from './primitives.js';

/** Amazon scope; server authentication must resolve this from the operator's profile. */
export const AssetLibraryScope = z.object({
  region: Region,
  amazonProfileId: z.string().regex(/^\d+$/),
}).strict();
export type AssetLibraryScope = z.infer<typeof AssetLibraryScope>;

export const AssetLibraryIdentity = z.object({ assetId: AmazonId, version: z.string().min(1) }).strict();
export type AssetLibraryIdentity = z.infer<typeof AssetLibraryIdentity>;

/** ACTIVE is processing evidence, not permission to serve an ad. */
export const AssetLibraryProcessing = z.enum(['active', 'processing', 'archived', 'inactive', 'unknown']);
export type AssetLibraryProcessing = z.infer<typeof AssetLibraryProcessing>;

const ProgramIdentifier = z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(200);
export const AssetLibraryProgramSpecifications = z.object({
  program: ProgramIdentifier,
  specifications: z.array(z.object({
    stringId: ProgramIdentifier.nullable(),
    passed: z.boolean(),
  }).strict()),
}).strict();
export type AssetLibraryProgramSpecifications = z.infer<typeof AssetLibraryProgramSpecifications>;

/** Missing evidence remains null. These checks are separate from creative moderation. */
export const AssetLibrarySpecChecks = z.object({
  approvedPrograms: z.array(ProgramIdentifier).nullable(),
  failedSpecChecks: z.array(AssetLibraryProgramSpecifications).nullable(),
}).strict();
export type AssetLibrarySpecChecks = z.infer<typeof AssetLibrarySpecChecks>;

/** No source URLs, upload URLs, arbitrary provider metadata or raw errors are retained. */
export const AssetLibraryObservation = z.object({
  scope: AssetLibraryScope,
  identity: AssetLibraryIdentity,
  observedAt: z.iso.datetime(),
  assetType: z.enum(['image', 'video', 'unknown']),
  name: z.string().nullable(),
  processing: AssetLibraryProcessing,
  specChecks: AssetLibrarySpecChecks,
}).strict();
export type AssetLibraryObservation = z.infer<typeof AssetLibraryObservation>;

export const AssetLibrarySearchRequest = z.object({
  text: z.string().optional(),
  filterCriteria: z.object({
    valueFilters: z.array(z.object({
      valueField: z.enum(['TAG', 'ASIN', 'CAMPAIGN_NAME', 'CAMPAIGN_ID', 'PROGRAM',
        'ASSET_TYPE', 'ASSET_SUB_TYPE', 'APPROVED_AD_POLICY', 'ASSET_EXTENSION']),
      values: z.array(z.string().min(1)).min(1),
    }).strict()).optional(),
    rangeFilters: z.array(z.object({
      rangeField: z.enum(['SIZE', 'DATE_UPLOADED']),
      ranges: z.array(z.object({ start: z.string(), end: z.string() }).strict()).min(1),
    }).strict()).optional(),
  }).strict().optional(),
  sortCriteria: z.object({
    field: z.enum(['CREATED_TIME', 'SIZE', 'NAME', 'IMAGE_HEIGHT', 'IMAGE_WIDTH', 'EXTENSION']),
    order: z.enum(['ASC', 'DESC']),
  }).strict().optional(),
  pageSize: z.number().int().min(1).max(500).default(100),
}).strict();
export type AssetLibrarySearchRequest = z.infer<typeof AssetLibrarySearchRequest>;

/** Complete traversal only; an interrupted or inconsistent search never returns this shape. */
export const AssetLibrarySearchResult = z.object({
  scope: AssetLibraryScope,
  assets: z.array(AssetLibraryObservation),
  counts: z.object({
    pages: z.number().int().min(1),
    providerRows: z.number().int().min(0),
    returnedRows: z.number().int().min(0),
    totalRecords: z.number().int().min(0),
  }).strict(),
}).strict().superRefine((value, context) => {
  const count = value.assets.length;
  if (count !== value.counts.providerRows || count !== value.counts.returnedRows
    || count !== value.counts.totalRecords) {
    context.addIssue({ code: 'custom', message: 'search counts do not reconcile' });
  }
  const identities = new Set(value.assets.map((asset) => JSON.stringify(asset.identity)));
  if (identities.size !== count || value.assets.some((asset) =>
    asset.scope.region !== value.scope.region
    || asset.scope.amazonProfileId !== value.scope.amazonProfileId)) {
    context.addIssue({ code: 'custom', message: 'search contains duplicate identities or another scope' });
  }
});
export type AssetLibrarySearchResult = z.infer<typeof AssetLibrarySearchResult>;

/** Durable registration metadata. The temporary transport URL is deliberately a separate argument. */
export const AssetLibraryRegistration = z.object({
  name: z.string().min(1),
  assetType: z.enum(['IMAGE', 'VIDEO']),
  assetSubTypes: z.array(z.enum(['LOGO', 'PRODUCT_IMAGE', 'AUTHOR_IMAGE', 'LIFESTYLE_IMAGE',
    'OTHER_IMAGE', 'BACKGROUND_VIDEO'])).min(1).max(10),
  asins: z.array(z.string().regex(/^[A-Z0-9]{10}$/)).optional(),
  tags: z.array(z.string()).optional(),
  linkedVersion: z.object({ assetId: AmazonId, notes: z.string().max(1000).optional() }).strict().optional(),
  brandEntityIds: z.array(AmazonId).min(1).max(100).optional(),
  skipSubtypeDetection: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.assetSubTypes).size !== value.assetSubTypes.length
    || value.assetSubTypes.some((type) => (type === 'BACKGROUND_VIDEO') !== (value.assetType === 'VIDEO'))) {
    context.addIssue({ code: 'custom', path: ['assetSubTypes'], message: 'asset subtypes do not match the asset type' });
  }
});
export type AssetLibraryRegistration = z.infer<typeof AssetLibraryRegistration>;

/** A single provider attempt; accepted registration does not establish processing or eligibility. */
export const AssetLibraryRegistrationOutcome = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('accepted'), scope: AssetLibraryScope, identity: AssetLibraryIdentity,
    failedSpecChecks: z.array(AssetLibraryProgramSpecifications).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('refused'), scope: AssetLibraryScope,
    status: z.union([z.literal(400), z.literal(401), z.literal(403), z.literal(404), z.literal(429)]),
  }).strict(),
  z.object({
    kind: z.literal('not_attempted'), scope: AssetLibraryScope,
    reason: z.enum(['invalid_input', 'headers_failed']),
  }).strict(),
  z.object({
    kind: z.literal('uncertain'), scope: AssetLibraryScope,
    reason: z.enum(['transport_failed', 'body_failed', 'unexpected_status', 'invalid_response']),
  }).strict(),
]);
export type AssetLibraryRegistrationOutcome = z.infer<typeof AssetLibraryRegistrationOutcome>;
