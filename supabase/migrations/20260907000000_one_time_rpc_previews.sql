-- Explicit one-time RPC previews. Additive to the recommendation custody baseline.
-- Historical/scheduled v1 rows remain unchanged. No producer is enabled here.

alter table public.recommendation_preview_batches add column execution_snapshot jsonb;
alter table public.recommendation_runs add column execution_snapshot jsonb;

create function app.one_time_rpc_snapshot_valid(p_snapshot jsonb)
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
     or v_config -> 'method' is distinct from '"rpc"'::jsonb then
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

create function app.one_time_rpc_snapshot_fingerprint(p_snapshot jsonb)
returns text
language plpgsql
stable
strict
set search_path = pg_catalog, app
as $$
declare
  v_config jsonb := p_snapshot -> 'configuration';
  v_values text[] := array['1','1','rpc'];
  v_key text;
  v_number double precision;
  v_value text;
  v_preimage text := E'openspell.one-time-rpc.snapshot.v1\n';
begin
  if not app.one_time_rpc_snapshot_valid(p_snapshot) then
    raise exception 'invalid one-time RPC snapshot' using errcode = '22023';
  end if;
  foreach v_key in array array['targetAcos','bidFloor','bidCeiling','bidIncreaseCap','bidDecreaseCap'] loop
    v_number := (v_config ->> v_key)::double precision;
    if v_number = 0 then v_number := 0; end if;
    v_values := array_append(v_values, encode(float8send(v_number), 'hex'));
  end loop;
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

alter table public.recommendation_preview_batches
  add constraint recommendation_preview_batches_execution_snapshot_check
    check (execution_snapshot is null or app.one_time_rpc_snapshot_valid(execution_snapshot));

alter table public.recommendation_runs
  drop constraint recommendation_runs_scope_shape_check,
  drop constraint recommendation_runs_batch_requires_scope_check,
  add constraint recommendation_runs_scope_shape_check check (
    (scope_version is null and scope_count is null and scope_fingerprint is null
      and job_id is null and strategy_goal is null and execution_snapshot is null)
    or
    (scope_version = 1 and scope_count between 1 and 10000
      and scope_fingerprint ~ '^[0-9a-f]{64}$' and job_id is not null
      and strategy_snapshot is not null and btrim(strategy_goal) <> '' and execution_snapshot is null)
    or
    (scope_version = 2 and scope_count is not null and scope_count between 1 and 10000
      and scope_fingerprint is not null and scope_fingerprint ~ '^[0-9a-f]{64}$' and job_id is not null and batch_id is not null
      and strategy_snapshot is null and strategy_goal is null and execution_snapshot is not null
      and app.one_time_rpc_snapshot_valid(execution_snapshot))
  ),
  add constraint recommendation_runs_batch_requires_scope_check
    check (batch_id is null or scope_version in (1,2));

create function app.guard_one_time_rpc_snapshot()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if old.execution_snapshot is distinct from new.execution_snapshot then
    raise exception 'one-time RPC snapshots are immutable' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_one_time_rpc_snapshot() from public;
create trigger recommendation_runs_one_time_snapshot_immutable
  before update on public.recommendation_runs for each row execute function app.guard_one_time_rpc_snapshot();
create trigger recommendation_batches_one_time_snapshot_immutable
  before update on public.recommendation_preview_batches for each row execute function app.guard_one_time_rpc_snapshot();


