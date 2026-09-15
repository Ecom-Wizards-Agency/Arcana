import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { coreReportIdentity, CORE_REPORT_FAMILIES, CoreReportCapability, CoreReportPromotion, CoreReportRow, type CoreFeatureReportType, type CoreReportConfiguration } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import type { CoreReportEvidence } from '@wizard-ads/shared';

const dailyTables: Record<CoreFeatureReportType, string> = {
  spCampaignMetrics: 'fact_ads_report_periodic', spTargetMetrics: 'fact_ads_report_periodic', spQueryMetrics: 'fact_ads_report_periodic', spPlacementMetrics: 'fact_ads_report_periodic', sbCampaignMetrics: 'fact_ads_report_periodic', sdCampaignMetrics: 'fact_ads_report_periodic', sbAdMetrics: 'fact_ads_report_periodic',
  spAdvertisedProduct: 'fact_advertised_product_daily', sdAdvertisedProduct: 'fact_advertised_product_daily',
  spPurchasedProduct: 'fact_purchased_product_daily', sbPurchasedProduct: 'fact_purchased_product_daily', sdPurchasedProduct: 'fact_purchased_product_daily',
  sbTargeting: 'fact_sb_target_daily', sbSearchTerm: 'fact_sb_search_term_daily', sbCampaignPlacement: 'fact_sb_placement_daily',
  sbAdGroup: 'fact_ad_group_daily', sdAdGroup: 'fact_ad_group_daily', sdTargeting: 'fact_sd_target_daily',
  sdAdGroupMatchedTarget: 'fact_sd_matched_target_daily', sdTargetingMatchedTarget: 'fact_sd_matched_target_daily', sdCampaignsMatchedTarget: 'fact_sd_matched_target_daily',
  spGrossAndInvalids: 'fact_traffic_quality_daily', sbGrossAndInvalids: 'fact_traffic_quality_daily', sdGrossAndInvalids: 'fact_traffic_quality_daily',
};
export function coreReportFactTable(configuration: CoreReportConfiguration): string {
  return configuration.timeUnit === 'SUMMARY' ? 'fact_ads_report_periodic' : dailyTables[configuration.family];
}
export function coreReportVariant(configuration: CoreReportConfiguration): string {
  const spec = CORE_REPORT_FAMILIES[configuration.family];
  const defaults = [...(configuration.timeUnit === 'DAILY' ? ['date'] : ['startDate', 'endDate']), ...spec.required, ...spec.optional, ...spec.defaultMetrics].sort();
  const columns = [...configuration.columns].sort();
  const metricSet = isDeepStrictEqual(columns, defaults) ? '' : `:${createHash('sha256').update(JSON.stringify(columns)).digest('hex').slice(0, 16)}`;
  return `${configuration.timeUnit}:${configuration.attributionGeneration}:v${configuration.version}${metricSet}`;
}
export function coreReportGrain(configuration: CoreReportConfiguration): string {
  return `${CORE_REPORT_FAMILIES[configuration.family].grain}:${coreReportVariant(configuration)}`;
}
export async function readCoreReportCapability(handle: QueryHandle, orgId: string, profileId: string, family: CoreFeatureReportType): Promise<CoreReportCapability | null> {
  const rows = await handle.sql`select org_id as "orgId", profile_id as "profileId", family, approved_configurations as "approvedConfigurations", enabled, status, marketplace, recovery_gate_evidence as "recoveryGateEvidence", sb_multi_ad_groups_enabled as "sbMultiAdGroupsEnabled", multi_touch_evidence as "multiTouchEvidence", observed_at as "observedAt" from public.report_family_capabilities where org_id=${orgId} and profile_id=${profileId} and family=${family}`;
  const row = rows[0];
  return row ? CoreReportCapability.parse({ ...row, observedAt: row['observedAt'] == null ? null : new Date(row['observedAt'] as string).toISOString() }) : null;
}

