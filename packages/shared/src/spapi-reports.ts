import { z } from 'zod';
import { IsoDate, Uuid, Region } from './primitives.js';
import { CreativeChangeCertainty } from './creative.js';

export const SpReportFamily = z.enum(['retail', 'aba', 'catalogue']);
export type SpReportFamily = z.infer<typeof SpReportFamily>;
export const SpReportScope = z.object({
  orgId: Uuid, profileId: Uuid, connectionId: Uuid,
  marketplaceId: z.string().min(1), sellingPartnerId: z.string().min(1), region: Region,
});
export type SpReportScope = z.infer<typeof SpReportScope>;
export const SpReportPlan = z.object({
  scope: SpReportScope, family: SpReportFamily, requestId: z.string().min(1),
  start: IsoDate, end: IsoDate, requestedAt: z.iso.datetime(),
  contractVersion: z.string().min(1),
});
export type SpReportPlan = z.infer<typeof SpReportPlan>;
const count = z.number().int().nonnegative();
const optionalCount = count.nullable();
const share = z.number().min(0).max(1).nullable();
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
export const SpRetailRow = z.object({
  kind: z.literal('retail'), key: z.string(), date: IsoDate,
  grain: z.enum(['total', 'child']), asin: asin.nullable(), parentAsin: asin.nullable(),
  sales: z.number().nonnegative().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  units: optionalCount, orderItems: optionalCount, sessions: optionalCount, pageViews: optionalCount,
  reportedUnitSessionPercentage: z.number().nonnegative().nullable(),
}).superRefine((row, ctx) => {
  if ((row.grain === 'child') !== (row.asin !== null)) ctx.addIssue({ code: 'custom', message: 'Retail grain mismatch' });
  if ((row.sales === null) !== (row.currency === null)) ctx.addIssue({ code: 'custom', message: 'Money requires currency' });
});
export type SpRetailRow = z.infer<typeof SpRetailRow>;
export const SpAbaRow = z.object({
  kind: z.literal('aba'), key: z.string(), date: IsoDate, end: IsoDate,
  department: z.string().min(1), query: z.string().min(1), frequencyRank: count.min(1),
  slot: z.number().int().min(0).max(3), asin: asin.nullable(),
  clickShare: share, conversionShare: share, complete: z.boolean(),
  /** Conflicting source rows for this ranked slot; survives canonical deduplication. */
  conflicted: z.boolean().optional(),
});
export type SpAbaRow = z.infer<typeof SpAbaRow>;
export const SpListingRow = z.object({
  kind: z.literal('catalogue'), key: z.string(), date: IsoDate,
  listingId: z.string().min(1), sku: z.string().min(1), asin,
  fields: z.object({ title: z.string().optional(), description: z.string().optional(),
    imageUrl: z.string().optional(), quantity: count.optional(), status: z.string().optional(),
    condition: z.string().optional() }),
});
export type SpListingRow = z.infer<typeof SpListingRow>;
export const SpReportRow = z.discriminatedUnion('kind', [SpRetailRow, SpAbaRow, SpListingRow]);
export type SpReportRow = z.infer<typeof SpReportRow>;
export const SpReportCounts = z.object({
  sourceRows: count, parsedRows: count, refusedRows: count, duplicateRows: count,
  addedRows: count, canonicalRows: count,
}).superRefine((c, ctx) => {
  if (c.sourceRows !== c.parsedRows + c.refusedRows || c.canonicalRows !== c.parsedRows - c.duplicateRows + c.addedRows)
    ctx.addIssue({ code: 'custom', message: 'Report row accounting mismatch' });
});
export type SpReportCounts = z.infer<typeof SpReportCounts>;
export const SpListingChange = z.object({
  id: z.string().min(1), asin, sku: z.string().min(1), field: z.string().min(1),
  before: z.union([z.string(), z.number()]).nullable(), after: z.union([z.string(), z.number()]),
  observedAt: z.iso.datetime(), source: z.string().min(1), certainty: CreativeChangeCertainty,
});
export type SpListingChange = z.infer<typeof SpListingChange>;
export const SpParsedReport = z.object({
  plan: SpReportPlan, reportId: z.string().min(1), documentId: z.string().min(1),
  observedAt: z.iso.datetime(), payloadFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  listingChanges: z.array(SpListingChange).optional(), listingPreviousReportId: z.string().nullable().optional(),
  rows: z.array(SpReportRow), counts: SpReportCounts, complete: z.boolean(),
}).superRefine((r, ctx) => {
  if (r.complete && r.counts.refusedRows !== 0)
    ctx.addIssue({ code: 'custom', message: 'Complete report cannot contain refused rows' });
  if (r.plan.family === 'catalogue' && (r.plan.start !== r.plan.end
    || r.observedAt.slice(0, 10) !== r.plan.start
    || r.plan.requestedAt.slice(0, 10) !== r.plan.start))
    ctx.addIssue({ code: 'custom', message: 'Catalogue report must retain its actual request and observation day' });
  if (r.listingChanges !== undefined && (r.plan.family !== 'catalogue' || r.listingPreviousReportId === undefined
    || r.listingChanges.some(change => change.observedAt !== r.observedAt || change.source !== r.plan.contractVersion)))
    ctx.addIssue({ code: 'custom', message: 'Listing certainty must bind its source observation and previous receipt' });
  if (r.rows.length !== r.counts.canonicalRows || r.rows.some(row => row.kind !== r.plan.family)
    || new Set(r.rows.map(row => row.key)).size !== r.rows.length)
    ctx.addIssue({ code: 'custom', message: 'Canonical report rows mismatch' });
});
export type SpParsedReport = z.infer<typeof SpParsedReport>;
export const SpReportReceipt = z.object({
  report: SpParsedReport, writtenRows: count, verifiedLoadedRows: count,
});
export type SpReportReceipt = z.infer<typeof SpReportReceipt>;
export const SpReportCheckpoint = z.object({
  plan: SpReportPlan, revision: count,
  state: z.enum(['planned', 'creating', 'requested', 'completed']),
  reportId: z.string().nullable(), documentId: z.string().nullable(),
  observedAt: z.iso.datetime().nullable(), receipt: SpReportReceipt.nullable(),
});
export type SpReportCheckpoint = z.infer<typeof SpReportCheckpoint>;
export const SpEvidence = z.object({
  state: z.enum(['measured', 'partial', 'stale', 'unavailable']),
  reason: z.string().nullable(), report: SpParsedReport.nullable(),
});
export type SpEvidence = z.infer<typeof SpEvidence>;
export const SpRetailSpendEvidence = z.object({
  orgId: Uuid, sellingPartnerId: z.string(), marketplaceId: z.string(), currency: z.string(),
  start: IsoDate, end: IsoDate, complete: z.boolean(), scope: z.literal('seller'),
  rows: z.array(z.object({ date: IsoDate, spend: z.number().nonnegative() })),
});
export type SpRetailSpendEvidence = z.infer<typeof SpRetailSpendEvidence>;

