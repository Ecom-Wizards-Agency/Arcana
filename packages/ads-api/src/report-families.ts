import {
  coreReportIdentity, CORE_REPORT_FAMILIES, CoreReportConfiguration, CoreReportRow, CoreReportParseResult,
  type CoreFeatureReportType, type CoreReportCapability,
} from '@wizard-ads/shared';
import { AdsApiConfigError } from './errors.js';

export function defaultCoreReportConfiguration(family: CoreFeatureReportType, timeUnit: 'DAILY' | 'SUMMARY' = 'DAILY'): CoreReportConfiguration {
  const spec = CORE_REPORT_FAMILIES[family];
  return CoreReportConfiguration.parse({ version: 1, family, timeUnit, format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: [...(timeUnit === 'DAILY' ? ['date'] : ['startDate', 'endDate']), ...spec.required, ...spec.optional, ...spec.defaultMetrics] });
}

/** Date differences and retention are separate bounds; no current provider guarantee is implied. */
export function validateCoreReportWindow(configuration: CoreReportConfiguration, start: string, end: string, today?: string): void {
  const dates = [start, end, ...(today === undefined ? [] : [today])];
  if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) throw new AdsApiConfigError('invalid report date');
  const spec = CORE_REPORT_FAMILIES[configuration.family];
  const span = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (span < 0 || span > spec.maximumDateDifferenceDays) throw new AdsApiConfigError('report family range exceeded');
  if (today !== undefined && (end >= today || (Date.parse(today) - Date.parse(start)) / 86_400_000 > spec.retentionDays)) throw new AdsApiConfigError('report family retention exceeded');
}

export function assertCoreReportAdmission(configuration: CoreReportConfiguration, capability: CoreReportCapability | null, scope: { orgId: string; profileId: string }): void {
  const spec = CORE_REPORT_FAMILIES[configuration.family];
  if (!capability?.enabled || capability.status !== 'eligible' || !capability.recoveryGateEvidence || capability.orgId !== scope.orgId || capability.profileId !== scope.profileId || capability.family !== configuration.family || capability.observedAt === null) throw new AdsApiConfigError('report family is not enabled with recovery evidence');
  const approved = capability.approvedConfigurations.some((item) => item.family === configuration.family && item.timeUnit === configuration.timeUnit && item.format === configuration.format && item.version === configuration.version && item.attributionGeneration === configuration.attributionGeneration && [...item.columns].sort().join('|') === [...configuration.columns].sort().join('|'));
  if (!approved) throw new AdsApiConfigError('exact marketplace report configuration is unverified');
  if (spec.product === 'SB' && capability.sbMultiAdGroupsEnabled !== true) throw new AdsApiConfigError('SB preview eligibility is unverified');
  if (configuration.attributionGeneration !== 'legacy') {
    if (!capability.multiTouchEvidence) throw new AdsApiConfigError('multi-touch report capability is unverified');
    // The dated audit names this capability but does not pin its provider column
    // contract. Never send legacy columns and relabel their output as multi-touch.
    throw new AdsApiConfigError('multi-touch provider column contract is not pinned');
  }
}

/** Strict canonical rows; provider display fields are discarded, never copied to logs. */
export function parseCoreReport(configurationInput: CoreReportConfiguration, input: readonly unknown[], startDate: string, endDate: string): CoreReportParseResult {
  const configuration = CoreReportConfiguration.parse(configurationInput);
  validateCoreReportWindow(configuration, startDate, endDate);
  const spec = CORE_REPORT_FAMILIES[configuration.family];
  const rows: CoreReportRow[] = [];
  const refusals: CoreReportParseResult['refusals'] = [];
  const identities = new Map<string, string>();
  let duplicateRows = 0;
  for (const [index, raw] of input.entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { refusals.push({ index, reason: 'invalid_row' }); continue; }
    const value = raw as Record<string, unknown>;
    const dimensions: Record<string, string | null> = {};
    let invalidDimension = false;
    for (const key of [...spec.required, ...spec.optional]) {
      const item = value[key];
      if (item == null) dimensions[key] = null;
      else if (typeof item === 'string' && item.length > 0) dimensions[key] = item;
      else if (typeof item === 'number' && Number.isSafeInteger(item) && item >= 0) dimensions[key] = String(item);
      else invalidDimension = true;
    }
    if (invalidDimension || spec.required.some((key) => !dimensions[key])) { refusals.push({ index, reason: 'invalid_dimension' }); continue; }
    const metrics: Record<string, number | null> = {};
    let invalidMetric = false;
    for (const key of configuration.columns.filter((key) => spec.metrics.includes(key))) {
      const item = value[key];
      if (item == null) metrics[key] = null;
      else if ((typeof item === 'number' || (typeof item === 'string' && item.trim() !== '')) && Number.isFinite(Number(item)) && Number(item) >= 0) metrics[key] = Number(item);
      else invalidMetric = true;
    }
    if (invalidMetric) { refusals.push({ index, reason: 'invalid_metric' }); continue; }
    const periodStart = configuration.timeUnit === 'DAILY' ? value['date'] : value['startDate'] ?? startDate;
    const periodEnd = configuration.timeUnit === 'DAILY' ? value['date'] : value['endDate'] ?? endDate;
    const result = CoreReportRow.safeParse({ family: configuration.family, periodStart, periodEnd, timeUnit: configuration.timeUnit, attributionGeneration: configuration.attributionGeneration, dimensions, metrics, identityResolution: 'reported_unresolved' });
    if (!result.success && result.error.issues.some((issue) => issue.path[0] === 'metrics')) { refusals.push({ index, reason: 'invalid_metric' }); continue; }
    if (!result.success || result.data.periodStart < startDate || result.data.periodEnd > endDate || (configuration.timeUnit === 'SUMMARY' && (periodStart !== startDate || periodEnd !== endDate))) { refusals.push({ index, reason: 'invalid_period' }); continue; }
    const row = result.data;
    const key = JSON.stringify([row.periodStart, row.periodEnd, coreReportIdentity(row)]);
    const normalized = JSON.stringify(row);
    const previous = identities.get(key);
    if (previous === normalized) { duplicateRows++; continue; }
    if (previous !== undefined) { refusals.push({ index, reason: 'conflicting_duplicate' }); continue; }
    identities.set(key, normalized);
    rows.push(row);
  }
  return CoreReportParseResult.parse({ configuration, sourceRows: input.length, parsedRows: input.length - refusals.length, duplicateRows, rows, refusals });
}