/** Called inside the existing report completion transaction; never commits independently. */
export async function promoteCoreReportWindow(handle: QueryHandle, raw: CoreReportPromotion): Promise<{ loadedRows: number; observedAt: string; superseded: boolean }> {
  if (!('savepoint' in handle.sql)) throw new Error('family promotion requires completion transaction');
  const input = CoreReportPromotion.parse(raw);
  const { parsed } = input;
  const configuration = parsed.configuration;
  const { family } = configuration;
  const variant = coreReportVariant(configuration);
  const sql = handle.sql;
  await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.orgId, input.profileId, family, variant])},0))`;
  const requests = await sql`select family_configuration, report_type::text, start_date::text, end_date::text, requested_at from public.report_requests where id=${input.reportRequestId} and org_id=${input.orgId} and profile_id=${input.profileId} for update`;
  const request = requests[0];
  if (!request || request['report_type'] !== family || request['start_date'] !== input.startDate || request['end_date'] !== input.endDate || new Date(request['requested_at'] as string).toISOString() !== input.requestedAt || !isDeepStrictEqual(request['family_configuration'], configuration)) throw new Error('family promotion request scope mismatch');
  const attempts = await sql`select * from public.report_family_attempts where report_request_id=${input.reportRequestId}`;
  const previous = attempts[0];
  const normalized = parsed.rows.map((row) => [row.family,row.timeUnit,row.attributionGeneration,row.periodStart,row.periodEnd,Object.entries(row.dimensions).sort(([a],[b]) => a.localeCompare(b)),Object.entries(row.metrics).sort(([a],[b]) => a.localeCompare(b))]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const canonicalSha256 = createHash('sha256').update(JSON.stringify([normalized, parsed.refusals])).digest('hex');
  if (previous && previous['canonical_sha256'] !== canonicalSha256) throw new Error('family replay normalized output changed');
  const observedAt = previous ? new Date(previous['observed_at'] as string).toISOString() : input.observedAt;
  const table = coreReportFactTable(configuration);
  const periods: [string, string][] = [];
  if (configuration.timeUnit === 'SUMMARY') periods.push([input.startDate, input.endDate]);
  else for (let t = Date.parse(input.startDate); t <= Date.parse(input.endDate); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10); periods.push([date, date]);
  }
  if (periods.length > 732) throw new Error('family promotion period bound exceeded');
  const watermarks = await sql`select * from public.report_family_watermarks where org_id=${input.orgId} and profile_id=${input.profileId} and family=${family} and variant=${variant} and period_start <= ${input.endDate} and period_end >= ${input.startDate}`;
  const superseded = watermarks.some((row) => new Date(row['requested_at'] as string).getTime() > Date.parse(input.requestedAt) || (new Date(row['requested_at'] as string).getTime() === Date.parse(input.requestedAt) && row['report_request_id'] !== input.reportRequestId));
  await sql`create temporary table if not exists wp310_family_stage (stage_key text primary key, row_data jsonb not null) on commit drop`;
  await sql`truncate pg_temp.wp310_family_stage`;
  const stageInput = parsed.rows.map((row) => ({ key: JSON.stringify([row.periodStart,row.periodEnd,coreReportIdentity(row)]), row }));
  await sql`insert into pg_temp.wp310_family_stage(stage_key,row_data) select value->>'key',value->'row' from jsonb_array_elements(${JSON.stringify(stageInput)}::jsonb)`;
  const staged = await sql<{ row_data: CoreReportRow }[]>`select row_data from pg_temp.wp310_family_stage order by stage_key`;
  if (staged.length !== parsed.rows.length) throw new Error('family staging count mismatch');
  const stagedKey = (row: CoreReportRow) => JSON.stringify([row.periodStart,row.periodEnd,Object.entries(coreReportIdentity(row))]);
  const canonical = new Map(parsed.rows.map((row) => [stagedKey(row), row]));
  if (staged.some((item) => !isDeepStrictEqual(canonical.get(stagedKey(item.row_data)), item.row_data))) throw new Error('family staged identity/value mismatch');
  let loadedRows = 0;
  if (!superseded && parsed.refusals.length === 0) {
    for (const [start, end] of periods) {
      const month = start.slice(0, 7).replace('-', '');
      const from = `${start.slice(0, 7)}-01`;
      const until = new Date(Date.UTC(Number(start.slice(0, 4)), Number(start.slice(5, 7)), 1)).toISOString().slice(0, 10);
      // Identifiers derive only from the closed table catalog and validated calendar dates.
      await sql.unsafe(`create table if not exists public.${table}_${month} partition of public.${table} for values from ('${from}') to ('${until}')`);
      // Direct partition reads do not inherit the parent's RLS policies.
      // Match the existing partition manager, including Supabase default grants.
      await sql.unsafe(`alter table public.${table}_${month} enable row level security`);
      await sql.unsafe(`revoke all on public.${table}_${month} from anon, authenticated`);
      await sql.unsafe(`grant all on public.${table}_${month} to service_role`);
      const expected = staged.map((item) => CoreReportRow.parse(item.row_data)).filter((row) => row.periodStart === start && row.periodEnd === end);
      if (!previous) {
        await sql`delete from ${sql(`public.${table}`)} where org_id=${input.orgId} and profile_id=${input.profileId} and family=${family} and variant=${variant} and date=${start} and period_end=${end}`;
        const batch = expected.map((row) => ({ row, identity: coreReportIdentity(row) }));
        await sql`insert into ${sql(`public.${table}`)} (org_id,profile_id,date,period_end,family,variant,ad_product,dimensions,identity_dimensions,row_data,report_request_id,observed_at)
          select ${input.orgId}::uuid,${input.profileId}::uuid,${start}::date,${end}::date,${family},${variant},${CORE_REPORT_FAMILIES[family].product},value->'row'->'dimensions',value->'identity',value->'row',${input.reportRequestId}::uuid,${observedAt}::timestamptz
          from jsonb_array_elements(${JSON.stringify(batch)}::jsonb)`;
      }
      const persisted = await sql<{ row_data: CoreReportRow; identity_dimensions: Record<string,string|null> }[]>`select row_data,identity_dimensions from ${sql(`public.${table}`)} where org_id=${input.orgId} and profile_id=${input.profileId} and family=${family} and variant=${variant} and date=${start} and period_end=${end}`;
      const identityKey = (row: CoreReportRow) => JSON.stringify(Object.entries(coreReportIdentity(row)));
      const remaining = new Map(expected.map((row) => [identityKey(row), row]));
      if (remaining.size !== expected.length) throw new Error('duplicate canonical identity');
      for (const actual of persisted) {
        const row = CoreReportRow.parse(actual.row_data);
        const key = identityKey(row);
        if (!isDeepStrictEqual(actual.identity_dimensions, coreReportIdentity(row))) throw new Error('family persisted grain key mismatch');
        if (!isDeepStrictEqual(remaining.get(key), row)) throw new Error('family destination identity/value readback mismatch');
        remaining.delete(key);
      }
      if (remaining.size || persisted.length !== expected.length) throw new Error('family destination row count mismatch');
      loadedRows += persisted.length;
      if (!previous) await sql`insert into public.report_family_watermarks (org_id,profile_id,family,variant,period_start,period_end,report_request_id,requested_at,observed_at,canonical_rows) values (${input.orgId},${input.profileId},${family},${variant},${start},${end},${input.reportRequestId},${input.requestedAt},${observedAt},${expected.length}) on conflict (org_id,profile_id,family,variant,period_start,period_end) do update set report_request_id=excluded.report_request_id, requested_at=excluded.requested_at, observed_at=excluded.observed_at, canonical_rows=excluded.canonical_rows`;
    }
    if (loadedRows !== parsed.rows.length) throw new Error('family rows escaped requested period');
  }
  if (previous && (Number(previous['source_rows']) !== parsed.sourceRows || Number(previous['parsed_rows']) !== parsed.parsedRows || Number(previous['duplicate_rows']) !== parsed.duplicateRows || !isDeepStrictEqual(previous['configuration'], configuration))) throw new Error('family replay accounting changed');
  if (!previous) await sql`insert into public.report_family_attempts (report_request_id,org_id,profile_id,configuration,canonical_sha256,source_rows,parsed_rows,refused_rows,duplicate_rows,canonical_rows,staged_rows,promoted_rows,verified_rows,refusals,observed_at) values (${input.reportRequestId},${input.orgId},${input.profileId},${JSON.stringify(configuration)}::jsonb,${canonicalSha256},${parsed.sourceRows},${parsed.parsedRows},${parsed.refusals.length},${parsed.duplicateRows},${parsed.rows.length},${staged.length},${loadedRows},${loadedRows},${JSON.stringify(parsed.refusals)}::jsonb,${observedAt})`;
  return { loadedRows, observedAt, superseded };
}

/** Scoped readers retain the original row grain and attribution generation. */
export async function readCoreReportFacts(handle: QueryHandle, input: { orgId: string; profileId: string; configuration: CoreReportConfiguration; startDate: string; endDate: string; limit?: number }) {
  const { configuration } = input;
  const limit = Math.min(Math.max(input.limit ?? 1000, 1), 50_000);
  const rows = await handle.sql<{ row_data: CoreReportRow; observed_at: string }[]>`select row_data, observed_at from ${handle.sql(`public.${coreReportFactTable(configuration)}`)} where org_id=${input.orgId} and profile_id=${input.profileId} and family=${configuration.family} and variant=${coreReportVariant(configuration)} and date >= ${input.startDate} and period_end <= ${input.endDate} and (${configuration.timeUnit !== 'SUMMARY'} or (date=${input.startDate} and period_end=${input.endDate})) order by date, identity_hash limit ${limit + 1}`;
  return { rows: rows.slice(0, limit).map((row) => ({ ...CoreReportRow.parse(row.row_data), observedAt: new Date(row.observed_at).toISOString() })), rowCount: Math.min(rows.length, limit), truncated: rows.length > limit };
}

export async function readCoreReportEvidence(handle: QueryHandle, input: { orgId: string; profileId: string; families: readonly CoreFeatureReportType[]; startDate: string; endDate: string; limit?: number }): Promise<CoreReportEvidence[]> {
  const groups = await Promise.all(input.families.map(async (family) => {
    const spec = CORE_REPORT_FAMILIES[family];
    const configuration: CoreReportConfiguration = { version: 1, family, timeUnit: 'DAILY', format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: ['date', ...spec.required, ...spec.optional, ...spec.defaultMetrics] };
    const attempts = await handle.sql<{ configuration: CoreReportConfiguration; refused_rows: number; observed_at: string }[]>`select configuration,refused_rows,observed_at from public.report_family_attempts where org_id=${input.orgId} and profile_id=${input.profileId} and configuration->>'family'=${family} order by observed_at desc,report_request_id`;
    // Column order is not storage identity. Keep the latest attempt for each
    // canonical variant, including refusals from equivalent reordered requests.
    const variants = new Map<string, { configuration: CoreReportConfiguration; attempt?: typeof attempts[number] }>();
    for (const attempt of attempts) {
      const variant = coreReportVariant(attempt.configuration);
      if (!variants.has(variant)) variants.set(variant, { configuration: attempt.configuration, attempt });
    }
    if (!variants.size) variants.set(coreReportVariant(configuration), { configuration });
    return Promise.all([...variants.values()].map(async ({ configuration, attempt }) => {
    const facts = await readCoreReportFacts(handle, { ...input, configuration });
    const [coverage] = await handle.sql`select status, latest_loaded_date::text as through, observed_at from public.report_coverage where org_id=${input.orgId} and profile_id=${input.profileId} and report_type=${family} and grain=${coreReportGrain(configuration)} and source='amazon_reporting_v3'`;
    const [periods] = await handle.sql`select count(*) as n from public.report_family_watermarks where org_id=${input.orgId} and profile_id=${input.profileId} and family=${family} and variant=${coreReportVariant(configuration)} and period_start>=${input.startDate} and period_end<=${input.endDate} and (${configuration.timeUnit !== 'SUMMARY'} or (period_start=${input.startDate} and period_end=${input.endDate}))`;
    const days = configuration.timeUnit === 'SUMMARY' ? 1 : (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000 + 1;
    const partialAttempt = Number(attempt?.['refused_rows'] ?? 0) > 0 && (!coverage?.['observed_at'] || Date.parse(String(attempt?.['observed_at'])) >= Date.parse(String(coverage['observed_at'])));
    const status: CoreReportEvidence['status'] = partialAttempt ? 'partial' : !coverage && facts.rowCount === 0 ? 'unmeasured' : coverage && String(coverage['through']) < input.endDate ? 'stale' : facts.truncated || !coverage || coverage['status'] !== 'complete' || Number(periods?.['n']) !== days ? 'partial' : 'measured';
    return { family, grain: spec.grain, variant: coreReportVariant(configuration), status, rows: facts.rows.map(({ observedAt: _observedAt, ...row }) => row), rowCount: facts.rowCount, truncated: facts.truncated, observedAt: coverage?.['observed_at'] == null ? null : new Date(coverage['observed_at'] as string).toISOString() };
    }));
  }));
  return groups.flat();
}
