set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Managed migration principals can administer this role without inheriting its
-- function ownership. Borrow only our own grantor edge for this transaction and
-- verify the original authority is restored before the migration can complete.
create temporary table coordinated_ownership_before on commit drop as
select current_user::text as operator_name,
       coalesce((select jsonb_agg(to_jsonb(m) order by m.roleid, m.member, m.grantor)
         from pg_catalog.pg_auth_members m
        where m.roleid = 'openspell_recommendation_executor'::regrole
           or m.member = 'openspell_recommendation_executor'::regrole), '[]'::jsonb) as memberships,
       (select jsonb_agg(jsonb_build_object('oid', n.oid, 'acl', n.nspacl) order by n.oid)
          from pg_catalog.pg_namespace n where n.nspname in ('public', 'app')) as schema_acls;

create function pg_temp.coordinated_ownership_preflight()
returns void language plpgsql set search_path = pg_catalog, pg_temp as $ownership_preflight$
begin
  if exists (select 1 from pg_catalog.pg_auth_members m
    where m.roleid = 'openspell_recommendation_executor'::regrole
      and m.member = current_user::regrole and m.grantor = current_user::regrole) then
    raise exception 'one-time migration refuses an existing self-granted ownership edge';
  end if;
end;
$ownership_preflight$;
select pg_temp.coordinated_ownership_preflight();
drop function pg_temp.coordinated_ownership_preflight();
grant openspell_recommendation_executor to current_user
  with inherit true, set true granted by current_user;

-- Nullable settings preserve historical groups; absence resolves to the reference method.
alter table public.optimization_groups
  add column method_id text,
  add column method_version text,
  add column method_settings jsonb,
  add constraint optimization_group_method_pair check (
    (method_id is null) = (method_version is null) and (( method_id is null and method_version is null)
    or (method_id = 'sp.reference-efficiency' and method_version = 'reference.1')
    or (method_id = 'sp.coordinated-efficiency' and method_version = 'candidate.1'))
  ),
  add constraint optimization_group_method_settings_shape check (
    method_settings is null or jsonb_typeof(method_settings) = 'object'
  );

-- The whole ordered set is stored once in recommendations.inputs.dependencySet.
-- Validate embedded scope even when a caller bypasses TypeScript parsing.
create function app.validate_recommendation_dependency_set()
returns trigger language plpgsql set search_path = pg_catalog, public, app, pg_temp as $$
declare
  v_set jsonb := new.inputs -> 'dependencySet';
  v_step jsonb;
  v_count integer;
begin
  if v_set is null then return new; end if;
  if new.field is distinct from 'control_set' or new.entity_type is distinct from 'campaign' or new.entity_id is distinct from new.campaign_id or new.ad_product is distinct from 'SP'
     or jsonb_typeof(v_set) is distinct from 'object' or v_set ->> 'campaignId' is distinct from new.campaign_id
     or v_set ->> 'id' is distinct from new.run_id::text || ':' || new.campaign_id
     or jsonb_typeof(v_set -> 'changes') is distinct from 'array'
     or jsonb_typeof(v_set -> 'precedenceReasons') is distinct from 'array' then
    raise exception 'invalid recommendation dependency set' using errcode = '23514';
  end if;
  v_count := jsonb_array_length(v_set -> 'changes');
  if v_count < 1 or jsonb_array_length(v_set -> 'precedenceReasons') <> v_count - 1
     or exists (select 1 from jsonb_array_elements(v_set -> 'precedenceReasons') reason
       where jsonb_typeof(reason) <> 'string' or length(trim(reason #>> '{}')) = 0)
     or (select count(distinct jsonb_build_array(step #>> '{entityRef,entityType}', step #>> '{entityRef,entityId}',
          step ->> 'control', case when step ->> 'control' = 'placement_adjustment' then step ->> 'placementKey' else null end))
          from jsonb_array_elements(v_set -> 'changes') step) <> v_count then
    raise exception 'dependency step counts or identities do not reconcile' using errcode = '23514';
  end if;
  for v_step in select value from jsonb_array_elements(v_set -> 'changes') loop
    if (v_step #>> '{entityRef,profileId}') is distinct from new.profile_id::text
       or (v_step #>> '{entityRef,campaignId}') is distinct from new.campaign_id
       or (v_step #>> '{entityRef,adProduct}') is distinct from 'SP'
       or v_step -> 'current' is not distinct from v_step -> 'proposed' then
      raise exception 'dependency step is outside the recommendation scope' using errcode = '23514';
    end if;
    if v_step ->> 'control' = 'target_bid' then
      if v_step ->> 'unit' is distinct from 'currency_per_click'
         or jsonb_typeof(v_step -> 'current') is distinct from 'number' or jsonb_typeof(v_step -> 'proposed') is distinct from 'number'
         or (v_step ->> 'current')::numeric < 0 or (v_step ->> 'proposed')::numeric <= 0
         or not exists (
           select 1 from public.keywords k where v_step #>> '{entityRef,entityType}' = 'keyword'
             and k.org_id = new.org_id and k.profile_id = new.profile_id and k.campaign_id = new.campaign_id
             and k.amazon_id = v_step #>> '{entityRef,entityId}'
           union all
           select 1 from public.targets t where v_step #>> '{entityRef,entityType}' = 'target'
             and t.org_id = new.org_id and t.profile_id = new.profile_id and t.campaign_id = new.campaign_id
             and t.amazon_id = v_step #>> '{entityRef,entityId}'
         ) then raise exception 'invalid dependent target bid' using errcode = '23514'; end if;
    elsif v_step ->> 'control' = 'placement_adjustment' then
      if v_step ->> 'unit' is distinct from 'percentage' or v_step #>> '{entityRef,entityType}' is distinct from 'campaign'
         or v_step #>> '{entityRef,entityId}' is distinct from new.campaign_id
         or not coalesce(v_step ->> 'placementKey' in ('top_of_search', 'rest_of_search', 'product_pages'), false)
         or jsonb_typeof(v_step -> 'current') is distinct from 'number'
         or jsonb_typeof(v_step -> 'proposed') is distinct from 'number'
         or not coalesce(v_step ->> 'current' ~ '^[0-9]+$', false)
         or not coalesce(v_step ->> 'proposed' ~ '^[0-9]+$', false)
         or (v_step ->> 'current')::numeric > 900 or (v_step ->> 'proposed')::numeric > 900 then
        raise exception 'invalid dependent placement adjustment' using errcode = '23514';
      end if;
    else raise exception 'unsupported coordinated control' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;
create trigger recommendation_dependency_scope before insert or update on public.recommendations
for each row execute function app.validate_recommendation_dependency_set();
revoke all on function app.validate_recommendation_dependency_set() from public;

create function app.recommendation_placement_evidence(
  p_org_id uuid, p_profile_id uuid, p_run_id uuid, p_start date, p_end date
) returns jsonb language sql stable security invoker set search_path = pg_catalog, public, app, pg_temp as $$
  with placement_facts as (
    select fact.campaign_id, fact.placement, sum(fact.clicks) as clicks, sum(fact.sales_7d) as sales
      from public.fact_placement_daily fact
      join public.recommendation_run_campaigns member
        on member.org_id = fact.org_id and member.profile_id = fact.profile_id
       and member.campaign_id = fact.campaign_id and member.run_id = p_run_id
      join public.recommendation_runs run
        on run.org_id = member.org_id and run.profile_id = member.profile_id and run.id = member.run_id
     where fact.org_id = p_org_id and fact.profile_id = p_profile_id and fact.ad_product = 'SP'
       and fact.placement in ('top_of_search', 'rest_of_search', 'product_pages')
       and fact.date between p_start and p_end
       and (run.method_id = 'sp.coordinated-efficiency'
         or run.group_snapshot #>> '{method,id}' = 'sp.coordinated-efficiency'
         or run.execution_snapshot #>> '{configuration,method}' = 'sp.coordinated-efficiency'
         or exists (select 1 from jsonb_each(coalesce(run.schedule_context #> '{methodAdmission,campaignMethods}', '{}'::jsonb)) selected
           where selected.value ->> 'id' = 'sp.coordinated-efficiency'))
     group by fact.campaign_id, fact.placement
  ), weighted as (
    select *, sum(clicks) over (partition by campaign_id) as total_clicks from placement_facts
  )
  select coalesce(jsonb_agg(jsonb_build_object('campaignId', campaign_id, 'placement', placement,
    'clicks', clicks, 'sales', sales, 'clickShare', case when total_clicks > 0 then clicks / total_clicks else 0 end)
    order by campaign_id, placement), '[]'::jsonb) from weighted;
$$;
revoke all on function app.recommendation_placement_evidence(uuid, uuid, uuid, date, date) from public;
grant execute on function app.recommendation_placement_evidence(uuid, uuid, uuid, date, date)
  to openspell_recommendation_executor, service_role;
grant select on public.fact_placement_daily to openspell_recommendation_executor;
create policy recommendation_executor_select on public.fact_placement_daily
  for select to openspell_recommendation_executor using (true);

create or replace function public.read_recommendation_inputs_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid,
  p_window_start date,
  p_window_end date
)
returns table (inputs jsonb, group_safety jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_targets jsonb;
  v_campaigns jsonb;
  v_profile_facts jsonb;
  v_group_safety jsonb;
  v_inputs jsonb;
begin
  if p_window_start is null or p_window_end is null or p_window_end < p_window_start then
    raise exception 'recommendation input window is invalid' using errcode = '22023';
  end if;
  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status <> 'running'
     or (p_window_end - p_window_start + 1) <> v_run.lookback_days
     or (v_run.scope_version = 2 and (
       p_window_start is distinct from (v_run.execution_snapshot #>> '{configuration,window,start}')::date
       or p_window_end is distinct from (v_run.execution_snapshot #>> '{configuration,window,end}')::date
     )) then
    raise exception 'recommendation input window does not match the running claim'
      using errcode = '23514';
  end if;

  with performance as (
    select fact.target_id, fact.target_kind::text as target_kind,
           min(fact.ad_product::text) as ad_product, fact.campaign_id,
           fact.ad_group_id, max(fact.match_type::text) as fact_match_type,
           sum(fact.impressions)::bigint as impressions,
           sum(fact.clicks)::bigint as clicks, sum(fact.cost) as cost,
           sum(fact.purchases_7d)::bigint as orders, sum(fact.sales_7d) as sales
      from public.fact_sp_target_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id
            and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id
            and member.campaign_id = fact.campaign_id
       )
     group by fact.target_id, fact.target_kind, fact.campaign_id, fact.ad_group_id
  ), target_rows as (
    select performance.target_id, performance.target_kind,
           performance.ad_product::public.ad_product as ad_product,
           performance.campaign_id, performance.ad_group_id,
           coalesce(keyword.keyword_text, target.resolved_expression,
                    keyword.name, target.name, performance.target_id) as entity_name,
           coalesce(campaign.name, performance.campaign_id) as campaign_name,
           ad_group.name as ad_group_name,
           coalesce(keyword.match_type::text, performance.fact_match_type) as match_type,
           case when coalesce(keyword.deleted_at, target.deleted_at) is not null
                then 'deleted' else coalesce(keyword.state::text, target.state::text) end
             as entity_state,
           case when campaign.deleted_at is not null then 'deleted'
                else campaign.state::text end as campaign_state,
           case when ad_group.deleted_at is not null then 'deleted'
                else ad_group.state::text end as ad_group_state,
           coalesce(keyword.bid, target.bid) as current_bid,
           campaign.budget_amount as daily_budget,
           coalesce(product_ads.advertised_asins, '{}'::text[]) as advertised_asins,
           radar.rank_now, radar.rank_prev, radar.rank_asin,
           radar.rank_observed_on::text as rank_observed_on,
           performance.impressions, performance.clicks, performance.cost,
           performance.orders, performance.sales,
           corridor.date::text as corridor_date,
           corridor.suggested_bid_low, corridor.suggested_bid_median,
           corridor.suggested_bid_high, corridor.bid as corridor_bid,
           corridor.cpc as corridor_cpc
      from performance
      left join public.campaigns campaign
        on campaign.org_id = v_run.org_id and campaign.profile_id = v_run.profile_id
       and campaign.amazon_id = performance.campaign_id
      left join public.ad_groups ad_group
        on ad_group.org_id = v_run.org_id and ad_group.profile_id = v_run.profile_id
       and ad_group.amazon_id = performance.ad_group_id
      left join public.keywords keyword
        on performance.target_kind = 'keyword'
       and keyword.org_id = v_run.org_id and keyword.profile_id = v_run.profile_id
       and keyword.amazon_id = performance.target_id
      left join public.targets target
        on performance.target_kind = 'target'
       and target.org_id = v_run.org_id and target.profile_id = v_run.profile_id
       and target.amazon_id = performance.target_id
      left join lateral (
        select pg_catalog.array_agg(distinct product_ad.asin order by product_ad.asin)
                 filter (where product_ad.asin is not null) as advertised_asins
          from public.product_ads product_ad
         where product_ad.org_id = v_run.org_id
           and product_ad.profile_id = v_run.profile_id
           and product_ad.campaign_id = performance.campaign_id
           and product_ad.ad_group_id = performance.ad_group_id
           and product_ad.deleted_at is null and product_ad.state = 'enabled'
      ) product_ads on true
      left join lateral (
        select candidate.rank_now, candidate.rank_prev, candidate.rank_asin,
               candidate.rank_observed_on
          from (
            select current_rank.organic_rank as rank_now,
                   previous_rank.organic_rank as rank_prev,
                   current_rank.asin as rank_asin,
                   current_rank.observed_on as rank_observed_on,
                   current_rank.id as rank_id
              from public.rank_observations current_rank
              left join lateral (
                select prior.organic_rank
                  from public.rank_observations prior
                 where prior.org_id = v_run.org_id
                   and prior.profile_id = v_run.profile_id
                   and prior.source = current_rank.source
                   and prior.asin = current_rank.asin
                   and pg_catalog.lower(prior.keyword) = pg_catalog.lower(current_rank.keyword)
                   and prior.organic_rank is not null
                   and prior.observed_on < current_rank.observed_on
                 order by prior.observed_on desc, prior.id desc limit 1
              ) previous_rank on true
             where performance.target_kind = 'keyword'
               and current_rank.org_id = v_run.org_id
               and current_rank.profile_id = v_run.profile_id
               and current_rank.source = 'rank_radar'
               and current_rank.asin = any(coalesce(product_ads.advertised_asins, '{}'::text[]))
               and pg_catalog.lower(current_rank.keyword) = pg_catalog.lower(
                 coalesce(keyword.keyword_text, keyword.name, performance.target_id)
               )
               and current_rank.organic_rank is not null
               and current_rank.observed_on <= p_window_end
          ) candidate
         order by (candidate.rank_prev is not null
                   and candidate.rank_now < candidate.rank_prev) desc,
                  candidate.rank_observed_on desc, candidate.rank_id desc
         limit 1
      ) radar on true
      left join lateral (
        select series.date, series.suggested_bid_low, series.suggested_bid_median,
               series.suggested_bid_high, series.bid, series.cpc
          from public.bid_series_daily series
         where series.org_id = v_run.org_id and series.profile_id = v_run.profile_id
           and series.target_id = performance.target_id
           and series.campaign_id = performance.campaign_id
           and series.ad_group_id = performance.ad_group_id
           and series.is_keyword = (performance.target_kind = 'keyword')
         order by series.date desc limit 1
      ) corridor on true
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(target_rows)
           order by target_rows.campaign_id, target_rows.ad_group_id,
                    target_rows.target_id), '[]'::jsonb)
    into v_targets from target_rows;

  with campaign_facts as (
    select 'SP'::text as ad_product, fact.campaign_id,
           sum(fact.impressions)::bigint as impressions,
           sum(fact.clicks)::bigint as clicks, sum(fact.cost) as cost,
           sum(fact.purchases_7d)::bigint as orders, sum(fact.sales_7d) as sales
      from public.fact_sp_target_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id and member.campaign_id = fact.campaign_id
       ) group by fact.campaign_id
    union all
    select 'SB', fact.campaign_id, sum(fact.impressions)::bigint,
           sum(fact.clicks)::bigint, sum(fact.cost),
           sum(fact.purchases_7d)::bigint, sum(fact.sales_7d)
      from public.fact_sb_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id and member.campaign_id = fact.campaign_id
       ) group by fact.campaign_id
    union all
    select 'SD', fact.campaign_id, sum(fact.impressions)::bigint,
           sum(fact.clicks)::bigint, sum(fact.cost),
           sum(fact.purchases_7d)::bigint, sum(fact.sales_7d)
      from public.fact_sd_daily fact
     where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
       and fact.date between p_window_start and p_window_end
       and exists (
         select 1 from public.recommendation_run_campaigns member
          where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
            and member.run_id = v_run.id and member.campaign_id = fact.campaign_id
       ) group by fact.campaign_id
  ), campaign_rows as (
    select facts.ad_product::public.ad_product as ad_product, facts.campaign_id,
           coalesce(campaign.name, facts.campaign_id) as campaign_name,
           case when campaign.deleted_at is not null then 'deleted'
                else campaign.state::text end as state,
           campaign.budget_amount as daily_budget, facts.impressions, facts.clicks,
           facts.cost, facts.orders, facts.sales
      from campaign_facts facts
      left join public.campaigns campaign
        on campaign.org_id = v_run.org_id and campaign.profile_id = v_run.profile_id
       and campaign.amazon_id = facts.campaign_id
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(campaign_rows)
           order by campaign_rows.ad_product, campaign_rows.campaign_id), '[]'::jsonb)
    into v_campaigns from campaign_rows;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(profile_row)
           order by profile_row.date), '[]'::jsonb)
    into v_profile_facts
    from (
      select fact.date::text as date, fact.impressions, fact.clicks, fact.cost,
             fact.purchases_7d as orders, fact.sales_7d as sales
        from public.fact_profile_daily fact
       where fact.org_id = v_run.org_id and fact.profile_id = v_run.profile_id
         and fact.date between least(
           pg_catalog.date_trunc('month', p_window_end)::date, p_window_start
         ) and p_window_end
       order by fact.date
    ) profile_row;

  if pg_catalog.jsonb_array_length(v_targets) > 100000
     or pg_catalog.jsonb_array_length(v_campaigns) > 10000
     or pg_catalog.jsonb_array_length(v_profile_facts) > 400 then
    raise exception 'recommendation execution inputs exceed their row bounds'
      using errcode = '54000';
  end if;

  if v_run.scope_version = 2 then
    select app.recommendation_campaign_safety(v_run.org_id, v_run.profile_id,
      array_agg(member.campaign_id order by member.campaign_id collate "C"))
      into v_group_safety
      from public.recommendation_run_campaigns member
     where member.org_id = v_run.org_id and member.profile_id = v_run.profile_id
       and member.run_id = v_run.id;
  elsif v_run.group_id is not null then
    with exported as (
      select distinct recommendation.id
        from public.recommendations recommendation
        join public.recommendation_runs prior_run
          on prior_run.id = recommendation.run_id
         and prior_run.org_id = v_run.org_id
         and prior_run.profile_id = v_run.profile_id
         and prior_run.group_id = v_run.group_id
        join public.apply_rows apply_row
          on apply_row.org_id = v_run.org_id
         and apply_row.profile_id = v_run.profile_id
         and apply_row.recommendation_id = recommendation.id
        join public.apply_batches batch
          on batch.org_id = v_run.org_id and batch.profile_id = v_run.profile_id
         and batch.id = apply_row.batch_id and batch.status in ('staged', 'applied')
       where recommendation.org_id = v_run.org_id
         and recommendation.profile_id = v_run.profile_id
    ), evidence as (
      select exported.id, observation.evidence_state, observation.decision
        from exported
        left join lateral (
          select candidate.evidence_state::text as evidence_state,
                 candidate.decision::text as decision
            from public.recommendation_observations candidate
           where candidate.org_id = v_run.org_id
             and candidate.profile_id = v_run.profile_id
             and candidate.group_id = v_run.group_id
             and candidate.recommendation_id = exported.id
           order by candidate.observed_at desc, candidate.id desc limit 1
        ) observation on true
    ), counts as (
      select pg_catalog.count(*)::integer as exported_recommendations,
             pg_catalog.count(*) filter (
               where evidence_state is null or evidence_state <> 'complete'
             )::integer as incomplete_observations,
             pg_catalog.count(*) filter (where decision = 'hold')::integer as hold_decisions,
             pg_catalog.count(*) filter (where decision = 'revert')::integer as revert_decisions
        from evidence
    )
    select pg_catalog.jsonb_build_object(
      'mayPropose', counts.revert_decisions = 0
                    and counts.incomplete_observations = 0
                    and counts.hold_decisions = 0,
      'exportedRecommendations', counts.exported_recommendations,
      'incompleteObservations', counts.incomplete_observations,
      'holdDecisions', counts.hold_decisions,
      'revertDecisions', counts.revert_decisions,
      'reason', case
        when counts.revert_decisions > 0 then
          counts.revert_decisions::text || ' exported recommendation(s) require reversion review before another group preview'
        when counts.incomplete_observations > 0 or counts.hold_decisions > 0 then
          greatest(counts.incomplete_observations, counts.hold_decisions)::text
            || ' exported recommendation(s) are awaiting complete synchronized evidence; hold and do not compound'
        when counts.exported_recommendations = 0 then
          'No prior exported recommendation requires observation.'
        else 'Every active exported recommendation has complete continue evidence.'
      end
    ) into v_group_safety from counts;
  else
    v_group_safety := null;
  end if;

  v_inputs := pg_catalog.jsonb_build_object(
    'targets', v_targets, 'campaigns', v_campaigns, 'profileFacts', v_profile_facts,
    'marketplaceProfile', (select jsonb_build_object('countryCode',p.country_code,'region',p.region,'currencyCode',p.currency_code)
      from public.ad_profiles p where p.org_id=v_run.org_id and p.id=v_run.profile_id),
    'placementFacts', app.recommendation_placement_evidence(v_run.org_id, v_run.profile_id, v_run.id, p_window_start, p_window_end)
  );
  if pg_catalog.octet_length(v_inputs::text) > 67108864 then
    raise exception 'recommendation execution inputs exceed the byte bound'
      using errcode = '54000';
  end if;
  return query select v_inputs, v_group_safety;
end;
$$;


revoke openspell_recommendation_executor from current_user granted by current_user;

create function pg_temp.coordinated_ownership_postflight()
returns void language plpgsql set search_path = pg_catalog, pg_temp as $ownership_postflight$
declare v_before record; v_memberships jsonb; v_schema_acls jsonb;
begin
  select * into strict v_before from pg_temp.coordinated_ownership_before;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid, m.member, m.grantor), '[]'::jsonb)
    into v_memberships from pg_catalog.pg_auth_members m
   where m.roleid = 'openspell_recommendation_executor'::regrole
      or m.member = 'openspell_recommendation_executor'::regrole;
  select jsonb_agg(jsonb_build_object('oid', n.oid, 'acl', n.nspacl) order by n.oid)
    into v_schema_acls from pg_catalog.pg_namespace n where n.nspname in ('public', 'app');
  if current_user <> v_before.operator_name or v_memberships is distinct from v_before.memberships
     or v_schema_acls is distinct from v_before.schema_acls then
    raise exception 'one-time migration ownership authority was not restored';
  end if;
end;
$ownership_postflight$;
select pg_temp.coordinated_ownership_postflight();
drop function pg_temp.coordinated_ownership_postflight();

create or replace function app.one_time_rpc_snapshot_valid(p_snapshot jsonb)
returns boolean
language plpgsql
stable
set search_path = pg_catalog
as $$
declare
  v_config jsonb;
  v_window jsonb;
  v_key text;
  v_number double precision;
  v_start date;
  v_end date;
  v_today date;
begin
  if p_snapshot -> 'version' = '2'::jsonb then
    v_config := p_snapshot -> 'configuration';
    if p_snapshot ->> 'methodId' is distinct from 'sp.coordinated-efficiency'
       or p_snapshot ->> 'methodVersion' is distinct from 'candidate.1'
       or v_config -> 'version' is distinct from '2'::jsonb
       or v_config ->> 'method' is distinct from 'sp.coordinated-efficiency'
       or jsonb_typeof(v_config -> 'exposureCeiling') is distinct from 'number'
       or jsonb_typeof(v_config -> 'minClicksPerPlacement') is distinct from 'number'
       or not coalesce(v_config ->> 'placementEvidenceRequirements' in ('single_target', 'validated_homogeneous'), false)
       or (v_config ->> 'exposureCeiling')::numeric <= 0
       or (v_config ->> 'minClicksPerPlacement')::numeric < 1
       or (v_config ->> 'minClicksPerPlacement')::numeric <> trunc((v_config ->> 'minClicksPerPlacement')::numeric) then
      return false;
    end if;
    return app.one_time_rpc_snapshot_valid((p_snapshot - array['methodId','methodVersion'])
      || jsonb_build_object('version', 1, 'configuration',
        (v_config - array['exposureCeiling','minClicksPerPlacement','placementEvidenceRequirements'])
          || jsonb_build_object('version', 1, 'method', 'sp.reference-efficiency')));
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) is distinct from 'object'
     or p_snapshot - array['version','configuration','profileTimezone','admittedAt','profileToday'] <> '{}'::jsonb
     or p_snapshot -> 'version' is distinct from '1'::jsonb
     or jsonb_typeof(p_snapshot -> 'profileTimezone') is distinct from 'string'
     or jsonb_typeof(p_snapshot -> 'admittedAt') is distinct from 'string'
     or jsonb_typeof(p_snapshot -> 'profileToday') is distinct from 'string'
     or not coalesce(p_snapshot ->> 'admittedAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$', false)
     or not coalesce(p_snapshot ->> 'profileToday' ~ '^\d{4}-\d{2}-\d{2}$', false) then
    return false;
  end if;
  v_config := p_snapshot -> 'configuration';
  if jsonb_typeof(v_config) is distinct from 'object'
     or v_config - array['version','method','targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap','window'] <> '{}'::jsonb
     or v_config -> 'version' is distinct from '1'::jsonb
     or not coalesce(v_config ->> 'method' in ('rpc', 'sp.reference-efficiency'), false) then
    return false;
  end if;
  foreach v_key in array array['targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap'] loop
    if jsonb_typeof(v_config -> v_key) is distinct from 'number' then return false; end if;
    v_number := (v_config ->> v_key)::double precision;
    if v_number < 0 or v_number in ('Infinity'::double precision, '-Infinity'::double precision, 'NaN'::double precision) then
      return false;
    end if;
  end loop;
  if (v_config ->> 'targetAcos')::double precision <= 0
     or (v_config ->> 'bidCeiling')::double precision <= 0
     or (v_config ->> 'bidFloor')::double precision > (v_config ->> 'bidCeiling')::double precision
     or (v_config ->> 'bidDecreaseCap')::double precision > 1 then return false; end if;
  v_window := v_config -> 'window';
  if jsonb_typeof(v_window) is distinct from 'object'
     or v_window - array['start','end'] <> '{}'::jsonb
     or not coalesce(v_window ->> 'start' ~ '^\d{4}-\d{2}-\d{2}$', false)
     or not coalesce(v_window ->> 'end' ~ '^\d{4}-\d{2}-\d{2}$', false) then return false; end if;
  v_start := (v_window ->> 'start')::date;
  v_end := (v_window ->> 'end')::date;
  v_today := (p_snapshot ->> 'profileToday')::date;
  return v_end >= v_start and v_end - v_start < 366 and v_end < v_today
     and v_today = ((p_snapshot ->> 'admittedAt')::timestamptz at time zone (p_snapshot ->> 'profileTimezone'))::date;
