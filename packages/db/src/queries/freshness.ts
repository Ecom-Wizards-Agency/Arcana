import type { FreshnessCoverage, FreshnessLedgerEntry, OrgActor } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';

/** Call within the actor's authenticated transaction; predicates bind multi-org actors. */
export async function readProfileFreshness(handle: QueryHandle, actor: OrgActor, profileId: string) {
  const coverage = await handle.sql<{
    source: string; reportType: string; status: string;
    coveredThrough: string | null; observedAt: Date | string;
    sourceRows: string | null; parsedRows: string | null; loadedRows: string | null;
    refusedRows: string | null; countsMatch: boolean | null;
  }[]>`
    select source::text, report_type as "reportType", status::text,
           latest_loaded_date::text as "coveredThrough", coalesce(observed_at, updated_at) as "observedAt",
           source_rows as "sourceRows", parsed_rows as "parsedRows", loaded_rows as "loadedRows",
           refused_rows as "refusedRows", counts_match as "countsMatch"
      from public.report_coverage
     where org_id = ${actor.orgId} and profile_id = ${profileId}
     order by source, report_type, grain
  `;
  const coverageKeys = new Set(coverage.map((row) => JSON.stringify([row.source, row.reportType])));
  const ledger = await handle.sql<{
    source: string; reportType: string; status: string; endDate: string;
    requestedAt: Date | string; completedAt: Date | string | null;
    rowsParsed: number | string | null; rowsLoaded: number | string | null;
    countsMatch: boolean | null; error: string | null;
  }[]>`
    select case when r.source = 'amazon_api' then 'amazon_reporting_v3'
                when r.source = 'adlabs_backfill' then 'secondary_import' else r.source end as source,
           r.report_type as "reportType", r.status, r.end_date::text as "endDate",
           r.requested_at as "requestedAt", r.completed_at as "completedAt",
           r.rows_parsed as "rowsParsed", r.rows_loaded as "rowsLoaded",
           r.counts_match as "countsMatch", r.error
      from public.report_requests r
     where r.org_id = ${actor.orgId} and r.profile_id = ${profileId}
     order by r.requested_at desc, r.id
  `;
  const coverageEntries: FreshnessCoverage[] = coverage.map((row) => ({
    ...row, observedAt: new Date(row.observedAt).toISOString(),
    sourceRows: row.sourceRows === null ? null : Number(row.sourceRows),
    parsedRows: row.parsedRows === null ? null : Number(row.parsedRows),
    loadedRows: row.loadedRows === null ? null : Number(row.loadedRows),
    refusedRows: row.refusedRows === null ? null : Number(row.refusedRows),
  }));
  const ledgerEntries: FreshnessLedgerEntry[] = ledger
    .filter((row) => !coverageKeys.has(JSON.stringify([row.source, row.reportType])))
    .map((row) => ({
    ...row,
    requestedAt: new Date(row.requestedAt).toISOString(),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
    rowsParsed: row.rowsParsed === null ? null : Number(row.rowsParsed),
    rowsLoaded: row.rowsLoaded === null ? null : Number(row.rowsLoaded),
  }));
  return {
    entries: [...coverageEntries, ...ledgerEntries],
    answeredBy: coverage.length > 0
      ? ledgerEntries.length > 0 ? 'mixed' as const : 'coverage' as const
      : ledgerEntries.length > 0 ? 'ledger' as const : 'none' as const,
  };
}
