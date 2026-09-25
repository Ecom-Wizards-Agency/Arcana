set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- WP-324: Amazon Ads report coverage records the days completed loads returned.
--
-- report_coverage already models a verified span: earliest_returned_date through
-- latest_loaded_date, minus missing_dates. The Ads report lifecycle never filled
-- it, so the grid read "not measured" where facts existed. A span grows only by
-- the union of days a completed, reconciled request left durable evidence for;
-- days between separate requests stay in missing_dates. The worker producer and
-- the one-time backfill below share these functions.

-- Days one completed, reconciled Ads report request loaded, read from its own
-- evidence: per-day promotion watermarks (empty days included) and fact rows
-- that still carry the request's identity. A requested window alone is never
-- evidence. Every branch is bounded by profile, request window and identity.
create or replace function app.report_request_loaded_days(p_report_request_id uuid)
returns setof date
language plpgsql stable
set search_path = pg_catalog, pg_temp
as $$
declare
  v_request record;
begin
  select r.id, r.org_id, r.profile_id, r.report_type::text as report_type,
         r.start_date, r.end_date, r.creative_sync_snapshot_id
    into v_request
    from public.report_requests r
   where r.id = p_report_request_id
     and r.status = 'completed'
     and r.completed_at is not null
     and coalesce(r.accounting_complete, r.counts_match) is true;
  if not found then
    return;
  end if;

  return query
    select distinct evidence.day
      from (
        select w.report_date as day
          from public.report_promotion_watermarks w
         where w.profile_id = v_request.profile_id
           and w.report_type = v_request.report_type
           and w.report_request_id = v_request.id
        union all
        select w.period_start
          from public.report_family_watermarks w
         where w.org_id = v_request.org_id and w.profile_id = v_request.profile_id
           and w.family = v_request.report_type and w.report_request_id = v_request.id
           and w.period_start = w.period_end
        union all
        select f.date from public.fact_profile_daily f
         where v_request.report_type = 'spCampaigns' and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.report_request_id = v_request.id
        union all
        select f.date from public.fact_sp_target_daily f
         where v_request.report_type = 'spTargeting' and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.report_request_id = v_request.id
        union all
        select f.date from public.fact_search_term_daily f
         where v_request.report_type = 'spSearchTerm' and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.report_request_id = v_request.id
        union all
        select f.date from public.fact_placement_daily f
         where v_request.report_type = 'spPlacement' and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.report_request_id = v_request.id
        union all
        select f.date from public.fact_sb_daily f
         where v_request.report_type = 'sbCampaigns' and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.report_request_id = v_request.id
        union all
        select f.date from public.fact_sd_daily f
         where v_request.report_type = 'sdCampaigns' and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.report_request_id = v_request.id
        union all
        -- Creative facts carry the request's snapshot, not its id.
        select f.date from public.fact_creative_daily f
         where v_request.report_type = 'sbAds' and f.org_id = v_request.org_id
           and f.profile_id = v_request.profile_id
           and f.date between v_request.start_date and v_request.end_date
           and f.creative_sync_snapshot_id = v_request.creative_sync_snapshot_id
      ) evidence
     where evidence.day between v_request.start_date and v_request.end_date
     order by evidence.day;
end;
$$;

-- The days one coverage row holds: its span minus the days no load returned.
create or replace function app.report_coverage_held_days(p_coverage_id uuid)
returns date[]
language sql stable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(span.day::date order by span.day), '{}'::date[])
    from public.report_coverage c
    cross join lateral generate_series(
      c.earliest_returned_date::timestamp, c.latest_loaded_date::timestamp, interval '1 day'
    ) as span(day)
   where c.id = p_coverage_id
     and c.earliest_returned_date is not null
     and c.latest_loaded_date is not null
     and not (span.day::date = any(c.missing_dates))
$$;

