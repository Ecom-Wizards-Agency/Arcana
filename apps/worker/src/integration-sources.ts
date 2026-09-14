import { IsoDate, type IngestionCounts, type JobType } from '@wizard-ads/shared';
import type { IntegrationHandlers } from './worker.js';
import { ingestionSource } from './ingestion-sources.js';
import type { CoverageTarget, IngestionContext, IngestionRegistry } from './ingestion-registry.js';

function count(result: Record<string, unknown>, key: string): number {
  const value = result[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Integration is missing its ${key} count`);
  }
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Missing ingestion accounting');
  return value as Record<string, unknown>;
}
function localDate(context: { profile: { timezone: string } }, at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: context.profile.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Production adapters publish coverage; the named-handler option remains legacy compatibility. */
export function registerIntegrationSources(
  registry: Pick<IngestionRegistry, 'register'>, handlers: IntegrationHandlers,
  now: () => Date = () => new Date(),
): void {
  function add<K extends JobType>(
    type: K, reportType: string,
    execute: (context: IngestionContext<K>) => Promise<Record<string, unknown>>,
    counts: (result: Record<string, unknown>) => IngestionCounts,
    dates?: (result: Record<string, unknown>, context: IngestionContext<K>) => { start: string; end: string },
  ) {
    registry.register({
      source: { ...ingestionSource(type), jobType: type, reportType },
      plan: (context) => ({ context, observedAt: now() }),
      execute: (plan) => execute(plan.context),
      counts,
      coverage: { target: (result, plan): CoverageTarget => {
        const range = dates?.(result, plan.context) ?? { start: localDate(plan.context, plan.observedAt), end: localDate(plan.context, plan.observedAt) };
        const counted = counts(result);
        return { reportType, grain: reportType, earliestDate: IsoDate.parse(range.start), coveredThrough: IsoDate.parse(range.end),
          observedAt: typeof result['observedAt'] === 'string' ? result['observedAt'] : plan.observedAt.toISOString(),
          status: counted.refusedRows > 0 || result['profileMatched'] === false
            || (typeof result['asinsSkippedByCap'] === 'number' && result['asinsSkippedByCap'] > 0)
            || (type === 'keepa.sync' && counted.loadedRows === 0) ? 'partial' : 'complete', settledThrough: null };
      } },
    });
  }
  const keepa = handlers.keepaSync;
  if (keepa) add('keepa.sync', 'product_observations', ({ payload }) => keepa(payload), (result) => ({
    sourceRows: count(result,'requested'), parsedRows: count(result,'returned'),
    refusedRows: Array.isArray(result['missing']) ? result['missing'].length : NaN,
    loadedRows: count(result,'observationsWritten') + count(result,'observationsExisting'),
    verifiedLoadedRows: count(result,'returned'),
  }), (result, context) => ({
    start: localDate(context, new Date(String(result['earliestObservedAt']))),
    end: localDate(context, new Date(String(result['observedAt']))),
  }));
  const rank = handlers.rankSync;
  if (rank) add('rank.sync', 'rank_observations', ({ payload }) => rank(payload), (result) => ({
    sourceRows: count(result,'observations'), parsedRows: count(result,'observations'), refusedRows: 0,
    loadedRows: count(result,'loaded'), verifiedLoadedRows: count(result,'uniqueObservations'),
  }), (result) => ({ start: IsoDate.parse(result['observedOn']), end: IsoDate.parse(result['observedOn']) }));
  const economics = handlers.economicsSync;
  if (economics) add('economics.sync', 'product_economics', ({ payload }) => economics(payload), (result) => ({
    sourceRows: count(result,'asinsSelected'), parsedRows: count(result,'rowsLoaded'),
    refusedRows: count(result,'asinsSelected') - count(result,'rowsLoaded'), loadedRows: count(result,'rowsLoaded'),
    verifiedLoadedRows: count(result,'productCallsSucceeded') - count(result,'productsSkippedIncomplete'),
  }), (result) => ({ start: IsoDate.parse(result['capturedOn']), end: IsoDate.parse(result['capturedOn']) }));
  const sqp = handlers.sqpRequest;
  if (sqp) add('sqp.request', ingestionSource('sqp.request').reportType!, async ({ payload, job }) => {
    const result = await sqp(payload, { jobId: job.id });
    // Old completed checkpoints have no observation timestamp. Keep their date conservative.
    return { ...result, observedAt: result['observedAt'] ?? `${payload.weekEnd}T23:59:59.999Z` };
  }, (result) => {
    const ingestion = record(result['ingestion']);
    const canonicalRows = count(ingestion, 'canonicalRows');
    const expectedWrites = ingestion['status'] === 'already_promoted' ? 0 : canonicalRows;
    if (!['promoted', 'already_promoted'].includes(String(ingestion['status']))
      || count(ingestion, 'upserts') !== expectedWrites || count(ingestion, 'promotedRows') !== expectedWrites) {
      throw new Error('SQP promotion write counts do not reconcile');
    }
    return { sourceRows: count(ingestion,'sourceRows'), parsedRows: count(ingestion,'parsedRows'),
      refusedRows: count(ingestion,'refusedRows'), loadedRows: canonicalRows,
      verifiedLoadedRows: count(ingestion,'deduplicatedRows') };
  }, (_result, { payload }) => ({ start: payload.weekStart, end: payload.weekEnd }));
}
