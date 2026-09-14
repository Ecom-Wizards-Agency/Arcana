-- WP-215: saved review artifacts only. Separate campaign window; no execution authority.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table public.campaign_creation_previews (
  org_id uuid not null,
  profile_id uuid not null,
  plan_id uuid not null,
  artifact_text text not null,
  artifact jsonb not null,
  artifact_sha256 text not null,
  recorded_by uuid not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (org_id, profile_id, plan_id),
  constraint campaign_creation_previews_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles (org_id, id) on delete cascade,
  constraint campaign_creation_previews_artifact_agrees check (
    artifact_text::jsonb = artifact
    and jsonb_typeof(artifact) = 'object'
    and (artifact ->> 'orgId')::uuid = org_id
    and (artifact ->> 'profileId')::uuid = profile_id
    and (artifact ->> 'id')::uuid = plan_id
    and artifact ?& array['orgId','profileId','id']
    and artifact -> 'orgId' <> 'null'::jsonb
    and artifact -> 'profileId' <> 'null'::jsonb
    and artifact -> 'id' <> 'null'::jsonb
  ),
  constraint campaign_creation_previews_byte_digest check (
    artifact_sha256 = encode(sha256(convert_to(artifact_text, 'UTF8')), 'hex')
  )
);

alter table public.campaign_creation_previews enable row level security;
create policy campaign_creation_previews_read on public.campaign_creation_previews
  for select to authenticated using (app.has_org_role(org_id, array['owner','admin']));
revoke all on public.campaign_creation_previews from public, anon, authenticated, service_role;
grant select on public.campaign_creation_previews to authenticated, service_role;

create function app.guard_campaign_creation_preview_immutable() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  -- Definer context distinguishes actual parent deletion from RLS invisibility.
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  raise exception 'campaign preview is immutable' using errcode = '55000';
end;
$$;
revoke all on function app.guard_campaign_creation_preview_immutable()
  from public, anon, authenticated, service_role;
create trigger campaign_creation_previews_immutable before update or delete
  on public.campaign_creation_previews for each row
  execute function app.guard_campaign_creation_preview_immutable();
create trigger campaign_creation_previews_no_truncate before truncate
  on public.campaign_creation_previews for each statement
  execute function app.guard_campaign_creation_preview_immutable();