create function app.recommendation_campaign_safety(
  p_org_id uuid,
  p_profile_id uuid,
  p_campaign_ids text[]
)
returns jsonb
language sql
stable
strict
security invoker
set search_path = pg_catalog
as $$
  with exported as (
    select recommendation.id,
           recommendation.campaign_id is null and recommendation.entity_type <> 'campaign' as unresolved_scope
      from public.recommendations recommendation
     where recommendation.org_id = p_org_id
       and recommendation.profile_id = p_profile_id
       and (
         (recommendation.campaign_id is null and recommendation.entity_type <> 'campaign')
         or recommendation.campaign_id = any (p_campaign_ids)
         or (recommendation.campaign_id is null and recommendation.entity_type = 'campaign'
             and recommendation.entity_id = any (p_campaign_ids))
       )
       and exists (
         select 1
           from public.apply_rows apply_row
           join public.apply_batches batch
             on batch.org_id = p_org_id
            and batch.profile_id = p_profile_id
            and batch.id = apply_row.batch_id
            and batch.status in ('staged', 'applied')
          where apply_row.org_id = p_org_id
            and apply_row.profile_id = p_profile_id
            and apply_row.recommendation_id = recommendation.id
       )
  ), evidence as (
    select exported.id, exported.unresolved_scope, observation.evidence_state, observation.decision
      from exported
      left join lateral (
        select candidate.evidence_state::text as evidence_state,
               candidate.decision::text as decision
          from public.recommendation_observations candidate
         where candidate.org_id = p_org_id
           and candidate.profile_id = p_profile_id
           and candidate.recommendation_id = exported.id
         order by candidate.observed_at desc, candidate.id desc
         limit 1
      ) observation on true
  ), counts as (
    select count(*)::integer as exported_recommendations,
           count(*) filter (where unresolved_scope)::integer as unresolved_scopes,
           count(*) filter (
             where unresolved_scope or evidence_state is null or evidence_state <> 'complete'
           )::integer as incomplete_observations,
           count(*) filter (where decision = 'hold')::integer as hold_decisions,
           count(*) filter (where decision = 'revert')::integer as revert_decisions
      from evidence
  )
  select jsonb_build_object(
    'mayPropose', revert_decisions = 0 and incomplete_observations = 0 and hold_decisions = 0,
    'exportedRecommendations', exported_recommendations,
    'incompleteObservations', incomplete_observations,
    'holdDecisions', hold_decisions,
    'revertDecisions', revert_decisions,
    'reason', case
      when unresolved_scopes > 0 then
        'An exported recommendation has no recorded campaign identity; its safety scope cannot be established.'
      when revert_decisions > 0 then
        revert_decisions::text || ' exported recommendation(s) require reversion review before another preview'
      when incomplete_observations > 0 or hold_decisions > 0 then
        greatest(incomplete_observations, hold_decisions)::text
          || ' exported recommendation(s) are awaiting complete synchronized evidence; hold and do not compound'
      when exported_recommendations = 0 then
        'No prior exported recommendation requires observation.'
      else 'Every active exported recommendation has complete continue evidence.'
    end
  ) from counts;
$$;

revoke all on function app.recommendation_campaign_safety(uuid, uuid, text[]) from public;
grant execute on function app.recommendation_campaign_safety(uuid, uuid, text[])
  to service_role, openspell_recommendation_executor;