-- Store exactly these held days: the earliest becomes the verified start and
-- every day between it and the latest loaded day that is not held becomes a
-- missing date. Callers pass the prior held days plus the new ones, so a span
-- never shrinks. Returns 1 when the row changed, 0 when it already matched.
create or replace function app.set_report_coverage_held_days(p_coverage_id uuid, p_days date[])
returns integer
language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  with held as (
    select coalesce(array_agg(distinct day order by day), '{}'::date[]) as days
      from unnest(p_days) as input(day)
     where day is not null
  ), next as (
    select c.id, held.days[1] as first_day,
           greatest(c.latest_loaded_date, held.days[cardinality(held.days)]) as last_day,
           held.days
      from public.report_coverage c, held
     where c.id = p_coverage_id and cardinality(held.days) > 0
  ), gaps as (
    select n.id,
           coalesce(array_agg(span.day::date order by span.day)
             filter (where not (span.day::date = any(n.days))), '{}'::date[]) as missing
      from next n
      cross join lateral generate_series(
        n.first_day::timestamp, n.last_day::timestamp, interval '1 day'
      ) as span(day)
     group by n.id
  ), changed as (
    update public.report_coverage c
       set earliest_returned_date = n.first_day,
           latest_loaded_date = n.last_day,
           missing_dates = g.missing
      from next n
      join gaps g on g.id = n.id
     where c.id = n.id
       and (c.earliest_returned_date, c.latest_loaded_date, c.missing_dates)
         is distinct from (n.first_day, n.last_day, g.missing)
    returning c.id
  )
  select count(*)::integer from changed
$$;

-- Idempotent backfill from existing history. Creates the observation row the
-- WP-256 ledger backfill would create for each Ads ledger group that has none,
-- then claims every day completed, reconciled requests loaded. Core family rows
-- are written by their promotion transaction and are only claimed here.
create or replace function app.backfill_report_coverage_days()
returns table (created_rows integer, claimed_rows integer, changed_rows integer, held_days bigint)
language plpgsql volatile
set search_path = pg_catalog, pg_temp
as $$
declare
  v_claim record;
  v_after date[];
  v_created integer := 0;
  v_claimed integer := 0;
  v_changed integer := 0;
  v_held bigint := 0;