-- Storage integrity and current recording authority only. Shared schemas verify
-- the complete graph/payload/fingerprints before insertion AND every product read.
-- A saved artifact, including a direct authenticated RPC insert, cannot grant execution.
create function app.record_campaign_creation_preview(p_plan_text text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, app, auth, pg_temp as $$
declare
  v_plan jsonb := p_plan_text::jsonb;
  v_actor uuid := auth.uid();
  v_org uuid := (v_plan ->> 'orgId')::uuid;
  v_profile_id uuid := (v_plan ->> 'profileId')::uuid;
  v_plan_id uuid := (v_plan ->> 'id')::uuid;
  v_profile public.ad_profiles%rowtype;
  v_existing public.campaign_creation_previews%rowtype;
  v_now timestamptz;
begin
  if v_plan is null or jsonb_typeof(v_plan) <> 'object'
    or v_actor is null or v_org is null or v_profile_id is null or v_plan_id is null
    or v_plan ->> 'schemaVersion' is distinct from 'openspell.campaign-creation-plan.v2' then
    raise exception 'invalid campaign preview' using errcode = '22023';
  end if;

  perform 1 from public.orgs where id = v_org for key share;
  if not found then raise exception 'campaign preview unavailable' using errcode = '42501'; end if;
  perform 1 from public.org_members where org_id = v_org and user_id = v_actor
    and role in ('owner','admin') for share;
  if not found then raise exception 'campaign preview unavailable' using errcode = '42501'; end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'wizard-ads:campaign-preview:' || v_org::text || ':' || v_profile_id::text || ':' || v_plan_id::text, 0));
  select * into v_existing from public.campaign_creation_previews
    where org_id = v_org and profile_id = v_profile_id and plan_id = v_plan_id;
  if found then
    if v_existing.artifact_text is distinct from p_plan_text then
      raise exception 'campaign preview identity conflict' using errcode = '23505';
    end if;
    return jsonb_build_object('profileId', v_profile_id, 'planId', v_plan_id);
  end if;

  select p.* into v_profile from public.ad_profiles p
    join public.ads_connections c on c.org_id = p.org_id and c.id = p.connection_id
    where p.org_id = v_org and p.id = v_profile_id and p.sync_enabled and c.status = 'active'
    for share of p, c;
  if not found or v_plan #>> '{providerScope,amazonProfileId}' is distinct from v_profile.amazon_profile_id
    or v_plan #>> '{providerScope,connectionId}' is distinct from v_profile.connection_id::text
    or v_plan #>> '{providerScope,region}' is distinct from v_profile.region::text
    or v_plan #>> '{providerScope,currencyCode}' is distinct from v_profile.currency_code
    or v_plan #>> '{providerScope,accountType}' is distinct from v_profile.account_type::text then
    raise exception 'campaign preview scope unavailable' using errcode = '42501';
  end if;
  -- Marketplace is a frozen requested value; profiles do not independently store it.
  v_now := clock_timestamp();
  if v_plan ->> 'generatedAt' is null or v_plan ->> 'frozenAt' is null or v_plan ->> 'expiresAt' is null
    or (v_plan ->> 'generatedAt')::timestamptz > (v_plan ->> 'frozenAt')::timestamptz
    or (v_plan ->> 'frozenAt')::timestamptz > v_now
    or (v_plan ->> 'expiresAt')::timestamptz <= v_now then
    raise exception 'campaign preview times unavailable' using errcode = '22023';
  end if;
  insert into public.campaign_creation_previews
    (org_id, profile_id, plan_id, artifact_text, artifact, artifact_sha256, recorded_by, recorded_at)
    values (v_org, v_profile_id, v_plan_id, p_plan_text, v_plan,
      encode(sha256(convert_to(p_plan_text, 'UTF8')), 'hex'), v_actor, v_now);
  return jsonb_build_object('profileId', v_profile_id, 'planId', v_plan_id);
end;
$$;
revoke all on function app.record_campaign_creation_preview(text) from public, anon, authenticated, service_role;
grant execute on function app.record_campaign_creation_preview(text) to authenticated;

comment on table public.campaign_creation_previews is
  'Immutable saved campaign review text. Not approval or provider evidence; shared validation is mandatory on reads.';

