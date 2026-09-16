import { createHash } from 'node:crypto';
import { SpReportPlan, SpParsedReport, type SpReportRow, type SpReportFamily } from '@wizard-ads/shared';
import { SpApiParseError } from './errors.js';
import type { CreateReportInput } from './types.js';

/** Amazon models pinned before parser implementation; fixtures are authored synthetic data. */
export const SP_REPORT_CONTRACT = 'amazon-models:3659f96867bfc669aca7a524c2f95744ff0e4478';
export const SP_REPORT_TYPES = {
  retail: 'GET_SALES_AND_TRAFFIC_REPORT', aba: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', catalogue: 'GET_MERCHANT_LISTINGS_ALL_DATA',
} as const;
export const SP_REPORT_POLICY = {
  retail: { documentRetentionDays: 90, lookbackCalendarYears: 2, maxRequestsPerFiveMinutes: 3, cadence: '1 day' },
  aba: { documentRetentionDays: 90, lookbackCalendarYears: null, cadence: '7 days' },
  catalogue: { documentRetentionDays: 90, lookbackCalendarYears: null, cadence: '1 day' },
} as const;
export function canonicalSpJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSpJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalSpJson(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function spFingerprint(value: unknown): string { return createHash('sha256').update(canonicalSpJson(value)).digest('hex'); }
export function spDate(value: string): Date {
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new SpApiParseError('Invalid source date');
  return d;
}
export function validateSpPlan(input: SpReportPlan): SpReportPlan {
  const plan = SpReportPlan.parse(input);
  const start = spDate(plan.start), end = spDate(plan.end), now = new Date(plan.requestedAt);
  if (plan.contractVersion !== SP_REPORT_CONTRACT || start > end || end > now) throw new SpApiParseError('Unsupported report contract or period');
  if (plan.family === 'aba') {
    if (start.getUTCDay() !== 0 || end.getUTCDay() !== 6 || +end - +start !== 6 * 86400000) throw new SpApiParseError('ABA requires one Sunday-Saturday week');
    if (+end + 86400000 > +now) throw new SpApiParseError('ABA requires a completed provider week');
  } else if (plan.start !== plan.end) throw new SpApiParseError('Daily reports require one day');
  if (plan.family === 'catalogue' && plan.start !== now.toISOString().slice(0, 10)) throw new SpApiParseError('Catalogue inventory requires the request observation day');
  if (plan.family === 'retail') {
    const earliest = new Date(now); earliest.setUTCFullYear(earliest.getUTCFullYear() - 2);
    if (start < spDate(earliest.toISOString().slice(0, 10))) throw new SpApiParseError('Retail period exceeds two calendar years');
  }
  return plan;
}
export function spReportRequest(input: SpReportPlan): CreateReportInput {
  const plan = validateSpPlan(input);
  return { reportType: SP_REPORT_TYPES[plan.family], marketplaceId: plan.scope.marketplaceId,
    dataStartTime: `${plan.start}T00:00:00.000Z`, dataEndTime: `${plan.end}T23:59:59.999Z`,
    reportOptions: plan.family === 'retail' ? { dateGranularity: 'DAY', asinGranularity: 'CHILD' }
      : plan.family === 'aba' ? { reportPeriod: 'WEEK' } : { preferredReportDocumentLocale: 'en_US' } };
}
export function spRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpApiParseError('Expected report object');
  return value as Record<string, unknown>;
}
export function spString(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new SpApiParseError('Missing report identity');
  return value;
}
export function spNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SpApiParseError('Invalid report number');
  return value;
}
export function spJsonDocument(text: string, plan: SpReportPlan, family: SpReportFamily): Record<string, unknown> {
  validateSpPlan(plan);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new SpApiParseError('Truncated or invalid JSON report'); }
  const body = spRecord(parsed), spec = spRecord(body['reportSpecification']), options = spRecord(spec['reportOptions']);
  if (family !== plan.family || spec['reportType'] !== SP_REPORT_TYPES[family]
    || spec['dataStartTime'] !== plan.start || spec['dataEndTime'] !== plan.end
    || canonicalSpJson(spec['marketplaceIds']) !== canonicalSpJson([plan.scope.marketplaceId])
    || (family === 'retail' && (options['dateGranularity'] !== 'DAY' || options['asinGranularity'] !== 'CHILD'))
    || (family === 'aba' && options['reportPeriod'] !== 'WEEK')) throw new SpApiParseError('Report specification differs from admitted scope');
  return body;
}
export function spArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new SpApiParseError('Missing report collection');
  return value;
}
export interface SpParseContext { plan: SpReportPlan; reportId: string; documentId: string; observedAt: string }
export function finishSpReport(text: string, context: SpParseContext, rows: SpReportRow[], counts: { sourceRows: number; parsedRows: number; refusedRows: number; addedRows?: number }, complete: boolean): SpParsedReport {
  const canonical = new Map<string, SpReportRow>();
  let duplicates = 0;
  for (const row of rows) {
    const previous = canonical.get(row.key);
    if (previous) { duplicates++; if (canonicalSpJson(previous) !== canonicalSpJson(row)) complete = false; }
    else canonical.set(row.key, row);
  }
  return SpParsedReport.parse({ ...context, payloadFingerprint: createHash('sha256').update(text).digest('hex'),
    rows: [...canonical.values()], counts: { ...counts, duplicateRows: duplicates, addedRows: counts.addedRows ?? 0, canonicalRows: canonical.size },
    complete: complete && counts.refusedRows === 0 });
}