export const SpReportAdmissionCode = z.enum([
  'profile_unavailable', 'source_disabled', 'binding_disabled', 'profile_sync_disabled',
  'credential_unavailable', 'seller_mismatch', 'marketplace_mismatch', 'region_mismatch', 'connection_mismatch',
]);
export type SpReportAdmissionCode = z.infer<typeof SpReportAdmissionCode>;
export const SpReportAdmission = z.discriminatedUnion('admitted', [
  z.object({ admitted: z.literal(true), scope: SpReportScope }),
  z.object({ admitted: z.literal(false), code: SpReportAdmissionCode }),
]);
export type SpReportAdmission = z.infer<typeof SpReportAdmission>;
/** Expected daily/weekly cadence plus six hours of delivery tolerance. Age uses producer observations. */
export const SP_REPORT_FRESHNESS_HOURS = { retail: 30, aba: 174, catalogue: 30 } as const;

/** Request identities may differ; provider identity and admitted seller period may not. */
export function sameSpReportDocument(a: SpParsedReport, b: SpParsedReport): boolean {
  const identity = (r: SpParsedReport) => [r.plan.scope.orgId, r.plan.scope.sellingPartnerId,
    r.plan.scope.marketplaceId, r.plan.scope.region, r.plan.family, r.plan.start, r.plan.end,
    r.plan.contractVersion, r.reportId, r.documentId, r.payloadFingerprint];
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      const fields = Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item));
      return '{' + fields.join(',') + '}';
    }
    return JSON.stringify(value);
  };
  return canonical(identity(a)) === canonical(identity(b)) && canonical(a.rows.map(row=>row.kind==='aba'?{...row,conflicted:row.conflicted??false}:row))
    === canonical(b.rows.map(row=>row.kind==='aba'?{...row,conflicted:row.conflicted??false}:row))
    && canonical(a.counts) === canonical(b.counts) && a.complete === b.complete;
}