-- WP-280: narrow authenticated commands reuse private ledger implementations.
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
  if v_version is null or v_version not in ('openspell.sp-write-plan.v1','openspell.sp-write-plan.v2') then
    raise exception 'unrecognized SP write plan version' using errcode = '22023';
  end if;
  v_plan := app.sp_write_verified_artifact(p_plan_text,p_plan_fingerprint_preimage,v_version);
  if v_version = 'openspell.sp-write-plan.v2' then
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
  ])
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
     or v_inserted <> (v_plan #>> '{counts,uniqueEntities}')::integer
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
revoke all on function app.record_sp_write_plan_internal(text,text,jsonb) from public, anon, authenticated, service_role;
create function app.record_sp_write_preview_internal(
  p_plan_text text, p_plan_preimage text, p_action_proofs jsonb,
  p_evidence_text text, p_guardrail_preimage text, p_provenance_preimage text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_plan jsonb := p_plan_text::jsonb;
  v_plan_id uuid := (v_plan ->> 'id')::uuid;
begin
  perform app.assert_sp_write_preview_source(p_plan_text, p_plan_preimage,
    p_evidence_text, p_guardrail_preimage, p_provenance_preimage);
  perform app.record_sp_write_plan_internal(p_plan_text, p_plan_preimage, p_action_proofs);
  insert into public.sp_write_preview_evidence
    (plan_id, org_id, profile_id, artifact_text, artifact, guardrail_preimage, provenance_preimage)
  values (v_plan_id, (v_plan ->> 'orgId')::uuid, (v_plan ->> 'profileId')::uuid,
    p_evidence_text, p_evidence_text::jsonb, p_guardrail_preimage, p_provenance_preimage);
  return v_plan_id;
end;
$$;
revoke all on function app.record_sp_write_preview_internal(text,text,jsonb,text,text,text) from public, anon, authenticated, service_role;
create or replace function app.start_sp_write_execution_internal(
  p_approval_id uuid,
  p_plan_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_child public.sp_write_cycle_plans%rowtype;
  v_plan public.sp_write_plans%rowtype;
  v_receipt public.sp_write_authorization_receipts%rowtype;
  v_now timestamptz;
  v_outbox_id uuid;
begin
  select child.* into strict v_child
  from public.sp_write_cycle_plans child
  where child.approval_id = p_approval_id and child.plan_id = p_plan_id
  for update;
  select * into strict v_plan from public.sp_write_plans where plan_id = v_child.plan_id;
  select * into strict v_receipt
  from public.sp_write_authorization_receipts where approval_id = v_child.approval_id;
  select outbox_id into v_outbox_id from public.sp_write_outbox
    where org_id=v_child.org_id and profile_id=v_child.profile_id
      and execution_id=v_child.execution_id and plan_id=v_child.plan_id
      and approval_id=v_child.approval_id and generation=v_child.generation and kind='dispatch';
  if found then
    if not exists(select 1 from public.sp_write_execution_requests where org_id=v_child.org_id
      and profile_id=v_child.profile_id and execution_id=v_child.execution_id and plan_id=v_child.plan_id
      and approval_id=v_child.approval_id and generation=v_child.generation) then
      raise exception 'Queued execution request missing' using errcode='55000';
    end if;
    return v_outbox_id;
  end if;
  perform app.assert_sp_write_method_evidence(
    case when v_plan.direction='inverse' then v_plan.source_plan_id else v_plan.plan_id end,true);
  v_now := clock_timestamp();
  if v_now >= v_receipt.expires_at or v_now >= v_plan.expires_at then
    raise exception 'SP write execution authority is expired' using errcode = '55000';
  end if;
  if v_child.direction = 'inverse' and not exists (
    select 1
    from public.sp_write_plans source_plan
    where source_plan.plan_id = v_plan.source_plan_id
      and source_plan.provider_rows = (
        select count(*)
        from public.sp_write_observations observation
        where observation.org_id = v_child.org_id
          and observation.profile_id = v_child.profile_id
          and observation.execution_id = v_child.execution_id
          and observation.plan_id = v_plan.source_plan_id
          and observation.outcome = 'observed_requested'
      )
  ) then
    raise exception 'SP write inverse source is not completely observed requested'
      using errcode = '55000';
  end if;

  insert into public.sp_write_execution_requests (
    org_id, profile_id, execution_id, plan_id, approval_id, generation, requested_at
  ) values (
    v_child.org_id, v_child.profile_id, v_child.execution_id, v_child.plan_id,
    v_child.approval_id, v_child.generation, v_now
  ) on conflict (org_id, profile_id, execution_id, plan_id) do nothing;

  insert into public.sp_write_outbox (
    org_id, profile_id, execution_id, plan_id, approval_id, generation,
    kind, provider_call_id, intent_id, source_sync_job_id, created_at
  ) values (
    v_child.org_id, v_child.profile_id, v_child.execution_id, v_child.plan_id,
    v_child.approval_id, v_child.generation, 'dispatch', null, null, null, v_now
  ) on conflict (org_id, profile_id, execution_id, plan_id, kind, provider_call_id)
    do nothing
  returning outbox_id into v_outbox_id;
  if v_outbox_id is null then
    select outbox_id into strict v_outbox_id
    from public.sp_write_outbox
    where org_id = v_child.org_id and profile_id = v_child.profile_id
      and execution_id = v_child.execution_id and plan_id = v_child.plan_id
      and kind = 'dispatch';
  end if;
  return v_outbox_id;
end;
$$;
revoke all on function app.start_sp_write_execution_internal(uuid,uuid) from public, anon, authenticated, service_role;

create function app.lock_sp_write_operator(p_org uuid, p_profile uuid, p_actor uuid)
returns void language plpgsql security definer
set search_path = pg_catalog, public, app, auth, pg_temp as $$
begin
  if p_actor is distinct from auth.uid() then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  perform app.lock_org_manager(p_org);
  perform 1 from public.ad_profiles where org_id = p_org and id = p_profile for key share;
  if not found then raise exception using errcode = '42501', message = 'Resource not found'; end if;
end;
$$;
revoke all on function app.lock_sp_write_operator(uuid,uuid,uuid) from public, anon, service_role;
grant execute on function app.lock_sp_write_operator(uuid,uuid,uuid) to authenticated;

create function app.sp_write_environment_enabled(p_org uuid, p_profile uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, app, pg_temp as $$
  select exists(select 1 from public.ad_profiles where org_id = p_org and id = p_profile)
    and (app.has_org_role(p_org, array['owner','admin']) or app.is_service_role())
    and exists(select 1 from public.sp_write_environment_gate_head head
      join public.sp_write_environment_gate_versions version on version.version_id = head.version_id
      where version.enabled);
$$;
revoke all on function app.sp_write_environment_enabled(uuid,uuid) from public, anon;
grant execute on function app.sp_write_environment_enabled(uuid,uuid) to authenticated, service_role;

-- Inputs are JSONB in both the current and WP-252 schema. Hash PostgreSQL's exact
-- representation; never invent a method identity for historical recommendations.
create function app.assert_sp_write_method_evidence(p_plan uuid, p_required boolean)
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
revoke all on function app.assert_sp_write_method_evidence(uuid,boolean) from public, anon, authenticated, service_role;

create function app.record_sp_write_preview_for_actor(
  p_org uuid, p_actor uuid, p_plan_text text, p_plan_preimage text, p_action_proofs jsonb,
  p_evidence_text text, p_guardrail_preimage text, p_provenance_preimage text
) returns uuid language plpgsql security definer
set search_path = pg_catalog, public, app, auth, pg_temp as $$
declare v_plan jsonb := p_plan_text::jsonb; v_id uuid;
begin
  if (v_plan ->> 'orgId')::uuid is distinct from p_org or v_plan ->> 'direction' is distinct from 'forward' then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  perform app.lock_sp_write_operator(p_org,(v_plan ->> 'profileId')::uuid,p_actor);
  v_id := app.record_sp_write_preview_internal(p_plan_text,p_plan_preimage,p_action_proofs,
    p_evidence_text,p_guardrail_preimage,p_provenance_preimage);
  perform app.assert_sp_write_method_evidence(v_id,false);
  return v_id;
end;
$$;
revoke all on function app.record_sp_write_preview_for_actor(uuid,uuid,text,text,jsonb,text,text,text)
  from public, anon, service_role;
grant execute on function app.record_sp_write_preview_for_actor(uuid,uuid,text,text,jsonb,text,text,text) to authenticated;

create function app.approve_and_queue_sp_write_for_actor(
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

-- WP-253 export still owns its transaction. Narrow definer commands replace the
-- recommendation UPDATE privilege removed by proposal-revision immutability.
create function app.lock_review_recommendations(p_org uuid,p_profile uuid,p_run uuid)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform app.lock_org_manager(p_org);
  perform 1 from app.recommendation_claim_authority where singleton for share;
  perform app.lock_review_export_rows(p_org,p_profile,p_run,'[]'::jsonb);
  perform id from public.recommendations
    where org_id=p_org and profile_id=p_profile and run_id=p_run order by id for update;
end;
$$;
revoke all on function app.lock_review_recommendations(uuid,uuid,uuid) from public,anon,service_role;
grant execute on function app.lock_review_recommendations(uuid,uuid,uuid) to authenticated;

create function app.stamp_review_export(p_org uuid,p_profile uuid,p_run uuid,p_batch uuid,p_ids uuid[])
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
       <> (select count(*) from public.recommendations where org_id=p_org and profile_id=p_profile
             and id=any(p_ids) and entity_type::text in ('keyword','target','campaign','ad_group'))
    or exists(select 1 from public.recommendations r where r.org_id=p_org and r.profile_id=p_profile
      and r.id=any(p_ids) and r.entity_type::text in ('keyword','target','campaign','ad_group')
      and (select count(*) from public.apply_rows a where a.org_id=p_org and a.profile_id=p_profile
        and a.batch_id=p_batch and a.recommendation_id=r.id and a.entity_type::text=r.entity_type::text
        and a.entity_id=r.entity_id and a.field=r.field)<>1)
    or not exists(select 1 from public.apply_batches b where b.id=p_batch and b.org_id=p_org and b.profile_id=p_profile
      and b.reversible_rows=(select count(*) from public.apply_rows where batch_id=p_batch and org_id=p_org and profile_id=p_profile)
      and b.unsupported_rows=cardinality(p_ids)-b.reversible_rows) then
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
  -- Reversible rows must carry the exact accepted revision and proposed value.
  if exists(select 1 from public.apply_rows a join public.recommendations r on r.id=a.recommendation_id
    and r.org_id=a.org_id and r.profile_id=a.profile_id
    left join public.recommendation_proposal_revisions rev on rev.id=r.proposal_revision_id
      and rev.org_id=r.org_id and rev.profile_id=r.profile_id and rev.recommendation_id=r.id
    where a.batch_id=p_batch and a.org_id=p_org and a.profile_id=p_profile and
      (not(r.id=any(p_ids)) or a.proposal_revision_id is distinct from r.proposal_revision_id
       or a.old_value is distinct from r.current_value
       or case when r.proposal_revision_id is null then a.new_value is distinct from r.proposed_value
          else (a.new_value #>> '{}')::numeric is distinct from (rev.receipt->>'proposedValue')::numeric end)) then
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

-- Method evidence is required at SQL admission too, including compatibility callers.
-- Already admitted immutable executions remain replayable; old pending approvals
-- cannot create new work without a new method-backed preview.
alter function app.approve_sp_write_cycle(uuid,text) rename to approve_sp_write_cycle_before_method;
revoke all on function app.approve_sp_write_cycle_before_method(uuid,text) from public,anon,authenticated,service_role;
create function app.approve_sp_write_cycle(p_plan uuid,p_request text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_receipt jsonb; v_source uuid;
begin
  v_receipt:=app.approve_sp_write_cycle_before_method(p_plan,p_request);
  if not exists(select 1 from public.sp_write_execution_requests
    where org_id=(v_receipt#>>'{plan,orgId}')::uuid and profile_id=(v_receipt#>>'{plan,profileId}')::uuid
      and execution_id=(v_receipt->>'executionId')::uuid and plan_id=p_plan
      and approval_id=(v_receipt->>'approvalId')::uuid and generation=(v_receipt->>'generation')::uuid) then
    select case when direction='inverse' then source_plan_id else plan_id end into strict v_source
      from public.sp_write_plans where plan_id=p_plan;
    perform app.assert_sp_write_method_evidence(v_source,true);
  end if;
  return v_receipt;
end;
$$;
revoke all on function app.approve_sp_write_cycle(uuid,text) from public,anon,service_role;
grant execute on function app.approve_sp_write_cycle(uuid,text) to authenticated;

-- Service admission goes through the same method and exact existing-request checks.
create or replace function app.start_sp_write_execution(p_approval_id uuid,p_plan_id uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,app,pg_temp as $$
begin
  perform app.assert_service_role('start_sp_write_execution');
  return app.start_sp_write_execution_internal(p_approval_id,p_plan_id);
end;
$$;
revoke all on function app.start_sp_write_execution(uuid,uuid) from public,anon,authenticated;
grant execute on function app.start_sp_write_execution(uuid,uuid) to service_role;

create unique index sp_write_confirmation_audit_identity on public.audit_log
  (org_id,target_id,((payload->>'approvalId'))) where action='sp_write.confirmed';
create function app.guard_sp_write_confirmation_audit() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if old.action='sp_write.confirmed' then
    if tg_op='DELETE' and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
    raise exception 'SP confirmation is immutable' using errcode='55000';
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.action='sp_write.confirmed' then raise exception 'SP confirmation is immutable' using errcode='55000'; end if;
  return new;
end;
$$;
revoke all on function app.guard_sp_write_confirmation_audit() from public,anon,authenticated,service_role;
create trigger sp_write_confirmation_audit_immutable before update or delete on public.audit_log
  for each row execute function app.guard_sp_write_confirmation_audit();
