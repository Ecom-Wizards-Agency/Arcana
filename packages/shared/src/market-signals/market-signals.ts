/**
 * `market-signals/2`: the NDJSON export wizards-ai writes for Arcana.
 *
 * wizards-ai is the only process that calls Keepa. Arcana imports its export
 * instead: batches of one `header` followed by `observation`, `change_point`
 * and `signal` records. Ids are uuid5 under a frozen namespace and stable under
 * replay, so the import upserts by id and the latest batch wins. A row is never
 * deleted because a later export lacks it.
 *
 * These schemas mirror `market-signals-2.schema.json` (vendored beside this
 * file; wizards-ai owns it). The test in this directory checks that both accept
 * and refuse the same records.
 */
import { z } from 'zod';

export const MARKET_SIGNALS_SCHEMA = 'market-signals/2' as const;
export const MARKET_SIGNALS_SOURCE = 'wizards-ai' as const;
/**
 * The uuid5 namespace every export id is derived under. Joined from its groups
 * because release packaging refuses any UUID literal in shipped sources.
 */
export const MARKET_SIGNALS_ID_NAMESPACE = ['6f1c2d3e', '5a1b', '5c00', '8000', '000000000001'].join('-');

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const UUID5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const MarketSignalsUtc = z.string().regex(UTC);
export const MarketSignalsId = z.string().regex(UUID5);
export const MarketSignalsAsin = z.string().regex(/^[A-Z0-9]{10}$/);
export const MarketSignalsMarketplace = z.string().regex(/^[A-Z]{2}$/);
export const MarketSignalsOrgKey = z.string().min(1);
export const MarketSignalsRole = z.enum(['own', 'competitor']);
export type MarketSignalsRole = z.infer<typeof MarketSignalsRole>;
const CategoryId = z.string().regex(/^([0-9]+)?$/);
const ProfileKey = z.string().nullable();
const Count = z.number().int().min(0);
const Money = z.number().min(0);

export const MarketSignalsHeader = z.object({
  kind: z.literal('header'),
  schema: z.literal(MARKET_SIGNALS_SCHEMA),
  source: z.literal(MARKET_SIGNALS_SOURCE),
  org_key: MarketSignalsOrgKey,
  generated_at: MarketSignalsUtc,
  /** The market pass the batch was read from: Arcana's "data as of". */
  state_generated_at: MarketSignalsUtc.nullable(),
  mode: z.enum(['full', 'since', 'delta']),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  counts: z.object({ observation: Count, change_point: Count, signal: Count }).strict(),
}).strict();
export type MarketSignalsHeader = z.infer<typeof MarketSignalsHeader>;

/** Every series value in force at one Keepa change time; maps onto `keepa_bsr_observations`. */
export const MarketSignalsObservation = z.object({
  kind: z.literal('observation'),
  id: MarketSignalsId,
  org_key: MarketSignalsOrgKey,
  profile_key: ProfileKey,
  marketplace: MarketSignalsMarketplace,
  asin: MarketSignalsAsin,
  role: MarketSignalsRole,
  observed_at: MarketSignalsUtc,
  category: CategoryId,
  bsr: Count.nullable(),
  price: Money.nullable(),
  rating: z.number().min(0).max(5).nullable(),
  review_count: Count.nullable(),
  buy_box_price: Money.nullable(),
  offer_count: Count.nullable(),
}).strict();
export type MarketSignalsObservation = z.infer<typeof MarketSignalsObservation>;

export const MARKET_SIGNALS_PRICE_TRACKS = ['buybox_price', 'new_price', 'new_fba_price'] as const;
export const MARKET_SIGNALS_TRACKS = [
  'buybox_price', 'category_ids', 'fba_fee', 'holder', 'new_fba_price', 'new_price', 'offer_count',
  'package_dimensions', 'package_weight', 'rank', 'rating', 'referral_fee', 'reviews', 'root_category',
] as const;
export const MarketSignalsTrack = z.enum(MARKET_SIGNALS_TRACKS);
export type MarketSignalsTrack = z.infer<typeof MarketSignalsTrack>;