create or replace function app.recommendation_job_scope_closes(p_job_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_job public.sync_jobs;
  v_run public.recommendation_runs;
  v_campaign_ids text[];
  v_scope_count integer;
  v_batch record;
begin
  select * into v_job
    from public.sync_jobs job
   where job.id = p_job_id
     and job.job_type = 'recommendations.run';
  if not found
     or pg_catalog.jsonb_typeof(v_job.payload) <> 'object'
     or v_job.payload ->> 'type' <> 'recommendations.run'
     or v_job.payload ->> 'orgId' <> v_job.org_id::text
     or v_job.payload ->> 'profileId' <> v_job.profile_id::text
     or not coalesce((v_job.payload ->> 'runId') ~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', false)
 then
    return false;
  end if;

  select * into v_run
    from public.recommendation_runs run
   where run.id = (v_job.payload ->> 'runId')::uuid
     and run.org_id = v_job.org_id
     and run.profile_id = v_job.profile_id
     and run.job_id = v_job.id;
  if not found
     -- WP-195 producers predate the marker column. A structurally complete
     -- scoped run is queue lineage unless it is explicitly marked human.
     or v_run.execution_lineage is not distinct from 'human'
     or v_run.scope_version not in (1,2)
     or v_run.scope_count is null
     or v_run.scope_count not between 1 and 10000
     or v_run.scope_fingerprint is null

     or coalesce(v_job.payload ->> 'groupId', '')
        <> coalesce(v_run.group_id::text, '') then
    return false;
  end if;

  if v_run.scope_version = 1 then
    if v_job.payload ? 'executionVersion' or v_job.payload ? 'snapshotFingerprint'
       or v_run.execution_snapshot is not null or v_run.strategy_snapshot is null
       or nullif(btrim(v_run.strategy_goal), '') is null
       or not coalesce((v_job.payload ->> 'lookbackDays') ~ '^[1-9][0-9]*$', false)
       or (v_job.payload ->> 'lookbackDays')::integer > 366
       or v_run.lookback_days <> (v_job.payload ->> 'lookbackDays')::integer then return false; end if;
  else
    if v_job.payload - array['type','orgId','profileId','runId','groupId','executionVersion','snapshotFingerprint'] <> '{}'::jsonb
       or v_job.payload -> 'executionVersion' is distinct from '2'::jsonb
       or v_run.batch_id is null or v_run.strategy_snapshot is not null or v_run.strategy_goal is not null
       or not app.one_time_rpc_snapshot_valid(v_run.execution_snapshot)
       or v_job.payload ->> 'snapshotFingerprint' is distinct from app.one_time_rpc_snapshot_fingerprint(v_run.execution_snapshot)
       or v_run.lookback_days <> (v_run.execution_snapshot #>> '{configuration,window,end}')::date
          - (v_run.execution_snapshot #>> '{configuration,window,start}')::date + 1 then return false; end if;
  end if;

  select pg_catalog.count(*)::integer,
         coalesce(
           pg_catalog.array_agg(scope.campaign_id order by scope.campaign_id collate "C"),
           array[]::text[]
         )
    into v_scope_count, v_campaign_ids
    from public.recommendation_run_campaigns scope
   where scope.org_id = v_run.org_id
     and scope.profile_id = v_run.profile_id
     and scope.run_id = v_run.id
     and scope.batch_id is not distinct from v_run.batch_id;

  if v_scope_count <> v_run.scope_count
     or v_scope_count <> pg_catalog.cardinality(v_campaign_ids)
     or v_run.scope_fingerprint <>
       app.recommendation_run_scope_fingerprint(
         v_run.profile_id, v_run.group_id, v_campaign_ids
       ) then
    return false;
  end if;

  if v_run.batch_id is null then
    return true;
  end if;

  select batch.scope_count, batch.scope_fingerprint, batch.child_count,
         pg_catalog.count(distinct child.id)::integer as actual_children,
         pg_catalog.count(member.campaign_id)::integer as actual_campaigns,
         coalesce(
           pg_catalog.array_agg(member.campaign_id order by member.campaign_id collate "C"),
           array[]::text[]
         ) as campaign_ids,
         pg_catalog.count(distinct child.job_id)::integer as actual_jobs,
         pg_catalog.bool_and(
           child.execution_lineage is distinct from 'human'
           and child.scope_version = v_run.scope_version
           and child.execution_snapshot is not distinct from batch.execution_snapshot
           and child.execution_snapshot is not distinct from v_run.execution_snapshot
           and child.job_id is not null
         ) as children_scoped
    into v_batch
    from public.recommendation_preview_batches batch
    join public.recommendation_runs child
      on child.org_id = batch.org_id
     and child.profile_id = batch.profile_id
     and child.batch_id = batch.id
    join public.recommendation_run_campaigns member
      on member.org_id = child.org_id
     and member.profile_id = child.profile_id
     and member.run_id = child.id
     and member.batch_id = child.batch_id
   where batch.id = v_run.batch_id
     and batch.org_id = v_run.org_id
     and batch.profile_id = v_run.profile_id
   group by batch.scope_count, batch.scope_fingerprint, batch.child_count;

  if not found
     or not coalesce(v_batch.children_scoped, false)
     or v_batch.actual_children <> v_batch.child_count
     or v_batch.actual_jobs <> v_batch.child_count
     or v_batch.actual_campaigns <> v_batch.scope_count
     or v_batch.scope_fingerprint <>
       app.recommendation_batch_scope_fingerprint(v_run.profile_id, v_batch.campaign_ids) then
    return false;
  end if;

  return true;
exception
  when invalid_text_representation or numeric_value_out_of_range
    or invalid_datetime_format or datetime_field_overflow or invalid_parameter_value then
    return false;
end;
$$;

create or replace function public.start_recommendation_run_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid
)
returns table (decision text, run_data jsonb, profile_data jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_profile public.ad_profiles;
begin
  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status not in ('queued', 'running', 'failed', 'succeeded') then
    raise exception 'recommendation run has an invalid execution state' using errcode = '55000';
  end if;
  select * into v_profile from public.ad_profiles profile
   where profile.org_id = v_run.org_id and profile.id = v_run.profile_id;
  if not found then
    raise exception 'recommendation execution profile is unavailable' using errcode = '55000';
  end if;
  if v_run.status <> 'succeeded' then
    update public.recommendation_runs run
       set status = 'running', started_at = coalesce(run.started_at, now()),
           finished_at = null, error = null
     where run.id = v_run.id and run.org_id = v_run.org_id
       and run.profile_id = v_run.profile_id
    returning run.* into v_run;
  end if;
  return query select
    case when v_run.status = 'succeeded' then 'already_succeeded' else 'started' end,
    pg_catalog.jsonb_build_object(
      'proposalsCount', v_run.proposals_count,
      'lookbackDays', v_run.lookback_days,
      'groupId', v_run.group_id,
      'groupRole', v_run.group_role,
      'groupSnapshot', v_run.group_snapshot,
      'dueAt', v_run.due_at,
      'scheduleContext', v_run.schedule_context,
      'strategySnapshot', v_run.strategy_snapshot,
      'strategyGoal', v_run.strategy_goal,
      'scopeVersion', v_run.scope_version,
      'executionSnapshot', v_run.execution_snapshot
    ),
    pg_catalog.jsonb_build_object(
      'orgId', v_profile.org_id,
      'profileId', v_profile.id,
      'timezone', v_profile.timezone,
      'goal', v_profile.goal_lens,
      'monthlyBudget', v_profile.monthly_budget
    );
end;
$$;

create or replace function public.succeed_recommendation_run_fenced(
  p_job_id uuid,
  p_worker_id text,
  p_claim_token uuid,
  p_revision text,
  p_org_id uuid,
  p_profile_id uuid,
  p_run_id uuid,
  p_group_id uuid,
  p_completion jsonb
)
returns table (decision text, proposals_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_run public.recommendation_runs;
  v_offered integer;
  v_inserted integer;
  v_notes_offered integer;
  v_notes_inserted integer;
  v_start date;
  v_end date;
begin
  if p_completion is null or pg_catalog.jsonb_typeof(p_completion) <> 'object'
     or pg_catalog.octet_length(p_completion::text) > 67108864
     or pg_catalog.jsonb_typeof(p_completion -> 'proposals') <> 'array'
     or pg_catalog.jsonb_array_length(p_completion -> 'proposals') > 100000
     or not coalesce((p_completion ->> 'lookbackDays') ~ '^[1-9][0-9]*$', false)
     or not coalesce((p_completion #>> '{window,start}') ~ '^\d{4}-\d{2}-\d{2}$', false)
     or not coalesce((p_completion #>> '{window,end}') ~ '^\d{4}-\d{2}-\d{2}$', false)
     or p_completion -> 'strategySnapshot' is null
     or p_completion -> 'narrative' is null then
    raise exception 'recommendation completion envelope is invalid' using errcode = '22023';
  end if;
  begin
    v_start := (p_completion #>> '{window,start}')::date;
    v_end := (p_completion #>> '{window,end}')::date;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'recommendation completion window is invalid' using errcode = '22023';
  end;

  v_run := app.lock_recommendation_claimed_run(
    p_job_id, p_worker_id, p_claim_token, p_revision,
    p_org_id, p_profile_id, p_run_id, p_group_id
  );
  if v_run.status = 'succeeded' then
    return query select 'already_succeeded'::text, v_run.proposals_count;
    return;
  end if;
  if v_run.status <> 'running'
     or (p_completion ->> 'lookbackDays')::integer <> v_run.lookback_days
     or v_end < v_start
     or (v_end - v_start + 1) <> v_run.lookback_days
     or nullif(p_completion -> 'strategySnapshot', 'null'::jsonb) is distinct from v_run.strategy_snapshot
     or (v_run.scope_version = 2 and (
       v_start is distinct from (v_run.execution_snapshot #>> '{configuration,window,start}')::date
       or v_end is distinct from (v_run.execution_snapshot #>> '{configuration,window,end}')::date
       or p_completion #> '{narrative,oneTimeConfiguration}' is distinct from v_run.execution_snapshot -> 'configuration'
     )) then
    raise exception 'recommendation completion does not match the locked run'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.recommendations recommendation
     where recommendation.run_id = v_run.id
  ) then
    raise exception 'running recommendation run already has result rows' using errcode = '55000';
  end if;
  if exists (
    select 1
      from pg_catalog.jsonb_array_elements(p_completion -> 'proposals') offered(value)
     where pg_catalog.jsonb_typeof(offered.value) <> 'object'
        or pg_catalog.jsonb_typeof(offered.value -> 'entityRef') <> 'object'
        or offered.value #>> '{entityRef,profileId}' <> v_run.profile_id::text
        or nullif(pg_catalog.btrim(offered.value #>> '{entityRef,entityId}'), '') is null
        or nullif(pg_catalog.btrim(offered.value ->> 'field'), '') is null
        or nullif(pg_catalog.btrim(offered.value #>> '{entityRef,campaignId}'), '') is null
        or offered.value -> 'inputs' is null
        or pg_catalog.jsonb_typeof(offered.value -> 'preconditionNotes') <> 'array'
        or not exists (
          select 1 from public.recommendation_run_campaigns member
           where member.org_id = v_run.org_id
             and member.profile_id = v_run.profile_id
             and member.run_id = v_run.id
             and member.campaign_id = offered.value #>> '{entityRef,campaignId}'
        )
        or exists (
          select 1
            from pg_catalog.jsonb_array_elements(offered.value -> 'preconditionNotes') note(value)
           where pg_catalog.jsonb_typeof(note.value) <> 'object'
              or nullif(pg_catalog.btrim(note.value ->> 'code'), '') is null
              or nullif(pg_catalog.btrim(note.value ->> 'message'), '') is null
        )
  ) then
    raise exception 'recommendation completion contains an invalid or out-of-scope proposal'
      using errcode = '23514';
  end if;

  v_offered := pg_catalog.jsonb_array_length(p_completion -> 'proposals');
  select pg_catalog.count(*)::integer into v_notes_offered
    from pg_catalog.jsonb_array_elements(p_completion -> 'proposals') offered(value)
   where pg_catalog.jsonb_array_length(offered.value -> 'preconditionNotes') > 0;

  with offered as materialized (
    select pg_catalog.gen_random_uuid() as id, proposal.value, proposal.ordinality
      from pg_catalog.jsonb_array_elements(p_completion -> 'proposals')
           with ordinality proposal(value, ordinality)
  ), inserted as (
    insert into public.recommendations
      (id, run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product,
       campaign_id, ad_group_id, entity_name, field, current_value, proposed_value,
       inputs, status)
    select offered.id, v_run.id, v_run.org_id, v_run.profile_id,
           (offered.value ->> 'reason')::public.recommendation_reason,
           (offered.value #>> '{entityRef,entityType}')::public.entity_type,
           offered.value #>> '{entityRef,entityId}',
           (offered.value #>> '{entityRef,adProduct}')::public.ad_product,
           offered.value #>> '{entityRef,campaignId}',
           offered.value #>> '{entityRef,adGroupId}',
           offered.value #>> '{entityRef,name}',
           offered.value ->> 'field', offered.value -> 'currentValue',
           offered.value -> 'proposedValue', offered.value -> 'inputs',
           'proposed'::public.recommendation_status
      from offered order by offered.ordinality
    returning id
  ), noted as (
    insert into public.audit_log
      (org_id, actor_type, action, target_type, target_id, payload, source)
    select v_run.org_id, 'service', 'recommendation.preconditions.noted',
           'recommendation', offered.id::text,
           pg_catalog.jsonb_build_object(
             'note', (
               select pg_catalog.string_agg(note.value ->> 'message', ' ' order by note.ordinality)
                 from pg_catalog.jsonb_array_elements(offered.value -> 'preconditionNotes')
                      with ordinality note(value, ordinality)
             ),
             'codes', (
               select pg_catalog.jsonb_agg(note.value -> 'code' order by note.ordinality)
                 from pg_catalog.jsonb_array_elements(offered.value -> 'preconditionNotes')
                      with ordinality note(value, ordinality)
             )
           ), 'worker'
      from offered join inserted using (id)
     where pg_catalog.jsonb_array_length(offered.value -> 'preconditionNotes') > 0
    returning 1 as inserted
  )
  select (select pg_catalog.count(*)::integer from inserted),
         (select pg_catalog.count(*)::integer from noted)
    into v_inserted, v_notes_inserted;

  if v_inserted <> v_offered or v_notes_inserted <> v_notes_offered then
    raise exception 'recommendation completion row counts do not close' using errcode = '55000';
  end if;
  update public.recommendation_runs run
     set status = 'succeeded', lookback_days = v_run.lookback_days,
         window_start = v_start, window_end = v_end,
         engine_version = 'white-box-v1', proposals_count = v_inserted,
         finished_at = now(), error = null
   where run.id = v_run.id and run.org_id = v_run.org_id
     and run.profile_id = v_run.profile_id;
  if not found then
    raise exception 'succeeded zero recommendation runs' using errcode = '55000';
  end if;
  insert into public.audit_log
    (org_id, actor_type, action, target_type, target_id, payload, source)
  values (
    v_run.org_id, 'service', 'recommendation.run.succeeded',
    'recommendation_run', v_run.id::text,
    pg_catalog.jsonb_build_object(
      'engineVersion', 'white-box-v1', 'proposals', v_inserted,
      'narrative', p_completion -> 'narrative'
    ), 'worker'
  );
  return query select 'succeeded'::text, v_inserted;
end;
$$;

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
    'targets', v_targets, 'campaigns', v_campaigns, 'profileFacts', v_profile_facts
  );
  if pg_catalog.octet_length(v_inputs::text) > 67108864 then
    raise exception 'recommendation execution inputs exceed the byte bound'
      using errcode = '54000';
  end if;
  return query select v_inputs, v_group_safety;
end;
$$;
