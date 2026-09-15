import { ReportCoverageAccounting, ReportCoverageObservation } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';
import type postgres from 'postgres';

/** Verify the persisted observation inside the same transaction as its upsert.
 * Budget callers must verify the latest immutable run under its source lock before
 * replacing accounting. Provider time remains the observation time, even when
 * that run changes completeness/counts without advancing provider freshness.
 */
export async function upsertReportCoverage(
  handle: QueryHandle,
  raw: ReportCoverageObservation,
  verifiedLoadedRows: number | null,
  options?: { accounting: 'verified_budget_run' },
): Promise<{ offered: number; written: number; unchanged: number }> {
  const input = ReportCoverageObservation.parse(raw);
  const replaceAccounting = options?.accounting === 'verified_budget_run';
  if (replaceAccounting && (input.reportType !== 'campaign_budget_usage' || input.grain !== 'campaign_budget_usage'
    || !['amazon_ads_api', 'amazon_marketing_stream'].includes(input.source) || !input.sourceRunId || !input.countsMatch)) {
    throw new Error('verified budget accounting requires a scoped budget source run');
  }
  if (input.loadedRows !== verifiedLoadedRows) throw new Error('coverage loaded count differs from verified load');
  if (input.sourceRows !== null && input.parsedRows !== null && input.refusedRows !== null &&
      input.sourceRows !== input.parsedRows + input.refusedRows) {
    throw new Error('coverage source counts do not reconcile');
  }
  const write = async (sql: postgres.TransactionSql) => {
    const written = await sql<{ id: string }[]>`
      insert into public.report_coverage
        (org_id, profile_id, report_type, grain, source, status,
         earliest_requested_date, earliest_returned_date, latest_loaded_date, latest_settled_date,
         source_rows, parsed_rows, loaded_rows, refused_rows, counts_match, observed_at)
      values (${input.orgId}, ${input.profileId}, ${input.reportType}, ${input.grain}, ${input.source},
              ${input.status}, ${input.earliestDate}, null,
              ${input.coveredThrough}, ${input.settledThrough}, ${input.sourceRows}, ${input.parsedRows},
              ${input.loadedRows}, ${input.refusedRows}, ${input.countsMatch}, ${input.observedAt})
      on conflict (profile_id, report_type, grain, source) do update set
        status = excluded.status,
        earliest_requested_date = least(report_coverage.earliest_requested_date, excluded.earliest_requested_date),
        earliest_returned_date = least(report_coverage.earliest_returned_date, excluded.earliest_returned_date),
        latest_loaded_date = excluded.latest_loaded_date,
        latest_settled_date = case when ${replaceAccounting} then excluded.latest_settled_date else greatest(report_coverage.latest_settled_date, excluded.latest_settled_date) end,
        source_rows = excluded.source_rows, parsed_rows = excluded.parsed_rows,
        loaded_rows = excluded.loaded_rows, refused_rows = excluded.refused_rows,
        counts_match = excluded.counts_match, observed_at = excluded.observed_at
      where report_coverage.org_id = excluded.org_id
        and ((${replaceAccounting} and
          (report_coverage.status,report_coverage.latest_loaded_date,report_coverage.latest_settled_date,
            report_coverage.source_rows,report_coverage.parsed_rows,report_coverage.loaded_rows,
            report_coverage.refused_rows,report_coverage.counts_match,report_coverage.observed_at)
          is distinct from
          (excluded.status,excluded.latest_loaded_date,excluded.latest_settled_date,
            excluded.source_rows,excluded.parsed_rows,excluded.loaded_rows,
            excluded.refused_rows,excluded.counts_match,excluded.observed_at))
          or (not ${replaceAccounting} and (report_coverage.latest_loaded_date is null
            or excluded.latest_loaded_date > report_coverage.latest_loaded_date
            or (excluded.latest_loaded_date = report_coverage.latest_loaded_date
              and (report_coverage.observed_at is null or excluded.observed_at > report_coverage.observed_at)))))
      returning id
    `;
    const rows = await sql<{
      org_id: string; status: string; counts_match: boolean | null; latest_settled_date: string | null; source_rows: string | null; parsed_rows: string | null;
      loaded_rows: string | null; refused_rows: string | null;
      observed_at: Date | string | null; latest_loaded_date: string | null;
    }[]>`
      select org_id, status, counts_match, latest_settled_date::text, source_rows, parsed_rows, loaded_rows, refused_rows, observed_at,
             latest_loaded_date::text
        from public.report_coverage
       where profile_id = ${input.profileId} and report_type = ${input.reportType}
         and grain = ${input.grain} and source = ${input.source}
    `;
    if (written.length > 1 || rows.length !== 1 || rows[0]?.org_id !== input.orgId) {
      throw new Error(`coverage count mismatch: offered 1, wrote ${written.length}, read ${rows.length}`);
    }
    const row = rows[0]!;
    const sameCounts = [row.source_rows, row.parsed_rows, row.loaded_rows, row.refused_rows]
      .every((value, index) => (value === null ? null : Number(value)) ===
        [input.sourceRows, input.parsedRows, input.loadedRows, input.refusedRows][index]);
    if ((written.length === 1 || replaceAccounting) && (!sameCounts || row.latest_loaded_date !== input.coveredThrough ||
        (replaceAccounting && (row.status !== input.status || row.counts_match !== input.countsMatch || row.latest_settled_date !== input.settledThrough)) ||
        (row.observed_at === null ? null : new Date(row.observed_at).toISOString()) !== new Date(input.observedAt).toISOString())) {
      throw new Error('coverage readback differs from verified promotion counts');
    }
    if (written.length === 0 && (row.observed_at === null ? null : new Date(row.observed_at).getTime()) === new Date(input.observedAt).getTime() &&
        row.latest_loaded_date === input.coveredThrough && !sameCounts) {
      throw new Error('conflicting coverage counts for the same observation');
    }
    return { offered: 1, written: written.length, unchanged: 1 - written.length };
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(write) : handle.sql.begin(write);
}

const grains: Readonly<Record<string, string>> = {
  spCampaigns: 'profile', spTargeting: 'sp_target', spSearchTerm: 'search_term',
  spPlacement: 'placement', sbCampaigns: 'sb', sdCampaigns: 'sd', sbAds: 'creative',
};

interface LedgerCoverageRow {
  id: string; org_id: string; profile_id: string; report_type: string; source: string;
  start_date: string; end_date: string; completed_at: Date | string;
  source_rows: string | null; rows_parsed: string | null; rows_loaded: string | null;
  refused_rows: string | null; counts_match: boolean | null; accounting_complete: boolean | null;
}
const numberOrNull = (value: string | null) => value === null ? null : Number(value);

function fromLedger(row: LedgerCoverageRow, accounting?: ReportCoverageAccounting): ReportCoverageObservation {
  const supplied = accounting === undefined ? undefined : ReportCoverageAccounting.parse(accounting);
  const refused = supplied?.refusedRows ?? numberOrNull(row.refused_rows);
  return {
    orgId: row.org_id, profileId: row.profile_id, reportType: row.report_type,
    grain: grains[row.report_type] ?? row.report_type,
    source: row.source === 'amazon_api' ? 'amazon_reporting_v3'
      : row.source === 'adlabs_backfill' ? 'secondary_import' : row.source,
    status: refused !== null && refused > 0 ? 'partial' : 'complete',
    earliestDate: row.start_date, coveredThrough: row.end_date,
    settledThrough: supplied?.settledThrough ?? null,
    observedAt: supplied?.observedAt ?? new Date(row.completed_at).toISOString(),
    sourceRows: supplied?.sourceRows ?? numberOrNull(row.source_rows),
    parsedRows: supplied?.parsedRows ?? numberOrNull(row.rows_parsed),
    loadedRows: numberOrNull(row.rows_loaded), refusedRows: refused,
    countsMatch: row.accounting_complete ?? row.counts_match,
  };
}

/** Called only after the ledger's existing completion/count assertion succeeds. */
export async function recordReportCoverage(
  handle: QueryHandle, reportRequestId: string, accounting?: ReportCoverageAccounting,
) {
  const rows = await handle.sql<LedgerCoverageRow[]>`
    select id, org_id, profile_id, report_type::text, source, start_date::text, end_date::text, completed_at,
           source_rows, rows_parsed, rows_loaded, refused_rows, counts_match, accounting_complete
      from public.report_requests
     where id = ${reportRequestId} and status = 'completed' and completed_at is not null
  `;
  if (rows.length !== 1) throw new Error(`coverage expected 1 completed request, read ${rows.length}`);
  const row = rows[0]!;
  return upsertReportCoverage(handle, fromLedger(row, accounting), numberOrNull(row.rows_loaded));
}

/** Select one successful observation per ledger group, retaining its furthest covered date. */
export async function backfillReportCoverage(handle: Pick<DbHandle, 'sql'>) {
  const rows = await handle.sql<LedgerCoverageRow[]>`
    select distinct on (org_id, profile_id, report_type, source)
           id, org_id, profile_id, report_type::text, source,
           min(start_date) over (partition by org_id, profile_id, report_type, source)::text as start_date,
           end_date::text, completed_at, source_rows, rows_parsed, rows_loaded, refused_rows,
           counts_match, accounting_complete
      from public.report_requests r
     where status = 'completed' and completed_at is not null
       and not exists (
         select 1 from public.report_promotion_watermarks w
          where r.source = 'amazon_api' and w.org_id = r.org_id and w.profile_id = r.profile_id
            and w.report_type = r.report_type::text and w.source = 'amazon_reporting_v3'
            and w.report_date between r.start_date and r.end_date and w.requested_at > r.requested_at
       )
     order by org_id, profile_id, report_type, source, end_date desc, completed_at desc, id desc
  `;
  let written = 0;
  let unchanged = 0;
  for (const row of rows) {
    const result = await upsertReportCoverage(handle, fromLedger(row), numberOrNull(row.rows_loaded));
    written += result.written;
    unchanged += result.unchanged;
  }
  if (rows.length !== written + unchanged) throw new Error('coverage backfill groups do not reconcile');
  return { groups: rows.length, written, unchanged };
}