begin
  -- Waits for in-flight producers; none can capture, offer and claim meanwhile.
  lock table public.report_coverage in exclusive mode;

  with ledger_grains(report_type, grain) as (
    values ('spCampaigns', 'profile'), ('spTargeting', 'sp_target'),
           ('spSearchTerm', 'search_term'), ('spPlacement', 'placement'),
           ('sbCampaigns', 'sb'), ('sdCampaigns', 'sd'), ('sbAds', 'creative')
  ), ledger as (
    select distinct on (r.org_id, r.profile_id, r.report_type, r.source)
           r.org_id, r.profile_id, r.report_type::text as report_type, g.grain,
           case r.source when 'amazon_api' then 'amazon_reporting_v3'
                         when 'adlabs_backfill' then 'secondary_import' else r.source end as source,
           min(r.start_date) over (partition by r.org_id, r.profile_id, r.report_type, r.source) as first_start,
           r.end_date, r.completed_at, r.source_rows, r.rows_parsed, r.rows_loaded, r.refused_rows,
           coalesce(r.accounting_complete, r.counts_match) as counts_match
      from public.report_requests r
      join ledger_grains g on g.report_type = r.report_type::text
     where r.status = 'completed' and r.completed_at is not null
       and not (r.source_rows is not null and r.rows_parsed is not null and r.refused_rows is not null
                and r.source_rows <> r.rows_parsed + r.refused_rows)
       and not exists (
         select 1 from public.report_promotion_watermarks w
          where r.source = 'amazon_api' and w.org_id = r.org_id and w.profile_id = r.profile_id
            and w.report_type = r.report_type::text and w.source = 'amazon_reporting_v3'
            and w.report_date between r.start_date and r.end_date and w.requested_at > r.requested_at
       )
     order by r.org_id, r.profile_id, r.report_type, r.source, r.end_date desc, r.completed_at desc, r.id desc
  ), created as (
    insert into public.report_coverage
      (org_id, profile_id, report_type, grain, source, status,
       earliest_requested_date, latest_loaded_date,
       source_rows, parsed_rows, loaded_rows, refused_rows, counts_match, observed_at)
    select l.org_id, l.profile_id, l.report_type, l.grain, l.source,
           case when coalesce(l.refused_rows, 0) > 0 then 'partial' else 'complete' end::public.historical_bootstrap_status,
           l.first_start, l.end_date,
           l.source_rows, l.rows_parsed, l.rows_loaded, l.refused_rows, l.counts_match, l.completed_at
      from ledger l
    on conflict (profile_id, report_type, grain, source) do nothing
    returning 1
  )
  select count(*)::integer into v_created from created;

  for v_claim in
    with ledger_grains(report_type, grain) as (
      values ('spCampaigns', 'profile'), ('spTargeting', 'sp_target'),
             ('spSearchTerm', 'search_term'), ('spPlacement', 'placement'),
             ('sbCampaigns', 'sb'), ('sdCampaigns', 'sd'), ('sbAds', 'creative')
    ), requests as (
      select r.id, r.org_id, r.profile_id, r.report_type::text as report_type,
             case r.source when 'amazon_api' then 'amazon_reporting_v3'
                           when 'adlabs_backfill' then 'secondary_import' else r.source end as source
        from public.report_requests r
       where r.status = 'completed' and r.completed_at is not null
         and coalesce(r.accounting_complete, r.counts_match) is true
    ), claimed as (
      select c.id as coverage_id, loaded.day
        from requests q
        join ledger_grains g on g.report_type = q.report_type
        join public.report_coverage c
          on c.org_id = q.org_id and c.profile_id = q.profile_id and c.report_type = q.report_type
         and c.grain = g.grain and c.source = q.source
       cross join lateral app.report_request_loaded_days(q.id) as loaded(day)
      union all
      select c.id, w.period_start
        from public.report_family_watermarks w
        join requests q on q.id = w.report_request_id and q.source = 'amazon_reporting_v3'
        join public.report_coverage c
          on c.org_id = w.org_id and c.profile_id = w.profile_id and c.report_type = w.family
         and c.source = 'amazon_reporting_v3'
         and c.grain = split_part(c.grain, ':', 1) || ':' || w.variant
       where w.period_start = w.period_end
    )
    select coverage_id, array_agg(distinct day order by day) as days
      from claimed
     group by coverage_id
     order by coverage_id
  loop
    v_claimed := v_claimed + 1;
    v_changed := v_changed + app.set_report_coverage_held_days(
      v_claim.coverage_id, app.report_coverage_held_days(v_claim.coverage_id) || v_claim.days);
    v_after := app.report_coverage_held_days(v_claim.coverage_id);
    if not (v_after @> v_claim.days) then
      raise exception 'report coverage backfill claimed % days for % but holds %',
        cardinality(v_claim.days), v_claim.coverage_id, cardinality(v_after);
    end if;
    v_held := v_held + cardinality(v_after);
  end loop;

  return query select v_created, v_claimed, v_changed, v_held;
end;
$$;

revoke all on function app.report_request_loaded_days(uuid) from public, anon, authenticated;
revoke all on function app.report_coverage_held_days(uuid) from public, anon, authenticated;
revoke all on function app.set_report_coverage_held_days(uuid, date[]) from public, anon, authenticated;
revoke all on function app.backfill_report_coverage_days() from public, anon, authenticated;
grant execute on function app.report_request_loaded_days(uuid) to service_role;
grant execute on function app.report_coverage_held_days(uuid) to service_role;
grant execute on function app.set_report_coverage_held_days(uuid, date[]) to service_role;
grant execute on function app.backfill_report_coverage_days() to service_role;

-- Existing history is claimed once, at deploy; rerunning changes nothing.
select * from app.backfill_report_coverage_days();