exception when invalid_text_representation or numeric_value_out_of_range
  or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
  return false;
end;
$$;
revoke all on function app.one_time_rpc_snapshot_valid(jsonb) from public;
grant execute on function app.one_time_rpc_snapshot_valid(jsonb)
  to authenticated, service_role, openspell_recommendation_executor;

create or replace function app.one_time_rpc_snapshot_fingerprint(p_snapshot jsonb)
returns text
language plpgsql
stable
strict
set search_path = pg_catalog, app
as $$
declare
  v_config jsonb := p_snapshot -> 'configuration';
  v_values text[] := array['1','1',v_config ->> 'method'];
  v_key text;
  v_number double precision;
  v_value text;
  v_preimage text := E'openspell.one-time-rpc.snapshot.v1\n';
begin
  if not app.one_time_rpc_snapshot_valid(p_snapshot) then
    raise exception 'invalid one-time RPC snapshot' using errcode = '22023';
  end if;
  if p_snapshot -> 'version' = '2'::jsonb then
    v_values := array['2','2',v_config ->> 'method',p_snapshot ->> 'methodVersion'];
    v_preimage := E'openspell.coordinated.snapshot.v2\n';
  end if;
  foreach v_key in array array['targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap'] loop
    v_number := (v_config ->> v_key)::double precision;
    if v_number = 0 then v_number := 0; end if;
    v_values := array_append(v_values, encode(float8send(v_number), 'hex'));
  end loop;
  if p_snapshot -> 'version' = '2'::jsonb then
    foreach v_key in array array['exposureCeiling','minClicksPerPlacement'] loop
      v_values := array_append(v_values, encode(float8send((v_config ->> v_key)::double precision), 'hex'));
    end loop;
    v_values := array_append(v_values, v_config ->> 'placementEvidenceRequirements');
  end if;
  v_values := v_values || array[v_config #>> '{window,start}', v_config #>> '{window,end}',
    p_snapshot ->> 'profileTimezone', p_snapshot ->> 'admittedAt', p_snapshot ->> 'profileToday'];
  foreach v_value in array v_values loop
    v_preimage := v_preimage || octet_length(v_value)::text || ':' || v_value || E'\n';
  end loop;
  return encode(sha256(convert_to(v_preimage, 'UTF8')), 'hex');
end;
$$;
revoke all on function app.one_time_rpc_snapshot_fingerprint(jsonb) from public;
grant execute on function app.one_time_rpc_snapshot_fingerprint(jsonb)
  to authenticated, service_role, openspell_recommendation_executor;

