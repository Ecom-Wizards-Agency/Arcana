-- Original export bytes remain the trust root. No execution gates are changed.
-- Private command receipts and source ownership live in app; they are read through
-- the authenticated query boundary and are not public provider-ledger relations.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create or replace function app.assert_sp_write_legacy_preview_source_v1(
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
  v_index integer;
  v_count integer := 0;
  v_actual_count integer;
  v_narrowed boolean;
  v_source_artifact jsonb;
  v_ids uuid[];
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
  v_narrowed := v_plan #> '{source,forwardRowIds}' is not null;
  if (v_plan #> '{source,sourceArtifactText}' is not null) <> v_narrowed
    or (v_plan #> '{source,retryOrigin}' is not null and not v_narrowed)
    or v_plan #> '{source,restoreProposal}' is not null then
    raise exception 'Invalid forward source' using errcode='22023';
  end if;
  if v_narrowed then
    if jsonb_typeof(v_plan #> '{source,forwardRowIds}') is distinct from 'array' then
      raise exception 'Invalid forward rows' using errcode='22023';
    end if;
    select array_agg(value::uuid order by value::uuid) into v_ids
      from jsonb_array_elements_text(v_plan #> '{source,forwardRowIds}');
    if cardinality(v_ids) not between 1 and 500
      or cardinality(v_ids) <> (select count(distinct x) from unnest(v_ids) x)
      or to_jsonb(v_ids) is distinct from v_plan #> '{source,forwardRowIds}'
      or to_jsonb(v_ids) is distinct from (select jsonb_agg(s->'applyRowId' order by s->>'applyRowId')
        from jsonb_array_elements(v_plan->'actions') a cross join lateral jsonb_array_elements(a->'sources') s)
      then raise exception 'Forward rows must exactly bind every action source' using errcode='22023'; end if;
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
  if v_narrowed then
    -- WP-265 trust rule: verify the complete original export before any narrowing.
    v_source_artifact := (v_plan #>> '{source,sourceArtifactText}')::jsonb;
    if v_batch.artifact_sha256 is null
      or v_batch.artifact_sha256 is distinct from app.sp_write_sha256(v_plan #>> '{source,sourceArtifactText}')
      or v_batch.reversible_rows <> v_actual_count or v_batch.exported_proposals <> v_actual_count
      or v_source_artifact is distinct from (
        select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
          'entity_type',r.entity_type,'entity_id',r.entity_id,'field',r.field,'old',r.old_value,'new',r.new_value,
          'name',r.entity_name,'clicks',r.clicks,'revenue',r.revenue)) order by rec.created_at,rec.id,r.dependency_step_index)
        from public.apply_rows r left join public.recommendations rec
          on rec.org_id=r.org_id and rec.profile_id=r.profile_id and rec.id=r.recommendation_id
        where r.org_id=v_org and r.profile_id=v_profile and r.batch_id=v_batch.id
      ) or exists(select 1 from public.apply_rows r left join public.recommendations rec
          on rec.org_id=r.org_id and rec.profile_id=r.profile_id and rec.id=r.recommendation_id
        where r.org_id=v_org and r.profile_id=v_profile and r.batch_id=v_batch.id
          and (rec.id is null or rec.export_batch_id is distinct from v_batch.id or rec.status not in ('exported','applied')
            or rec.entity_type::text is distinct from r.entity_type::text or rec.entity_id is distinct from r.entity_id
            or rec.field is distinct from r.field or rec.proposal_revision_id is distinct from r.proposal_revision_id)) then
      raise exception 'source_changed: Original export evidence changed' using errcode='55000',detail='source_changed';
    end if;
    v_actual_count := cardinality(v_ids);
    if (select count(*) from public.apply_rows where org_id=v_org and profile_id=v_profile
      and batch_id=v_batch.id and id=any(v_ids)) <> v_actual_count then
      raise exception 'Forward rows are outside the original batch' using errcode='55000';
    end if;
  end if;
  v_artifact := (v_evidence #>> '{provenance,artifactText}')::jsonb;
  if v_batch.status <> 'staged' or v_batch.source_batch_id is not null
     or v_batch.unsupported_rows <> 0 or v_batch.reversible_rows not between 1 and 500
     or (not v_narrowed and (v_batch.reversible_rows <> v_actual_count or v_batch.exported_proposals <> v_actual_count))
     or jsonb_typeof(v_artifact) is distinct from 'array' or jsonb_array_length(v_artifact) <> v_actual_count
     or jsonb_typeof(v_evidence #> '{provenance,rows}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{provenance,rows}') <> v_actual_count
     or jsonb_typeof(v_evidence #> '{guardrails,policies}') is distinct from 'array'
     or jsonb_array_length(v_evidence #> '{guardrails,policies}') <> v_actual_count
     or v_batch.artifact_sha256 is null
     or (not v_narrowed and v_batch.artifact_sha256 is distinct from v_evidence #>> '{provenance,artifactSha256}')
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
    if v_row.entity_type <> 'keyword' or v_row.field <> 'bid'
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
       or v_row.proposal_revision_id is distinct from v_recommendation.proposal_revision_id
       or v_row.proposal_revision_id::text is distinct from v_source ->> 'proposalRevisionId'
       or (case when v_row.proposal_revision_id is null then
         v_recommendation.current_value is distinct from v_row.old_value
         or v_recommendation.proposed_value is distinct from v_row.new_value
       else
         jsonb_typeof(v_row.old_value) is distinct from 'number'
         or jsonb_typeof(v_row.new_value) is distinct from 'number'
         or to_jsonb((v_recommendation.current_value #>> '{}')::numeric) is distinct from v_row.old_value
         or not exists (
           select 1 from public.recommendation_proposal_revisions revision
           where revision.org_id = v_org and revision.profile_id = v_profile
             and revision.recommendation_id = v_recommendation.id and revision.id = v_row.proposal_revision_id
             and to_jsonb((revision.receipt ->> 'proposedValue')::numeric) = v_row.new_value
         )
       end)
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
       or (v_row.old_value #>> '{}')::numeric is distinct from (v_action #>> '{changes,bid,expected,amount}')::numeric
       or (v_row.new_value #>> '{}')::numeric is distinct from (v_action #>> '{changes,bid,requested,amount}')::numeric
       or v_keyword.bid is distinct from (v_row.old_value #>> '{}')::numeric
       or v_artifact -> v_index is distinct from jsonb_strip_nulls(jsonb_build_object(
         'entity_type', v_row.entity_type, 'entity_id', v_row.entity_id, 'field', v_row.field,
         'old', v_row.old_value, 'new', v_row.new_value, 'name', v_row.entity_name,
         'clicks', v_row.clicks, 'revenue', v_row.revenue)) then
      raise exception 'SP preview source or policy changed' using errcode = '55000';
    end if;
    if v_plan#>'{source,retryOrigin}' is not null and not exists(
      select 1 from public.sp_write_preview_evidence e
      cross join lateral jsonb_array_elements(e.artifact#>'{provenance,rows}') with ordinality parent(value,n)
      where e.org_id=v_org and e.profile_id=v_profile and e.plan_id=(v_plan#>>'{source,retryOrigin,planId}')::uuid
        and parent.value=v_source and e.artifact#>array['guardrails','policies',(parent.n-1)::text]=v_policy) then
      raise exception 'Retry source provenance differs from its recorded parent' using errcode='55000'; end if;
    if v_run.scope_version=2 then
      perform app.assert_optimizer_export_source(v_org,v_profile,v_batch.id);
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> v_actual_count or v_count <> (v_plan #>> '{counts,providerRows}')::integer then
    raise exception 'SP preview source counts differ' using errcode = '22023';
  end if;
  perform app.assert_sp_write_forward_lineage(v_plan);
end;
$$;

-- Preview lineage consumes no execution authority. Admission claims are separate,
-- append-only edges; no mutable head can be moved back to an earlier failure.
create table app.sp_write_forward_lineage (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null, retry_plan_id uuid not null,
  source_row_id uuid not null, parent_execution_id uuid not null,
  parent_plan_id uuid not null, parent_action_id uuid not null,
  primary key(org_id,profile_id,retry_plan_id,source_row_id),
  foreign key(org_id,profile_id,retry_plan_id) references public.sp_write_plans(org_id,profile_id,plan_id) on delete cascade,
  foreign key(org_id,profile_id,source_row_id) references public.apply_rows(org_id,profile_id,id),
  foreign key(org_id,profile_id,parent_execution_id,parent_plan_id) references public.sp_write_cycle_plans(org_id,profile_id,execution_id,plan_id),
  foreign key(org_id,profile_id,parent_plan_id,parent_action_id) references public.sp_write_plan_actions(org_id,profile_id,plan_id,action_id),
  check(retry_plan_id<>parent_plan_id)
);
create table app.sp_write_forward_admissions (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null, plan_id uuid not null,
  execution_id uuid not null, source_row_id uuid not null, parent_plan_id uuid,
  primary key(org_id,profile_id,plan_id,source_row_id),
  unique nulls not distinct(org_id,profile_id,source_row_id,parent_plan_id),
  foreign key(org_id,profile_id,execution_id,plan_id) references public.sp_write_cycle_plans(org_id,profile_id,execution_id,plan_id) on delete cascade,
  foreign key(org_id,profile_id,source_row_id) references public.apply_rows(org_id,profile_id,id),
  foreign key(org_id,profile_id,parent_plan_id) references public.sp_write_plans(org_id,profile_id,plan_id),
  check(parent_plan_id is null or parent_plan_id<>plan_id)
);
select app.install_tenant_rls('app.sp_write_forward_lineage',null);
select app.install_tenant_rls('app.sp_write_forward_admissions',null);
revoke all on app.sp_write_forward_lineage,app.sp_write_forward_admissions from public,anon,authenticated,service_role;
grant select on app.sp_write_forward_lineage,app.sp_write_forward_admissions to authenticated,service_role;
create trigger sp_write_forward_lineage_immutable before update or delete on app.sp_write_forward_lineage for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_forward_lineage_no_truncate before truncate on app.sp_write_forward_lineage for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_forward_admissions_immutable before update or delete on app.sp_write_forward_admissions for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_forward_admissions_no_truncate before truncate on app.sp_write_forward_admissions for each statement execute function app.reject_sp_write_evidence_truncate();

-- This function derives eligibility from immutable resolution/result records.
-- In particular an expected-value read after ambiguity never grants retry authority.
create function app.sp_write_retry_population(p_org uuid,p_profile uuid,p_execution uuid,p_plan uuid)
returns table(source_row_id uuid,parent_action_id uuid,eligible boolean,successful boolean)
language sql stable security invoker set search_path=pg_catalog,public as $$
  select r.id,a.action_id,
    coalesce(p.artifact->>'schemaVersion'='openspell.sp-write-plan.v1'
      and p.direction='forward' and p.artifact#>>'{source,kind}'='apply_batch'
      and r.dependency_set_id is null and r.dependency_step_index is null
      and o.observation_id is null
      -- Freeze the complete retry population before admitting a successor. A
      -- still-pending sibling could fail later and otherwise be stranded behind
      -- an already admitted child whose source set cannot acquire that sibling.
      and not exists(select 1 from public.sp_write_plan_actions sibling
        left join public.sp_write_action_resolutions resolved on resolved.org_id=sibling.org_id
          and resolved.profile_id=sibling.profile_id and resolved.plan_id=sibling.plan_id
          and resolved.action_id=sibling.action_id and resolved.execution_id=cycle.execution_id
        left join public.sp_write_provider_result_positions completed on completed.org_id=resolved.org_id
          and completed.profile_id=resolved.profile_id and completed.intent_id=resolved.intent_id
          and completed.action_id=resolved.action_id
        where sibling.org_id=p.org_id and sibling.profile_id=p.profile_id and sibling.plan_id=p.plan_id
          and (resolved.action_id is null or (resolved.resolution_kind='intent' and completed.result_id is null)))
      and ((resolution.resolution_kind='refusal' and d.reason in
        ('approval_expired','authorization_revoked','environment_gate_closed','profile_gate_closed','lease_unavailable'))
        or (resolution.resolution_kind='intent' and result.outcome='authoritative_rejected')),false),
    coalesce(result.outcome='accepted' or o.outcome='observed_requested',false)
  from public.sp_write_cycle_plans cycle
  join public.sp_write_plans p on p.org_id=cycle.org_id and p.profile_id=cycle.profile_id and p.plan_id=cycle.plan_id
  join public.sp_write_plan_actions a on a.org_id=p.org_id and a.profile_id=p.profile_id and a.plan_id=p.plan_id
  cross join lateral jsonb_array_elements(a.artifact->'sources') s
  join public.apply_rows r on r.org_id=p.org_id and r.profile_id=p.profile_id
    and r.id::text=s->>'applyRowId' and s->>'kind'='apply_row'
    and r.batch_id::text=p.artifact#>>'{source,applyBatchId}'
  left join public.sp_write_action_resolutions resolution on resolution.org_id=cycle.org_id
    and resolution.profile_id=cycle.profile_id and resolution.execution_id=cycle.execution_id
    and resolution.plan_id=cycle.plan_id and resolution.action_id=a.action_id
  left join public.sp_write_predispatch_dispositions d on d.org_id=resolution.org_id and d.profile_id=resolution.profile_id
    and d.disposition_id=resolution.disposition_id
  left join public.sp_write_provider_result_positions result on result.org_id=resolution.org_id and result.profile_id=resolution.profile_id
    and result.intent_id=resolution.intent_id and result.action_id=resolution.action_id
  left join public.sp_write_observations o on o.org_id=cycle.org_id and o.profile_id=cycle.profile_id
    and o.execution_id=cycle.execution_id and o.plan_id=cycle.plan_id and o.action_id=a.action_id
  where cycle.org_id=p_org and cycle.profile_id=p_profile and cycle.execution_id=p_execution and cycle.plan_id=p_plan
  order by r.id
$$;
revoke all on function app.sp_write_retry_population(uuid,uuid,uuid,uuid) from public,anon;
grant execute on function app.sp_write_retry_population(uuid,uuid,uuid,uuid) to authenticated,service_role;

create function app.assert_sp_write_forward_lineage(p_plan jsonb)
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
      or v_parent.artifact->'providerScope' is distinct from p_plan->'providerScope' then
      raise exception 'Retry origin differs from its source' using errcode='55000'; end if;
    perform 1 from public.sp_write_cycle_plans where org_id=v_org and profile_id=v_profile
      and execution_id=(v_origin->>'executionId')::uuid and plan_id=v_parent.plan_id for update;
    if not found then raise exception 'Retry origin was not admitted' using errcode='55000'; end if;
    select array_agg(source_row_id order by source_row_id) filter(where eligible),count(*)
      into v_eligible,v_count from app.sp_write_retry_population(v_org,v_profile,(v_origin->>'executionId')::uuid,v_parent.plan_id);
    if v_count<>v_parent.provider_rows or v_eligible is null or v_rows is distinct from v_eligible
      or to_jsonb(v_rows) is distinct from p_plan#>'{source,forwardRowIds}' then
      raise exception 'Retry requires the exact eligible unresolved population' using errcode='55000'; end if;
    for v_action in select value from jsonb_array_elements(p_plan->'actions') loop
      select artifact into strict v_parent_action from public.sp_write_plan_actions
        where org_id=v_org and profile_id=v_profile and plan_id=v_parent.plan_id
          and artifact->'sources'=v_action->'sources';
      if (v_action-array['actionId','fingerprint']) is distinct from (v_parent_action-array['actionId','fingerprint']) then
        raise exception 'Retry cannot rewrite original expected or requested values; fresh evaluation required' using errcode='55000'; end if;
    end loop;
  end if;
  foreach v_row in array v_rows loop
    -- Include historical admissions, even when they predate this migration.
    -- Every other admitted owner must be an ancestor of the requested parent.
    if exists(with recursive ancestors(plan_id) as (
      select (v_origin->>'planId')::uuid where v_origin is not null
      union
      select edge.parent_plan_id from app.sp_write_forward_lineage edge join ancestors a on edge.retry_plan_id=a.plan_id
        where edge.org_id=v_org and edge.profile_id=v_profile and edge.source_row_id=v_row
    ) select 1 from public.sp_write_cycle_plans cycle
      join public.sp_write_plan_actions a on a.org_id=cycle.org_id and a.profile_id=cycle.profile_id and a.plan_id=cycle.plan_id
      where cycle.org_id=v_org and cycle.profile_id=v_profile and cycle.direction='forward' and cycle.plan_id<>v_id
        and exists(select 1 from jsonb_array_elements(a.artifact->'sources') s where s->>'kind'='apply_row' and s->>'applyRowId'=v_row::text)
        and not exists(select 1 from ancestors where plan_id=cycle.plan_id)) then
      raise exception 'Source row already has an admitted owner; retry the latest failed operation' using errcode='55000';
    end if;
  end loop;
end $$;
revoke all on function app.assert_sp_write_forward_lineage(jsonb) from public,anon,authenticated,service_role;

-- Existing guarded preparation is the only writer of preview lineage.
create or replace function app.record_sp_write_preview_internal(
  p_plan_text text,p_plan_preimage text,p_action_proofs jsonb,p_evidence_text text,p_guardrail_preimage text,p_provenance_preimage text
) returns uuid language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan jsonb:=p_plan_text::jsonb; v_id uuid:=(v_plan->>'id')::uuid; v_origin jsonb:=v_plan#>'{source,retryOrigin}'; v_count integer;
begin
  perform app.assert_sp_write_preview_source(p_plan_text,p_plan_preimage,p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  perform app.record_sp_write_plan_internal(p_plan_text,p_plan_preimage,p_action_proofs);
  insert into public.sp_write_preview_evidence(plan_id,org_id,profile_id,artifact_text,artifact,guardrail_preimage,provenance_preimage)
    values(v_id,(v_plan->>'orgId')::uuid,(v_plan->>'profileId')::uuid,p_evidence_text,p_evidence_text::jsonb,p_guardrail_preimage,p_provenance_preimage);
  if v_origin is not null then
    insert into app.sp_write_forward_lineage(org_id,profile_id,retry_plan_id,source_row_id,parent_execution_id,parent_plan_id,parent_action_id)
      select (v_plan->>'orgId')::uuid,(v_plan->>'profileId')::uuid,v_id,source_row_id,
        (v_origin->>'executionId')::uuid,(v_origin->>'planId')::uuid,parent_action_id
      from app.sp_write_retry_population((v_plan->>'orgId')::uuid,(v_plan->>'profileId')::uuid,
        (v_origin->>'executionId')::uuid,(v_origin->>'planId')::uuid) where eligible;
    get diagnostics v_count=row_count;
    if v_count<>(v_plan#>>'{counts,providerRows}')::integer then raise exception 'Retry lineage counts differ' using errcode='55000'; end if;
  end if;
  return v_id;
end $$;
revoke all on function app.record_sp_write_preview_internal(text,text,jsonb,text,text,text) from public,anon,authenticated,service_role;

-- Deferred cycle closure covers manual and delegated admission entrypoints.
-- Only their guarded definers can insert cycle rows. Exact approval recovery
-- inserts no cycle row and therefore never reclaims an old source leaf.
create function app.close_sp_write_forward_admission() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; e public.sp_write_preview_evidence%rowtype; v_count integer; v_origin jsonb;
begin
  select * into strict v_plan from public.sp_write_plans where org_id=new.org_id and profile_id=new.profile_id and plan_id=new.plan_id;
  if v_plan.direction<>'forward' or v_plan.artifact->>'schemaVersion' is distinct from 'openspell.sp-write-plan.v1' then return new; end if;
  select * into strict e from public.sp_write_preview_evidence where org_id=new.org_id and profile_id=new.profile_id and plan_id=new.plan_id;
  perform app.assert_sp_write_preview_source(v_plan.artifact_text,v_plan.fingerprint_preimage,e.artifact_text,e.guardrail_preimage,e.provenance_preimage);
  v_origin:=v_plan.artifact#>'{source,retryOrigin}';
  if v_origin is not null and (select count(*) from app.sp_write_forward_lineage
    where org_id=new.org_id and profile_id=new.profile_id and retry_plan_id=new.plan_id)<>v_plan.provider_rows then
    raise exception 'Retry lineage missing' using errcode='55000'; end if;
  insert into app.sp_write_forward_admissions(org_id,profile_id,plan_id,execution_id,source_row_id,parent_plan_id)
    select new.org_id,new.profile_id,new.plan_id,new.execution_id,(s->>'applyRowId')::uuid,(v_origin->>'planId')::uuid
    from jsonb_array_elements(v_plan.artifact->'actions') a cross join lateral jsonb_array_elements(a->'sources') s;
  get diagnostics v_count=row_count;
  if v_count<>v_plan.provider_rows then raise exception 'Forward admission counts differ' using errcode='55000'; end if;
  return new;
end $$;
revoke all on function app.close_sp_write_forward_admission() from public,anon,authenticated,service_role;
create constraint trigger sp_write_forward_admission_closed after insert on public.sp_write_cycle_plans
  deferrable initially deferred for each row execute function app.close_sp_write_forward_admission();

-- Legacy artifact bytes omit UUIDs. Once an executable forward preview binds a
-- row, replacing its identity must not turn a used source into a new root.
create function app.preserve_sp_forward_source_identity() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='DELETE' and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  if (tg_op='DELETE' or (new.id,new.org_id,new.profile_id,new.batch_id,new.recommendation_id,new.proposal_revision_id,new.dependency_set_id,new.dependency_step_index)
      is distinct from (old.id,old.org_id,old.profile_id,old.batch_id,old.recommendation_id,old.proposal_revision_id,old.dependency_set_id,old.dependency_step_index))
    and exists(select 1 from public.sp_write_plan_actions a join public.sp_write_plans p
      on p.org_id=a.org_id and p.profile_id=a.profile_id and p.plan_id=a.plan_id
      where a.org_id=old.org_id and a.profile_id=old.profile_id and p.direction='forward'
        and p.artifact#>'{source,restoreProposal}' is null
        and exists(select 1 from jsonb_array_elements(a.artifact->'sources') s where s->>'kind'='apply_row' and s->>'applyRowId'=old.id::text)) then
    raise exception 'Original forward source identity is immutable' using errcode='55000'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function app.preserve_sp_forward_source_identity() from public,anon,authenticated,service_role;
create trigger apply_rows_forward_identity before update or delete on public.apply_rows for each row execute function app.preserve_sp_forward_source_identity();

-- One immutable receipt covers the entire accepted set across all child runs.
create table app.optimizer_selection_exports (
  org_id uuid not null references public.orgs(id) on delete cascade,profile_id uuid not null,request_id uuid not null,
  actor_id uuid not null references auth.users(id),preview_batch_id uuid not null,apply_batch_id uuid not null,
  request jsonb not null,source jsonb not null,artifact_text text not null,rows jsonb not null,result jsonb not null,
  primary key(org_id,request_id), unique(org_id,profile_id,apply_batch_id),
  foreign key(org_id,profile_id,apply_batch_id) references public.apply_batches(org_id,profile_id,id),
  foreign key(org_id,profile_id,preview_batch_id) references public.recommendation_preview_batches(org_id,profile_id,id)
);
select app.install_tenant_rls('app.optimizer_selection_exports',null);
revoke all on app.optimizer_selection_exports from public,anon,authenticated,service_role;
grant select on app.optimizer_selection_exports to authenticated,service_role;
create trigger optimizer_selection_exports_immutable before update or delete on app.optimizer_selection_exports for each row execute function app.reject_sp_write_evidence_change();
create trigger optimizer_selection_exports_no_truncate before truncate on app.optimizer_selection_exports for each statement execute function app.reject_sp_write_evidence_truncate();

-- Review decisions are intentionally excluded; recorded settings, scope, inputs,
-- identities and values are included. A changed input needs a new review binding.
create function app.optimizer_review_source(p_org uuid,p_profile uuid,p_batch uuid)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select jsonb_build_object('version',1,'batchId',b.id,'profileId',b.profile_id,
    'scopeCount',b.scope_count,'scopeFingerprint',b.scope_fingerprint,'childCount',b.child_count,'snapshot',b.execution_snapshot,
    'children',coalesce((select jsonb_agg(jsonb_build_object('runId',r.id,'scopeVersion',r.scope_version,
      'scopeCount',r.scope_count,'scopeFingerprint',r.scope_fingerprint,'snapshot',r.execution_snapshot,
      'groupId',r.group_id,'groupSnapshot',r.group_snapshot,'methodAdmission',r.schedule_context->'methodAdmission',
      'proposalsCount',r.proposals_count,'jobId',r.job_id,
      'campaigns',array(select m.campaign_id from public.recommendation_run_campaigns m
        where m.org_id=r.org_id and m.profile_id=r.profile_id and m.run_id=r.id and m.batch_id=b.id order by m.campaign_id collate "C")) order by r.id)
      from public.recommendation_runs r where r.org_id=p_org and r.profile_id=p_profile and r.batch_id=p_batch),'[]'::jsonb),
    'recommendations',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'runId',r.run_id,'entityType',r.entity_type,
      'entityId',r.entity_id,'campaignId',r.campaign_id,'adGroupId',r.ad_group_id,'adProduct',r.ad_product,
      'name',r.entity_name,'field',r.field,'current',r.current_value,'proposed',r.proposed_value,'inputs',r.inputs,
      'revisionId',r.proposal_revision_id) order by r.created_at,r.id)
      from public.recommendations r join public.recommendation_runs child on child.org_id=r.org_id
        and child.profile_id=r.profile_id and child.id=r.run_id
      where r.org_id=p_org and r.profile_id=p_profile and child.batch_id=p_batch),'[]'::jsonb))
  from public.recommendation_preview_batches b where b.org_id=p_org and b.profile_id=p_profile and b.id=p_batch
$$;
revoke all on function app.optimizer_review_source(uuid,uuid,uuid) from public,anon;
grant execute on function app.optimizer_review_source(uuid,uuid,uuid) to authenticated,service_role;

create function app.assert_optimizer_export_source(p_org uuid,p_profile uuid,p_apply uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare e app.optimizer_selection_exports%rowtype; v_count integer;
begin
  select * into strict e from app.optimizer_selection_exports where org_id=p_org and profile_id=p_profile and apply_batch_id=p_apply;
  if e.source is distinct from app.optimizer_review_source(p_org,p_profile,e.preview_batch_id)
    or (select artifact_sha256 from public.apply_batches where org_id=p_org and profile_id=p_profile and id=p_apply)
      is distinct from app.sp_write_sha256(e.artifact_text) then
    raise exception 'One-time export source changed; fresh evaluation required' using errcode='55000'; end if;
  select count(*) into v_count from public.apply_rows where org_id=p_org and profile_id=p_profile and batch_id=p_apply;
  if v_count<>jsonb_array_length(e.rows) or v_count<>(e.result#>>'{counts,applyRows}')::integer
    or exists(select 1 from jsonb_array_elements(e.rows) item left join public.apply_rows r
      on r.org_id=p_org and r.profile_id=p_profile and r.batch_id=p_apply and r.id::text=item->>'id'
      left join public.recommendations rec on rec.org_id=r.org_id and rec.profile_id=r.profile_id and rec.id=r.recommendation_id
      where r.id is null or r.recommendation_id::text is distinct from item->>'recommendationId'
        or r.entity_type::text is distinct from item#>>'{wire,entity_type}' or r.entity_id is distinct from item#>>'{wire,entity_id}'
        or r.field is distinct from item#>>'{wire,field}' or r.old_value is distinct from item#>'{wire,old}'
        or r.new_value is distinct from item#>'{wire,new}' or r.entity_name is distinct from item#>>'{wire,name}'
        or r.clicks is not null or r.revenue is not null or r.proposal_revision_id is not null
        or r.dependency_set_id is not null or r.dependency_step_index is not null
        or rec.export_batch_id is distinct from p_apply or rec.status not in ('exported','applied')) then
    raise exception 'One-time export rows do not reconcile' using errcode='55000'; end if;
end $$;
revoke all on function app.assert_optimizer_export_source(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- Preserve one-time ancestry and values; an exact receipt is the only export
-- exception. A receipt alone cannot fabricate an applied observation.
create or replace function app.guard_one_time_preview_export()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_run public.recommendation_runs%rowtype; v_rec public.recommendations%rowtype; e app.optimizer_selection_exports%rowtype; item jsonb;
begin
  if tg_table_name='recommendations' then
    if tg_op='UPDATE' and (new.org_id,new.profile_id,new.run_id) is distinct from (old.org_id,old.profile_id,old.run_id)
      and exists(select 1 from public.recommendation_runs r where r.scope_version=2 and
        ((r.org_id=old.org_id and r.profile_id=old.profile_id and r.id=old.run_id)
        or (r.org_id=new.org_id and r.profile_id=new.profile_id and r.id=new.run_id))) then
      raise exception 'One-time preview recommendation provenance is immutable.' using errcode='23514'; end if;
    select * into v_run from public.recommendation_runs where org_id=new.org_id and profile_id=new.profile_id and id=new.run_id;
    if v_run.scope_version is distinct from 2 or (new.status not in ('exported','applied') and new.export_batch_id is null) then return new; end if;
    select * into e from app.optimizer_selection_exports where org_id=new.org_id and profile_id=new.profile_id and apply_batch_id=new.export_batch_id;
    -- Preserve the legacy refusal diagnostic for callers without an exact receipt.
    if e.request_id is null then
      raise exception 'One-time preview export awaits observation support.' using errcode='23514',
        detail='Export through the complete saved Optimize Now selection to bind observation lineage.';
    end if;
    select value into item from jsonb_array_elements(e.rows) where value->>'recommendationId'=new.id::text;
    if e.request_id is null or item is null or e.preview_batch_id<>v_run.batch_id
      or tg_op<>'UPDATE' or old.status not in ('accepted','exported','applied')
      or new.entity_type::text is distinct from item#>>'{wire,entity_type}' or new.entity_id is distinct from item#>>'{wire,entity_id}'
      or new.field is distinct from item#>>'{wire,field}' or new.current_value is distinct from item#>'{wire,old}'
      or new.proposed_value is distinct from item#>'{wire,new}' or new.proposal_revision_id is not null then
      raise exception 'One-time export requires its exact selection receipt' using errcode='23514'; end if;
    if new.status='applied' and old.status<>'applied' and not exists(select 1 from public.entity_changes ec
      where ec.org_id=new.org_id and ec.profile_id=new.profile_id and ec.source='sync'
        and ec.apply_batch_id=new.export_batch_id and ec.apply_row_id::text=item->>'id'
        and ec.entity_type::text=new.entity_type::text and ec.amazon_id=new.entity_id and ec.field=new.field
        and ec.old_value=new.current_value and ec.new_value=new.proposed_value) then
      raise exception 'One-time applied state requires its linked observation' using errcode='23514'; end if;
  else
    if tg_op='UPDATE' and (new.id,new.org_id,new.profile_id,new.batch_id,new.recommendation_id)
      is distinct from (old.id,old.org_id,old.profile_id,old.batch_id,old.recommendation_id)
      and exists(select 1 from public.recommendations r join public.recommendation_runs run
        on run.org_id=r.org_id and run.profile_id=r.profile_id and run.id=r.run_id
        where r.org_id=old.org_id and r.profile_id=old.profile_id and r.id=old.recommendation_id and run.scope_version=2) then
      raise exception 'One-time export source identity is immutable' using errcode='23514'; end if;
    select * into v_rec from public.recommendations where org_id=new.org_id and profile_id=new.profile_id and id=new.recommendation_id;
    select * into v_run from public.recommendation_runs where org_id=v_rec.org_id and profile_id=v_rec.profile_id and id=v_rec.run_id;
    if v_run.scope_version is distinct from 2 then return new; end if;
    select * into e from app.optimizer_selection_exports where org_id=new.org_id and profile_id=new.profile_id and apply_batch_id=new.batch_id;
    if e.request_id is null then
      raise exception 'One-time preview export awaits observation support.' using errcode='23514',
        detail='An exact immutable selection receipt is required.';
    end if;
    select value into item from jsonb_array_elements(e.rows) where value->>'id'=new.id::text;
    if e.request_id is null or item is null or e.preview_batch_id<>v_run.batch_id
      or new.recommendation_id::text is distinct from item->>'recommendationId'
      or v_rec.status not in ('accepted','exported','applied')
      or new.entity_type::text is distinct from item#>>'{wire,entity_type}' or new.entity_id is distinct from item#>>'{wire,entity_id}'
      or new.field is distinct from item#>>'{wire,field}' or new.old_value is distinct from item#>'{wire,old}'
      or new.new_value is distinct from item#>'{wire,new}' or new.entity_name is distinct from item#>>'{wire,name}'
      or new.clicks is not null or new.revenue is not null or new.proposal_revision_id is not null
      or new.dependency_set_id is not null or new.dependency_step_index is not null then
      raise exception 'One-time export row requires its exact selection receipt' using errcode='23514'; end if;
  end if;
  return new;
end $$;
-- Cover every field mutation, not just a changed recommendation pointer.
drop trigger apply_rows_one_time_export_guard on public.apply_rows;
create trigger apply_rows_one_time_export_guard before insert or update on public.apply_rows for each row execute function app.guard_one_time_preview_export();

create function app.export_optimizer_selection(p_org uuid,p_request jsonb,p_artifact_text text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,auth,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_profile uuid:=(p_request->>'profileId')::uuid; v_id uuid:=(p_request->>'requestId')::uuid;
  v_batch public.recommendation_preview_batches%rowtype; v_run public.recommendation_runs%rowtype;
  e app.optimizer_selection_exports%rowtype; v_source jsonb; v_selected uuid[]; v_accepted uuid[];
  v_campaigns text[]; v_all_campaigns text[]:=array[]::text[]; v_children integer:=0;
  v_wire jsonb:=p_artifact_text::jsonb; v_expected jsonb; v_rows jsonb; v_apply uuid:=gen_random_uuid(); v_result jsonb;
  v_count integer; v_offered integer;
begin
  perform app.lock_org_manager(p_org);
  if v_actor is null or not exists(select 1 from public.ad_profiles where org_id=p_org and id=v_profile)
    then raise exception 'Resource not found' using errcode='42501'; end if;
  if not coalesce(app.sp_write_exact_json_keys(p_request,array['requestId','profileId','batchId','reviewFingerprint','recommendationIds']),false)
    then raise exception 'Invalid selection request' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('optimizer-export:'||p_org::text||':'||v_id::text,0));
  select * into e from app.optimizer_selection_exports where org_id=p_org and request_id=v_id;
  if found then
    if e.actor_id<>v_actor or e.request is distinct from p_request then raise exception 'Export request identity conflict' using errcode='23505'; end if;
    return e.result;
  end if;
  select array_agg(value::uuid order by value::uuid) into v_selected from jsonb_array_elements_text(p_request->'recommendationIds');
  v_offered:=cardinality(v_selected);
  if v_offered not between 1 and 500 or to_jsonb(v_selected) is distinct from p_request->'recommendationIds'
    or v_offered<>(select count(distinct x) from unnest(v_selected) x) then raise exception 'Invalid selection' using errcode='22023'; end if;
  perform 1 from app.recommendation_claim_authority where singleton for share;
  select * into strict v_batch from public.recommendation_preview_batches where org_id=p_org and profile_id=v_profile
    and id=(p_request->>'batchId')::uuid for update;
  if v_batch.execution_snapshot is null or not app.one_time_rpc_snapshot_valid(v_batch.execution_snapshot)
    then raise exception 'One-time snapshot unavailable' using errcode='55000'; end if;
  for v_run in select * from public.recommendation_runs where org_id=p_org and profile_id=v_profile and batch_id=v_batch.id order by id for update loop
    v_children:=v_children+1;
    select array_agg(campaign_id order by campaign_id collate "C") into v_campaigns from public.recommendation_run_campaigns
      where org_id=p_org and profile_id=v_profile and run_id=v_run.id and batch_id=v_batch.id;
    if v_run.status<>'succeeded' or v_run.scope_version is distinct from 2
      or v_run.execution_snapshot is distinct from v_batch.execution_snapshot
      or v_run.job_id is null or v_campaigns is null or cardinality(v_campaigns)<>v_run.scope_count
      or v_run.scope_fingerprint is distinct from app.recommendation_run_scope_fingerprint(v_profile,v_run.group_id,v_campaigns)
      or (select count(*) from public.recommendations where org_id=p_org and profile_id=v_profile and run_id=v_run.id)<>v_run.proposals_count then
      raise exception 'Completed child scope does not reconcile' using errcode='55000'; end if;
    v_all_campaigns:=v_all_campaigns||v_campaigns;
    perform app.lock_review_recommendations(p_org,v_profile,v_run.id);
  end loop;
  if v_children<>v_batch.child_count or v_children=0 or cardinality(v_all_campaigns)<>v_batch.scope_count
    or cardinality(v_all_campaigns)<>(select count(distinct x) from unnest(v_all_campaigns) x)
    or v_batch.scope_fingerprint is distinct from app.recommendation_batch_scope_fingerprint(v_profile,v_all_campaigns) then
    raise exception 'Complete batch scope does not reconcile' using errcode='55000'; end if;
  v_source:=app.optimizer_review_source(p_org,v_profile,v_batch.id);
  if app.sp_write_sha256(v_source::text) is distinct from p_request->>'reviewFingerprint' then
    raise exception 'Review inputs changed; fresh review required' using errcode='55000'; end if;
  select array_agg(r.id order by r.id) into v_accepted from public.recommendations r
    join public.recommendation_runs run on run.org_id=r.org_id and run.profile_id=r.profile_id and run.id=r.run_id
    where r.org_id=p_org and r.profile_id=v_profile and run.batch_id=v_batch.id and r.status='accepted';
  if v_accepted is distinct from v_selected then raise exception 'The complete accepted selection changed' using errcode='55000'; end if;
  if exists(select 1 from public.recommendations r where r.org_id=p_org and r.profile_id=v_profile and r.id=any(v_selected)
    and (r.export_batch_id is not null or r.proposal_revision_id is not null or r.entity_type<>'keyword' or r.field<>'bid'
      or r.inputs->'dependencySet' is not null or r.ad_product is distinct from 'SP'
      or jsonb_typeof(r.current_value)<>'number' or jsonb_typeof(r.proposed_value)<>'number'
      or not exists(select 1 from public.recommendation_run_campaigns m where m.org_id=p_org and m.profile_id=v_profile
        and m.run_id=r.run_id and m.batch_id=v_batch.id and m.campaign_id=r.campaign_id))) then
    raise exception 'Selected source is unsupported or outside its saved campaign scope' using errcode='55000'; end if;
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('entity_type',entity_type,'entity_id',entity_id,'field',field,
    'old',current_value,'new',proposed_value,'name',entity_name)) order by created_at,id) into v_expected
    from public.recommendations where org_id=p_org and profile_id=v_profile and id=any(v_selected);
  if v_wire is distinct from v_expected or jsonb_array_length(v_wire)<>v_offered
    then raise exception 'Export artifact differs from recorded values' using errcode='55000'; end if;
  perform app.lock_review_export_rows(p_org,v_profile,null,(select jsonb_agg(jsonb_build_object(
    'entityType',r.entity_type,'entityId',r.entity_id,'field',r.field)) from public.recommendations r
    where r.org_id=p_org and r.profile_id=v_profile and r.id=any(v_selected)));
  if exists(select 1 from public.recommendations r left join public.keywords k on k.org_id=r.org_id and k.profile_id=r.profile_id
      and k.amazon_id=r.entity_id cross join lateral app.resolve_apply_current_value(r.org_id,r.profile_id,r.entity_type::text::public.apply_entity_type,r.entity_id,r.field) state
    where r.org_id=p_org and r.profile_id=v_profile and r.id=any(v_selected)
      and (not state.supported or not state.present or state.current_value is distinct from r.current_value
        or k.ad_product is distinct from 'SP' or k.campaign_id is distinct from r.campaign_id
        or k.deleted_at is not null or k.state not in ('enabled','paused') or k.synced_at is null)) then
    raise exception 'Current values changed; fresh evaluation required' using errcode='55000'; end if;
  select jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'recommendationId',r.id,'wire',v_wire->(r.i-1)::integer) order by r.i)
    into v_rows from (select id,row_number() over(order by created_at,id) as i from public.recommendations
      where org_id=p_org and profile_id=v_profile and id=any(v_selected)) r;
  v_result:=jsonb_build_object('requestId',v_id,'batchId',v_batch.id,'applyBatchId',v_apply,
    'forwardRowIds',(select jsonb_agg(value->'id' order by value->>'id') from jsonb_array_elements(v_rows)),
    'counts',jsonb_build_object('offered',v_offered,'accepted',v_offered,'exported',v_offered,'applyRows',v_offered));
  insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,status,created_by,exported_at,artifact_sha256,exported_proposals,reversible_rows,unsupported_rows)
    values(v_apply,p_org,v_profile,'optimizer-'||v_id::text,'optimizer','bid','Selected in Optimize Now for guarded preview','staged',v_actor,
      clock_timestamp(),app.sp_write_sha256(p_artifact_text),v_offered,v_offered,0);
  insert into app.optimizer_selection_exports(org_id,profile_id,request_id,actor_id,preview_batch_id,apply_batch_id,request,source,artifact_text,rows,result)
    values(p_org,v_profile,v_id,v_actor,v_batch.id,v_apply,p_request,v_source,p_artifact_text,v_rows,v_result);
  insert into public.apply_rows(id,org_id,profile_id,batch_id,recommendation_id,entity_type,entity_id,entity_name,field,old_value,new_value,lever)
    select (item->>'id')::uuid,p_org,v_profile,v_apply,(item->>'recommendationId')::uuid,
      (item#>>'{wire,entity_type}')::public.apply_entity_type,item#>>'{wire,entity_id}',item#>>'{wire,name}',item#>>'{wire,field}',item#>'{wire,old}',item#>'{wire,new}','bid'
      from jsonb_array_elements(v_rows) item;
  get diagnostics v_count=row_count;
  if v_count<>v_offered then raise exception 'Exported apply-row count differs' using errcode='55000'; end if;
  update public.recommendations set status='exported',export_batch_id=v_apply
    where org_id=p_org and profile_id=v_profile and id=any(v_selected) and status='accepted';
  get diagnostics v_count=row_count;
  if v_count<>v_offered then raise exception 'Exported recommendation count differs' using errcode='55000'; end if;
  perform app.assert_optimizer_export_source(p_org,v_profile,v_apply);
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'user',v_actor,'optimizer.selection.exported','apply_batch',v_apply::text,v_result,'web');
  return v_result;
end $$;
revoke all on function app.export_optimizer_selection(uuid,jsonb,text) from public,anon,service_role;
grant execute on function app.export_optimizer_selection(uuid,jsonb,text) to authenticated;