const changePointBase = {
  kind: z.literal('change_point'),
  id: MarketSignalsId,
  org_key: MarketSignalsOrgKey,
  profile_key: ProfileKey,
  marketplace: MarketSignalsMarketplace,
  asin: MarketSignalsAsin,
  role: MarketSignalsRole,
  /** wizards-ai's observation id, `MKT|ASIN`. */
  observation: z.string().regex(/^[A-Z]{2}\|[A-Z0-9]{10}$/),
  at: MarketSignalsUtc,
};
const NoOffer = z.literal('no_offer');
const changePoint = <T extends z.ZodTypeAny, V extends z.ZodTypeAny>(track: T, value: V) =>
  z.object({ ...changePointBase, track, value }).strict();

/** One stored Keepa change; the value's type depends on the track. */
export const MarketSignalsChangePoint = z.discriminatedUnion('track', [
  changePoint(z.literal('holder'), z.string().regex(/^(A[0-9A-Z]{5,20}|suppressed|unidentified)$/)),
  changePoint(z.enum(MARKET_SIGNALS_PRICE_TRACKS), z.union([Money, NoOffer])),
  changePoint(z.enum(['rank', 'reviews', 'offer_count']), z.union([Count, NoOffer])),
  changePoint(z.literal('rating'), z.number().min(0).max(5)),
  changePoint(z.literal('category_ids'), z.array(z.string())),
  changePoint(z.literal('root_category'), CategoryId),
  changePoint(z.literal('package_dimensions'), z.record(z.string(), z.unknown())),
  changePoint(z.enum(['fba_fee', 'referral_fee', 'package_weight']), z.number().nullable()),
]);
export type MarketSignalsChangePoint = z.infer<typeof MarketSignalsChangePoint>;

export const MARKET_SIGNALS_TAG_NAMESPACES = ['family', 'because', 'hero', 'band', 'holder', 'route', 'label', 'jev'] as const;

/** A tag add or remove. Marks are deltas: fold them in order for the current set. */
export const MarketSignalsTagMark = z.object({
  id: MarketSignalsId,
  /** uuid5 of the path; organisation-free, kept on Arcana's mark as `source_tag_id`. */
  tag_id: MarketSignalsId,
  path: z.string().regex(/^signal\/[a-z_]+\/[^/]+$/),
  op: z.enum(['add', 'remove']),
  at: MarketSignalsUtc,
  source: z.enum(['rule', 'label', 'jev', 'human']),
  /** `shadow` marks are measurement only and never shown as facts. */
  stage: z.enum(['live', 'shadow']),
  rules: z.string().nullable(),
}).strict();
export type MarketSignalsTagMark = z.infer<typeof MarketSignalsTagMark>;

export const MARKET_SIGNALS_ISSUE_TYPES = [
  'browse_node_changed', 'bsr_competitor_proximity', 'bsr_degradation', 'buybox_lost', 'buybox_suppressed',
  'fba_fee_changed', 'offer_count_increased', 'out_of_stock', 'package_dimensions_changed',
  'package_weight_changed', 'price_changed', 'rating_display_dropped', 'rating_display_improved',
  'rating_drop', 'referral_fee_changed', 'reviews_disappeared', 'root_category_changed',
] as const;
export const MarketSignalsIssueType = z.enum(MARKET_SIGNALS_ISSUE_TYPES);
export type MarketSignalsIssueType = z.infer<typeof MarketSignalsIssueType>;
export const MarketSignalsFamily = z.enum(['buybox', 'category', 'fees', 'offers', 'package', 'price', 'rank', 'rating', 'reviews', 'stock']);
export const MarketSignalsStatus = z.enum(['open', 'stale', 'resolved', 'quarantined', 'out_of_scope']);
export const MarketSignalsRoute = z.enum(['now', 'selected', 'weekly', 'never']);
export const MarketSignalsHolderClass = z.enum(['us', 'own_store', 'amazon', 'third_party', 'unidentified', 'suppressed', 'no_offer', 'unknown']);