-- Current executable catalogue: reference.1 is stable; candidate.1 remains draft.
create or replace function app.assert_sp_write_method_evidence(p_plan uuid, p_required boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public, app, pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; v_evidence jsonb; v_source jsonb;
  v_inputs jsonb; v_method jsonb;
begin
  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan;
  select artifact into strict v_evidence from public.sp_write_preview_evidence
    where org_id = v_plan.org_id and profile_id = v_plan.profile_id and plan_id = p_plan;
  if v_evidence ->> 'schemaVersion' = 'openspell.sp-write-preview-evidence.v2' then return; end if;
  if v_evidence ->> 'schemaVersion' is distinct from 'openspell.sp-write-preview-evidence.v1' then
    raise exception 'Unknown source evidence' using errcode = '22023';
  end if;
  for v_source in select value from jsonb_array_elements(v_evidence #> '{provenance,rows}') loop
    select inputs into strict v_inputs from public.recommendations
      where org_id = v_plan.org_id and profile_id = v_plan.profile_id
        and id = (v_source ->> 'recommendationId')::uuid
        and run_id = (v_source ->> 'runId')::uuid for share;
    v_method := v_source -> 'method';
    if v_method is null and not p_required and not (v_inputs ?| array['methodId','methodVersion','trace','settingSources']) then
      continue;
    end if;
    if p_required and v_method is not null and (v_method ->> 'methodId' is distinct from 'sp.reference-efficiency'
      or v_method ->> 'methodVersion' is distinct from 'reference.1') then
      raise exception 'method_not_executable' using errcode = '42501';
    end if;
    if v_method is null or coalesce(length(v_inputs ->> 'methodId'),0) = 0
      or coalesce(length(v_inputs ->> 'methodVersion'),0) = 0
      or jsonb_typeof(v_inputs -> 'trace') is distinct from 'object'
      or jsonb_typeof(v_inputs -> 'settingSources') is distinct from 'object'
      or v_method is distinct from jsonb_build_object(
        'methodId',v_inputs ->> 'methodId','methodVersion',v_inputs ->> 'methodVersion',
        'traceSha256',app.sp_write_sha256((v_inputs -> 'trace')::text),
        'settingSourcesSha256',app.sp_write_sha256((v_inputs -> 'settingSources')::text)) then
      raise exception 'Recommendation method evidence is missing or changed' using errcode = '55000';
    end if;
  end loop;
end;
$$;

-- Ordered controls retain the existing apply-batch source and its legacy count invariant.
alter table public.apply_batches add column dependency_sets_count integer;
alter table public.apply_rows add column dependency_set_id text, add column dependency_step_index integer,
  add constraint apply_rows_dependency_pair check ((dependency_set_id is null) = (dependency_step_index is null)
    and (dependency_step_index is null or dependency_step_index between 0 and 499));
create unique index apply_rows_dependency_step_key on public.apply_rows(batch_id, dependency_set_id, dependency_step_index)
  where dependency_set_id is not null;
alter table public.apply_batches drop constraint apply_batches_export_counts;
alter table public.apply_batches add constraint apply_batches_export_counts check (
  exported_proposals >= 0 and reversible_rows >= 0 and unsupported_rows >= 0
  and case when dependency_sets_count is null then case source_kind
    when 'legacy_export' then exported_proposals = reversible_rows + unsupported_rows
    when 'mcp_keyword_proposals' then exported_proposals = 0 and reversible_rows between 1 and 500 and unsupported_rows = 0 end
    else source_kind = 'legacy_export' and dependency_sets_count > 0 and exported_proposals = dependency_sets_count
      and unsupported_rows = 0 and reversible_rows >= dependency_sets_count end);
alter table public.sp_write_plan_actions drop constraint sp_write_plan_actions_entity_key;
alter type public.sp_write_refusal_reason add value 'dependency_failed';
alter type public.sp_write_refusal_reason add value 'dependency_changed';
alter type public.sp_write_refusal_reason add value 'source_changed';

-- This catalogue is migration-owned authority, never caller-supplied release metadata.
create table app.sp_write_method_releases (
  method_id text not null, method_version text not null,
  release_state text not null check (release_state in ('draft','reviewed','shadow','pilot','stable')),
  primary key(method_id, method_version)
);
alter table app.sp_write_method_releases enable row level security;
insert into app.sp_write_method_releases values
  ('sp.reference-efficiency','reference.1','stable'), ('sp.coordinated-efficiency','candidate.1','draft');
revoke all on app.sp_write_method_releases from public, anon, authenticated, service_role;

create function app.assert_sp_dependency_plan_v3(p_plan jsonb)
returns void language plpgsql set search_path=pg_catalog,public,app,pg_temp as $$
declare v_group jsonb; v_action jsonb; v_last jsonb; v_key text; v_placement text;
  v_action_id text; v_ids jsonb := '[]'::jsonb; v_prior jsonb; v_seen jsonb := '{}'::jsonb;
  v_source_ids text[] := array[]::text[];
begin
  if p_plan ->> 'schemaVersion' is distinct from 'openspell.sp-write-plan.v3'
    or p_plan ->> 'direction' is distinct from 'forward'
    or not coalesce(app.sp_write_exact_json_keys(p_plan->'source',array['kind','applyBatchId','guardrailSnapshotFingerprint','provenanceSnapshotFingerprint']),false)
    or p_plan #>> '{source,kind}' is distinct from 'apply_batch'
    or jsonb_typeof(p_plan->'dependencySets') is distinct from 'array'
    or jsonb_array_length(p_plan->'dependencySets') not between 1 and 500
    or jsonb_typeof(p_plan->'actions') is distinct from 'array'
    or jsonb_array_length(p_plan->'actions') not between 1 and 500
    or not coalesce(app.sp_write_exact_json_keys(p_plan->'counts',array['logicalChanges','providerRows','uniqueEntities','byRoute']),false)
    or not coalesce(app.sp_write_exact_json_keys(p_plan#>'{counts,byRoute}',array['sp.v3.campaigns.update','sp.v3.ad_groups.update','sp.v3.keywords.update','sp.v3.targets.update','sp.v3.product_ads.update']),false)
    then raise exception 'invalid dependency plan' using errcode='22023'; end if;
  if (select count(distinct x->>'dependencySetId') from jsonb_array_elements(p_plan->'dependencySets') x)
      <> jsonb_array_length(p_plan->'dependencySets')
    or (select count(distinct x->>'recommendationId') from jsonb_array_elements(p_plan->'dependencySets') x)
      <> jsonb_array_length(p_plan->'dependencySets') then
    raise exception 'dependency identities repeat' using errcode='22023'; end if;
  for v_group in select value from jsonb_array_elements(p_plan->'dependencySets') loop
    if not coalesce(app.sp_write_exact_json_keys(v_group,array['dependencySetId','recommendationId','dependencySetSha256','actionIds','precedenceReasons']),false)
      or coalesce(length(v_group->>'dependencySetId'),0)=0
      or not coalesce(v_group->>'dependencySetSha256' ~ '^[a-f0-9]{64}$',false)
      or jsonb_typeof(v_group->'actionIds') is distinct from 'array'
      or jsonb_array_length(v_group->'actionIds')=0
      or jsonb_typeof(v_group->'precedenceReasons') is distinct from 'array'
      or jsonb_array_length(v_group->'precedenceReasons')<>jsonb_array_length(v_group->'actionIds')-1
      or exists(select 1 from jsonb_array_elements(v_group->'precedenceReasons') reason
        where jsonb_typeof(reason)<>'string' or length(trim(reason#>>'{}'))=0) then
      raise exception 'dependency group malformed' using errcode='22023'; end if;
    perform (v_group->>'recommendationId')::uuid;
    v_prior := '{}'::jsonb;
    for v_action_id in select value from jsonb_array_elements_text(v_group->'actionIds') loop
      select action into strict v_action from jsonb_array_elements(p_plan->'actions') action where action->>'actionId'=v_action_id;
      v_ids := v_ids || jsonb_build_array(v_action_id);
      if jsonb_typeof(v_action->'sources') is distinct from 'array' or jsonb_array_length(v_action->'sources')<>1
        or not coalesce(app.sp_write_exact_json_keys(v_action#>'{sources,0}',array['kind','applyRowId','changeKey']),false)
        or v_action#>>'{sources,0,kind}' is distinct from 'apply_row'
        or (v_action#>>'{sources,0,applyRowId}')=any(v_source_ids) then
        raise exception 'dependency source must be one unique apply row' using errcode='22023'; end if;
      perform (v_action#>>'{sources,0,applyRowId}')::uuid;
      v_source_ids:=array_append(v_source_ids,v_action#>>'{sources,0,applyRowId}');
      v_key := (v_action->>'routeKey')||':'||app.sp_write_action_entity_id(v_action);
      if v_seen ? v_key and v_seen->>v_key is distinct from v_group->>'dependencySetId' then
        raise exception 'dependency sets overlap an entity' using errcode='22023'; end if;
      v_seen := v_seen || jsonb_build_object(v_key,v_group->>'dependencySetId');
      if v_action->>'routeKey' in ('sp.v3.keywords.update','sp.v3.targets.update') then
        if not coalesce(app.sp_write_exact_json_keys(v_action->'changes',array['bid']),false)
          or not coalesce(app.sp_write_exact_json_keys(v_action->'entity',array[case when v_action->>'routeKey'='sp.v3.keywords.update' then 'keywordId' else 'targetId' end]),false)
          or v_action#>>'{sources,0,changeKey}' is distinct from (case when v_action->>'routeKey'='sp.v3.keywords.update' then 'keyword.bid' else 'target.bid' end)
          or (v_action#>>'{changes,bid,expected,amount}')::numeric<0
          or (v_action#>>'{changes,bid,requested,amount}')::numeric<=0
          or v_action#>'{changes,bid,expected}'=v_action#>'{changes,bid,requested}'
          or v_action#>>'{changes,bid,expected,currencyCode}' is distinct from p_plan#>>'{providerScope,currencyCode}'
          or v_action#>>'{changes,bid,requested,currencyCode}' is distinct from p_plan#>>'{providerScope,currencyCode}'
          or v_prior ? v_key then raise exception 'invalid dependent bid' using errcode='22023'; end if;
        v_prior:=v_prior||jsonb_build_object(v_key,true);
      elsif v_action->>'routeKey'='sp.v3.campaigns.update' then
        if not coalesce(app.sp_write_exact_json_keys(v_action->'changes',array['placement']),false)
          or not coalesce(app.sp_write_exact_json_keys(v_action->'entity',array['campaignId']),false)
          or not coalesce(app.sp_write_exact_json_keys(v_action#>'{changes,placement}',array['expected','requested','approvedPlacementKeys']),false)
          or jsonb_typeof(v_action#>'{changes,placement,approvedPlacementKeys}') is distinct from 'array'
          or jsonb_array_length(v_action#>'{changes,placement,approvedPlacementKeys}')<>1 then
          raise exception 'invalid dependent placement' using errcode='22023'; end if;
        v_placement:=v_action#>>'{changes,placement,approvedPlacementKeys,0}';
        if not coalesce(v_placement in ('top_of_search','rest_of_search','product_pages'),false)
          or v_action#>>'{sources,0,changeKey}' is distinct from 'campaign.placement.'||v_placement
          or v_prior ? (v_key||':'||v_placement) then raise exception 'dependent placement key repeats' using errcode='22023'; end if;
        v_last:=v_prior->v_key;
        if v_last is not null and v_last is distinct from v_action#>'{changes,placement,expected}' then
          raise exception 'dependent placement expected state breaks sequence' using errcode='22023'; end if;
        v_prior:=v_prior||jsonb_build_object(v_key,v_action#>'{changes,placement,requested}',v_key||':'||v_placement,true);
      else raise exception 'unsupported dependent control' using errcode='22023'; end if;
    end loop;
  end loop;
  if v_ids is distinct from (select jsonb_agg(action->'actionId' order by ordinality) from jsonb_array_elements(p_plan->'actions') with ordinality a(action,ordinality))
    or (select count(distinct id) from jsonb_array_elements_text(v_ids) id)<>jsonb_array_length(v_ids)
    or (p_plan#>>'{counts,providerRows}')::integer<>jsonb_array_length(v_ids)
    or (p_plan#>>'{counts,logicalChanges}')::integer<>jsonb_array_length(v_ids) then
    raise exception 'dependency action order or step counts differ' using errcode='22023'; end if;
end;
$$;
revoke all on function app.assert_sp_dependency_plan_v3(jsonb) from public,anon,authenticated,service_role;

-- Ordered dependency export retains the accepted source and every scalar mirror check.
create or replace function app.resolve_apply_current_value(
  p_org_id uuid,
  p_profile_id uuid,
  p_entity_type public.apply_entity_type,
  p_entity_id text,
  p_field text
)
returns table (
  supported boolean,
  present boolean,
  current_value jsonb,
  current_synced_at timestamptz
)
language plpgsql
stable
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_field text := app.canonical_apply_field(p_entity_type::text, p_field);
begin
  supported := false;
  present := false;
  current_value := null;
  current_synced_at := null;

  if p_entity_type = 'keyword' and v_field in ('bid', 'state') then
    supported := true;
    select k.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(k.bid) else to_jsonb(k.state::text) end,
           k.synced_at
      into present, current_value, current_synced_at
      from public.keywords k
     where k.org_id = p_org_id and k.profile_id = p_profile_id and k.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'target' and v_field in ('bid', 'state') then
    supported := true;
    select t.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(t.bid) else to_jsonb(t.state::text) end,
           t.synced_at
      into present, current_value, current_synced_at
      from public.targets t
     where t.org_id = p_org_id and t.profile_id = p_profile_id and t.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'campaign' and v_field in ('tos_modifier','ros_modifier','pp_modifier') then
    supported := true;
    select c.deleted_at is null and c.ad_product='SP' and jsonb_typeof(c.placement_bidding ->
             case v_field when 'tos_modifier' then 'topOfSearch' when 'ros_modifier' then 'restOfSearch' else 'productPages' end)='number',
           c.placement_bidding -> case v_field when 'tos_modifier' then 'topOfSearch' when 'ros_modifier' then 'restOfSearch' else 'productPages' end,
           c.synced_at
      into present,current_value,current_synced_at from public.campaigns c
      where c.org_id=p_org_id and c.profile_id=p_profile_id and c.amazon_id=p_entity_id;
    if not found then present:=false; end if;
  elsif p_entity_type = 'campaign' and v_field in ('budget', 'state') then
    supported := true;
    select c.deleted_at is null,
           case
             when v_field = 'budget' then to_jsonb(c.budget_amount)
             else to_jsonb(c.state::text)
           end,
           c.synced_at
      into present, current_value, current_synced_at
      from public.campaigns c
     where c.org_id = p_org_id and c.profile_id = p_profile_id and c.amazon_id = p_entity_id;
    if not found then present := false; end if;
  elsif p_entity_type = 'ad_group' and v_field in ('bid', 'state') then
    supported := true;
    select a.deleted_at is null,
           case when v_field = 'bid' then to_jsonb(a.default_bid)
                else to_jsonb(a.state::text) end,
           a.synced_at
      into present, current_value, current_synced_at
      from public.ad_groups a
     where a.org_id = p_org_id and a.profile_id = p_profile_id and a.amazon_id = p_entity_id;
    if not found then present := false; end if;
  end if;

  return next;
end;
$$;

grant execute on function app.resolve_apply_current_value(uuid, uuid, public.apply_entity_type, text, text)
  to authenticated, service_role;

create or replace function app.stamp_review_export(p_org uuid,p_profile uuid,p_run uuid,p_batch uuid,p_ids uuid[])
returns setof uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare v_count integer;
begin
  perform app.lock_review_recommendations(p_org,p_profile,p_run);
  if cardinality(p_ids) is null or cardinality(p_ids)=0
    or cardinality(p_ids)<>(select count(distinct id) from unnest(p_ids) id)
    or not exists(select 1 from public.apply_batches where org_id=p_org and profile_id=p_profile
      and id=p_batch and created_by=auth.uid() and status='staged' and source_kind='legacy_export'
      and exported_proposals=cardinality(p_ids))
    or (select count(*) from public.recommendations where org_id=p_org and profile_id=p_profile
      and run_id=p_run and id=any(p_ids) and status='accepted')<>cardinality(p_ids) then
    raise exception using errcode='42501',message='Resource not found';
  end if;
  if (select count(*) from public.apply_rows where org_id=p_org and profile_id=p_profile and batch_id=p_batch)
       <> (select coalesce(sum(case when inputs ? 'dependencySet' then jsonb_array_length(inputs#>'{dependencySet,changes}')
                   when entity_type::text in ('keyword','target','campaign','ad_group') then 1 else 0 end),0)
             from public.recommendations where org_id=p_org and profile_id=p_profile and id=any(p_ids))
    or exists(select 1 from public.recommendations r where r.org_id=p_org and r.profile_id=p_profile and r.id=any(p_ids)
      and (select count(*) from public.apply_rows a where a.org_id=p_org and a.profile_id=p_profile
        and a.batch_id=p_batch and a.recommendation_id=r.id)
        <> case when r.inputs ? 'dependencySet' then jsonb_array_length(r.inputs#>'{dependencySet,changes}')
             when r.entity_type::text in ('keyword','target','campaign','ad_group') then 1 else 0 end)
    or not exists(select 1 from public.apply_batches b where b.id=p_batch and b.org_id=p_org and b.profile_id=p_profile
      and b.reversible_rows=(select count(*) from public.apply_rows where batch_id=p_batch and org_id=p_org and profile_id=p_profile)
      and b.unsupported_rows=(select count(*) from public.recommendations where org_id=p_org and profile_id=p_profile
        and id=any(p_ids) and entity_type::text not in ('keyword','target','campaign','ad_group'))
      and ((b.dependency_sets_count is null and not exists(select 1 from public.recommendations
          where org_id=p_org and profile_id=p_profile and id=any(p_ids) and inputs ? 'dependencySet'))
        or (b.dependency_sets_count=cardinality(p_ids) and not exists(select 1 from public.recommendations
          where org_id=p_org and profile_id=p_profile and id=any(p_ids) and not(inputs ? 'dependencySet'))))) then
    raise exception using errcode='55000',message='Export row coverage differs';
  end if;
  perform app.lock_review_export_rows(p_org,p_profile,null,coalesce((select jsonb_agg(jsonb_build_object(
    'entityType',entity_type,'entityId',entity_id,'field',field)) from public.apply_rows
      where org_id=p_org and profile_id=p_profile and batch_id=p_batch),'[]'::jsonb));
  if exists(select 1 from public.apply_rows a cross join lateral app.resolve_apply_current_value(
    p_org,p_profile,a.entity_type,a.entity_id,a.field) state
    where a.org_id=p_org and a.profile_id=p_profile and a.batch_id=p_batch
      and (not state.supported or not state.present or state.current_value is distinct from a.old_value)) then
    raise exception using errcode='55000',message='Export mirror changed';
  end if;
  -- Every row is bound either to one scalar recommendation or one ordered control.
  if exists(select 1 from public.apply_rows a
    left join public.recommendations r on r.id=a.recommendation_id and r.org_id=a.org_id and r.profile_id=a.profile_id
    left join public.recommendation_proposal_revisions rev on rev.id=r.proposal_revision_id
      and rev.org_id=r.org_id and rev.profile_id=r.profile_id and rev.recommendation_id=r.id
    where a.batch_id=p_batch and a.org_id=p_org and a.profile_id=p_profile and
      (r.id is null or not(r.id=any(p_ids)) or a.proposal_revision_id is distinct from r.proposal_revision_id
       or case when r.inputs ? 'dependencySet' then
         r.proposal_revision_id is not null or a.dependency_set_id is distinct from r.inputs#>>'{dependencySet,id}'
         or a.dependency_step_index is null or a.dependency_step_index < 0
         or a.dependency_step_index >= jsonb_array_length(r.inputs#>'{dependencySet,changes}')
         or a.entity_type::text is distinct from (r.inputs#>'{dependencySet,changes}'->a.dependency_step_index)#>>'{entityRef,entityType}'
         or a.entity_id is distinct from (r.inputs#>'{dependencySet,changes}'->a.dependency_step_index)#>>'{entityRef,entityId}'
         or a.field is distinct from case (r.inputs#>'{dependencySet,changes}'->a.dependency_step_index)->>'control'
           when 'target_bid' then 'bid'
           when 'placement_adjustment' then case (r.inputs#>'{dependencySet,changes}'->a.dependency_step_index)->>'placementKey'
             when 'top_of_search' then 'tos_modifier' when 'rest_of_search' then 'ros_modifier' when 'product_pages' then 'pp_modifier' end end
         or a.old_value is distinct from (r.inputs#>'{dependencySet,changes}'->a.dependency_step_index)->'current'
         or a.new_value is distinct from (r.inputs#>'{dependencySet,changes}'->a.dependency_step_index)->'proposed'
       else a.dependency_set_id is not null or a.dependency_step_index is not null
         or a.entity_type::text is distinct from r.entity_type::text or a.entity_id is distinct from r.entity_id or a.field is distinct from r.field
         or a.old_value is distinct from r.current_value
         or case when r.proposal_revision_id is null then a.new_value is distinct from r.proposed_value
           else (a.new_value #>> '{}')::numeric is distinct from (rev.receipt->>'proposedValue')::numeric end end)) then
    raise exception using errcode='55000',message='Export revision changed';
  end if;
  return query update public.recommendations set status='exported',export_batch_id=p_batch
    where org_id=p_org and profile_id=p_profile and run_id=p_run and id=any(p_ids) and status='accepted' returning id;
  get diagnostics v_count=row_count;
  if v_count<>cardinality(p_ids) then raise exception 'Export count mismatch'; end if;
end;
$$;
revoke all on function app.stamp_review_export(uuid,uuid,uuid,uuid,uuid[]) from public,anon,service_role;
grant execute on function app.stamp_review_export(uuid,uuid,uuid,uuid,uuid[]) to authenticated;


-- Complete native control observations are separate from partial ordinary campaign sync.
alter table public.targets add column bid_observed_at timestamptz;
alter table public.campaigns add column bidding_control_state jsonb, add column bidding_observed_at timestamptz;
alter table public.sp_write_mirror_observations drop constraint sp_write_mirror_observations_artifact_identity;
alter table public.sp_write_mirror_observations
add constraint sp_write_mirror_observations_artifact_identity check (coalesce(
    app.sp_write_exact_json_keys(artifact, array[
      'schemaVersion','orgId','profileId','executionId','planId','observationId','observationFingerprint',
      'actionId','amazonEntityId','changeKey','observationOutcome','outcome','before','observed','after',
      'entityChangeId','changeAttribution','observedAt','reconciledAt','bidObservedAt'
    ] || case when artifact ? 'observedState' then array['observedState'] else array[]::text[] end) and
    artifact ->> 'schemaVersion' = 'openspell.sp-write-mirror-receipt.v1'
    and artifact ->> 'observationId' = observation_id::text
    and artifact ->> 'orgId' = org_id::text and artifact ->> 'profileId' = profile_id::text
    and artifact ->> 'executionId' = execution_id::text and artifact ->> 'planId' = plan_id::text
    and artifact ->> 'actionId' = action_id::text and artifact ->> 'observationFingerprint' = observation_fingerprint
    and artifact ->> 'outcome' = outcome
    and (not (artifact ? 'observedState') or (
      artifact ->> 'observedState' = 'archived' and artifact ->> 'observationOutcome' = 'conflict'
      and outcome in ('superseded', 'missing')
    ))
    and (artifact ->> 'entityChangeId') is not distinct from entity_change_id::text
    and (artifact ->> 'changeAttribution') is not distinct from change_attribution
    and (artifact ->> 'reconciledAt')::timestamptz = reconciled_at,
    false) or coalesce(
    app.sp_write_exact_json_keys(artifact,array['schemaVersion','orgId','profileId','executionId','planId','observationId','observationFingerprint','actionId','amazonEntityId','changeKey','observationOutcome','outcome','before','observed','after','entityChangeId','changeAttribution','observedAt','reconciledAt','controlObservedAt'] || case when artifact ? 'observedState' then array['observedState'] else array[]::text[] end)
    and artifact->>'schemaVersion'='openspell.sp-write-mirror-receipt.v2'
    and artifact->>'observationId'=observation_id::text and artifact->>'orgId'=org_id::text and artifact->>'profileId'=profile_id::text
    and artifact->>'executionId'=execution_id::text and artifact->>'planId'=plan_id::text and artifact->>'actionId'=action_id::text
    and artifact->>'observationFingerprint'=observation_fingerprint and artifact->>'outcome'=outcome
    and (not(artifact ? 'observedState') or (artifact->>'observedState'='archived' and artifact->>'observationOutcome'='conflict' and outcome in ('superseded','missing')))
    and (artifact->>'entityChangeId') is not distinct from entity_change_id::text
    and (artifact->>'changeAttribution') is not distinct from change_attribution
    and (artifact->>'reconciledAt')::timestamptz=reconciled_at,false));
create function app.guard_target_bid_observation()
returns trigger language plpgsql
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_read_text text := nullif(current_setting('app.target_bid_read_started_at', true), '');
  v_read_at timestamptz;
begin
  if tg_op = 'UPDATE' and old.bid_observed_at is not null then
    if new.bid_observed_at is null or new.bid_observed_at < old.bid_observed_at then
      raise exception 'target field evidence cannot move backwards' using errcode = '55000';
    end if;
    if new.bid is not distinct from old.bid
       and new.deleted_at is not distinct from old.deleted_at
       and new.bid_observed_at is not distinct from old.bid_observed_at then return new; end if;
  elsif new.bid_observed_at is null then return new;
  end if;
  if v_read_text is null then
    raise exception 'target field update requires a read window' using errcode = '55000';
  end if;
  v_read_at := v_read_text::timestamptz;
  if v_read_at > clock_timestamp() or new.bid_observed_at is distinct from v_read_at
     or (tg_op = 'UPDATE' and old.bid_observed_at is not null and v_read_at < old.bid_observed_at) then
    raise exception 'target field read window is stale or invalid' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_target_bid_observation() from public, anon, authenticated, service_role;
create trigger targets_bid_observation_guard before insert or update on public.targets
  for each row execute function app.guard_target_bid_observation();

-- A fresh partial ordinary read may invalidate completeness, but never backdate evidence.
create or replace function app.guard_campaign_control_observation()
returns trigger language plpgsql set search_path=pg_catalog,public,app,pg_temp as $$
declare v_read_text text:=nullif(current_setting('app.campaign_control_read_started_at',true),''); v_read_at timestamptz;
begin
  if tg_op='UPDATE' and old.bidding_observed_at is not null then
    if new.bidding_observed_at is null or new.bidding_observed_at<old.bidding_observed_at then
      raise exception 'campaign field evidence cannot move backwards' using errcode='55000';
    end if;
    if new.bidding_control_state is not distinct from old.bidding_control_state
      and new.bidding_strategy is not distinct from old.bidding_strategy
      and new.placement_bidding is not distinct from old.placement_bidding
      and new.deleted_at is not distinct from old.deleted_at
      and new.bidding_observed_at is not distinct from old.bidding_observed_at then return new; end if;
  elsif new.bidding_observed_at is null then return new;
  end if;
  if v_read_text is null then raise exception 'campaign field update requires a read window' using errcode='55000'; end if;
  v_read_at:=v_read_text::timestamptz;
  if v_read_at>clock_timestamp() or new.bidding_observed_at is distinct from v_read_at
    or (tg_op='UPDATE' and old.bidding_observed_at is not null and v_read_at<old.bidding_observed_at)
    or (new.bidding_control_state is not null and (
      new.bidding_control_state->>'strategy' is distinct from new.bidding_strategy::text
      or new.bidding_control_state#>'{placements,topOfSearch}' is distinct from new.placement_bidding->'topOfSearch'
      or new.bidding_control_state#>'{placements,restOfSearch}' is distinct from new.placement_bidding->'restOfSearch'
      or new.bidding_control_state#>'{placements,productPages}' is distinct from new.placement_bidding->'productPages')) then
    raise exception 'campaign field read window or projection is stale or invalid' using errcode='55000';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_campaign_control_observation() from public,anon,authenticated,service_role;
create trigger campaigns_control_observation_guard before insert or update on public.campaigns
  for each row execute function app.guard_campaign_control_observation();

alter function app.reconcile_sp_write_mirror(uuid,text) rename to reconcile_sp_write_keyword_mirror;
revoke all on function app.reconcile_sp_write_keyword_mirror(uuid,text) from public,anon,authenticated,service_role;
create function app.reconcile_sp_write_mirror(p_observation_id uuid,p_observation_fingerprint text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare
  v_observation public.sp_write_observations%rowtype;
  v_action public.sp_write_plan_actions%rowtype;
  v_plan public.sp_write_plans%rowtype;
  v_target public.targets%rowtype;
  v_campaign public.campaigns%rowtype;
  v_existing public.sp_write_mirror_observations%rowtype;
  v_expected jsonb; v_observed jsonb; v_before jsonb; v_after jsonb;
  v_head timestamptz; v_outcome text; v_change_id bigint; v_attribution text; v_now timestamptz;
  v_artifact jsonb; v_change_key text; v_archived boolean; v_name text;
  v_context_key text; v_old_context text; v_affected integer;
begin
  perform app.assert_service_role('reconcile_sp_write_mirror');
  select * into v_observation from public.sp_write_observations
    where observation_id=p_observation_id and fingerprint=p_observation_fingerprint;
  if not found then raise exception 'write observation not found' using errcode='P0002'; end if;
  select * into strict v_action from public.sp_write_plan_actions
    where org_id=v_observation.org_id and profile_id=v_observation.profile_id
      and plan_id=v_observation.plan_id and action_id=v_observation.action_id;
  if v_action.route_key='sp.v3.keywords.update' then
    return app.reconcile_sp_write_keyword_mirror(p_observation_id,p_observation_fingerprint);
  end if;
  perform 1 from public.orgs where id=v_observation.org_id for key share;
  if not found then raise exception 'write observation tenant not found' using errcode='P0002'; end if;
  perform 1 from public.ad_profiles where org_id=v_observation.org_id and id=v_observation.profile_id for key share;
  if not found then raise exception 'write observation profile not found' using errcode='P0002'; end if;
  perform 1 from public.sp_write_observations where observation_id=p_observation_id for update;
  select * into v_existing from public.sp_write_mirror_observations where observation_id=p_observation_id;
  if found then return v_existing.artifact; end if;
  select * into strict v_plan from public.sp_write_plans
    where org_id=v_observation.org_id and profile_id=v_observation.profile_id and plan_id=v_observation.plan_id;
  v_archived:=coalesce(v_observation.observed#>>'{values,state}'='archived',false);
  if v_action.route_key='sp.v3.targets.update' and app.sp_write_exact_json_keys(v_action.artifact->'changes',array['bid']) then
    v_change_key:='target.bid';
    v_context_key:='app.target_bid_read_started_at';
    v_expected:=v_action.artifact#>'{changes,bid,expected}';
    v_observed:=v_observation.observed#>'{values,bid}';
    if (v_observed is not null and (v_observed->>'currencyCode' is distinct from v_plan.currency_code
        or (v_observed->>'amount')::numeric<>(v_observed->>'amount')::numeric(12,4)))
      or (not v_archived and v_observation.outcome<>'missing' and v_observed is null) then
      raise exception 'write observation value unavailable' using errcode='22023';
    end if;
    select * into v_target from public.targets where org_id=v_observation.org_id and profile_id=v_observation.profile_id
      and amazon_id=v_action.amazon_entity_id and ad_product='SP' for update;
    if found and v_target.deleted_at is null and v_target.bid is not null then
      v_before:=jsonb_build_object('amount',trim_scale(v_target.bid)::text,'currencyCode',v_plan.currency_code);
      v_head:=v_target.bid_observed_at; v_name:=v_target.name;
    end if;
  elsif v_action.route_key='sp.v3.campaigns.update' and app.sp_write_exact_json_keys(v_action.artifact->'changes',array['placement'])
    and jsonb_array_length(v_action.artifact#>'{changes,placement,approvedPlacementKeys}')=1 then
    v_change_key:='campaign.placement.'||(v_action.artifact#>>'{changes,placement,approvedPlacementKeys,0}');
    if v_change_key not in ('campaign.placement.top_of_search','campaign.placement.rest_of_search','campaign.placement.product_pages') then
      raise exception 'write mirror action unsupported' using errcode='22023';
    end if;
    v_context_key:='app.campaign_control_read_started_at';
    v_expected:=v_action.artifact#>'{changes,placement,expected}';
    v_observed:=v_observation.observed#>'{values,placement}';
    if not v_archived and v_observation.outcome<>'missing' and v_observed is null then
      raise exception 'write observation value unavailable' using errcode='22023';
    end if;
    select * into v_campaign from public.campaigns where org_id=v_observation.org_id and profile_id=v_observation.profile_id
      and amazon_id=v_action.amazon_entity_id and ad_product='SP' for update;
    -- Partial mirrors cannot establish a complete prior campaign-control state.
    if found and v_campaign.deleted_at is null and v_campaign.bidding_control_state is not null
      and v_campaign.bidding_control_state->>'strategy'=v_campaign.bidding_strategy::text
      and v_campaign.bidding_control_state#>'{placements,topOfSearch}'=v_campaign.placement_bidding->'topOfSearch'
      and v_campaign.bidding_control_state#>'{placements,restOfSearch}'=v_campaign.placement_bidding->'restOfSearch'
      and v_campaign.bidding_control_state#>'{placements,productPages}'=v_campaign.placement_bidding->'productPages' then
      v_before:=v_campaign.bidding_control_state; v_head:=v_campaign.bidding_observed_at; v_name:=v_campaign.name;
    end if;
  else raise exception 'write mirror action unsupported' using errcode='22023'; end if;
  v_old_context:=current_setting(v_context_key,true);
  v_after:=v_before;
  if v_before is null then v_outcome:='missing';
  elsif v_archived or v_observed is null then v_outcome:='superseded';
  elsif v_before=v_observed then
    v_outcome:='already_current';
    if v_head is null or v_head<v_observation.observed_at then v_head:=v_observation.observed_at; end if;
  elsif v_before<>v_expected or v_head>v_observation.observed_at then v_outcome:='superseded';
  else
    v_outcome:='promoted'; v_after:=v_observed; v_head:=v_observation.observed_at;
    v_attribution:=case when v_observation.outcome='observed_requested' then 'write' else 'observation' end;
  end if;
  if v_outcome in ('promoted','already_current') then
    perform set_config(v_context_key,app.keyword_mirror_instant(v_head),true);
    if v_change_key='target.bid' then
      update public.targets set bid=(v_after->>'amount')::numeric,bid_observed_at=v_head where id=v_target.id;
    else
      update public.campaigns set bidding_control_state=v_after,bidding_observed_at=v_head,
        bidding_strategy=(v_after->>'strategy')::public.bidding_strategy, placement_bidding=coalesce(placement_bidding,'{}'::jsonb)||jsonb_build_object(
          'topOfSearch',v_after#>'{placements,topOfSearch}','restOfSearch',v_after#>'{placements,restOfSearch}',
          'productPages',v_after#>'{placements,productPages}') where id=v_campaign.id;
    end if;
    get diagnostics v_affected=row_count;
    if v_affected<>1 then raise exception 'mirror row count does not close' using errcode='P0003'; end if;
  end if;
  if v_outcome='promoted' then
    insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,entity_name,field,old_value,new_value,source,observed_at)
    values(v_observation.org_id,v_observation.profile_id,
      case when v_change_key='target.bid' then 'target'::public.entity_type else 'campaign'::public.entity_type end,
      v_action.amazon_entity_id,v_name,case when v_change_key='target.bid' then 'bid' else 'bidding_control_state' end,
      case when v_change_key='target.bid' then to_jsonb(v_before->>'amount') else v_before end,
      case when v_change_key='target.bid' then to_jsonb(v_after->>'amount') else v_after end,
      case when v_attribution='write' then 'apply'::public.entity_change_source else 'sync'::public.entity_change_source end,v_observation.observed_at)
    returning id into strict v_change_id;
  end if;
  perform set_config(v_context_key,coalesce(v_old_context,''),true);
  v_now:=clock_timestamp();
  v_artifact:=jsonb_build_object('schemaVersion','openspell.sp-write-mirror-receipt.v2',
    'orgId',v_observation.org_id::text,'profileId',v_observation.profile_id::text,'executionId',v_observation.execution_id::text,
    'planId',v_observation.plan_id::text,'observationId',v_observation.observation_id::text,'observationFingerprint',v_observation.fingerprint,
    'actionId',v_observation.action_id::text,'amazonEntityId',v_action.amazon_entity_id,'changeKey',v_change_key,
    'observationOutcome',v_observation.outcome::text,'outcome',v_outcome,'before',v_before,'observed',v_observed,'after',v_after,
    'entityChangeId',v_change_id::text,'changeAttribution',v_attribution,'observedAt',app.keyword_mirror_instant(v_observation.observed_at),
    'reconciledAt',app.keyword_mirror_instant(v_now),'controlObservedAt',case when v_head is null then null else app.keyword_mirror_instant(v_head) end);
  if v_archived then v_artifact:=v_artifact||jsonb_build_object('observedState','archived'); end if;
  insert into public.sp_write_mirror_observations(observation_id,org_id,profile_id,execution_id,plan_id,action_id,observation_fingerprint,
    outcome,entity_change_id,change_attribution,artifact,reconciled_at)
  values(v_observation.observation_id,v_observation.org_id,v_observation.profile_id,v_observation.execution_id,v_observation.plan_id,
    v_observation.action_id,v_observation.fingerprint,v_outcome,v_change_id,v_attribution,v_artifact,v_now);
  get diagnostics v_affected=row_count;
  if v_affected<>1 then raise exception 'mirror receipt count does not close' using errcode='P0003'; end if;
  return v_artifact;
end;
$$;
revoke all on function app.reconcile_sp_write_mirror(uuid,text) from public,anon,authenticated,service_role;
grant execute on function app.reconcile_sp_write_mirror(uuid,text) to service_role;

-- Exposure depends on the complete campaign controls and every affected target,
-- including controls and bids that the plan does not change.
create function app.sp_write_exposure_source_matches(p_org uuid,p_profile uuid,p_snapshot jsonb,p_applied jsonb)
returns boolean language plpgsql stable set search_path=pg_catalog,public,app,pg_temp as $$
declare v_campaign public.campaigns%rowtype; v_controls jsonb; v_bids jsonb; v_actual jsonb;
  v_action jsonb; v_rows jsonb; v_campaign_id text; v_key text;
begin
  v_rows:=p_snapshot->'evidenceRows';
  v_campaign_id:=p_snapshot#>>'{campaignEvidence,campaignId}';
  v_controls:=p_snapshot#>'{campaignEvidence,currentControls}';
  if p_snapshot->>'profileId' is distinct from p_profile::text
    or p_snapshot#>'{campaignEvidence,complete}' is distinct from 'true'::jsonb
    or jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows)<1
    or p_snapshot#>'{campaignEvidence,targetCount}' is distinct from to_jsonb(jsonb_array_length(v_rows))
    or jsonb_typeof(v_controls) is distinct from 'object' then return false; end if;
  if exists(select 1 from jsonb_array_elements(v_rows) evidence where
    evidence#>>'{entityRef,profileId}' is distinct from p_profile::text
    or evidence#>>'{entityRef,campaignId}' is distinct from v_campaign_id
    or evidence#>>'{entityRef,adProduct}' is distinct from 'SP'
    or evidence#>>'{entityRef,entityType}' not in ('keyword','target')
    or jsonb_typeof(evidence->'currentBid') is distinct from 'number'
    or (evidence->>'currentBid')::numeric<=0) then return false; end if;
  select jsonb_object_agg((evidence#>>'{entityRef,entityType}')||':'||(evidence#>>'{entityRef,entityId}'),evidence->'currentBid')
    into v_bids from jsonb_array_elements(v_rows) evidence;
  if (select count(*) from jsonb_object_keys(v_bids))<>jsonb_array_length(v_rows) then return false; end if;
  for v_action in select value from jsonb_array_elements(p_applied) loop
    if v_action->>'routeKey' in ('sp.v3.keywords.update','sp.v3.targets.update') then
      v_key:=case v_action->>'routeKey' when 'sp.v3.keywords.update' then 'keyword:' else 'target:' end
        ||app.sp_write_action_entity_id(v_action);
      if not(v_bids ? v_key) then return false; end if;
      v_bids:=jsonb_set(v_bids,array[v_key],to_jsonb((v_action#>>'{changes,bid,requested,amount}')::numeric));
    elsif v_action->>'routeKey'='sp.v3.campaigns.update' then
      if app.sp_write_action_entity_id(v_action) is distinct from v_campaign_id
        or v_action#>'{changes,placement,expected}' is distinct from v_controls then return false; end if;
      v_controls:=v_action#>'{changes,placement,requested}';
    else return false; end if;
  end loop;
  select * into v_campaign from public.campaigns where org_id=p_org and profile_id=p_profile and amazon_id=v_campaign_id
    and ad_product='SP' and deleted_at is null and state in ('enabled','paused');
  if not found or v_campaign.synced_at is null or v_campaign.bidding_observed_at is null
    or v_campaign.bidding_control_state is distinct from v_controls
    or v_campaign.bidding_strategy::text is distinct from v_controls->>'strategy'
    or v_campaign.placement_bidding->'topOfSearch' is distinct from v_controls#>'{placements,topOfSearch}'
    or v_campaign.placement_bidding->'restOfSearch' is distinct from v_controls#>'{placements,restOfSearch}'
    or v_campaign.placement_bidding->'productPages' is distinct from v_controls#>'{placements,productPages}' then return false; end if;
  select coalesce(jsonb_object_agg(kind||':'||amazon_id,to_jsonb(bid)),'{}'::jsonb) into v_actual from (
    select 'keyword' as kind,amazon_id,case when synced_at is null then null else bid end as bid from public.keywords where org_id=p_org and profile_id=p_profile
      and campaign_id=v_campaign_id and ad_product='SP' and deleted_at is null and state in ('enabled','paused')
    union all select 'target',amazon_id,case when synced_at is null then null else bid end from public.targets where org_id=p_org and profile_id=p_profile
      and campaign_id=v_campaign_id and ad_product='SP' and deleted_at is null and state in ('enabled','paused')
  ) bids;
  return v_actual=v_bids;
end;
$$;
revoke all on function app.sp_write_exposure_source_matches(uuid,uuid,jsonb,jsonb) from public,anon,authenticated,service_role;

create function app.lock_sp_write_exposure_source(p_org uuid,p_profile uuid,p_snapshot jsonb)
returns void language plpgsql set search_path=pg_catalog,public,app,pg_temp as $$
begin
  -- The caller holds the profile authority lock first, excluding new rows via
  -- their profile foreign keys. Lock all existing profile targets as well, so
  -- a concurrent cross-campaign move cannot change the validated inventory.
  perform 1 from public.campaigns where org_id=p_org and profile_id=p_profile
    and amazon_id=p_snapshot#>>'{campaignEvidence,campaignId}' for update;
  perform 1 from public.keywords where org_id=p_org and profile_id=p_profile order by amazon_id for share;
  perform 1 from public.targets where org_id=p_org and profile_id=p_profile order by amazon_id for share;
end;
$$;
revoke all on function app.lock_sp_write_exposure_source(uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create or replace function app.assert_sp_write_dependency_preview_source_v3(
  p_plan_text text,
  p_plan_preimage text,
  p_evidence_text text,
  p_guardrail_preimage text,
  p_provenance_preimage text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb;
  v_evidence jsonb;
  v_source jsonb;
  v_policy jsonb;
  v_action jsonb;
  v_artifact jsonb;
  v_guards jsonb;
  v_provenance jsonb;
  v_org uuid;
  v_profile uuid;
  v_batch public.apply_batches%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype;
  v_row public.apply_rows%rowtype;
  v_recommendation public.recommendations%rowtype;
  v_run public.recommendation_runs%rowtype;
  v_current record;
  v_group jsonb; v_set jsonb; v_step jsonb; v_snapshot jsonb; v_baseline jsonb; v_expected jsonb;
  v_requested jsonb; v_group_source jsonb; v_campaign public.campaigns%rowtype;
  v_prior_states jsonb := '{}'::jsonb; v_snapshot_text text; v_snapshot_count integer;
  v_group_index integer; v_step_index integer; v_placement text; v_placement_field text;
  v_last_recommendation uuid; v_last_step integer; v_ordered_ids jsonb;

  v_index integer;
  v_count integer := 0;
  v_actual_count integer;
begin
  v_plan := app.sp_write_verified_artifact(p_plan_text, p_plan_preimage, 'openspell.sp-write-plan.v3');
  v_evidence := p_evidence_text::jsonb;
  v_guards := p_guardrail_preimage::jsonb;
  v_provenance := p_provenance_preimage::jsonb;
  if v_evidence ->> 'schemaVersion' is distinct from 'openspell.sp-write-preview-evidence.v3'
     or not coalesce(app.sp_write_exact_json_keys(v_evidence, array['schemaVersion','planId','guardrails','provenance']), false)
     or v_evidence -> 'planId' is distinct from v_plan -> 'id'
     or v_plan ->> 'direction' is distinct from 'forward'
     or v_plan #>> '{source,kind}' is distinct from 'apply_batch'
     or jsonb_typeof(v_guards) is distinct from 'array' or jsonb_array_length(v_guards) <> 2
     or v_guards ->> 0 is distinct from 'openspell.sp-write-preview-guards.v3'
     or v_guards -> 1 is distinct from v_evidence -> 'guardrails'
     or app.sp_write_sha256(p_guardrail_preimage) is distinct from v_plan #>> '{source,guardrailSnapshotFingerprint}'
     or jsonb_typeof(v_provenance) is distinct from 'array' or jsonb_array_length(v_provenance) <> 2
     or v_provenance ->> 0 is distinct from 'openspell.sp-write-preview-source.v3'
     or v_provenance -> 1 is distinct from v_evidence -> 'provenance'
     or app.sp_write_sha256(p_provenance_preimage) is distinct from v_plan #>> '{source,provenanceSnapshotFingerprint}'
     or v_evidence #> '{guardrails,providerScope}' is distinct from v_plan -> 'providerScope'
     or v_evidence #> '{guardrails,maximumProviderRows}' is distinct from '500'::jsonb
     or v_evidence #> '{guardrails,requireCurrentValueMatch}' is distinct from 'true'::jsonb
     or v_evidence #>> '{provenance,applyBatchId}' is distinct from v_plan #>> '{source,applyBatchId}' then
    raise exception 'SP preview evidence does not bind its plan' using errcode = '22023';
  end if;
  perform app.assert_sp_dependency_plan_v3(v_plan);
  v_org := (v_plan ->> 'orgId')::uuid;
  v_profile := (v_plan ->> 'profileId')::uuid;

  -- Same parent-first ordering as execution authority. Preview does not take
  -- an environment gate: it grants no permission to execute.
  perform 1 from public.orgs where id = v_org for key share;
  if not found then raise exception 'SP preview scope unavailable' using errcode = '42501'; end if;
  select g.* into strict v_grant
    from public.sp_write_profile_grant_heads h
    join public.sp_write_profile_grant_versions g
      on g.org_id = h.org_id and g.profile_id = h.profile_id
     and g.grant_id = h.grant_id and g.version_id = h.version_id
    join public.ad_profiles p on p.org_id = h.org_id and p.id = h.profile_id
    join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
   where h.org_id = v_org and h.profile_id = v_profile and g.enabled
     and p.sync_enabled and c.status = 'active'
     and g.amazon_profile_id = p.amazon_profile_id and g.connection_id = p.connection_id
     and g.region = p.region and g.currency_code = p.currency_code
   for share of h, g, c for update of p;
  if v_grant.grant_id::text is distinct from v_evidence #>> '{guardrails,profileGrantId}'
     or v_grant.version_id::text is distinct from v_evidence #>> '{guardrails,profileGrantVersion}'
     or v_plan -> 'providerScope' is distinct from jsonb_build_object(
       'amazonProfileId', v_grant.amazon_profile_id, 'connectionId', v_grant.connection_id,
       'region', v_grant.region, 'marketplaceId', v_grant.marketplace_id,
       'currencyCode', v_grant.currency_code, 'apiDialect', v_grant.api_dialect) then
    raise exception 'SP preview grant changed' using errcode = '55000';
  end if;

  -- Lock source parents before children, including the run->recommendation
  -- cascade. The later comparisons prove these are the actual source parents;
  -- caller-supplied identities cannot substitute another run or recommendation.
  perform 1 from public.recommendation_runs
   where org_id = v_org and profile_id = v_profile
     and id in (select (s ->> 'runId')::uuid
       from jsonb_array_elements(v_evidence #> '{provenance,rows}') s)
   order by id for share;
  perform 1 from public.recommendations
   where org_id = v_org and profile_id = v_profile
     and id in (select (s ->> 'recommendationId')::uuid
       from jsonb_array_elements(v_evidence #> '{provenance,rows}') s)
   order by id for share;

  -- FOR UPDATE also excludes new child rows taking an FK key-share lock.
  select * into strict v_batch from public.apply_batches
   where org_id = v_org and profile_id = v_profile
     and id = (v_plan #>> '{source,applyBatchId}')::uuid for update;
  perform 1 from public.apply_rows
   where org_id = v_org and profile_id = v_profile and batch_id = v_batch.id
   order by id for share;
  get diagnostics v_actual_count = row_count;
  v_artifact := (v_evidence #>> '{provenance,artifactText}')::jsonb;
  if v_batch.status <> 'staged' or v_batch.source_batch_id is not null
     or v_batch.unsupported_rows <> 0 or v_batch.reversible_rows not between 1 and 500
     or v_batch.reversible_rows <> v_actual_count or v_batch.dependency_sets_count is null
     or v_batch.exported_proposals <> v_batch.dependency_sets_count
     or v_batch.source_kind <> 'legacy_export'
     or exists(select 1 from public.apply_batches child where child.org_id=v_org and child.profile_id=v_profile
       and child.source_batch_id=v_batch.id and child.status<>'abandoned')
     or jsonb_typeof(v_evidence#>'{provenance,dependencySets}') is distinct from 'array'
     or jsonb_array_length(v_evidence#>'{provenance,dependencySets}')<>v_batch.dependency_sets_count
     or jsonb_array_length(v_plan->'dependencySets')<>v_batch.dependency_sets_count
     or jsonb_typeof(v_artifact) is distinct from 'array' or jsonb_array_length(v_artifact) <> v_actual_count
     or jsonb_typeof(v_evidence #> '{provenance,rows}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{provenance,rows}') <> v_actual_count
     or jsonb_typeof(v_evidence #> '{guardrails,policies}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{guardrails,policies}') <> v_actual_count
     or v_batch.artifact_sha256 is null
     or v_batch.artifact_sha256 is distinct from v_evidence #>> '{provenance,artifactSha256}'
     or v_batch.artifact_sha256 is distinct from app.sp_write_sha256(v_evidence #>> '{provenance,artifactText}')
     or v_batch.exported_at is distinct from (v_evidence #>> '{provenance,exportedAt}')::timestamptz
     or v_batch.tag is distinct from v_evidence #>> '{provenance,tag}'
     or v_batch.opt_group is distinct from v_evidence #>> '{provenance,optGroup}'
     or v_batch.lever is distinct from v_evidence #>> '{provenance,lever}'
     or v_batch.note is distinct from v_evidence #>> '{provenance,note}' then
    raise exception 'SP preview export changed or is incomplete' using errcode = '55000';
  end if;
  if (select count(distinct r ->> 'applyRowId') from jsonb_array_elements(v_evidence #> '{provenance,rows}') r) <> v_actual_count
     or (select count(distinct r ->> 'recommendationId') from jsonb_array_elements(v_evidence #> '{provenance,rows}') r) <> v_batch.dependency_sets_count then
    raise exception 'SP preview repeats a source identity' using errcode = '22023';
  end if;

  select jsonb_agg(r.id::text order by rec.created_at,rec.id,r.dependency_step_index) into v_ordered_ids
    from public.apply_rows r join public.recommendations rec on rec.org_id=r.org_id and rec.profile_id=r.profile_id and rec.id=r.recommendation_id
    where r.org_id=v_org and r.profile_id=v_profile and r.batch_id=v_batch.id;
  if v_ordered_ids is distinct from (select jsonb_agg(r->'applyRowId' order by ordinality)
    from jsonb_array_elements(v_evidence#>'{provenance,rows}') with ordinality source(r,ordinality)) then
    raise exception 'dependency source order differs from stored export' using errcode='55000'; end if;

  for v_source, v_index in select value,(ordinality-1)::integer
    from jsonb_array_elements(v_evidence#>'{provenance,rows}') with ordinality loop
    v_policy:=v_evidence#>array['guardrails','policies',v_index::text];
    v_action:=v_plan->'actions'->v_index;
    select * into strict v_row from public.apply_rows where org_id=v_org and profile_id=v_profile
      and batch_id=v_batch.id and id=(v_source->>'applyRowId')::uuid;
    select * into strict v_recommendation from public.recommendations
      where org_id=v_org and profile_id=v_profile and id=v_row.recommendation_id;
    select * into strict v_run from public.recommendation_runs
      where org_id=v_org and profile_id=v_profile and id=v_recommendation.run_id;
    v_set:=v_recommendation.inputs->'dependencySet';
    v_step_index:=v_row.dependency_step_index;
    v_step:=v_set->'changes'->v_step_index;
    select value,(ordinality-1)::integer into strict v_group,v_group_index
      from jsonb_array_elements(v_plan->'dependencySets') with ordinality
      where value->>'dependencySetId'=v_row.dependency_set_id;
    v_group_source:=v_evidence#>array['provenance','dependencySets',v_group_index::text];
    if v_row.dependency_set_id is null or v_step_index is null or v_step is null
      or not coalesce(app.sp_write_exact_json_keys(v_source,array['applyRowId','recommendationId','runId','dependencySetId','dependencyStepIndex','method']),false)
      or v_source->>'recommendationId' is distinct from v_row.recommendation_id::text
      or v_source->>'runId' is distinct from v_run.id::text
      or v_source->>'dependencySetId' is distinct from v_row.dependency_set_id
      or v_source->'dependencyStepIndex' is distinct from to_jsonb(v_step_index)
      or v_recommendation.export_batch_id is distinct from v_batch.id or v_recommendation.status<>'exported'
      or v_recommendation.field<>'control_set' or v_recommendation.entity_type<>'campaign' or v_recommendation.ad_product<>'SP'
      or v_row.proposal_revision_id is not null or v_recommendation.proposal_revision_id is not null
      or v_set->>'id' is distinct from v_row.dependency_set_id
      or v_set->>'campaignId' is distinct from v_recommendation.campaign_id
      or v_row.dependency_set_id is distinct from v_run.id::text||':'||v_recommendation.campaign_id
      or v_group->>'recommendationId' is distinct from v_recommendation.id::text
      or v_group->>'dependencySetSha256' is distinct from app.sp_write_sha256(v_set::text)
      or v_group->'precedenceReasons' is distinct from v_set->'precedenceReasons'
      or jsonb_array_length(v_group->'actionIds')<>jsonb_array_length(v_set->'changes')
      or v_group->'actionIds'->v_step_index is distinct from v_action->'actionId'
      or v_group_source->>'dependencySetId' is distinct from v_row.dependency_set_id
      or v_group_source->>'recommendationId' is distinct from v_recommendation.id::text
      or v_group_source->>'dependencySetText' is distinct from v_set::text
      or v_group_source->>'dependencySetSha256' is distinct from app.sp_write_sha256(v_set::text)
      or v_step#>>'{entityRef,profileId}' is distinct from v_profile::text
      or v_step#>>'{entityRef,campaignId}' is distinct from v_recommendation.campaign_id
      or v_step#>>'{entityRef,adProduct}' is distinct from 'SP'
      or v_step#>>'{entityRef,entityType}' is distinct from v_row.entity_type::text
      or v_step#>>'{entityRef,entityId}' is distinct from v_row.entity_id
      or v_step->'current' is distinct from v_row.old_value or v_step->'proposed' is distinct from v_row.new_value
      or v_action#>>'{sources,0,applyRowId}' is distinct from v_row.id::text
      or v_policy->>'applyRowId' is distinct from v_row.id::text
      or v_policy->>'recommendationId' is distinct from v_recommendation.id::text
      or v_policy->>'runId' is distinct from v_run.id::text
      or v_run.strategy_snapshot is null or v_run.strategy_goal is null
      or v_policy->>'strategySnapshotText' is distinct from v_run.strategy_snapshot::text
      or v_policy->>'strategyGoal' is distinct from v_run.strategy_goal
      or v_policy->>'groupId' is distinct from v_run.group_id::text
      or v_policy->>'groupSnapshotText' is distinct from v_run.group_snapshot::text
      or v_recommendation.inputs->>'methodId' is distinct from 'sp.coordinated-efficiency'
      or v_recommendation.inputs->>'methodVersion' is distinct from 'candidate.1'
      or v_source->'method' is distinct from jsonb_build_object(
        'methodId',v_recommendation.inputs->>'methodId','methodVersion',v_recommendation.inputs->>'methodVersion',
        'traceSha256',app.sp_write_sha256((v_recommendation.inputs->'trace')::text),
        'settingSourcesSha256',app.sp_write_sha256((v_recommendation.inputs->'settingSources')::text))
      or v_artifact->v_index is distinct from jsonb_build_object('entity_type',v_row.entity_type,
        'entity_id',v_row.entity_id,'field',v_row.field,'old',v_row.old_value,'new',v_row.new_value)
      then raise exception 'dependency source or policy changed' using errcode='55000'; end if;
    if v_last_recommendation is distinct from v_recommendation.id then
      if v_step_index<>0 then raise exception 'dependency starts after its first step' using errcode='55000'; end if;
    elsif v_step_index<>v_last_step+1 then raise exception 'dependency step order changed' using errcode='55000'; end if;
    v_last_recommendation:=v_recommendation.id; v_last_step:=v_step_index;

    select min(item.value::text),count(*) into v_snapshot_text,v_snapshot_count
      from public.audit_log audit cross join lateral jsonb_array_elements(audit.payload#>'{narrative,calculationSnapshots}') item
      where audit.org_id=v_org and audit.action='recommendation.run.succeeded' and audit.target_type='recommendation_run'
        and audit.target_id=v_run.id::text and audit.source='worker'
        and item.value->>'methodId'='sp.coordinated-efficiency' and item.value->>'methodVersion'='candidate.1'
        and item.value->>'runId'=v_run.id::text and item.value->>'profileId'=v_profile::text
        and item.value#>>'{campaignEvidence,campaignId}'=v_recommendation.campaign_id;
    if v_snapshot_count<>1 or v_group_source->>'calculationSnapshotText' is distinct from v_snapshot_text
      or v_group_source->>'calculationSnapshotSha256' is distinct from app.sp_write_sha256(v_snapshot_text) then
      raise exception 'complete calculation evidence is unavailable or changed' using errcode='55000'; end if;
    v_snapshot:=v_snapshot_text::jsonb; v_baseline:=v_snapshot#>'{campaignEvidence,currentControls}';
    if v_snapshot#>'{campaignEvidence,complete}' is distinct from 'true'::jsonb
      or not coalesce(app.sp_write_exact_json_keys(v_baseline,array['strategy','placements','shopperCohorts','offAmazonBudgetControlStrategy']),false)
      or not coalesce(app.sp_write_exact_json_keys(v_baseline->'placements',array['topOfSearch','restOfSearch','productPages','amazonBusiness']),false)
      or jsonb_typeof(v_baseline->'shopperCohorts') is distinct from 'array'
      or v_snapshot->'resolvedSettings' is distinct from v_recommendation.inputs->'settingSources'
      then raise exception 'complete control evidence is required' using errcode='55000'; end if;
    perform app.lock_sp_write_exposure_source(v_org,v_profile,v_snapshot);
    if not app.sp_write_exposure_source_matches(v_org,v_profile,v_snapshot,'[]'::jsonb) then
      raise exception 'source_changed: complete exposure dependencies changed' using errcode='55000'; end if;
    select * into strict v_current from app.resolve_apply_current_value(v_org,v_profile,v_row.entity_type,v_row.entity_id,v_row.field);
    if not v_current.supported or not v_current.present or v_current.current_value is distinct from v_row.old_value then
      raise exception 'dependency synchronized source changed' using errcode='55000'; end if;
    if v_step->>'control'='target_bid' and v_row.entity_type in ('keyword','target') and v_row.field='bid' then
      if not exists(select 1 from public.keywords k where v_row.entity_type='keyword' and k.org_id=v_org and k.profile_id=v_profile
          and k.amazon_id=v_row.entity_id and k.campaign_id=v_recommendation.campaign_id and k.ad_product='SP' and k.deleted_at is null and k.state in ('enabled','paused')
        union all select 1 from public.targets t where v_row.entity_type='target' and t.org_id=v_org and t.profile_id=v_profile
          and t.amazon_id=v_row.entity_id and t.campaign_id=v_recommendation.campaign_id and t.ad_product='SP' and t.deleted_at is null and t.state in ('enabled','paused'))
        or v_step->>'unit' is distinct from 'currency_per_click'
        or v_action->>'routeKey' is distinct from (case when v_row.entity_type='keyword' then 'sp.v3.keywords.update' else 'sp.v3.targets.update' end)
        or app.sp_write_action_entity_id(v_action) is distinct from v_row.entity_id
        or v_action->'changes' is distinct from jsonb_build_object('bid',jsonb_build_object(
          'expected',jsonb_build_object('amount',trim_scale((v_row.old_value#>>'{}')::numeric)::text,'currencyCode',v_grant.currency_code),
          'requested',jsonb_build_object('amount',trim_scale((v_row.new_value#>>'{}')::numeric)::text,'currencyCode',v_grant.currency_code)))
        then raise exception 'dependent bid differs from saved control' using errcode='55000'; end if;
    elsif v_step->>'control'='placement_adjustment' and v_row.entity_type='campaign' then
      v_placement:=v_step->>'placementKey';
      v_placement_field:=case v_placement when 'top_of_search' then 'topOfSearch' when 'rest_of_search' then 'restOfSearch' when 'product_pages' then 'productPages' end;
      select * into strict v_campaign from public.campaigns where org_id=v_org and profile_id=v_profile
        and amazon_id=v_recommendation.campaign_id and ad_product='SP' and deleted_at is null and state in ('enabled','paused') for share;
      v_expected:=coalesce(v_prior_states->v_row.dependency_set_id,v_baseline);
      v_requested:=jsonb_set(v_expected,array['placements',v_placement_field],v_step->'proposed');
      if v_step->>'unit' is distinct from 'percentage' or v_placement_field is null
        or v_row.field is distinct from (case v_placement when 'top_of_search' then 'tos_modifier' when 'rest_of_search' then 'ros_modifier' when 'product_pages' then 'pp_modifier' end)
        or v_row.entity_id is distinct from v_recommendation.campaign_id
        or v_campaign.bidding_strategy::text is distinct from v_baseline->>'strategy'
        or v_campaign.placement_bidding->'topOfSearch' is distinct from v_baseline#>'{placements,topOfSearch}'
        or v_campaign.placement_bidding->'restOfSearch' is distinct from v_baseline#>'{placements,restOfSearch}'
        or v_campaign.placement_bidding->'productPages' is distinct from v_baseline#>'{placements,productPages}'
        or (v_campaign.bidding_control_state is not null and v_campaign.bidding_control_state is distinct from v_baseline)
        or v_expected->'placements'->v_placement_field is distinct from v_step->'current'
        or not coalesce(v_step->>'proposed' ~ '^[0-9]+$',false) or (v_step->>'proposed')::integer not between 0 and 900
        or v_action->>'routeKey' is distinct from 'sp.v3.campaigns.update'
        or app.sp_write_action_entity_id(v_action) is distinct from v_row.entity_id
        or v_action->'changes' is distinct from jsonb_build_object('placement',jsonb_build_object('expected',v_expected,
          'requested',v_requested,'approvedPlacementKeys',jsonb_build_array(v_placement))) then
        raise exception 'dependent placement differs from complete saved controls' using errcode='55000'; end if;
      v_prior_states:=v_prior_states||jsonb_build_object(v_row.dependency_set_id,v_requested);
    else raise exception 'unsupported dependent control' using errcode='22023'; end if;
    v_count:=v_count+1;
  end loop;
  if v_count<>v_actual_count or v_count<>(v_plan#>>'{counts,providerRows}')::integer then
    raise exception 'dependency source counts differ' using errcode='22023'; end if;
end;
$$;
revoke all on function app.assert_sp_write_dependency_preview_source_v3(text,text,text,text,text) from public,anon,authenticated,service_role;

create or replace function app.record_sp_write_plan_internal(
  p_plan_text text,
  p_plan_fingerprint_preimage text,
  p_action_proofs jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb;
  v_action jsonb;
  v_proof jsonb;
  v_action_text text;
  v_action_preimage text;
  v_org_id uuid;
  v_profile_id uuid;
  v_plan_id uuid;
  v_direction public.sp_write_plan_direction;
  v_route public.sp_write_route_key;
  v_entity_id text;
  v_index integer;
  v_inserted integer := 0;
  v_logical_changes integer := 0;
  v_existing public.sp_write_plans%rowtype;
  v_version text;
begin
  v_version := p_plan_text::jsonb ->> 'schemaVersion';
  if v_version is null or v_version not in ('openspell.sp-write-plan.v1','openspell.sp-write-plan.v2','openspell.sp-write-plan.v3') then
    raise exception 'unrecognized SP write plan version' using errcode = '22023';
  end if;
  v_plan := app.sp_write_verified_artifact(p_plan_text,p_plan_fingerprint_preimage,v_version);
  if v_version = 'openspell.sp-write-plan.v3' then
    perform app.assert_sp_dependency_plan_v3(v_plan);
  elsif v_version = 'openspell.sp-write-plan.v2' then
    perform app.assert_sp_keyword_plan_v2(v_plan,p_plan_fingerprint_preimage);
    perform app.assert_sp_keyword_plan_source_v2(v_plan);
  elsif v_plan ->> 'direction' = 'inverse' and exists (
    select 1 from public.sp_write_plans parent where parent.org_id::text = v_plan ->> 'orgId'
      and parent.profile_id::text = v_plan ->> 'profileId'
      and parent.plan_id::text = v_plan #>> '{source,sourcePlanId}'
      and parent.artifact ->> 'schemaVersion' = 'openspell.sp-write-plan.v2'
  ) then
    raise exception 'v2 source requires a v2 inverse' using errcode = '22023';
  end if;
  if not app.sp_write_exact_json_keys(v_plan, array[
    'schemaVersion','id','orgId','profileId','providerScope','direction','source',
    'generatedAt','frozenAt','expiresAt','actions','counts','fingerprint'
  ] || case when v_version='openspell.sp-write-plan.v3' then array['dependencySets'] else array[]::text[] end)
     or v_plan ->> 'schemaVersion' <> v_version
     or not app.sp_write_exact_json_keys(v_plan -> 'providerScope', array[
       'amazonProfileId','connectionId','region','marketplaceId','currencyCode','apiDialect'
     ])
     or pg_catalog.jsonb_typeof(v_plan -> 'actions') <> 'array'
     or pg_catalog.jsonb_typeof(p_action_proofs) <> 'array'
     or pg_catalog.jsonb_array_length(v_plan -> 'actions')
        <> pg_catalog.jsonb_array_length(p_action_proofs) then
    raise exception 'SP write plan relational shape mismatch' using errcode = '22023';
  end if;

  begin
    v_org_id := (v_plan ->> 'orgId')::uuid;
    v_profile_id := (v_plan ->> 'profileId')::uuid;
    v_plan_id := (v_plan ->> 'id')::uuid;
    v_direction := (v_plan ->> 'direction')::public.sp_write_plan_direction;
  exception when others then
    raise exception 'SP write plan identity is invalid' using errcode = '22023';
  end;

  select * into v_existing from public.sp_write_plans where plan_id = v_plan_id;
  if found then
    raise exception 'SP write plan identity collision' using errcode = '23505';
  end if;

  insert into public.sp_write_plans (
    plan_id, org_id, profile_id, direction, artifact_text, artifact,
    fingerprint_preimage, fingerprint, amazon_profile_id, connection_id,
    region, marketplace_id, currency_code, api_dialect,
    source_execution_id, source_plan_id, source_plan_fingerprint,
    generated_at, frozen_at, expires_at, logical_changes, provider_rows,
    unique_entities
  ) values (
    v_plan_id, v_org_id, v_profile_id, v_direction, p_plan_text, v_plan,
    p_plan_fingerprint_preimage, v_plan ->> 'fingerprint',
    v_plan #>> '{providerScope,amazonProfileId}',
    (v_plan #>> '{providerScope,connectionId}')::uuid,
    (v_plan #>> '{providerScope,region}')::public.ads_region,
    v_plan #>> '{providerScope,marketplaceId}',
    v_plan #>> '{providerScope,currencyCode}',
    v_plan #>> '{providerScope,apiDialect}',
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourceExecutionId}')::uuid end,
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourcePlanId}')::uuid end,
    case when v_direction = 'inverse'
      then v_plan #>> '{source,sourcePlanFingerprint}' end,
    (v_plan ->> 'generatedAt')::timestamptz,
    (v_plan ->> 'frozenAt')::timestamptz,
    (v_plan ->> 'expiresAt')::timestamptz,
    (v_plan #>> '{counts,logicalChanges}')::integer,
    (v_plan #>> '{counts,providerRows}')::integer,
    (v_plan #>> '{counts,uniqueEntities}')::integer
  );

  for v_action, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_plan -> 'actions') with ordinality
  loop
    v_proof := p_action_proofs -> v_index;
    if not app.sp_write_exact_json_keys(v_proof, array['artifactText','fingerprintPreimage']) then
      raise exception 'SP write action proof shape mismatch' using errcode = '22023';
    end if;
    v_action_text := v_proof ->> 'artifactText';
    v_action_preimage := v_proof ->> 'fingerprintPreimage';
    if v_action_text::jsonb <> v_action then
      raise exception 'SP write action text differs from nested plan action'
        using errcode = '22023';
    end if;
    v_action := app.sp_write_verified_artifact(
      v_action_text, v_action_preimage, 'openspell.sp-write-action.v1'
    );
    if not app.sp_write_exact_json_keys(
      v_action, array['actionId','sources','fingerprint','routeKey','entity','changes']
    ) or pg_catalog.jsonb_typeof(v_action -> 'sources') <> 'array' then
      raise exception 'SP write action relational shape mismatch' using errcode = '22023';
    end if;
    if v_version = 'openspell.sp-write-plan.v2' and v_action_preimage is distinct from
      '["openspell.sp-write-action.v1",' || app.mcp_keyword_preview_json(v_action - 'fingerprint','action_preimage') || ']' then
      raise exception 'v2 action fingerprint bytes differ from shared contract' using errcode = '22023';
    end if;
    v_route := (v_action ->> 'routeKey')::public.sp_write_route_key;
    v_entity_id := app.sp_write_action_entity_id(v_action);
    if v_entity_id is null or v_entity_id = '' then
      raise exception 'SP write action entity is empty' using errcode = '22023';
    end if;
    insert into public.sp_write_plan_actions (
      org_id, profile_id, plan_id, action_id, action_index, route_key,
      amazon_entity_id, artifact_text, artifact, fingerprint_preimage, fingerprint
    ) values (
      v_org_id, v_profile_id, v_plan_id, (v_action ->> 'actionId')::uuid,
      v_index, v_route, v_entity_id, v_action_text, v_action,
      v_action_preimage, v_action ->> 'fingerprint'
    );
    v_inserted := v_inserted + 1;
    v_logical_changes := v_logical_changes
      + pg_catalog.jsonb_array_length(v_action -> 'sources');
  end loop;

  if v_inserted <> (v_plan #>> '{counts,providerRows}')::integer
     or v_logical_changes <> (v_plan #>> '{counts,logicalChanges}')::integer
     or (select count(distinct (route_key,amazon_entity_id)) from public.sp_write_plan_actions
          where org_id=v_org_id and profile_id=v_profile_id and plan_id=v_plan_id)
        <> (v_plan #>> '{counts,uniqueEntities}')::integer
     or (v_version<>'openspell.sp-write-plan.v3' and v_inserted <> (v_plan #>> '{counts,uniqueEntities}')::integer)
     or exists (
       select 1
       from pg_catalog.jsonb_each_text(v_plan #> '{counts,byRoute}') expected(route, count)
       where (
         select count(*)
         from public.sp_write_plan_actions action
         where action.org_id = v_org_id and action.profile_id = v_profile_id
           and action.plan_id = v_plan_id and action.route_key::text = expected.route
       ) <> expected.count::integer
     ) then
    raise exception 'SP write plan action counts do not close' using errcode = '22023';
  end if;
  return v_plan_id;
end;
$$;

create or replace function app.record_sp_write_plan(
  p_plan_text text,
  p_plan_fingerprint_preimage text,
  p_action_proofs jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb;
  v_action jsonb;
  v_proof jsonb;
  v_action_text text;
  v_action_preimage text;
  v_org_id uuid;
  v_profile_id uuid;
  v_plan_id uuid;
  v_direction public.sp_write_plan_direction;
  v_route public.sp_write_route_key;
  v_entity_id text;
  v_index integer;
  v_inserted integer := 0;
  v_logical_changes integer := 0;
  v_existing public.sp_write_plans%rowtype;
  v_version text;
begin
  perform app.assert_service_role('record_sp_write_plan');
  v_version := p_plan_text::jsonb ->> 'schemaVersion';
  if v_version is null or v_version not in ('openspell.sp-write-plan.v1','openspell.sp-write-plan.v2','openspell.sp-write-plan.v3') then
    raise exception 'unrecognized SP write plan version' using errcode = '22023';
  end if;
  v_plan := app.sp_write_verified_artifact(p_plan_text,p_plan_fingerprint_preimage,v_version);
  if v_version = 'openspell.sp-write-plan.v3' then
    perform app.assert_sp_dependency_plan_v3(v_plan);
  elsif v_version = 'openspell.sp-write-plan.v2' then
    perform app.assert_sp_keyword_plan_v2(v_plan,p_plan_fingerprint_preimage);
    perform app.assert_sp_keyword_plan_source_v2(v_plan);
  elsif v_plan ->> 'direction' = 'inverse' and exists (
    select 1 from public.sp_write_plans parent where parent.org_id::text = v_plan ->> 'orgId'
      and parent.profile_id::text = v_plan ->> 'profileId'
      and parent.plan_id::text = v_plan #>> '{source,sourcePlanId}'
      and parent.artifact ->> 'schemaVersion' = 'openspell.sp-write-plan.v2'
  ) then
    raise exception 'v2 source requires a v2 inverse' using errcode = '22023';
  end if;
  if not app.sp_write_exact_json_keys(v_plan, array[
    'schemaVersion','id','orgId','profileId','providerScope','direction','source',
    'generatedAt','frozenAt','expiresAt','actions','counts','fingerprint'
  ] || case when v_version='openspell.sp-write-plan.v3' then array['dependencySets'] else array[]::text[] end)
     or v_plan ->> 'schemaVersion' <> v_version
     or not app.sp_write_exact_json_keys(v_plan -> 'providerScope', array[
       'amazonProfileId','connectionId','region','marketplaceId','currencyCode','apiDialect'
     ])
     or pg_catalog.jsonb_typeof(v_plan -> 'actions') <> 'array'
     or pg_catalog.jsonb_typeof(p_action_proofs) <> 'array'
     or pg_catalog.jsonb_array_length(v_plan -> 'actions')
        <> pg_catalog.jsonb_array_length(p_action_proofs) then
    raise exception 'SP write plan relational shape mismatch' using errcode = '22023';
  end if;

  begin
    v_org_id := (v_plan ->> 'orgId')::uuid;
    v_profile_id := (v_plan ->> 'profileId')::uuid;
    v_plan_id := (v_plan ->> 'id')::uuid;
    v_direction := (v_plan ->> 'direction')::public.sp_write_plan_direction;
  exception when others then
    raise exception 'SP write plan identity is invalid' using errcode = '22023';
  end;

  select * into v_existing from public.sp_write_plans where plan_id = v_plan_id;
  if found then
    raise exception 'SP write plan identity collision' using errcode = '23505';
  end if;

  insert into public.sp_write_plans (
    plan_id, org_id, profile_id, direction, artifact_text, artifact,
    fingerprint_preimage, fingerprint, amazon_profile_id, connection_id,
    region, marketplace_id, currency_code, api_dialect,
    source_execution_id, source_plan_id, source_plan_fingerprint,
    generated_at, frozen_at, expires_at, logical_changes, provider_rows,
    unique_entities
  ) values (
    v_plan_id, v_org_id, v_profile_id, v_direction, p_plan_text, v_plan,
    p_plan_fingerprint_preimage, v_plan ->> 'fingerprint',
    v_plan #>> '{providerScope,amazonProfileId}',
    (v_plan #>> '{providerScope,connectionId}')::uuid,
    (v_plan #>> '{providerScope,region}')::public.ads_region,
    v_plan #>> '{providerScope,marketplaceId}',
    v_plan #>> '{providerScope,currencyCode}',
    v_plan #>> '{providerScope,apiDialect}',
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourceExecutionId}')::uuid end,
    case when v_direction = 'inverse'
      then (v_plan #>> '{source,sourcePlanId}')::uuid end,
    case when v_direction = 'inverse'
      then v_plan #>> '{source,sourcePlanFingerprint}' end,
    (v_plan ->> 'generatedAt')::timestamptz,
    (v_plan ->> 'frozenAt')::timestamptz,
    (v_plan ->> 'expiresAt')::timestamptz,
    (v_plan #>> '{counts,logicalChanges}')::integer,
    (v_plan #>> '{counts,providerRows}')::integer,
    (v_plan #>> '{counts,uniqueEntities}')::integer
  );

  for v_action, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_plan -> 'actions') with ordinality
  loop
    v_proof := p_action_proofs -> v_index;
    if not app.sp_write_exact_json_keys(v_proof, array['artifactText','fingerprintPreimage']) then
      raise exception 'SP write action proof shape mismatch' using errcode = '22023';
    end if;
    v_action_text := v_proof ->> 'artifactText';
    v_action_preimage := v_proof ->> 'fingerprintPreimage';
    if v_action_text::jsonb <> v_action then
      raise exception 'SP write action text differs from nested plan action'
        using errcode = '22023';
    end if;
    v_action := app.sp_write_verified_artifact(
      v_action_text, v_action_preimage, 'openspell.sp-write-action.v1'
    );
    if not app.sp_write_exact_json_keys(
      v_action, array['actionId','sources','fingerprint','routeKey','entity','changes']
    ) or pg_catalog.jsonb_typeof(v_action -> 'sources') <> 'array' then
      raise exception 'SP write action relational shape mismatch' using errcode = '22023';
    end if;
    if v_version = 'openspell.sp-write-plan.v2' and v_action_preimage is distinct from
      '["openspell.sp-write-action.v1",' || app.mcp_keyword_preview_json(v_action - 'fingerprint','action_preimage') || ']' then
      raise exception 'v2 action fingerprint bytes differ from shared contract' using errcode = '22023';
    end if;
    v_route := (v_action ->> 'routeKey')::public.sp_write_route_key;
    v_entity_id := app.sp_write_action_entity_id(v_action);
    if v_entity_id is null or v_entity_id = '' then
      raise exception 'SP write action entity is empty' using errcode = '22023';
    end if;
    insert into public.sp_write_plan_actions (
      org_id, profile_id, plan_id, action_id, action_index, route_key,
      amazon_entity_id, artifact_text, artifact, fingerprint_preimage, fingerprint
    ) values (
      v_org_id, v_profile_id, v_plan_id, (v_action ->> 'actionId')::uuid,
      v_index, v_route, v_entity_id, v_action_text, v_action,
      v_action_preimage, v_action ->> 'fingerprint'
    );
    v_inserted := v_inserted + 1;
    v_logical_changes := v_logical_changes
      + pg_catalog.jsonb_array_length(v_action -> 'sources');
  end loop;

  if v_inserted <> (v_plan #>> '{counts,providerRows}')::integer
     or v_logical_changes <> (v_plan #>> '{counts,logicalChanges}')::integer
     or (select count(distinct (route_key,amazon_entity_id)) from public.sp_write_plan_actions
          where org_id=v_org_id and profile_id=v_profile_id and plan_id=v_plan_id)
        <> (v_plan #>> '{counts,uniqueEntities}')::integer
     or (v_version<>'openspell.sp-write-plan.v3' and v_inserted <> (v_plan #>> '{counts,uniqueEntities}')::integer)
     or exists (
       select 1
       from pg_catalog.jsonb_each_text(v_plan #> '{counts,byRoute}') expected(route, count)
       where (
         select count(*)
         from public.sp_write_plan_actions action
         where action.org_id = v_org_id and action.profile_id = v_profile_id
           and action.plan_id = v_plan_id and action.route_key::text = expected.route
       ) <> expected.count::integer
     ) then
    raise exception 'SP write plan action counts do not close' using errcode = '22023';
  end if;
  return v_plan_id;
end;
$$;

create or replace function app.assert_sp_write_preview_source(
  p_plan_text text, p_plan_preimage text, p_evidence_text text,
  p_guardrail_preimage text, p_provenance_preimage text
)
returns void language plpgsql security definer
set search_path = pg_catalog, public, app, pg_temp as $$
declare v_plan jsonb := p_plan_text::jsonb; v_batch public.apply_batches%rowtype;
begin
  if p_evidence_text::jsonb ->> 'schemaVersion' = 'openspell.sp-write-preview-evidence.v3' then
    perform app.assert_sp_write_dependency_preview_source_v3(p_plan_text,p_plan_preimage,p_evidence_text,
      p_guardrail_preimage,p_provenance_preimage);
    return;
  end if;
  if p_evidence_text::jsonb ->> 'schemaVersion' = 'openspell.sp-write-preview-evidence.v2' then
    perform app.assert_mcp_bid_preview_source_v2(p_plan_text,p_plan_preimage,p_evidence_text,
      p_guardrail_preimage,p_provenance_preimage);
    return;
  end if;
  perform app.assert_sp_write_legacy_preview_source_v1(p_plan_text, p_plan_preimage,
    p_evidence_text, p_guardrail_preimage, p_provenance_preimage);
  -- The legacy validator already holds this batch FOR UPDATE, after its source
  -- parents. Never take the batch before those parents here.
  select * into strict v_batch from public.apply_batches where org_id = (v_plan ->> 'orgId')::uuid
    and profile_id = (v_plan ->> 'profileId')::uuid and id = (v_plan #>> '{source,applyBatchId}')::uuid;
  if v_batch.dependency_sets_count is not null or v_batch.source_kind <> 'legacy_export' or exists(select 1 from public.apply_batches child
    where child.org_id = v_batch.org_id and child.profile_id = v_batch.profile_id
      and child.source_batch_id = v_batch.id and child.status <> 'abandoned') then
    raise exception 'source belongs to another write path' using errcode = '55000';
  end if;
end;
$$;

create or replace function app.assert_sp_write_method_evidence(p_plan uuid, p_required boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public, app, pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; v_evidence jsonb; v_source jsonb;
  v_inputs jsonb; v_method jsonb;
begin
  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan;
  select artifact into strict v_evidence from public.sp_write_preview_evidence
    where org_id = v_plan.org_id and profile_id = v_plan.profile_id and plan_id = p_plan;
  if v_evidence ->> 'schemaVersion' = 'openspell.sp-write-preview-evidence.v2' then return; end if;
  if not coalesce(v_evidence ->> 'schemaVersion' in ('openspell.sp-write-preview-evidence.v1','openspell.sp-write-preview-evidence.v3'),false) then
    raise exception 'Unknown source evidence' using errcode = '22023';
  end if;
  for v_source in select value from jsonb_array_elements(v_evidence #> '{provenance,rows}') loop
    select inputs into strict v_inputs from public.recommendations
      where org_id = v_plan.org_id and profile_id = v_plan.profile_id
        and id = (v_source ->> 'recommendationId')::uuid
        and run_id = (v_source ->> 'runId')::uuid for share;
    v_method := v_source -> 'method';
    if v_method is null and not p_required and not (v_inputs ?| array['methodId','methodVersion','trace','settingSources']) then
      continue;
    end if;
    if p_required and v_method is not null and not exists(select 1 from app.sp_write_method_releases release
      where release.method_id=v_method->>'methodId' and release.method_version=v_method->>'methodVersion'
        and release.release_state in ('pilot','stable')) then
      raise exception 'method_not_executable' using errcode = '42501';
    end if;
    if v_method is null or coalesce(length(v_inputs ->> 'methodId'),0) = 0
      or coalesce(length(v_inputs ->> 'methodVersion'),0) = 0
      or jsonb_typeof(v_inputs -> 'trace') is distinct from 'object'
      or jsonb_typeof(v_inputs -> 'settingSources') is distinct from 'object'
      or v_method is distinct from jsonb_build_object(
        'methodId',v_inputs ->> 'methodId','methodVersion',v_inputs ->> 'methodVersion',
        'traceSha256',app.sp_write_sha256((v_inputs -> 'trace')::text),
        'settingSourcesSha256',app.sp_write_sha256((v_inputs -> 'settingSources')::text)) then
      raise exception 'Recommendation method evidence is missing or changed' using errcode = '55000';
    end if;
  end loop;
end;
$$;

-- Readiness is based on durable domain facts, never an HTTP status alone.
create function app.sp_write_dependency_status(p_execution uuid,p_plan uuid,p_action uuid)
returns text language plpgsql stable set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan jsonb; v_set jsonb; v_before text; v_wait boolean:=false; v_seen boolean:=false; v_action jsonb; v_key text; v_snapshot jsonb; v_applied jsonb:='[]'::jsonb;
begin
  select artifact into strict v_plan from public.sp_write_plans where plan_id=p_plan;
  if v_plan->>'schemaVersion'<>'openspell.sp-write-plan.v3' then return 'ready'; end if;
  select value into strict v_set from jsonb_array_elements(v_plan->'dependencySets') where value->'actionIds' ? p_action::text;
  for v_before in select value from jsonb_array_elements_text(v_set->'actionIds') loop
    if v_before=p_action::text then v_seen:=true; exit; end if;
    if exists(select 1 from public.sp_write_action_resolutions where execution_id=p_execution and plan_id=p_plan
        and action_id=v_before::uuid and resolution_kind='refusal')
      or exists(select 1 from public.sp_write_provider_result_positions result
        join public.sp_write_provider_call_positions position on position.org_id=result.org_id and position.profile_id=result.profile_id
          and position.intent_id=result.intent_id and position.action_id=result.action_id
        where position.execution_id=p_execution and position.plan_id=p_plan
          and result.action_id=v_before::uuid and result.outcome='authoritative_rejected')
      or exists(select 1 from public.sp_write_observations where execution_id=p_execution and plan_id=p_plan
        and action_id=v_before::uuid and outcome<>'observed_requested')
      or exists(select 1 from public.sp_write_mirror_observations where execution_id=p_execution and plan_id=p_plan
        and action_id=v_before::uuid and outcome not in ('promoted','already_current')) then return 'failed'; end if;
    if not exists(select 1 from public.sp_write_observations observation
      join public.sp_write_mirror_observations mirror on mirror.org_id=observation.org_id and mirror.profile_id=observation.profile_id
        and mirror.observation_id=observation.observation_id and mirror.observation_fingerprint=observation.fingerprint
        and mirror.execution_id=observation.execution_id and mirror.plan_id=observation.plan_id and mirror.action_id=observation.action_id
      where observation.execution_id=p_execution and observation.plan_id=p_plan and observation.action_id=v_before::uuid
        and observation.outcome='observed_requested' and mirror.outcome in ('promoted','already_current')) then
      v_wait:=true;
    else
      select artifact into strict v_action from public.sp_write_plan_actions where plan_id=p_plan and action_id=v_before::uuid;
      if v_action->>'routeKey'='sp.v3.keywords.update' then
        if not exists(select 1 from public.keywords where org_id=(v_plan->>'orgId')::uuid and profile_id=(v_plan->>'profileId')::uuid
          and amazon_id=v_action#>>'{entity,keywordId}' and ad_product='SP' and deleted_at is null and state in ('enabled','paused')
          and bid=(v_action#>>'{changes,bid,requested,amount}')::numeric) then return 'source_changed'; end if;
      elsif v_action->>'routeKey'='sp.v3.targets.update' then
        if not exists(select 1 from public.targets where org_id=(v_plan->>'orgId')::uuid and profile_id=(v_plan->>'profileId')::uuid
          and amazon_id=v_action#>>'{entity,targetId}' and ad_product='SP' and deleted_at is null and state in ('enabled','paused')
          and bid=(v_action#>>'{changes,bid,requested,amount}')::numeric) then return 'source_changed'; end if;
      elsif v_action->>'routeKey'='sp.v3.campaigns.update' then
        v_key:=case v_action#>>'{changes,placement,approvedPlacementKeys,0}' when 'top_of_search' then 'topOfSearch'
          when 'rest_of_search' then 'restOfSearch' when 'product_pages' then 'productPages' end;
        if not exists(select 1 from public.campaigns where org_id=(v_plan->>'orgId')::uuid and profile_id=(v_plan->>'profileId')::uuid
          and amazon_id=v_action#>>'{entity,campaignId}' and ad_product='SP' and deleted_at is null and state in ('enabled','paused')
          and placement_bidding->v_key=v_action#>array['changes','placement','requested','placements',v_key]
          and bidding_control_state#>array['placements',v_key]=v_action#>array['changes','placement','requested','placements',v_key]) then
          return 'source_changed'; end if;
      end if;
    end if;
  end loop;
  if not v_seen then raise exception 'dependency action is absent' using errcode='22023'; end if;
  if v_wait then return 'waiting'; end if;
  select (source->>'calculationSnapshotText')::jsonb into strict v_snapshot
    from public.sp_write_preview_evidence evidence
    cross join lateral jsonb_array_elements(evidence.artifact#>'{provenance,dependencySets}') source
    where evidence.plan_id=p_plan and source->>'dependencySetId'=v_set->>'dependencySetId';
  for v_before in select value from jsonb_array_elements_text(v_set->'actionIds') loop
    exit when v_before=p_action::text;
    select artifact into strict v_action from public.sp_write_plan_actions where plan_id=p_plan and action_id=v_before::uuid;
    v_applied:=v_applied||jsonb_build_array(v_action);
  end loop;
  if not app.sp_write_exposure_source_matches((v_plan->>'orgId')::uuid,(v_plan->>'profileId')::uuid,v_snapshot,v_applied) then
    return 'source_changed'; end if;
  return 'ready';
end;
$$;
revoke all on function app.sp_write_dependency_status(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Caller holds the canonical execution child lock. Untouched descendants alone are terminalized.
create function app.refuse_sp_write_dependency_descendants(p_execution uuid,p_plan uuid,p_generation uuid)
returns integer language plpgsql set search_path=pg_catalog,public,app,pg_temp as $$
declare v_child public.sp_write_cycle_plans%rowtype; v_plan public.sp_write_plans%rowtype;
  v_action public.sp_write_plan_actions%rowtype; v_id uuid; v_artifact jsonb; v_now timestamptz;
  v_count integer:=0; v_affected integer; v_status text; v_reason public.sp_write_refusal_reason;
begin
  select * into strict v_child from public.sp_write_cycle_plans where execution_id=p_execution and plan_id=p_plan
    and generation=p_generation for update;
  select * into strict v_plan from public.sp_write_plans where plan_id=p_plan;
  if v_plan.artifact->>'schemaVersion'<>'openspell.sp-write-plan.v3' then return 0; end if;
  v_now:=clock_timestamp();
  for v_action in select action.* from public.sp_write_plan_actions action
    where action.org_id=v_child.org_id and action.profile_id=v_child.profile_id and action.plan_id=p_plan
      and not exists(select 1 from public.sp_write_action_resolutions resolution where resolution.org_id=action.org_id
        and resolution.profile_id=action.profile_id and resolution.execution_id=p_execution and resolution.plan_id=p_plan
        and resolution.action_id=action.action_id)
    order by action.action_index loop
    v_status:=app.sp_write_dependency_status(p_execution,p_plan,v_action.action_id);
    if v_status not in ('failed','changed','source_changed') then continue; end if;
    v_reason:=case when v_status='source_changed' then 'source_changed'::public.sp_write_refusal_reason when v_status='changed' then 'dependency_changed'::public.sp_write_refusal_reason else 'dependency_failed'::public.sp_write_refusal_reason end;
    v_id:=gen_random_uuid();
    v_artifact:=app.sp_write_disposition_artifact(v_id,p_plan,v_plan.fingerprint,v_child.approval_id,p_execution,p_generation,
      v_action.action_id,v_action.fingerprint,v_now,v_reason,null);
    insert into public.sp_write_predispatch_dispositions(disposition_id,org_id,profile_id,execution_id,plan_id,approval_id,generation,
      action_id,action_fingerprint,reason,provider_observation_fingerprint,recorded_at,persisted_at,artifact_text,artifact,fingerprint_preimage,fingerprint)
    values(v_id,v_child.org_id,v_child.profile_id,p_execution,p_plan,v_child.approval_id,p_generation,
      v_action.action_id,v_action.fingerprint,v_reason,null,v_now,v_now,
      v_artifact->>'artifactText',v_artifact->'artifact',v_artifact->>'fingerprintPreimage',v_artifact->>'fingerprint');
    insert into public.sp_write_action_resolutions(org_id,profile_id,execution_id,plan_id,action_id,resolution_kind,disposition_id,intent_id,resolved_at)
    values(v_child.org_id,v_child.profile_id,p_execution,p_plan,v_action.action_id,'refusal',v_id,null,v_now);
    get diagnostics v_affected=row_count;
    if v_affected<>1 then raise exception 'dependency refusal count does not close' using errcode='23514'; end if;
    v_count:=v_count+1;
  end loop;
  if exists(select 1 from public.sp_write_plan_actions action where action.org_id=v_child.org_id and action.profile_id=v_child.profile_id
    and action.plan_id=p_plan and app.sp_write_dependency_status(p_execution,p_plan,action.action_id) in ('failed','changed','source_changed')
    and not exists(select 1 from public.sp_write_action_resolutions resolution where resolution.org_id=action.org_id
      and resolution.profile_id=action.profile_id and resolution.execution_id=p_execution and resolution.plan_id=p_plan
      and resolution.action_id=action.action_id)) then
    raise exception 'dependency refusals left an untouched descendant' using errcode='23514'; end if;
  return v_count;
end;
$$;
revoke all on function app.refuse_sp_write_dependency_descendants(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function app.settle_sp_write_dependencies_for_claim(p_outbox_id uuid,p_claim_epoch bigint,p_claim_token uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_outbox public.sp_write_outbox%rowtype; v_head app.sp_write_outbox_delivery_heads%rowtype; v_count integer;
begin
  perform app.assert_service_role('settle_sp_write_dependencies_for_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch<1 or p_claim_token is null then
    raise exception 'invalid dependency settlement claim' using errcode='22023'; end if;
  select * into v_outbox from public.sp_write_outbox where outbox_id=p_outbox_id;
  if not found then return jsonb_build_object('kind','stale_claim'); end if;
  perform 1 from public.orgs where id=v_outbox.org_id for key share;
  select * into v_head from app.sp_write_outbox_delivery_heads where outbox_id=p_outbox_id for update;
  if v_head.outbox_id is null or v_head.state<>'leased' or v_head.claim_epoch<>p_claim_epoch
    or v_head.token_digest<>app.sp_write_outbox_claim_token_digest(p_claim_token) or v_head.lease_expires_at<=clock_timestamp() then
    return jsonb_build_object('kind','stale_claim'); end if;
  if v_outbox.kind<>'dispatch' then return jsonb_build_object('kind','unchanged'); end if;
  v_count:=app.refuse_sp_write_dependency_descendants(v_outbox.execution_id,v_outbox.plan_id,v_outbox.generation);
  if v_head.lease_expires_at<=clock_timestamp() then raise exception 'dependency settlement claim expired' using errcode='40001'; end if;
  return case when v_count=0 then jsonb_build_object('kind','unchanged') else jsonb_build_object('kind','refused','refusedRows',v_count) end;
end;
$$;
revoke all on function app.settle_sp_write_dependencies_for_claim(uuid,bigint,uuid) from public,anon,authenticated,service_role;
grant execute on function app.settle_sp_write_dependencies_for_claim(uuid,bigint,uuid) to service_role;

create or replace function app.reserve_sp_write_provider_call(
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_dispatch_lease_id uuid,
  p_predispatch_observation_text text,
  p_predispatch_observation_preimage text,
  p_intent_text text,
  p_request_fingerprint_preimage text,
  p_intent_preimage text
)
returns table (
  decision text,
  refusal_reason text,
  checked_at timestamptz,
  result_id uuid,
  intent_text text
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan public.sp_write_plans%rowtype;
  v_child public.sp_write_cycle_plans%rowtype;
  v_receipt public.sp_write_authorization_receipts%rowtype;
  v_lease public.sp_write_dispatch_leases%rowtype;
  v_environment public.sp_write_environment_gate_versions%rowtype;
  v_grant public.sp_write_profile_grant_versions%rowtype;
  v_authorization public.sp_write_bounded_authorizations%rowtype;
  v_profile public.ad_profiles%rowtype;
  v_connection public.ads_connections%rowtype;
  v_observation jsonb;
  v_intent jsonb;
  v_position jsonb;
  v_item jsonb;
  v_expected_observed jsonb;
  v_action public.sp_write_plan_actions%rowtype;
  v_disposition jsonb;
  v_disposition_id uuid;
  v_source_sync_job_id uuid;
  v_result_id uuid;
  v_index integer;
  v_offered integer;
  v_inserted integer := 0;
  v_targeted integer := 0;
  v_refusal public.sp_write_refusal_reason;
  v_action_refusal public.sp_write_refusal_reason;
  v_effective_at timestamptz;
  v_context_invalid_action_ids uuid[] := array[]::uuid[];
  v_stale_action_ids uuid[] := array[]::uuid[];
  v_targeted_action_ids uuid[] := array[]::uuid[];
  v_environment_found boolean := false;
  v_grant_found boolean := false;
  v_lease_found boolean := false;
  v_route_valid boolean := false;
  v_authorization_valid boolean := true;
  v_lease_valid boolean := false;
  v_busy boolean := false;
  v_duplicate_intent boolean := false;
  v_mcp_refusal public.sp_write_refusal_reason;
  v_dependency_status text;
  v_dependency_snapshot jsonb;
begin
  perform app.assert_service_role('reserve_sp_write_provider_call');
  v_observation := app.sp_write_verified_artifact(
    p_predispatch_observation_text, p_predispatch_observation_preimage,
    'openspell.sp-write-predispatch-observation.v1'
  );
  v_intent := app.sp_write_verified_artifact(
    p_intent_text, p_intent_preimage,
    'openspell.sp-write-provider-call-intent.v1'
  );
  if not app.sp_write_exact_json_keys(v_intent, array[
       'schemaVersion','intentId','providerCallId','planId','planFingerprint',
       'approvalId','executionId','generation','routeKey','attemptNumber',
       'dispatchLeaseId','providerObservationFingerprint','requestFingerprint',
       'recordedAt','positions','fingerprint'
     ])
     or not app.sp_write_exact_json_keys(v_observation, array[
       'schemaVersion','observationId','planId','planFingerprint','approvalId',
       'executionId','generation','routeKey','observedAt','validUntil','items',
       'fingerprint'
     ])
     or pg_catalog.jsonb_typeof(v_intent -> 'positions') <> 'array'
     or pg_catalog.jsonb_typeof(v_observation -> 'items') <> 'array'
     or pg_catalog.jsonb_array_length(v_intent -> 'positions') < 1
     or pg_catalog.jsonb_array_length(v_intent -> 'positions') > 100
     or pg_catalog.jsonb_array_length(v_intent -> 'positions')
        <> pg_catalog.jsonb_array_length(v_observation -> 'items')
     or v_intent ->> 'schemaVersion' <> 'openspell.sp-write-provider-call-intent.v1'
     or v_observation ->> 'schemaVersion'
        <> 'openspell.sp-write-predispatch-observation.v1'
     or (v_intent ->> 'attemptNumber')::integer <> 1
     or (v_intent ->> 'executionId')::uuid <> p_execution_id
     or (v_intent ->> 'planId')::uuid <> p_plan_id
     or (v_intent ->> 'generation')::uuid <> p_generation
     or (v_intent ->> 'dispatchLeaseId')::uuid <> p_dispatch_lease_id
     or v_intent ->> 'providerObservationFingerprint' <> v_observation ->> 'fingerprint'
     or v_intent ->> 'requestFingerprint'
        <> app.sp_write_sha256(p_request_fingerprint_preimage)
     or p_request_fingerprint_preimage::jsonb <> pg_catalog.jsonb_build_array(
       'openspell.sp-write-provider-request.v1',
       v_intent -> 'planId', v_intent -> 'planFingerprint',
       v_intent -> 'approvalId', v_intent -> 'executionId',
       v_intent -> 'generation', v_intent -> 'providerCallId',
       v_intent -> 'routeKey', v_intent -> 'providerObservationFingerprint',
       v_intent -> 'positions'
     ) then
    raise exception 'SP write reservation artifacts are structurally mismatched'
      using errcode = '22023';
  end if;
  v_offered := pg_catalog.jsonb_array_length(v_intent -> 'positions');

  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan_id;
  select * into strict v_child
  from public.sp_write_cycle_plans child
  where child.execution_id = p_execution_id and child.plan_id = p_plan_id;
  select * into strict v_receipt
  from public.sp_write_authorization_receipts receipt
  where receipt.approval_id = v_child.approval_id;
  if v_child.generation <> p_generation
     or (v_intent ->> 'approvalId')::uuid <> v_child.approval_id
     or v_intent ->> 'planFingerprint' <> v_plan.fingerprint
     or (v_observation ->> 'executionId')::uuid <> p_execution_id
     or (v_observation ->> 'planId')::uuid <> p_plan_id
     or (v_observation ->> 'approvalId')::uuid <> v_child.approval_id
     or (v_observation ->> 'generation')::uuid <> p_generation
     or v_observation ->> 'planFingerprint' <> v_plan.fingerprint
     or v_observation ->> 'routeKey' <> v_intent ->> 'routeKey' then
    raise exception 'SP write reservation identity does not match the child ledger'
      using errcode = '22023';
  end if;

  -- Hold the tenant parent against deletion through intent commit. The org
  -- purge guard below can therefore never observe "no unresolved intent" and
  -- then race a reservation which commits one before the cascade reaches it.
  -- This is reservation's first lock, before any authority or tenant-child
  -- lock, so a purge winner cannot deadlock behind a losing reservation.
  perform 1
  from public.orgs org
  where org.id = v_plan.org_id
  for key share;
  if not found then
    raise exception 'SP write reservation tenant no longer exists'
      using errcode = '55000';
  end if;

  if v_receipt.approval_mode = 'delegated_mcp' then
    v_mcp_refusal := app.lock_mcp_dispatch_authority(p_plan_id,v_receipt.approval_id);
  end if;

  select version.* into v_environment
  from public.sp_write_environment_gate_head head
  join public.sp_write_environment_gate_versions version
    on version.version_id = head.version_id
  where head.singleton
  for update of head, version;
  v_environment_found := found;

  select version.* into v_grant
  from public.sp_write_profile_grant_heads head
  join public.sp_write_profile_grant_versions version
    on version.org_id = head.org_id and version.profile_id = head.profile_id
   and version.grant_id = head.grant_id and version.version_id = head.version_id
  where head.org_id = v_plan.org_id and head.profile_id = v_plan.profile_id
  for update of head, version;
  v_grant_found := found;

  select * into v_profile from public.ad_profiles profile
  where profile.org_id = v_plan.org_id and profile.id = v_plan.profile_id
  for update;
  if found and v_profile.connection_id is not null then
    select * into v_connection from public.ads_connections connection
    where connection.id = v_profile.connection_id and connection.org_id = v_profile.org_id
    for update;
    v_route_valid := found
      and v_connection.status = 'active'
      and v_profile.connection_id = v_plan.connection_id
      and v_profile.amazon_profile_id = v_plan.amazon_profile_id
      and v_profile.region = v_plan.region
      and v_profile.currency_code = v_plan.currency_code;
  end if;

  if v_receipt.bounded_authorization_id is not null then
    select * into v_authorization
    from public.sp_write_bounded_authorizations bounded
    where bounded.authorization_id = v_receipt.bounded_authorization_id
    for update;
    v_authorization_valid := found and not exists (
      select 1 from public.sp_write_bounded_authorization_revocations revocation
      where revocation.authorization_id = v_receipt.bounded_authorization_id
    );
  end if;

  select * into strict v_child
  from public.sp_write_cycle_plans child
  where child.org_id = v_plan.org_id and child.profile_id = v_plan.profile_id
    and child.execution_id = p_execution_id and child.plan_id = p_plan_id
  for update;
  select * into strict v_receipt
  from public.sp_write_authorization_receipts receipt
  where receipt.org_id = v_child.org_id and receipt.profile_id = v_child.profile_id
    and receipt.approval_id = v_child.approval_id
  for update;

  select * into v_lease from public.sp_write_dispatch_leases lease
  where lease.lease_id = p_dispatch_lease_id
    and lease.org_id = v_plan.org_id and lease.profile_id = v_plan.profile_id
    and lease.execution_id = p_execution_id and lease.plan_id = p_plan_id
    and lease.approval_id = v_child.approval_id and lease.generation = p_generation
    and lease.route_key::text = v_intent ->> 'routeKey'
  for update;
  v_lease_found := found;

  -- Stable entity locks come after the authority and child locks. A hash
  -- collision only serializes unrelated entities; it cannot admit overlap.
  for v_position in
    select value
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value)
    order by value ->> 'amazonEntityId', value ->> 'actionId'
  loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'openspell:sp-write-entity:v1:' || v_plan.org_id::text || ':'
      || v_plan.profile_id::text || ':' || (v_intent ->> 'routeKey') || ':'
      || (v_position ->> 'amazonEntityId'), 0
    ));
  end loop;
  checked_at := clock_timestamp();
  v_lease_valid := v_lease_found and v_lease.expires_at > checked_at
    and v_lease.expires_at >= checked_at + interval '70 seconds';

  if (
    select count(distinct value ->> 'actionId') <> v_offered
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value)
  ) then
    raise exception 'SP write reservation repeats an action' using errcode = '22023';
  end if;

  for v_position, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') with ordinality
  loop
    v_item := v_observation -> 'items' -> v_index;
    if not app.sp_write_exact_json_keys(v_position, array[
         'requestIndex','actionId','actionFingerprint','amazonEntityId',
         'actionRequestFingerprint'
       ]) or not app.sp_write_exact_json_keys(v_item, array[
         'routeKey','actionId','actionFingerprint','amazonEntityId','values'
       ]) then
      raise exception 'SP write reservation position or item shape is invalid'
        using errcode = '22023';
    end if;
    select * into v_action
    from public.sp_write_plan_actions action
    where action.org_id = v_plan.org_id and action.profile_id = v_plan.profile_id
      and action.plan_id = p_plan_id
      and action.action_id = (v_position ->> 'actionId')::uuid;
    if not found
       or (v_position ->> 'requestIndex')::integer <> v_index
       or (v_position ->> 'actionFingerprint') !~ '^[a-f0-9]{64}$'
       or (v_position ->> 'actionRequestFingerprint') !~ '^[a-f0-9]{64}$'
       or v_position ->> 'actionFingerprint' <> v_action.fingerprint
       or v_position ->> 'amazonEntityId' <> v_action.amazon_entity_id
       or v_action.route_key::text <> v_intent ->> 'routeKey'
       or v_item ->> 'actionId' <> v_position ->> 'actionId'
       or v_item ->> 'actionFingerprint' <> v_action.fingerprint
       or v_item ->> 'routeKey' <> v_action.route_key::text
       or v_item ->> 'routeKey' <> v_observation ->> 'routeKey'
       or v_item ->> 'routeKey' <> v_intent ->> 'routeKey'
       or v_item ->> 'amazonEntityId' <> v_action.amazon_entity_id then
      raise exception 'SP write reservation position identity is invalid'
        using errcode = '22023';
    end if;
    if v_receipt.bounded_authorization_id is not null
       and not app.sp_write_action_within_bounded_authorization(
         v_receipt.bounded_authorization_id, v_plan.org_id, v_plan.profile_id,
         v_action.artifact
       ) then
      v_authorization_valid := false;
    end if;
    v_expected_observed := app.sp_write_observed_action_for_side(
      v_action.artifact, 'expected'
    );
    if not app.sp_write_exact_json_keys(v_item -> 'values', array(
      select key from pg_catalog.jsonb_object_keys(v_expected_observed -> 'values') key
    )) then
      v_context_invalid_action_ids := pg_catalog.array_append(
        v_context_invalid_action_ids, (v_position ->> 'actionId')::uuid
      );
    elsif v_item <> v_expected_observed then
      v_stale_action_ids := pg_catalog.array_append(
        v_stale_action_ids, (v_position ->> 'actionId')::uuid
      );
    end if;
  end loop;

  -- The execution child and authority prefix are locked before this final order check.
  if v_plan.artifact->>'schemaVersion'='openspell.sp-write-plan.v3' then
    if v_offered<>1 or v_receipt.approval_mode<>'manual' then
      raise exception 'dependency execution requires one manually approved step per call' using errcode='22023'; end if;
    select (source->>'calculationSnapshotText')::jsonb into strict v_dependency_snapshot
      from public.sp_write_preview_evidence evidence
      cross join lateral jsonb_array_elements(evidence.artifact#>'{provenance,dependencySets}') source
      join lateral jsonb_array_elements(v_plan.artifact->'dependencySets') group_set
        on group_set->>'dependencySetId'=source->>'dependencySetId'
      where evidence.plan_id=p_plan_id and group_set->'actionIds' ? v_action.action_id::text;
    perform app.lock_sp_write_exposure_source(v_plan.org_id,v_plan.profile_id,v_dependency_snapshot);
    checked_at:=clock_timestamp();
    v_lease_valid:=v_lease_found and v_lease.expires_at>checked_at and v_lease.expires_at>=checked_at+interval '70 seconds';
    v_dependency_status:=app.sp_write_dependency_status(p_execution_id,p_plan_id,(v_intent#>>'{positions,0,actionId}')::uuid);
    if v_dependency_status in ('failed','changed','source_changed') then
      perform app.refuse_sp_write_dependency_descendants(p_execution_id,p_plan_id,p_generation);
      decision:='refused'; refusal_reason:=case when v_dependency_status='source_changed' then 'source_changed' when v_dependency_status='changed' then 'dependency_changed' else 'dependency_failed' end; result_id:=null; intent_text:=null; return next; return;
    elsif v_dependency_status='waiting' then
      decision:='busy'; refusal_reason:=null; result_id:=null; intent_text:=null; return next; return;
    end if;
  end if;

  v_result_id := app.sp_write_reserved_result_id((v_intent ->> 'intentId')::uuid);
  if exists (
    select 1 from public.sp_write_provider_call_intents existing
    where existing.reserved_result_id = v_result_id
      and existing.intent_id <> (v_intent ->> 'intentId')::uuid
  ) then
    raise exception 'SP write reserved result UUID collision' using errcode = '23505';
  end if;
  v_duplicate_intent := exists (
    select 1 from public.sp_write_provider_call_intents existing
    where existing.intent_id = (v_intent ->> 'intentId')::uuid
       or existing.provider_call_id = (v_intent ->> 'providerCallId')::uuid
  );

  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value)
    join public.sp_write_action_resolutions resolution
      on resolution.org_id = v_plan.org_id and resolution.profile_id = v_plan.profile_id
     and resolution.execution_id = p_execution_id and resolution.plan_id = p_plan_id
     and resolution.action_id = (position.value ->> 'actionId')::uuid
  ) then
    decision := 'already_intended';
    refusal_reason := null;
    result_id := null;
    intent_text := null;
    return next;
    return;
  end if;

  if checked_at >= v_receipt.expires_at or checked_at >= v_plan.expires_at then
    v_refusal := 'approval_expired';
    v_effective_at := v_receipt.expires_at;
  elsif not v_environment_found or not v_environment.enabled
     or v_environment.version_id <> v_receipt.environment_gate_version then
    v_refusal := 'environment_gate_closed';
    v_effective_at := checked_at;
  elsif not v_grant_found or not v_grant.enabled
     or v_grant.grant_id <> v_receipt.profile_grant_id
     or v_grant.version_id <> v_receipt.profile_grant_version
     or v_grant.amazon_profile_id <> v_plan.amazon_profile_id
     or v_grant.connection_id <> v_plan.connection_id
     or v_grant.region <> v_plan.region
     or v_grant.marketplace_id <> v_plan.marketplace_id
     or v_grant.currency_code <> v_plan.currency_code then
    v_refusal := 'profile_gate_closed';
    v_effective_at := checked_at;
  elsif not v_route_valid then
    v_refusal := 'route_mismatch';
    v_effective_at := checked_at;
  elsif v_mcp_refusal is not null then
    v_refusal := v_mcp_refusal;
    v_effective_at := checked_at;
  elsif not v_authorization_valid or v_child.generation <> v_receipt.generation then
    v_refusal := 'authorization_revoked';
    v_effective_at := checked_at;
  elsif not v_lease_valid then
    v_refusal := 'lease_unavailable';
    v_effective_at := checked_at;
  end if;

  if v_refusal is null then
    if (v_observation ->> 'observedAt')::timestamptz < v_receipt.approved_at
       or (v_observation ->> 'observedAt')::timestamptz > checked_at
       or (v_observation ->> 'validUntil')::timestamptz <=
          (v_observation ->> 'observedAt')::timestamptz
       or (v_observation ->> 'validUntil')::timestamptz >
          (v_observation ->> 'observedAt')::timestamptz + interval '2 minutes'
       or (v_observation ->> 'validUntil')::timestamptz < checked_at
       or (v_intent ->> 'recordedAt')::timestamptz
          < (v_observation ->> 'observedAt')::timestamptz
       or (v_intent ->> 'recordedAt')::timestamptz > checked_at
       or (v_intent ->> 'recordedAt')::timestamptz
          > (v_observation ->> 'validUntil')::timestamptz then
      raise exception 'SP write reservation observation or intent is stale'
        using errcode = '22023';
    end if;
  end if;

  if v_refusal is null then
    -- Authority remains current. Capacity and unresolved entity/source fences
    -- are nonterminal and consume no action.
    if exists (
      select 1
      from public.sp_write_provider_call_intents intent
      left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
      where result.intent_id is null
    ) or (
      v_receipt.bounded_authorization_id is not null and exists (
        select 1
        from public.sp_write_provider_call_intents intent
        join public.sp_write_cycle_plans child
          on child.org_id = intent.org_id and child.profile_id = intent.profile_id
         and child.execution_id = intent.execution_id and child.plan_id = intent.plan_id
        join public.sp_write_authorization_receipts receipt
          on receipt.approval_id = child.approval_id
        left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
        where receipt.bounded_authorization_id = v_receipt.bounded_authorization_id
          and (
            result.intent_id is null
            or exists (
              select 1
              from public.sp_write_provider_result_positions result_position
              left join public.sp_write_observations observation
                on observation.org_id = result_position.org_id
               and observation.profile_id = result_position.profile_id
               and observation.intent_id = result_position.intent_id
               and observation.result_id = result_position.result_id
               and observation.action_id = result_position.action_id
              where result_position.org_id = result.org_id
                and result_position.profile_id = result.profile_id
                and result_position.intent_id = result.intent_id
                and result_position.result_id = result.result_id
                and result_position.outcome <> 'authoritative_rejected'
                and observation.observation_id is null
            )
          )
      )
    ) or (
      v_receipt.bounded_authorization_id is null and exists (
        select 1 from public.sp_write_provider_call_intents intent
        left join public.sp_write_provider_results result on result.intent_id = intent.intent_id
        where intent.execution_id = p_execution_id and result.intent_id is null
      )
    ) then
      v_busy := true;
    end if;
    if not v_busy and exists (
      select 1
      from pg_catalog.jsonb_array_elements(v_intent -> 'positions') offered(value)
      join public.sp_write_provider_call_positions prior
        on prior.org_id = v_plan.org_id and prior.profile_id = v_plan.profile_id
       and prior.amazon_entity_id = offered.value ->> 'amazonEntityId'
      join public.sp_write_provider_call_intents prior_intent
        on prior_intent.intent_id = prior.intent_id
       and prior_intent.route_key::text = v_intent ->> 'routeKey'
      left join public.sp_write_provider_results prior_result
        on prior_result.intent_id = prior.intent_id
      left join public.sp_write_provider_result_positions prior_position
        on prior_position.result_id = prior_result.result_id
       and prior_position.action_id = prior.action_id
      left join public.sp_write_observations prior_observation
        on prior_observation.intent_id = prior.intent_id
       and prior_observation.action_id = prior.action_id
      where prior_intent.execution_id <> p_execution_id
        and (
          prior_result.result_id is null
          or (
            prior_position.outcome <> 'authoritative_rejected'
            and prior_observation.observation_id is null
          )
        )
    ) then
      v_busy := true;
    end if;
    if not v_busy and v_plan.direction = 'inverse' and not exists (
      select 1 from public.sp_write_plans source
      where source.plan_id = v_plan.source_plan_id
        and source.provider_rows = (
          select count(*) from public.sp_write_observations observed
          where observed.execution_id = p_execution_id
            and observed.plan_id = v_plan.source_plan_id
            and observed.outcome = 'observed_requested'
        )
    ) then
      v_busy := true;
    end if;
    if v_busy then
      decision := 'busy';
      refusal_reason := null;
      result_id := null;
      intent_text := null;
      return next;
      return;
    end if;
  end if;

  if v_refusal is null then
    if v_duplicate_intent then
      v_refusal := 'duplicate_intent';
      v_effective_at := checked_at;
    elsif pg_catalog.cardinality(v_context_invalid_action_ids) > 0 then
      v_refusal := 'unsupported_provider_state';
      v_effective_at := checked_at;
    elsif pg_catalog.cardinality(v_stale_action_ids) > 0 then
      v_refusal := 'stale_expected_state';
      v_effective_at := checked_at;
    end if;
  end if;

  if v_refusal is not null then
    if v_refusal in ('unsupported_provider_state', 'stale_expected_state') then
      v_targeted_action_ids := pg_catalog.array_cat(
        v_context_invalid_action_ids, v_stale_action_ids
      );
    else
      select pg_catalog.array_agg((position.value ->> 'actionId')::uuid)
      into v_targeted_action_ids
      from pg_catalog.jsonb_array_elements(v_intent -> 'positions') position(value);
    end if;
    v_targeted := pg_catalog.cardinality(v_targeted_action_ids);
    if v_targeted < 1 then
      raise exception 'SP write refusal selected no actions' using errcode = '22023';
    end if;

    if pg_catalog.cardinality(v_stale_action_ids) > 0
       and v_refusal in ('unsupported_provider_state', 'stale_expected_state') then
      insert into public.sp_write_predispatch_observations (
        observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
        generation, route_key, observed_at, valid_until, artifact_text, artifact,
        fingerprint_preimage, fingerprint, persisted_at
      ) values (
        (v_observation ->> 'observationId')::uuid, v_plan.org_id, v_plan.profile_id,
        p_execution_id, p_plan_id, v_child.approval_id, p_generation,
        (v_observation ->> 'routeKey')::public.sp_write_route_key,
        (v_observation ->> 'observedAt')::timestamptz,
        (v_observation ->> 'validUntil')::timestamptz,
        p_predispatch_observation_text, v_observation,
        p_predispatch_observation_preimage, v_observation ->> 'fingerprint', checked_at
      );
      for v_item, v_index in
        select value, (ordinality - 1)::integer
        from pg_catalog.jsonb_array_elements(v_observation -> 'items') with ordinality
      loop
        insert into public.sp_write_predispatch_observation_items (
          org_id, profile_id, observation_id, execution_id, plan_id, approval_id,
          generation, item_index, action_id, action_fingerprint, route_key,
          amazon_entity_id, observed
        ) values (
          v_plan.org_id, v_plan.profile_id,
          (v_observation ->> 'observationId')::uuid, p_execution_id, p_plan_id,
          v_child.approval_id, p_generation, v_index,
          (v_item ->> 'actionId')::uuid, v_item ->> 'actionFingerprint',
          (v_item ->> 'routeKey')::public.sp_write_route_key,
          v_item ->> 'amazonEntityId', v_item
        );
      end loop;
    end if;
    v_inserted := 0;
    for v_position in select value
      from pg_catalog.jsonb_array_elements(v_intent -> 'positions')
    loop
      if not ((v_position ->> 'actionId')::uuid = any(v_targeted_action_ids)) then
        continue;
      end if;
      if v_refusal not in ('unsupported_provider_state', 'stale_expected_state') then
        v_action_refusal := v_refusal;
      elsif (v_position ->> 'actionId')::uuid = any(v_context_invalid_action_ids) then
        v_action_refusal := 'unsupported_provider_state';
      else
        v_action_refusal := 'stale_expected_state';
      end if;
      v_disposition_id := gen_random_uuid();
      v_disposition := app.sp_write_disposition_artifact(
        v_disposition_id, p_plan_id, v_plan.fingerprint, v_child.approval_id,
        p_execution_id, p_generation, (v_position ->> 'actionId')::uuid,
        v_position ->> 'actionFingerprint', v_effective_at, v_action_refusal,
        case when v_action_refusal = 'stale_expected_state'
          then v_observation ->> 'fingerprint' end
      );
      insert into public.sp_write_predispatch_dispositions (
        disposition_id, org_id, profile_id, execution_id, plan_id, approval_id,
        generation, action_id, action_fingerprint, reason,
        provider_observation_fingerprint, recorded_at, persisted_at,
        artifact_text, artifact, fingerprint_preimage, fingerprint
      ) values (
        v_disposition_id, v_plan.org_id, v_plan.profile_id, p_execution_id,
        p_plan_id, v_child.approval_id, p_generation,
        (v_position ->> 'actionId')::uuid, v_position ->> 'actionFingerprint',
        v_action_refusal, case when v_action_refusal = 'stale_expected_state'
          then v_observation ->> 'fingerprint' end,
        v_effective_at, checked_at, v_disposition ->> 'artifactText',
        v_disposition -> 'artifact', v_disposition ->> 'fingerprintPreimage',
        v_disposition ->> 'fingerprint'
      );
      insert into public.sp_write_action_resolutions (
        org_id, profile_id, execution_id, plan_id, action_id, resolution_kind,
        disposition_id, intent_id, resolved_at
      ) values (
        v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
        (v_position ->> 'actionId')::uuid, 'refusal',
        v_disposition_id, null, checked_at
      );
      v_inserted := v_inserted + 1;
    end loop;
    if v_inserted <> v_targeted
       or (
         select count(*)
         from public.sp_write_predispatch_dispositions disposition
         where disposition.org_id = v_plan.org_id
           and disposition.profile_id = v_plan.profile_id
           and disposition.execution_id = p_execution_id
           and disposition.plan_id = p_plan_id
           and disposition.action_id = any(v_targeted_action_ids)
       ) <> v_targeted
       or (
         select count(*)
         from public.sp_write_action_resolutions resolution
         where resolution.org_id = v_plan.org_id
           and resolution.profile_id = v_plan.profile_id
           and resolution.execution_id = p_execution_id
           and resolution.plan_id = p_plan_id
           and resolution.resolution_kind = 'refusal'
           and resolution.action_id = any(v_targeted_action_ids)
       ) <> v_targeted then
      raise exception 'SP write refusal counts do not close' using errcode = '22023';
    end if;
    if pg_catalog.cardinality(v_stale_action_ids) > 0
       and v_refusal in ('unsupported_provider_state', 'stale_expected_state') and (
      (select count(*) from public.sp_write_predispatch_observations observation
       where observation.observation_id = (v_observation ->> 'observationId')::uuid) <> 1
      or
      (select count(*) from public.sp_write_predispatch_observation_items item
       where item.observation_id = (v_observation ->> 'observationId')::uuid) <> v_offered
    ) then
      raise exception 'SP write stale refusal observation counts do not close'
        using errcode = '22023';
    end if;
    if v_plan.artifact->>'schemaVersion'='openspell.sp-write-plan.v3' then
      perform app.refuse_sp_write_dependency_descendants(p_execution_id,p_plan_id,p_generation);
    end if;
    decision := 'refused';
    refusal_reason := v_refusal::text;
    result_id := null;
    intent_text := null;
    return next;
    return;
  end if;

  insert into public.sp_write_predispatch_observations (
    observation_id, org_id, profile_id, execution_id, plan_id, approval_id,
    generation, route_key, observed_at, valid_until, artifact_text, artifact,
    fingerprint_preimage, fingerprint, persisted_at
  ) values (
    (v_observation ->> 'observationId')::uuid, v_plan.org_id, v_plan.profile_id,
    p_execution_id, p_plan_id, v_child.approval_id, p_generation,
    (v_observation ->> 'routeKey')::public.sp_write_route_key,
    (v_observation ->> 'observedAt')::timestamptz,
    (v_observation ->> 'validUntil')::timestamptz,
    p_predispatch_observation_text, v_observation,
    p_predispatch_observation_preimage, v_observation ->> 'fingerprint', checked_at
  );
  for v_item, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_observation -> 'items') with ordinality
  loop
    insert into public.sp_write_predispatch_observation_items (
      org_id, profile_id, observation_id, execution_id, plan_id, approval_id,
      generation, item_index, action_id, action_fingerprint, route_key,
      amazon_entity_id, observed
    ) values (
      v_plan.org_id, v_plan.profile_id, (v_observation ->> 'observationId')::uuid,
      p_execution_id, p_plan_id, v_child.approval_id, p_generation, v_index,
      (v_item ->> 'actionId')::uuid, v_item ->> 'actionFingerprint',
      (v_item ->> 'routeKey')::public.sp_write_route_key,
      v_item ->> 'amazonEntityId', v_item
    );
  end loop;

  insert into public.sp_write_provider_call_intents (
    intent_id, provider_call_id, reserved_result_id, org_id, profile_id,
    execution_id, plan_id, approval_id, generation, route_key, attempt_number,
    dispatch_lease_id, provider_observation_fingerprint,
    request_fingerprint_preimage, request_fingerprint,
    intent_fingerprint_preimage, fingerprint, artifact_text, artifact,
    recorded_at, checked_at, dispatch_start_deadline, provider_attempt_deadline
  ) values (
    (v_intent ->> 'intentId')::uuid, (v_intent ->> 'providerCallId')::uuid,
    v_result_id, v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
    v_child.approval_id, p_generation,
    (v_intent ->> 'routeKey')::public.sp_write_route_key, 1,
    p_dispatch_lease_id, v_intent ->> 'providerObservationFingerprint',
    p_request_fingerprint_preimage, v_intent ->> 'requestFingerprint',
    p_intent_preimage, v_intent ->> 'fingerprint', p_intent_text, v_intent,
    (v_intent ->> 'recordedAt')::timestamptz, checked_at,
    checked_at + interval '5 seconds', checked_at + interval '35 seconds'
  );
  v_inserted := 0;
  for v_position, v_index in
    select value, (ordinality - 1)::integer
    from pg_catalog.jsonb_array_elements(v_intent -> 'positions') with ordinality
  loop
    insert into public.sp_write_provider_call_positions (
      org_id, profile_id, execution_id, plan_id, intent_id, request_index,
      action_id, action_fingerprint, amazon_entity_id, action_request_fingerprint
    ) values (
      v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
      (v_intent ->> 'intentId')::uuid, v_index,
      (v_position ->> 'actionId')::uuid, v_position ->> 'actionFingerprint',
      v_position ->> 'amazonEntityId', v_position ->> 'actionRequestFingerprint'
    );
    insert into public.sp_write_action_resolutions (
      org_id, profile_id, execution_id, plan_id, action_id, resolution_kind,
      disposition_id, intent_id, resolved_at
    ) values (
      v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
      (v_position ->> 'actionId')::uuid, 'intent', null,
      (v_intent ->> 'intentId')::uuid, checked_at
    );
    v_inserted := v_inserted + 1;
  end loop;
  v_source_sync_job_id := gen_random_uuid();
  insert into public.sp_write_outbox (
    org_id, profile_id, execution_id, plan_id, approval_id, generation,
    kind, provider_call_id, intent_id, source_sync_job_id, created_at
  ) values (
    v_plan.org_id, v_plan.profile_id, p_execution_id, p_plan_id,
    v_child.approval_id, p_generation, 'observe_and_recover',
    (v_intent ->> 'providerCallId')::uuid, (v_intent ->> 'intentId')::uuid,
    v_source_sync_job_id, checked_at
  );
  if v_inserted <> v_offered
     or (select count(*) from public.sp_write_predispatch_observations observation
         where observation.observation_id =
           (v_observation ->> 'observationId')::uuid) <> 1
     or (select count(*) from public.sp_write_predispatch_observation_items item
         where item.observation_id =
           (v_observation ->> 'observationId')::uuid) <> v_offered
     or (select count(*) from public.sp_write_provider_call_intents intent
         where intent.intent_id = (v_intent ->> 'intentId')::uuid) <> 1
     or (select count(*) from public.sp_write_provider_call_positions position
         where position.intent_id = (v_intent ->> 'intentId')::uuid) <> v_offered
     or (select count(*) from public.sp_write_action_resolutions resolution
         where resolution.intent_id = (v_intent ->> 'intentId')::uuid) <> v_offered
     or (select count(*) from public.sp_write_outbox outbox
         where outbox.intent_id = (v_intent ->> 'intentId')::uuid
           and outbox.kind = 'observe_and_recover') <> 1 then
    raise exception 'SP write reservation counts do not close' using errcode = '22023';
  end if;
  decision := 'won';
  refusal_reason := null;
  result_id := v_result_id;
  intent_text := p_intent_text;
  return next;
end;
$$;

create or replace function app.acquire_sp_write_dispatch_lease(
  p_execution_id uuid,
  p_plan_id uuid,
  p_generation uuid,
  p_route_key public.sp_write_route_key,
  p_lease_seconds integer default 120
)
returns table (lease_id uuid, acquired_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_request public.sp_write_execution_requests%rowtype;
  v_now timestamptz;
begin
  perform app.assert_service_role('acquire_sp_write_dispatch_lease');
  if p_lease_seconds < 70 or p_lease_seconds > 300 then
    raise exception 'SP write lease must be between 70 and 300 seconds'
      using errcode = '22023';
  end if;
  select request.* into strict v_request
  from public.sp_write_execution_requests request
  where request.execution_id = p_execution_id and request.plan_id = p_plan_id
    and request.generation = p_generation
  for update;
  v_now := clock_timestamp();
  if exists (
    select 1 from public.sp_write_dispatch_leases lease
    where lease.org_id = v_request.org_id and lease.profile_id = v_request.profile_id
      and lease.execution_id = p_execution_id and lease.plan_id = p_plan_id
      and lease.route_key = p_route_key and lease.expires_at > v_now
      and not (
        exists(select 1 from public.sp_write_plans plan where plan.plan_id=p_plan_id
          and plan.artifact->>'schemaVersion'='openspell.sp-write-plan.v3')
        and exists(select 1 from public.sp_write_provider_call_intents intent where intent.dispatch_lease_id=lease.lease_id)
        and not exists(select 1 from public.sp_write_provider_call_intents intent
          join public.sp_write_provider_call_positions position on position.intent_id=intent.intent_id
          left join public.sp_write_observations observation on observation.intent_id=intent.intent_id and observation.action_id=position.action_id
          left join public.sp_write_mirror_observations mirror on mirror.observation_id=observation.observation_id
            and mirror.observation_fingerprint=observation.fingerprint
          where intent.dispatch_lease_id=lease.lease_id and (observation.outcome is distinct from 'observed_requested'
            or mirror.outcome is null or mirror.outcome not in ('promoted','already_current')))
      )
  ) then
    raise exception 'SP write dispatch lease is unavailable' using errcode = '55P03';
  end if;
  lease_id := gen_random_uuid();
  acquired_at := v_now;
  expires_at := v_now + pg_catalog.make_interval(secs => p_lease_seconds);
  insert into public.sp_write_dispatch_leases (
    lease_id, org_id, profile_id, execution_id, plan_id, approval_id,
    generation, route_key, acquired_at, expires_at
  ) values (
    lease_id, v_request.org_id, v_request.profile_id, p_execution_id, p_plan_id,
    v_request.approval_id, p_generation, p_route_key, acquired_at, expires_at
  );
  return next;
end;
$$;

create or replace function app.defer_sp_write_outbox_claim(
  p_outbox_id uuid,
  p_claim_epoch bigint,
  p_claim_token uuid,
  p_reason text
)
returns table (
  decision text,
  reason text,
  checked_at timestamptz,
  available_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_head app.sp_write_outbox_delivery_heads%rowtype;
  v_latest app.sp_write_outbox_delivery_events%rowtype;
  v_now timestamptz;
  v_available_at timestamptz;
  v_digest text;
  v_backoff_seconds integer;
  v_affected integer;
begin
  perform app.assert_service_role('defer_sp_write_outbox_claim');
  if p_outbox_id is null or p_claim_epoch is null or p_claim_epoch < 1
     or p_claim_token is null
     or p_reason is null
     or p_reason not in (
       'reservation_busy', 'observation_pending', 'recovery_pending', 'shutdown'
     ) then
    raise exception 'SP write outbox defer input is invalid' using errcode = '22023';
  end if;
  select * into v_head
  from app.sp_write_outbox_delivery_heads head
  where head.outbox_id = p_outbox_id
  for update;
  v_now := clock_timestamp();
  checked_at := v_now;
  reason := null;
  v_digest := app.sp_write_outbox_claim_token_digest(p_claim_token);

  if found
     and v_head.state = 'leased'
     and v_head.claim_epoch = p_claim_epoch
     and v_head.token_digest = v_digest
     and v_head.lease_expires_at > v_now then
    v_backoff_seconds := least(
      300,
      (15 * power(2::numeric, least(greatest(v_head.attempt_count - 1, 0), 5)))::integer
    );
    -- Dependency progress has a short fixed retry; delivery events still record every transition.
    if p_reason='reservation_busy' and exists(select 1 from public.sp_write_outbox source
      join public.sp_write_plans plan on plan.plan_id=source.plan_id
      where source.outbox_id=p_outbox_id and source.kind='dispatch' and plan.artifact->>'schemaVersion'='openspell.sp-write-plan.v3') then
      v_backoff_seconds:=1;
    end if;
    v_available_at := v_now + make_interval(secs => v_backoff_seconds);
    update app.sp_write_outbox_delivery_heads head
    set state = 'available',
        transition_sequence = v_head.transition_sequence + 1,
        claimant_id = null,
        token_digest = null,
        claimed_at = null,
        lease_expires_at = null,
        available_at = v_available_at,
        completed_at = null
    where head.outbox_id = p_outbox_id;
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'SP write outbox defer head count does not close'
        using errcode = 'P0003';
    end if;
    insert into app.sp_write_outbox_delivery_events (
      org_id, profile_id, outbox_id, transition_sequence, claim_epoch,
      event_kind, actor_claimant_id, actor_token_digest, recorded_at,
      claimed_at, lease_expires_at, available_at, completed_at, defer_reason
    ) values (
      v_head.org_id, v_head.profile_id, v_head.outbox_id,
      v_head.transition_sequence + 1, v_head.claim_epoch,
      'deferred', v_head.claimant_id, v_digest, v_now,
      null, null, v_available_at, null, p_reason
    );
    get diagnostics v_affected = row_count;
    if v_affected <> 1 then
      raise exception 'SP write outbox defer event count does not close'
        using errcode = 'P0003';
    end if;
    decision := 'deferred';
    reason := p_reason;
    available_at := v_available_at;
    return next;
    return;
  end if;

  if found then
    select * into v_latest
    from app.sp_write_outbox_delivery_events event
    where event.outbox_id = v_head.outbox_id
      and event.transition_sequence = v_head.transition_sequence;
    if found
       and v_latest.event_kind = 'deferred'
       and v_latest.claim_epoch = p_claim_epoch
       and v_latest.actor_token_digest = v_digest
       and v_latest.defer_reason = p_reason then
      decision := 'already_deferred';
      reason := p_reason;
      available_at := v_latest.available_at;
      return next;
      return;
    end if;
  end if;
  decision := 'stale_claim';
  available_at := null;
  return next;
end;
$$;
