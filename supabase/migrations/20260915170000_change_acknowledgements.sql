set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Acknowledgement is a review receipt, never evidence that a write succeeded.
alter table public.entity_changes
  add column acknowledged_at timestamptz,
  add column acknowledged_by uuid references auth.users(id),
  add constraint entity_changes_ack_pair check ((acknowledged_at is null) = (acknowledged_by is null));
create index entity_changes_unacknowledged on public.entity_changes(org_id,profile_id)
  where acknowledged_at is null and source='sync';

create function app.acknowledge_observed_change(p_org uuid,p_profile uuid,p_change bigint)
returns bigint language plpgsql security definer set search_path=pg_catalog,public as $$
declare result bigint;
begin
  perform app.lock_org_editor(p_org);
  if not exists(select 1 from public.entity_changes where org_id=p_org and profile_id=p_profile
    and id=p_change and source='sync') then
    raise exception 'Resource not found' using errcode='42501';
  end if;
  update public.entity_changes set acknowledged_at=statement_timestamp(),acknowledged_by=auth.uid()
    where org_id=p_org and profile_id=p_profile and id=p_change and source='sync' and acknowledged_at is null
    returning id into result;
  -- Read the receipt back even on a retry; a deleted row cannot report success.
  select id into result from public.entity_changes
    where org_id=p_org and profile_id=p_profile and id=p_change and source='sync'
      and acknowledged_at is not null and acknowledged_by is not null;
  if not found then raise exception 'Resource not found' using errcode='42501'; end if;
  return result;
end $$;
revoke all on function app.acknowledge_observed_change(uuid,uuid,bigint) from public,anon;
grant execute on function app.acknowledge_observed_change(uuid,uuid,bigint) to authenticated;

-- Only an explicitly recorded export context can label an experiment start.
create unique index experiments_org_profile_id_key on public.experiments(org_id,profile_id,id);
alter table public.apply_batches add column experiment_id uuid,
  add constraint apply_batches_experiment_scope_fk foreign key(org_id,profile_id,experiment_id)
    references public.experiments(org_id,profile_id,id);

-- A recorded artifact fingerprint cannot be replaced to bless edited export rows.
create function app.preserve_restore_export_fingerprint() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if old.artifact_sha256 is not null and new.artifact_sha256 is distinct from old.artifact_sha256 then
    raise exception 'source_changed: Original export fingerprint is immutable' using errcode='55000', detail='source_changed';
  end if;
  return new;
end $$;
create trigger apply_batches_export_fingerprint_immutable before update of artifact_sha256 on public.apply_batches
  for each row execute function app.preserve_restore_export_fingerprint();

-- Proposal receipts are separate from execution approvals and cannot enqueue work.
create table public.sp_write_restore_proposals (
  plan_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  -- Preserve source identity even if the legacy export is later removed. Admission and review recheck its tenant scope.
  source_batch_id uuid not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique(org_id,profile_id,plan_id),
  foreign key(org_id,profile_id,plan_id) references public.sp_write_plans(org_id,profile_id,plan_id) on delete cascade
);
create table public.sp_write_restore_reviews (
  plan_id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  reviewed_by uuid not null references auth.users(id),
  reviewed_at timestamptz not null default now(),
  foreign key(org_id,profile_id,plan_id) references public.sp_write_restore_proposals(org_id,profile_id,plan_id) on delete cascade
);
select app.install_tenant_rls('public.sp_write_restore_proposals',null);
select app.install_tenant_rls('public.sp_write_restore_reviews',null);
revoke all on public.sp_write_restore_proposals,public.sp_write_restore_reviews from public,anon,authenticated,service_role;
grant select on public.sp_write_restore_proposals,public.sp_write_restore_reviews to authenticated,service_role;
create trigger sp_write_restore_proposals_immutable before update or delete on public.sp_write_restore_proposals for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_restore_proposals_no_truncate before truncate on public.sp_write_restore_proposals for each statement execute function app.reject_sp_write_evidence_truncate();
create trigger sp_write_restore_reviews_immutable before update or delete on public.sp_write_restore_reviews for each row execute function app.reject_sp_write_evidence_change();
create trigger sp_write_restore_reviews_no_truncate before truncate on public.sp_write_restore_reviews for each statement execute function app.reject_sp_write_evidence_truncate();

