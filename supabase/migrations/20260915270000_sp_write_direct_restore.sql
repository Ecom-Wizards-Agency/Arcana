set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- A source row can own a forward write and a restore independently. The existing
-- root uniqueness omitted this operation class and wrongly made them collide.
alter table app.sp_write_forward_admissions add column operation_kind text not null default 'forward'
  check(operation_kind in ('forward','restore'));
-- Name and definition verified against the WP-269 migration on a disposable database.
alter table app.sp_write_forward_admissions
  drop constraint sp_write_forward_admissions_org_id_profile_id_source_row_id_key;
create unique index sp_write_forward_admissions_source_operation on app.sp_write_forward_admissions
  (org_id,profile_id,source_row_id,parent_plan_id,operation_kind) nulls not distinct;

create or replace function app.assert_sp_write_forward_lineage(p_plan jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_org uuid:=(p_plan->>'orgId')::uuid; v_profile uuid:=(p_plan->>'profileId')::uuid;
  v_id uuid:=(p_plan->>'id')::uuid; v_parent public.sp_write_plans%rowtype;
  v_origin jsonb:=p_plan#>'{source,retryOrigin}'; v_rows uuid[]; v_eligible uuid[];
  v_action jsonb; v_row uuid; v_parent_action jsonb; v_count integer;
begin
  if p_plan->>'schemaVersion'<>'openspell.sp-write-plan.v1' or p_plan->>'direction'<>'forward' then return; end if;
  select array_agg((s->>'applyRowId')::uuid order by s->>'applyRowId') into v_rows
    from jsonb_array_elements(p_plan->'actions') a cross join lateral jsonb_array_elements(a->'sources') s;
  -- Caller already holds source parents, the complete batch FOR UPDATE, and rows.
  -- Lock parent operation after source, as in approval. Terminal action evidence is immutable.
  if v_origin is not null then
    if not coalesce(app.sp_write_exact_json_keys(v_origin,array['executionId','planId','planFingerprint']),false)
      or v_origin->>'planId'=v_id::text then raise exception 'Invalid retry origin' using errcode='22023'; end if;
    select * into strict v_parent from public.sp_write_plans where org_id=v_org and profile_id=v_profile
      and plan_id=(v_origin->>'planId')::uuid;
    if v_parent.fingerprint is distinct from v_origin->>'planFingerprint'
      or v_parent.artifact->>'schemaVersion'<>'openspell.sp-write-plan.v1' or v_parent.direction<>'forward'
      or v_parent.artifact#>>'{source,applyBatchId}' is distinct from p_plan#>>'{source,applyBatchId}'
      or v_parent.artifact->'providerScope' is distinct from p_plan->'providerScope'
      or (v_parent.artifact#>'{source,restoreProposal}' is null) is distinct from (p_plan#>'{source,restoreProposal}' is null) then
      raise exception 'Retry origin differs from its source' using errcode='55000'; end if;
    perform 1 from public.sp_write_cycle_plans where org_id=v_org and profile_id=v_profile
      and execution_id=(v_origin->>'executionId')::uuid and plan_id=v_parent.plan_id for update;
    if not found then raise exception 'Retry origin was not admitted' using errcode='55000'; end if;
    select array_agg(source_row_id order by source_row_id) filter(where eligible),count(*)
      into v_eligible,v_count from app.sp_write_retry_population(v_org,v_profile,(v_origin->>'executionId')::uuid,v_parent.plan_id);
    if v_count<>v_parent.provider_rows or v_eligible is null or v_rows is distinct from v_eligible
      or to_jsonb(v_rows) is distinct from (case when p_plan#>'{source,restoreProposal}' is null
        then p_plan#>'{source,forwardRowIds}' else (select jsonb_agg(value order by value) from jsonb_array_elements(p_plan#>'{source,restoreProposal,sourceRowIds}')) end) then
      raise exception 'Retry requires the exact eligible unresolved population' using errcode='55000'; end if;
    for v_action in select value from jsonb_array_elements(p_plan->'actions') loop
      select artifact into strict v_parent_action from public.sp_write_plan_actions
        where org_id=v_org and profile_id=v_profile and plan_id=v_parent.plan_id
          and artifact->'sources'=v_action->'sources';
      if (v_action-array['actionId','fingerprint']) is distinct from (v_parent_action-array['actionId','fingerprint']) then
        raise exception 'Retry cannot rewrite original expected or requested values; fresh evaluation required' using errcode='55000'; end if;
    end loop;
  end if;
  if p_plan#>'{source,restoreProposal}' is not null and exists(
    with recursive ancestors(plan_id) as (
      select (v_origin->>'planId')::uuid where v_origin is not null
      union select edge.parent_plan_id from app.sp_write_forward_lineage edge join ancestors a on edge.retry_plan_id=a.plan_id
        where edge.org_id=v_org and edge.profile_id=v_profile
    ) select 1 from public.sp_write_cycle_plans cycle join public.sp_write_restore_proposals proposal
      on proposal.org_id=cycle.org_id and proposal.profile_id=cycle.profile_id and proposal.plan_id=cycle.plan_id
    where cycle.org_id=v_org and cycle.profile_id=v_profile and proposal.source_batch_id=(p_plan#>>'{source,applyBatchId}')::uuid
      and cycle.plan_id<>v_id and not exists(select 1 from ancestors where plan_id=cycle.plan_id)
  ) then raise exception 'restore_active_reversion: This source already has an admitted restore; retry its failed rows.'
      using errcode='55000',detail='restore_active_reversion'; end if;
  foreach v_row in array v_rows loop
    -- Include historical admissions, even when they predate this migration.
    -- Every other admitted owner must be an ancestor of the requested parent.
    if exists(with recursive ancestors(plan_id) as (
      select (v_origin->>'planId')::uuid where v_origin is not null
      union
      select edge.parent_plan_id from app.sp_write_forward_lineage edge join ancestors a on edge.retry_plan_id=a.plan_id
        where edge.org_id=v_org and edge.profile_id=v_profile and edge.source_row_id=v_row
    ) select 1 from public.sp_write_cycle_plans cycle
      join public.sp_write_plans owner_plan on owner_plan.org_id=cycle.org_id and owner_plan.profile_id=cycle.profile_id and owner_plan.plan_id=cycle.plan_id
      join public.sp_write_plan_actions a on a.org_id=cycle.org_id and a.profile_id=cycle.profile_id and a.plan_id=cycle.plan_id
      where cycle.org_id=v_org and cycle.profile_id=v_profile and cycle.direction='forward' and cycle.plan_id<>v_id
        and (owner_plan.artifact#>'{source,restoreProposal}' is null) = (p_plan#>'{source,restoreProposal}' is null)
        and exists(select 1 from jsonb_array_elements(a.artifact->'sources') s where s->>'kind'='apply_row' and s->>'applyRowId'=v_row::text)
        and not exists(select 1 from ancestors where plan_id=cycle.plan_id)) then
      raise exception 'Source row already has an admitted owner; retry the latest failed operation' using errcode='55000';
    end if;
  end loop;
end $$;
revoke all on function app.assert_sp_write_forward_lineage(jsonb) from public,anon,authenticated,service_role;

create or replace function app.assert_sp_write_restore_source(
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
  v_keyword public.keywords%rowtype;
  v_restore jsonb;
  v_read timestamptz;
  v_observed timestamptz;
  v_source_artifact jsonb;
  v_index integer;
  v_count integer := 0;
  v_actual_count integer;
begin
  v_plan := app.sp_write_verified_artifact(p_plan_text, p_plan_preimage, 'openspell.sp-write-plan.v1');
  v_evidence := p_evidence_text::jsonb;
  v_guards := p_guardrail_preimage::jsonb;
  v_provenance := p_provenance_preimage::jsonb;
  if v_evidence ->> 'schemaVersion' is distinct from 'openspell.sp-write-preview-evidence.v1'
     or not coalesce(app.sp_write_exact_json_keys(v_evidence, array['schemaVersion','planId','guardrails','provenance']), false)
     or v_evidence -> 'planId' is distinct from v_plan -> 'id'
     or v_plan ->> 'direction' is distinct from 'forward'
     or v_plan #>> '{source,kind}' is distinct from 'apply_batch'
     or v_plan #>> '{source,restoreProposal,kind}' is distinct from 'restore_proposal'
     or v_plan #>> '{source,restoreProposal,sourceBatchId}' is distinct from v_plan #>> '{source,applyBatchId}'
     or jsonb_typeof(v_guards) is distinct from 'array' or jsonb_array_length(v_guards) <> 2
     or v_guards ->> 0 is distinct from 'openspell.sp-write-preview-guards.v1'
     or v_guards -> 1 is distinct from v_evidence -> 'guardrails'
     or app.sp_write_sha256(p_guardrail_preimage) is distinct from v_plan #>> '{source,guardrailSnapshotFingerprint}'
     or jsonb_typeof(v_provenance) is distinct from 'array' or jsonb_array_length(v_provenance) <> 2
     or v_provenance ->> 0 is distinct from 'openspell.sp-write-preview-source.v1'
     or v_provenance -> 1 is distinct from v_evidence -> 'provenance'
     or app.sp_write_sha256(p_provenance_preimage) is distinct from v_plan #>> '{source,provenanceSnapshotFingerprint}'
     or v_evidence #> '{guardrails,providerScope}' is distinct from v_plan -> 'providerScope'
     or v_evidence #> '{guardrails,maximumProviderRows}' is distinct from '500'::jsonb
     or v_evidence #> '{guardrails,requireCurrentValueMatch}' is distinct from 'true'::jsonb
     or v_evidence #>> '{provenance,applyBatchId}' is distinct from v_plan #>> '{source,applyBatchId}' then
    raise exception 'SP preview evidence does not bind its plan' using errcode = '22023';
  end if;
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
   for share of h, g, p, c;
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
  if v_actual_count <> v_batch.exported_proposals then raise exception 'Source batch count changed' using errcode='55000'; end if;
  if exists(select 1 from public.apply_batches child where child.org_id=v_org and child.profile_id=v_profile
    and child.source_batch_id=v_batch.id and child.status<>'abandoned') then
    raise exception 'restore_active_reversion: This batch already has an active reversion export.' using errcode='55000', detail='restore_active_reversion';
  end if;
  -- The complete original artifact is the trust root; the selected artifact alone is insufficient.
  v_source_artifact := (v_plan #>> '{source,restoreProposal,sourceArtifactText}')::jsonb;
  if v_batch.artifact_sha256 is null
    or v_batch.artifact_sha256 is distinct from app.sp_write_sha256(v_plan #>> '{source,restoreProposal,sourceArtifactText}')
    or v_source_artifact is distinct from (
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'entity_type',r.entity_type,'entity_id',r.entity_id,'field',r.field,'old',r.old_value,'new',r.new_value,
        'name',r.entity_name,'clicks',r.clicks,'revenue',r.revenue)) order by rec.created_at,rec.id,r.dependency_step_index)
      from public.apply_rows r left join public.recommendations rec on rec.org_id=r.org_id and rec.profile_id=r.profile_id and rec.id=r.recommendation_id
      where r.org_id=v_org and r.profile_id=v_profile and r.batch_id=v_batch.id
    ) then
    raise exception 'source_changed: Original export evidence changed' using errcode='55000', detail='source_changed';
  end if;
  v_actual_count := jsonb_array_length(v_plan #> '{source,restoreProposal,rows}');
  v_artifact := (v_evidence #>> '{provenance,artifactText}')::jsonb;
  if v_batch.status not in ('staged','applied') or v_batch.source_batch_id is not null
     or v_batch.dependency_sets_count is not null
     or v_actual_count not between 1 and 500
     or jsonb_array_length(v_plan #> '{source,restoreProposal,sourceRowIds}') <> v_actual_count
     or jsonb_typeof(v_artifact) is distinct from 'array' or jsonb_array_length(v_artifact) <> v_actual_count
     or jsonb_typeof(v_evidence #> '{provenance,rows}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{provenance,rows}') <> v_actual_count
     or jsonb_typeof(v_evidence #> '{guardrails,policies}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{guardrails,policies}') <> v_actual_count
     or v_batch.artifact_sha256 is null
     or v_evidence #>> '{provenance,artifactSha256}' is distinct from app.sp_write_sha256(v_evidence #>> '{provenance,artifactText}')
     or v_batch.exported_at is distinct from (v_evidence #>> '{provenance,exportedAt}')::timestamptz
     or v_batch.tag is distinct from v_evidence #>> '{provenance,tag}'
     or v_batch.opt_group is distinct from v_evidence #>> '{provenance,optGroup}'
     or v_batch.lever is distinct from v_evidence #>> '{provenance,lever}'
     or v_batch.note is distinct from v_evidence #>> '{provenance,note}' then
    raise exception 'SP preview export changed or is incomplete' using errcode = '55000';
  end if;
  if (select count(distinct r ->> 'applyRowId') from jsonb_array_elements(v_evidence #> '{provenance,rows}') r) <> v_actual_count
     or (select count(distinct r ->> 'recommendationId') from jsonb_array_elements(v_evidence #> '{provenance,rows}') r) <> v_actual_count then
    raise exception 'SP preview repeats a source identity' using errcode = '22023';
  end if;

  for v_source, v_index in
    select value, (ordinality - 1)::integer
      from jsonb_array_elements(v_evidence #> '{provenance,rows}') with ordinality
  loop
    v_policy := v_evidence #> array['guardrails','policies',v_index::text];
    select * into strict v_row from public.apply_rows
     where org_id = v_org and profile_id = v_profile and batch_id = v_batch.id
       and id = (v_source ->> 'applyRowId')::uuid;
    select * into strict v_recommendation from public.recommendations
     where org_id = v_org and profile_id = v_profile and id = v_row.recommendation_id;
    select * into strict v_run from public.recommendation_runs
     where org_id = v_org and profile_id = v_profile and id = v_recommendation.run_id;
    select * into strict v_keyword from public.keywords
     where org_id = v_org and profile_id = v_profile and amazon_id = v_row.entity_id
       and ad_product = 'SP' and deleted_at is null and state in ('enabled', 'paused') for share;
    select a into strict v_action from jsonb_array_elements(v_plan -> 'actions') a
     where a #>> '{sources,0,applyRowId}' = v_row.id::text;
    if v_row.dependency_set_id is not null or v_row.dependency_step_index is not null
       or v_recommendation.inputs -> 'dependencySet' is not null
       or v_row.entity_type <> 'keyword' or v_row.field <> 'bid'
       or v_recommendation.id::text is distinct from v_source ->> 'recommendationId'
       or v_run.id::text is distinct from v_source ->> 'runId'
       or v_recommendation.export_batch_id is distinct from v_batch.id
       or v_recommendation.status <> 'exported'
       or v_recommendation.entity_type::text is distinct from v_row.entity_type::text
       or v_recommendation.entity_id is distinct from v_row.entity_id
       or v_recommendation.field is distinct from v_row.field
       or (v_recommendation.ad_product is not null and v_recommendation.ad_product <> 'SP')
       or (v_recommendation.campaign_id is not null and v_recommendation.campaign_id is distinct from v_keyword.campaign_id)
       or (v_recommendation.ad_group_id is not null and v_recommendation.ad_group_id is distinct from v_keyword.ad_group_id)
       or v_recommendation.current_value is distinct from v_row.old_value
       or v_recommendation.proposed_value is distinct from v_row.new_value
       or v_policy ->> 'applyRowId' is distinct from v_source ->> 'applyRowId'
       or v_policy ->> 'recommendationId' is distinct from v_source ->> 'recommendationId'
       or v_policy ->> 'runId' is distinct from v_source ->> 'runId'
       or (case when v_run.scope_version=2 then v_run.execution_snapshot is null or v_run.status<>'succeeded'
         else v_run.strategy_snapshot is null or v_run.strategy_goal is null end)
       or v_policy ->> 'strategySnapshotText' is distinct from (case when v_run.scope_version=2 then v_run.execution_snapshot else v_run.strategy_snapshot end)::text
       or v_policy ->> 'strategyGoal' is distinct from (case when v_run.scope_version=2 then 'one_time' else v_run.strategy_goal end)
       or v_policy ->> 'groupId' is distinct from v_run.group_id::text
       or v_policy ->> 'groupSnapshotText' is distinct from v_run.group_snapshot::text
       or v_action ->> 'routeKey' is distinct from 'sp.v3.keywords.update'
       or v_action #>> '{entity,keywordId}' is distinct from v_row.entity_id
       or jsonb_array_length(v_action -> 'sources') <> 1
       or v_action #>> '{sources,0,changeKey}' is distinct from 'keyword.bid'
       or not coalesce(app.sp_write_exact_json_keys(v_action -> 'changes', array['bid']), false)
       or (v_row.new_value #>> '{}')::numeric is distinct from (v_action #>> '{changes,bid,expected,amount}')::numeric
       or (v_row.old_value #>> '{}')::numeric is distinct from (v_action #>> '{changes,bid,requested,amount}')::numeric
       or v_keyword.bid is distinct from (v_row.new_value #>> '{}')::numeric
       or v_artifact -> v_index is distinct from jsonb_strip_nulls(jsonb_build_object(
         'entity_type', v_row.entity_type, 'entity_id', v_row.entity_id, 'field', v_row.field,
         'old', v_row.old_value, 'new', v_row.new_value, 'name', v_row.entity_name,
         'clicks', v_row.clicks, 'revenue', v_row.revenue)) then
      raise exception 'SP preview source or policy changed' using errcode = '55000',detail='source_changed';
    end if;
    if v_run.scope_version=2 then
      perform app.assert_optimizer_export_source(v_org,v_profile,v_batch.id);
    end if;
    perform 1 from public.entity_changes ec where ec.org_id=v_org and ec.profile_id=v_profile
      and ec.apply_row_id=v_row.id order by ec.id for share;
    -- A linked row ID alone cannot attribute a different entity or before-value.
    select max(ec.observed_at) into v_observed from public.entity_changes ec
      where ec.org_id=v_org and ec.profile_id=v_profile and ec.source='sync'
        and ec.apply_row_id=v_row.id and ec.apply_batch_id=v_batch.id
        and ec.entity_type::text=v_row.entity_type::text and ec.amazon_id=v_row.entity_id
        and ec.field=v_row.field and ec.old_value=v_row.old_value and ec.new_value=v_row.new_value
        and ec.observed_at>=v_batch.exported_at;
    if v_observed is null or exists(select 1 from public.entity_changes ec
      where ec.org_id=v_org and ec.profile_id=v_profile and ec.apply_row_id=v_row.id
        and (ec.apply_batch_id is distinct from v_batch.id or ec.entity_type::text is distinct from v_row.entity_type::text
          or ec.amazon_id is distinct from v_row.entity_id or ec.field is distinct from v_row.field
          or ec.old_value is distinct from v_row.old_value or ec.new_value is distinct from v_row.new_value)) then
      raise exception 'source_changed: Linked observation differs from the original export' using errcode='55000', detail='source_changed';
    end if;
    v_restore := v_plan #> array['source','restoreProposal','rows',v_index::text];
    select current_synced_at into v_read from app.resolve_apply_current_value(v_org,v_profile,v_row.entity_type,v_row.entity_id,v_row.field);
    if v_read is null or v_read < greatest(v_batch.exported_at,v_observed) then
      raise exception 'restore_mirror_stale: Mirror predates the applied observation' using errcode='55000', detail='restore_mirror_stale';
    end if;
    if v_restore ->> 'sourceRowId' is distinct from v_row.id::text
      or v_plan #>> array['source','restoreProposal','sourceRowIds',v_index::text] is distinct from v_row.id::text
      or v_restore ->> 'entityId' is distinct from v_row.entity_id
      or v_restore -> 'current' is distinct from v_action #> '{changes,bid,expected}'
      or v_restore -> 'restoreTo' is distinct from v_action #> '{changes,bid,requested}'
      or v_read is distinct from (v_restore ->> 'readAt')::timestamptz
      or exists(select 1 from public.entity_changes ec where ec.org_id=v_org and ec.profile_id=v_profile
        and ec.apply_batch_id is null and ec.source='sync' and ec.entity_type::text=v_row.entity_type::text
        and ec.amazon_id=v_row.entity_id and ec.field=v_row.field and ec.old_value=v_row.old_value and ec.new_value=v_row.new_value
        and ec.observed_at>=v_batch.exported_at) then
      raise exception 'Restore source changed or is not ready' using errcode='55000',detail='source_changed';
    end if;
    v_count := v_count + 1;
  end loop;
  perform app.assert_sp_write_forward_lineage(v_plan);
  if v_count <> v_actual_count or v_count <> (v_plan #>> '{counts,providerRows}')::integer then
    raise exception 'SP preview source counts differ' using errcode = '22023';
  end if;
end;
$$;

revoke all on function app.assert_sp_write_restore_source(text,text,text,text,text)
  from public, anon, authenticated, service_role;


alter function app.assert_sp_write_preview_source(text,text,text,text,text) rename to assert_sp_write_nonrestore_preview_source;
create function app.assert_sp_write_preview_source(p_plan_text text,p_plan_preimage text,p_evidence_text text,
  p_guardrail_preimage text,p_provenance_preimage text) returns void language plpgsql security definer
  set search_path=pg_catalog,public,app,pg_temp as $$
begin
  if p_plan_text::jsonb#>'{source,restoreProposal}' is not null then
    perform app.assert_sp_write_restore_source(p_plan_text,p_plan_preimage,p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  else
    perform app.assert_sp_write_nonrestore_preview_source(p_plan_text,p_plan_preimage,p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  end if;
end $$;
revoke all on function app.assert_sp_write_preview_source(text,text,text,text,text) from public,anon,authenticated,service_role;
create or replace function app.record_sp_write_restore_proposal(p_org uuid,p_plan_text text,p_plan_preimage text,p_action_proofs jsonb,
  p_evidence_text text,p_guardrail_preimage text,p_provenance_preimage text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan jsonb:=p_plan_text::jsonb; v_id uuid:=(v_plan->>'id')::uuid;
begin
  if (v_plan->>'orgId')::uuid is distinct from p_org then raise exception 'Resource not found' using errcode='42501'; end if;
  perform app.lock_sp_write_operator(p_org,(v_plan->>'profileId')::uuid,auth.uid());
  if (v_plan->>'expiresAt')::timestamptz<=clock_timestamp() then raise exception 'Preview expired' using errcode='55000'; end if;
  if v_plan#>>'{source,restoreProposal,kind}' is distinct from 'restore_proposal' then
    raise exception 'Restore proposal source required' using errcode='22023'; end if;
  perform app.record_sp_write_preview_internal(p_plan_text,p_plan_preimage,p_action_proofs,
    p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  perform app.assert_sp_write_method_evidence(v_id,false);
  insert into public.sp_write_restore_proposals(plan_id,org_id,profile_id,source_batch_id,created_by)
    values(v_id,p_org,(v_plan->>'profileId')::uuid,(v_plan#>>'{source,applyBatchId}')::uuid,auth.uid());
  return v_id;
end $$;
revoke all on function app.record_sp_write_restore_proposal(uuid,text,text,jsonb,text,text,text) from public,anon,service_role;
grant execute on function app.record_sp_write_restore_proposal(uuid,text,text,jsonb,text,text,text) to authenticated;

create or replace function app.close_sp_write_forward_admission() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; e public.sp_write_preview_evidence%rowtype; v_count integer; v_origin jsonb;
begin
  select * into strict v_plan from public.sp_write_plans where org_id=new.org_id and profile_id=new.profile_id and plan_id=new.plan_id;
  if v_plan.direction<>'forward' or v_plan.artifact->>'schemaVersion' is distinct from 'openspell.sp-write-plan.v1' then return new; end if;
  -- Generic preview staging cannot establish the restore family used by the
  -- queue and source-batch admission lock. Require the dedicated immutable receipt.
  if v_plan.artifact#>'{source,restoreProposal}' is not null and not exists(
    select 1 from public.sp_write_restore_proposals proposal
      where proposal.org_id=new.org_id and proposal.profile_id=new.profile_id and proposal.plan_id=new.plan_id
        and proposal.source_batch_id=(v_plan.artifact#>>'{source,applyBatchId}')::uuid
        and proposal.source_batch_id=(v_plan.artifact#>>'{source,restoreProposal,sourceBatchId}')::uuid) then
    raise exception 'Restore proposal receipt is missing or mismatched' using errcode='55000',detail='source_changed'; end if;
  if v_plan.artifact#>'{source,restoreProposal}' is not null and not exists(
    select 1 from public.sp_write_authorization_receipts receipt where receipt.org_id=new.org_id and receipt.profile_id=new.profile_id
      and receipt.approval_id=new.approval_id and receipt.approval_mode in ('manual','bounded_live_test')) then
    raise exception 'Restore requires explicit operator confirmation' using errcode='42501'; end if;
  select * into strict e from public.sp_write_preview_evidence where org_id=new.org_id and profile_id=new.profile_id and plan_id=new.plan_id;
  perform app.assert_sp_write_preview_source(v_plan.artifact_text,v_plan.fingerprint_preimage,e.artifact_text,e.guardrail_preimage,e.provenance_preimage);
  v_origin:=v_plan.artifact#>'{source,retryOrigin}';
  if v_origin is not null and (select count(*) from app.sp_write_forward_lineage
    where org_id=new.org_id and profile_id=new.profile_id and retry_plan_id=new.plan_id)<>v_plan.provider_rows then
    raise exception 'Retry lineage missing' using errcode='55000'; end if;
  insert into app.sp_write_forward_admissions(org_id,profile_id,plan_id,execution_id,source_row_id,parent_plan_id,operation_kind)
    select new.org_id,new.profile_id,new.plan_id,new.execution_id,(s->>'applyRowId')::uuid,(v_origin->>'planId')::uuid,
      case when v_plan.artifact#>'{source,restoreProposal}' is null then 'forward' else 'restore' end
    from jsonb_array_elements(v_plan.artifact->'actions') a cross join lateral jsonb_array_elements(a->'sources') s;
  get diagnostics v_count=row_count;
  if v_count<>v_plan.provider_rows then raise exception 'Forward admission counts differ' using errcode='55000'; end if;
  return new;
end $$;
revoke all on function app.close_sp_write_forward_admission() from public,anon,authenticated,service_role;

create or replace function app.approve_and_queue_sp_write_for_actor(
  p_org uuid, p_actor uuid, p_profile uuid, p_request_text text, p_confirmation text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, app, auth, pg_temp as $$
declare v_request jsonb := p_request_text::jsonb; v_plan public.sp_write_plans%rowtype;
  v_receipt jsonb; v_outbox uuid;
begin
  perform app.lock_sp_write_operator(p_org,p_profile,p_actor);
  select * into v_plan from public.sp_write_plans
    where org_id = p_org and profile_id = p_profile and plan_id = (v_request #>> '{plan,planId}')::uuid;
  if not found then raise exception using errcode = '42501', message = 'Resource not found'; end if;
  if v_plan.direction <> 'forward' or v_request ->> 'approvalMode' is distinct from 'manual'
    or v_request -> 'plan' is distinct from app.sp_write_plan_binding(v_plan.artifact)
    or p_confirmation is distinct from ('Yes, apply ' || v_plan.logical_changes::text || ' changes to Amazon') then
    raise exception 'Exact Amazon confirmation required' using errcode = '22023';
  end if;
  if not exists(select 1 from public.sp_write_execution_requests
    where org_id=p_org and profile_id=p_profile and plan_id=v_plan.plan_id) then
    if v_plan.artifact#>'{source,restoreProposal}' is not null then
      if not app.sp_write_environment_enabled(p_org,p_profile) then
        raise exception 'SP write environment gate is closed' using errcode='55000',detail='gate_disabled'; end if;
      if not exists(select 1 from public.sp_write_profile_grant_heads h
        join public.sp_write_profile_grant_versions g on g.org_id=h.org_id and g.profile_id=h.profile_id and g.grant_id=h.grant_id and g.version_id=h.version_id
        where h.org_id=p_org and h.profile_id=p_profile and g.enabled and g.amazon_profile_id=v_plan.amazon_profile_id
          and g.connection_id=v_plan.connection_id and g.region=v_plan.region and g.marketplace_id=v_plan.marketplace_id
          and g.currency_code=v_plan.currency_code and g.api_dialect=v_plan.api_dialect) then
        raise exception 'SP write profile grant is closed or mismatched' using errcode='55000',detail='profile_not_allowlisted'; end if;
    end if;
    perform app.assert_sp_write_method_evidence(v_plan.plan_id,true);
  end if;
  v_receipt := app.approve_sp_write_preview_v1(v_plan.plan_id,p_request_text);
  if v_receipt ->> 'approvedBy' is distinct from p_actor::text then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  v_outbox := app.start_sp_write_execution_internal((v_receipt ->> 'approvalId')::uuid,v_plan.plan_id);
  if not exists(select 1 from public.sp_write_outbox where outbox_id = v_outbox
    and org_id = p_org and profile_id = p_profile and plan_id = v_plan.plan_id) then
    raise exception 'Outbox readback differs' using errcode = '55000';
  end if;
  if not exists(select 1 from public.audit_log where org_id=p_org and action='sp_write.confirmed'
    and target_type='sp_write_plan' and target_id=v_plan.plan_id::text
    and payload->>'approvalId'=v_receipt->>'approvalId') then
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'user',p_actor,'sp_write.confirmed','sp_write_plan',v_plan.plan_id::text,
      jsonb_build_object('confirmation',p_confirmation,'logicalChanges',v_plan.logical_changes,
        'approvalId',v_receipt ->> 'approvalId','planFingerprint',v_plan.fingerprint),'web')
    on conflict do nothing;
  end if;
  if (select count(*) from public.audit_log where org_id=p_org and actor_type='user' and actor_id=p_actor::text
      and action='sp_write.confirmed' and target_type='sp_write_plan' and target_id=v_plan.plan_id::text and source='web'
      and payload=jsonb_build_object('confirmation',p_confirmation,'logicalChanges',v_plan.logical_changes,
        'approvalId',v_receipt->>'approvalId','planFingerprint',v_plan.fingerprint))<>1 then
    raise exception 'Confirmation audit readback differs' using errcode='55000';
  end if;
  return jsonb_build_object('kind','queued','operation',jsonb_build_object(
    'executionId',v_receipt ->> 'executionId','planId',v_plan.plan_id),
    'approvalId',v_receipt ->> 'approvalId','approvalRequestId',v_receipt ->> 'approvalRequestId');
end;
$$;
revoke all on function app.approve_and_queue_sp_write_for_actor(uuid,uuid,uuid,text,text) from public, anon, service_role;
grant execute on function app.approve_and_queue_sp_write_for_actor(uuid,uuid,uuid,text,text) to authenticated;


create or replace function app.assert_sp_write_method_evidence(p_plan uuid, p_required boolean)
returns void language plpgsql security definer
set search_path = pg_catalog, public, app, pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; v_evidence jsonb; v_source jsonb;
  v_inputs jsonb; v_method jsonb;
begin
  select * into strict v_plan from public.sp_write_plans where plan_id = p_plan;
  -- A restore derives exact old values from immutable export and sync evidence.
  -- It does not rerun or authorize the historical recommendation's method.
  if v_plan.artifact#>'{source,restoreProposal}' is not null then p_required:=false; end if;
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