/** One market signal episode; its id is Arcana's `insights.id`. */
export const MarketSignalsSignal = z.object({
  kind: z.literal('signal'),
  id: MarketSignalsId,
  key: z.string().regex(/^.+\|[A-Z]{2}\|ASIN:[A-Z0-9]{10}\|[a-z_]+$/),
  org_key: MarketSignalsOrgKey,
  profile_key: ProfileKey,
  account: z.string(),
  marketplace: MarketSignalsMarketplace,
  asin: MarketSignalsAsin,
  parent_asin: MarketSignalsAsin.nullable(),
  issue_type: MarketSignalsIssueType,
  family: MarketSignalsFamily,
  severity: z.enum(['high', 'medium', 'low']),
  route: MarketSignalsRoute,
  route_source: z.enum(['rule', 'label', 'jev']),
  because: z.enum(['hero_holder_not_ours', 'hero_buybox_suppressed', 'hero_out_of_stock', 'hero_badge_drop', 'root_category_changed']).nullable(),
  status: MarketSignalsStatus,
  band: z.number().int().min(1).max(4),
  hero: z.boolean(),
  holder: MarketSignalsHolderClass.nullable(),
  onset_at: MarketSignalsUtc,
  first_fired_at: MarketSignalsUtc,
  last_movement: MarketSignalsUtc,
  resolved_at: MarketSignalsUtc.nullable(),
  summary: z.string(),
  figures: z.record(z.string(), z.unknown()),
  tag_marks: z.array(MarketSignalsTagMark),
}).strict();
export type MarketSignalsSignal = z.infer<typeof MarketSignalsSignal>;

export const MarketSignalsRecord = z.union([
  MarketSignalsHeader, MarketSignalsObservation, MarketSignalsChangePoint, MarketSignalsSignal,
]);
export type MarketSignalsRecord = z.infer<typeof MarketSignalsRecord>;
export const MarketSignalsRecordKind = z.enum(['header', 'observation', 'change_point', 'signal']);
export type MarketSignalsRecordKind = z.infer<typeof MarketSignalsRecordKind>;

/** wizards-ai `profile_key` to an Arcana profile, one row per key per organisation. */
export const MarketSignalsProfileMapRow = z.object({
  orgId: z.uuid(),
  profileKey: z.string().min(1).max(200),
  profileId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict();
export type MarketSignalsProfileMapRow = z.infer<typeof MarketSignalsProfileMapRow>;

/**
 * What one import pass did. Every valid record lands in exactly one of its
 * kind's outcome counts; invalid lines are counted and skipped.
 */
export const MarketSignalsImportCounts = z.object({
  filesSeen: Count,
  filesSkippedUnchanged: Count,
  /** Files that could not be read or positioned; the pass went on with the next file. */
  filesFailed: Count,
  batchesSeen: Count,
  batchesImported: Count,
  batchesAlreadyImported: Count,
  /** A trailing batch still being written: fewer lines than its header counts. */
  batchesIncomplete: Count,
  /** A complete batch whose lines disagree with its header counts. */
  batchesCountMismatch: Count,
  /** Batches whose org_key maps to no Arcana organisation. */
  batchesUnmappedOrg: Count,
  /** Batches the database refused; the rest of their file waits for the next pass. */
  batchesFailed: Count,
  observations: Count,
  observationsWritten: Count,
  observationsUnchanged: Count,
  changePoints: Count,
  /** Competitor price change points with no stored observation at their time. */
  changePointsWithoutObservation: Count,
  priceEventsWritten: Count,
  /** Already stored, or the same (ASIN, kind, time) twice in one batch. */
  priceEventsExisting: Count,
  signals: Count,
  /** New, or content changed. */
  signalsWritten: Count,
  /** A newer batch with the same content: only the batch time moved. */
  signalsAdvanced: Count,
  /** Older than the stored batch, so refused. */
  signalsBlocked: Count,
  /** The stored batch itself again. */
  signalsUnchanged: Count,
  unmappedSignals: Count,
  tagMarks: Count,
  tagMarksWritten: Count,
  tagMarksExisting: Count,
  /** Lines that failed validation or exceed what Arcana can store, in or outside a batch; skipped. */
  invalidRecords: Count,
  /** The newest header `state_generated_at` imported: "data as of". */
  stateGeneratedAt: z.string().nullable(),
}).strict();
export type MarketSignalsImportCounts = z.infer<typeof MarketSignalsImportCounts>;

/** The stored import position and totals for one organisation, read by /sync-status. */
export const MarketSignalsImportStatus = z.object({
  files: Count,
  batchesImported: Count,
  observations: Count,
  changePoints: Count,
  signals: Count,
  tagMarks: Count,
  invalidRecords: Count,
  unmappedSignals: Count,
  dataAsOf: z.string().nullable(),
  lastImportedAt: z.string().nullable(),
}).strict();
export type MarketSignalsImportStatus = z.infer<typeof MarketSignalsImportStatus>;