create function app.assert_sp_write_restore_source(
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
       or v_run.strategy_snapshot is null or v_run.strategy_goal is null
       or v_policy ->> 'strategySnapshotText' is distinct from v_run.strategy_snapshot::text
       or v_policy ->> 'strategyGoal' is distinct from v_run.strategy_goal
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
      raise exception 'SP preview source or policy changed' using errcode = '55000';
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
      raise exception 'Restore source changed or is not ready' using errcode='55000';
    end if;
    v_count := v_count + 1;
  end loop;
  if v_count <> v_actual_count or v_count <> (v_plan #>> '{counts,providerRows}')::integer then
    raise exception 'SP preview source counts differ' using errcode = '22023';
  end if;
end;
$$;

revoke all on function app.assert_sp_write_restore_source(text,text,text,text,text)
  from public, anon, authenticated, service_role;


create function app.record_sp_write_restore_proposal(p_org uuid,p_plan_text text,p_plan_preimage text,p_action_proofs jsonb,
  p_evidence_text text,p_guardrail_preimage text,p_provenance_preimage text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan jsonb:=p_plan_text::jsonb; v_id uuid:=(v_plan->>'id')::uuid;
begin
  if (v_plan->>'orgId')::uuid is distinct from p_org then raise exception 'Resource not found' using errcode='42501'; end if;
  perform app.lock_sp_write_operator(p_org,(v_plan->>'profileId')::uuid,auth.uid());
  if (v_plan->>'expiresAt')::timestamptz<=clock_timestamp() then raise exception 'Preview expired' using errcode='55000'; end if;
  perform app.assert_sp_write_restore_source(p_plan_text,p_plan_preimage,p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  perform app.record_sp_write_plan_internal(p_plan_text,p_plan_preimage,p_action_proofs);
  insert into public.sp_write_preview_evidence(plan_id,org_id,profile_id,artifact_text,artifact,guardrail_preimage,provenance_preimage)
    values(v_id,p_org,(v_plan->>'profileId')::uuid,p_evidence_text,p_evidence_text::jsonb,p_guardrail_preimage,p_provenance_preimage);
  perform app.assert_sp_write_method_evidence(v_id,false);
  insert into public.sp_write_restore_proposals(plan_id,org_id,profile_id,source_batch_id,created_by)
    values(v_id,p_org,(v_plan->>'profileId')::uuid,(v_plan#>>'{source,applyBatchId}')::uuid,auth.uid());
  return v_id;
end $$;
revoke all on function app.record_sp_write_restore_proposal(uuid,text,text,jsonb,text,text,text) from public,anon,service_role;
grant execute on function app.record_sp_write_restore_proposal(uuid,text,text,jsonb,text,text,text) to authenticated;

create function app.review_sp_write_restore_proposal(p_org uuid,p_profile uuid,p_plan uuid,p_fingerprint text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_plan public.sp_write_plans%rowtype; v_evidence public.sp_write_preview_evidence%rowtype;
begin
  perform app.lock_sp_write_operator(p_org,p_profile,auth.uid());
  if not exists(select 1 from public.sp_write_restore_proposals where org_id=p_org and profile_id=p_profile and plan_id=p_plan) then
    raise exception 'Resource not found' using errcode='42501'; end if;
  select * into strict v_plan from public.sp_write_plans where org_id=p_org and profile_id=p_profile and plan_id=p_plan;
  select * into strict v_evidence from public.sp_write_preview_evidence where org_id=p_org and profile_id=p_profile and plan_id=p_plan;
  if v_plan.fingerprint is distinct from p_fingerprint or v_plan.expires_at<=clock_timestamp() then raise exception 'Preview changed or expired' using errcode='55000'; end if;
  perform app.assert_sp_write_restore_source(v_plan.artifact_text,v_plan.fingerprint_preimage,v_evidence.artifact_text,v_evidence.guardrail_preimage,v_evidence.provenance_preimage);
  insert into public.sp_write_restore_reviews(plan_id,org_id,profile_id,reviewed_by) values(p_plan,p_org,p_profile,auth.uid()) on conflict(plan_id) do nothing;
  return p_plan;
end $$;
revoke all on function app.review_sp_write_restore_proposal(uuid,uuid,uuid,text) from public,anon,service_role;
grant execute on function app.review_sp_write_restore_proposal(uuid,uuid,uuid,text) to authenticated;
