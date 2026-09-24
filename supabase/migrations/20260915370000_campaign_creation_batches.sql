-- WP-290: operator-approved creation and keyword retry. No gate, grant or poller is enabled here.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table public.campaign_creation_batches (
  id uuid primary key,
  org_id uuid not null,
  profile_id uuid not null,
  draft_id uuid not null references public.campaign_drafts(id) on delete cascade,
  actor_id uuid not null references auth.users(id),
  parent_batch_id uuid references public.campaign_creation_batches(id) on delete cascade,
  admission_key text not null unique,
  artifact jsonb not null,
  node_count integer not null check (node_count > 0),
  admitted_at timestamptz not null default clock_timestamp(),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  unique (org_id,profile_id,id),
  check (artifact->>'id'=id::text and artifact->'plan'->>'orgId'=org_id::text
    and artifact->'plan'->>'profileId'=profile_id::text and artifact->>'actorId'=actor_id::text)
);
create table public.campaign_creation_batch_nodes (
  org_id uuid not null,
  profile_id uuid not null,
  batch_id uuid not null,
  node_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  node_fingerprint text not null check (node_fingerprint ~ '^[a-f0-9]{64}$'),
  intent jsonb,
  result jsonb,
  observation jsonb,
  refusal text check (refusal in ('gate_closed','dependency_failed','expired')),
  primary key (batch_id,node_id),
  unique (batch_id,ordinal),
  foreign key (org_id,profile_id,batch_id) references public.campaign_creation_batches(org_id,profile_id,id) on delete cascade,
  check (intent is null or refusal is null),
  check (result is null or intent is not null)
);
create table public.campaign_creation_outbox (
  batch_id uuid primary key references public.campaign_creation_batches(id) on delete cascade,
  claimant_id uuid,
  lease_id uuid,
  lease_until timestamptz,
  available_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
create table public.campaign_creation_observations (
  org_id uuid not null, profile_id uuid not null, batch_id uuid not null, node_id uuid not null,
  recorded_at timestamptz not null default clock_timestamp(), artifact jsonb not null, provider_artifact jsonb,
  foreign key (batch_id,node_id) references public.campaign_creation_batch_nodes(batch_id,node_id) on delete cascade,
  foreign key (org_id,profile_id,batch_id) references public.campaign_creation_batches(org_id,profile_id,id) on delete cascade,
  primary key (batch_id,node_id,recorded_at)
);
create unique index campaign_creation_observation_replay on public.campaign_creation_observations(batch_id,node_id,(artifact->>'id'));
select app.install_tenant_rls('public.campaign_creation_batches');
select app.install_tenant_rls('public.campaign_creation_batch_nodes');
select app.install_tenant_rls('public.campaign_creation_observations');
alter table public.campaign_creation_outbox enable row level security;
revoke all on public.campaign_creation_batches, public.campaign_creation_batch_nodes, public.campaign_creation_outbox from anon, authenticated;
grant select on public.campaign_creation_batches, public.campaign_creation_batch_nodes to authenticated;
grant select on public.campaign_creation_batches, public.campaign_creation_batch_nodes, public.campaign_creation_outbox to service_role;
revoke all on public.campaign_creation_observations from anon,authenticated;
grant select on public.campaign_creation_observations to authenticated,service_role;
create trigger campaign_creation_observations_immutable before update or delete on public.campaign_creation_observations
  for each row execute function app.reject_sp_write_evidence_change();
create trigger campaign_creation_observations_no_truncate before truncate on public.campaign_creation_observations
  execute function app.reject_sp_write_evidence_truncate();
create trigger campaign_creation_batches_immutable before update or delete on public.campaign_creation_batches
  for each row execute function app.reject_sp_write_evidence_change();
create trigger campaign_creation_batches_no_truncate before truncate on public.campaign_creation_batches
  execute function app.reject_sp_write_evidence_truncate();

/** Resolve both WP-280 gates and the independently owned profile. */
create function app.campaign_creation_gate(p_org uuid,p_profile uuid,p_scope jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_env uuid; v_grant public.sp_write_profile_grant_versions%rowtype;
begin
  if not (app.is_service_role() or app.has_org_role(p_org,array['owner','admin'])) then
    return jsonb_build_object('reason','authorization_refused');
  end if;
  select ev.version_id into v_env from public.sp_write_environment_gate_head eh
    join public.sp_write_environment_gate_versions ev on ev.version_id=eh.version_id where ev.enabled;
  if v_env is null then return jsonb_build_object('reason','environment_gate_off'); end if;
  select gv.* into v_grant from public.sp_write_profile_grant_heads gh
    join public.sp_write_profile_grant_versions gv on gv.version_id=gh.version_id and gv.grant_id=gh.grant_id
      and gv.org_id=gh.org_id and gv.profile_id=gh.profile_id
    where gh.org_id=p_org and gh.profile_id=p_profile and gv.enabled;
  if not found then return jsonb_build_object('reason','profile_not_allowlisted'); end if;
  if v_grant.amazon_profile_id is distinct from p_scope->>'amazonProfileId'
    or v_grant.connection_id::text is distinct from p_scope->>'connectionId'
    or v_grant.region::text is distinct from p_scope->>'region'
    or v_grant.marketplace_id is distinct from p_scope->>'marketplaceId'
    or v_grant.currency_code is distinct from p_scope->>'currencyCode' or v_grant.api_dialect<>'sp_v3'
    or not exists(select 1 from public.ad_profiles p join public.ads_connections c on c.id=p.connection_id and c.org_id=p.org_id
      where p.org_id=p_org and p.id=p_profile and p.sync_enabled and c.status='active'
        and p.amazon_profile_id=v_grant.amazon_profile_id and p.connection_id=v_grant.connection_id
        and p.region=v_grant.region and p.currency_code=v_grant.currency_code and p.account_type::text=p_scope->>'accountType') then
    return jsonb_build_object('reason','profile_not_allowlisted');
  end if;
  return jsonb_build_object('reason',null,'environmentGateVersion',v_env,'profileGrantVersion',v_grant.version_id);
end;
$$;
revoke all on function app.campaign_creation_gate(uuid,uuid,jsonb) from public,anon;
grant execute on function app.campaign_creation_gate(uuid,uuid,jsonb) to authenticated,service_role;

create function app.admit_campaign_creation(p_org uuid,p_request jsonb,p_validation jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare d public.campaign_drafts%rowtype; parent public.campaign_creation_batches%rowtype;
  v_id uuid:=gen_random_uuid(); v_key text; v_gate jsonb; v_nodes jsonb; v_checks jsonb;
  v_lineage jsonb:=null; v_inherited jsonb; v_ids jsonb; v_now timestamptz:=clock_timestamp(); v_count integer;
begin
  if auth.uid() is null or not app.has_org_role(p_org,array['owner','admin']) then
    return jsonb_build_object('reason','authorization_refused');
  end if;
  perform 1 from public.org_members where org_id=p_org and user_id=auth.uid() and role in ('owner','admin') for share;
  select * into d from public.campaign_drafts where org_id=p_org and profile_id=(p_request->>'profileId')::uuid
    and id=(p_request->>'draftId')::uuid and created_by=auth.uid() for update;
  if not found then return jsonb_build_object('reason','not_found'); end if;
  if d.plan->>'fingerprint' is distinct from p_request->>'planFingerprint' then return jsonb_build_object('reason','stale_fingerprint'); end if;
  if d.revision is distinct from (p_request->>'expectedRevision')::integer then return jsonb_build_object('reason','stale_revision'); end if;
  if d.status='blocked' then return jsonb_build_object('reason','blocking_check'); end if;
  if d.plan->>'adProduct'<>'SP' or d.plan->>'apiDialect'<>'sp_legacy_v3' then return jsonb_build_object('reason','plan_not_sponsored_products'); end if;
  if d.plan->>'schemaVersion'<>'openspell.campaign-creation-plan.v2' then return jsonb_build_object('reason','executor_unavailable'); end if;
  if p_request->>'action' not in ('create','retry') then return jsonb_build_object('reason','invalid_request'); end if;
  -- Revalidation may advance the draft revision without changing its plan.
  -- That cannot authorize a second creation of the same frozen resources.
  v_key:=concat_ws(':',p_org,d.profile_id,d.id,d.plan->>'fingerprint',p_request->>'action',p_request->>'parentBatchId');
  select id into v_id from public.campaign_creation_batches where admission_key=v_key;
  if found then
    if p_request->>'action'='retry' and not exists(select 1 from public.campaign_creation_batches where id=v_id and artifact->'lineage'->'nodeIds'=p_request->'nodeIds') then
      return jsonb_build_object('reason','retry_not_allowed'); end if;
    return jsonb_build_object('batchId',v_id,'replayed',true);
  end if;
  v_id:=gen_random_uuid();
  if (p_request->>'action'='create' and d.status<>'validated') or (p_request->>'action'='retry' and d.status<>'approved') then
    return jsonb_build_object('reason','draft_not_validated'); end if;
  if d.validation is null or p_validation is null or p_validation->>'planFingerprint' is distinct from d.plan->>'fingerprint'
    or p_validation->>'recipeFingerprint' is distinct from d.validation->>'recipeFingerprint' then
    return jsonb_build_object('reason','draft_not_validated'); end if;
  if exists(select 1 from jsonb_array_elements(p_validation->'checks') c where (c->>'blocking')::boolean or c->>'status'='blocked') then
    return jsonb_build_object('reason','blocking_check'); end if;
  -- Admission binds the persisted evidence displayed for this exact revision. It never
  -- substitutes newer evidence, so an expired confirmation cannot be refreshed here.
  if p_validation is distinct from d.validation then return jsonb_build_object('reason','freshness_not_current'); end if;
  if (d.plan->>'expiresAt')::timestamptz<=v_now or (d.validation->>'checkedAt')::timestamptz>v_now
    or (p_validation->>'checkedAt')::timestamptz>v_now or (p_validation->>'checkedAt')::timestamptz<v_now-interval '5 minutes'
    or jsonb_array_length(p_validation->'checks')<>(select count(distinct c->>'id') from jsonb_array_elements(p_validation->'checks') c)
    or exists(select 1 from jsonb_array_elements(p_validation->'checks') c where c->>'status' not in ('passed','not_measured')
      or (c->>'status'='not_measured' and c->>'id' not in ('stock','buy-box','suppression','moderation')))
    or (select array_agg(c->>'id' order by c->>'id') from jsonb_array_elements(p_validation->'checks') c) is distinct from
      array['budget','buy-box','capability','count','exposure','moderation','naming','permission','product','stock','suppression','unique-name']::text[] then
    return jsonb_build_object('reason','freshness_not_current'); end if;
  -- Lock authority heads until the admission commits; no new authorization is manufactured.
  perform 1 from public.sp_write_environment_gate_head for share;
  perform 1 from public.sp_write_profile_grant_heads where org_id=d.org_id and profile_id=d.profile_id for update;
  perform 1 from public.ad_profiles p join public.ads_connections c on c.id=p.connection_id and c.org_id=p.org_id
    where p.org_id=d.org_id and p.id=d.profile_id for share of p,c;
  v_gate:=app.campaign_creation_gate(d.org_id,d.profile_id,d.plan->'providerScope');
  if v_gate->>'reason' is not null then return v_gate; end if;
  if exists(select 1 from jsonb_array_elements(d.plan->'nodes') n where n->>'effect'='irreversible_create'
    and (n->'payload'->>'state'<>'paused' or n->>'rollback'<>'none')) then return jsonb_build_object('reason','blocking_check'); end if;
  select jsonb_agg(jsonb_build_object('nodeId',n->>'nodeId','providerEntityId',n->'payload'->>'asin',
    'observedAt',app.sp_write_instant(evidence.synced_at)) order by ordinal) into v_checks
    from jsonb_array_elements(d.plan->'nodes') with ordinality x(n,ordinal)
      join lateral (select a.synced_at from public.product_ads a
        where a.org_id=d.org_id and a.profile_id=d.profile_id and a.asin=n->'payload'->>'asin'
          and a.sku is not distinct from n->'payload'->>'sku' and a.deleted_at is null and a.state<>'archived'
          and a.synced_at is not null and a.synced_at<=v_now order by a.synced_at desc limit 1) evidence on true
      where n->>'effect'='read_check' and n->>'kind'='eligibility.require_product';
  if jsonb_array_length(coalesce(v_checks,'[]'))<>(d.plan->'counts'->>'readChecks')::int then return jsonb_build_object('reason','freshness_not_current'); end if;
  if p_request->>'action'='retry' then
    select * into parent from public.campaign_creation_batches where org_id=d.org_id and profile_id=d.profile_id
      and id=(p_request->>'parentBatchId')::uuid and draft_id=d.id and artifact->'plan'->>'fingerprint'=d.plan->>'fingerprint' for share;
    if not found then return jsonb_build_object('reason','retry_not_allowed'); end if;
    select jsonb_agg(n.node_id::text order by n.ordinal) into v_ids from public.campaign_creation_batch_nodes n
      join lateral (select value from jsonb_array_elements(d.plan->'nodes') where value->>'nodeId'=n.node_id::text) p on true
      where n.batch_id=parent.id and (n.observation->>'observation'='uncertain'
        or (n.intent is null and n.refusal='dependency_failed')
        or (n.result->>'outcome'='authoritative_rejected' and p.value->>'kind'='target.create' and p.value->'payload'->>'targetType'='keyword'));
    if v_ids is null or v_ids is distinct from p_request->'nodeIds' or exists(select 1 from public.campaign_creation_batch_nodes n
      where n.batch_id=parent.id and not (v_ids ? n.node_id::text) and coalesce(n.observation->>'observation','')<>'observed') then
      return jsonb_build_object('reason','retry_not_allowed'); end if;
    select coalesce(jsonb_agg(jsonb_build_object('batchId',parent.id,'nodeId',n.node_id,'nodeFingerprint',n.node_fingerprint,
      'providerEntityId',n.observation->>'providerEntityId','requestDigest',n.observation->>'requestDigest',
      'observedAt',n.observation->>'observedAt') order by n.ordinal),'[]'::jsonb) into v_inherited
      from public.campaign_creation_batch_nodes n where n.batch_id=parent.id and n.observation->>'observation'='observed';
    v_inherited:=coalesce(parent.artifact->'lineage'->'inheritedResources','[]'::jsonb)||v_inherited;
    v_lineage:=jsonb_build_object('parentBatchId',parent.id,'planFingerprint',d.plan->>'fingerprint','nodeIds',v_ids,'inheritedResources',v_inherited);
    -- Transferred work is owned only by this child; late evidence cannot reopen parent dispatch.
    update public.campaign_creation_outbox set completed_at=v_now,lease_until=null,lease_id=null,claimant_id=null where batch_id=parent.id;
  else
    if exists(select 1 from jsonb_array_elements(d.plan->'nodes') n join public.campaigns c on c.org_id=d.org_id
      and c.profile_id=d.profile_id and c.name=n->'payload'->>'name' where n->>'kind'='campaign.create') then
      return jsonb_build_object('reason','blocking_check'); end if;
    if exists(select 1 from public.campaign_creation_batches previous,
      lateral jsonb_array_elements(previous.artifact->'plan'->'nodes') old_node,
      lateral jsonb_array_elements(d.plan->'nodes') new_node
      where previous.org_id=d.org_id and previous.profile_id=d.profile_id and previous.parent_batch_id is null
        and old_node->>'kind'='campaign.create' and new_node->>'kind'='campaign.create'
        and old_node->'payload'->>'name'=new_node->'payload'->>'name') then
      return jsonb_build_object('reason','blocking_check'); end if;
  end if;
  select jsonb_agg(jsonb_build_object('nodeId',n->>'nodeId','nodeFingerprint',n->>'fingerprint',
    'intent',null,'result',null,'observation',null,'refusal',null) order by ordinal),count(*) into v_nodes,v_count
    from jsonb_array_elements(d.plan->'nodes') with ordinality x(n,ordinal)
    where n->>'effect'='irreversible_create' and (v_ids is null or v_ids ? (n->>'nodeId'));
  insert into public.campaign_creation_batches(id,org_id,profile_id,draft_id,actor_id,parent_batch_id,admission_key,artifact,node_count)
    values(v_id,d.org_id,d.profile_id,d.id,auth.uid(),parent.id,v_key,jsonb_build_object('id',v_id,'draftId',d.id,
      'draftRevision',d.revision,'actorId',auth.uid(),'plan',d.plan,'admittedAt',app.sp_write_instant(v_now),
      'expiresAt',app.sp_write_instant(least((d.plan->>'expiresAt')::timestamptz,(p_validation->>'checkedAt')::timestamptz+interval '5 minutes')),'environmentGateVersion',v_gate->>'environmentGateVersion',
      'profileGrantVersion',v_gate->>'profileGrantVersion','lineage',v_lineage,'productChecks',v_checks,'validation',p_validation),v_count);
  insert into public.campaign_creation_batch_nodes(org_id,profile_id,batch_id,node_id,ordinal,node_fingerprint)
    select d.org_id,d.profile_id,v_id,(n->>'nodeId')::uuid,ordinal-1,n->>'nodeFingerprint'
      from jsonb_array_elements(v_nodes) with ordinality x(n,ordinal);
  get diagnostics v_count=row_count;
  if v_count<>jsonb_array_length(v_nodes) then raise exception 'Creation node count mismatch'; end if;
  insert into public.campaign_creation_outbox(batch_id) values(v_id);
  update public.campaign_drafts set status='approved' where id=d.id;
  return jsonb_build_object('batchId',v_id,'replayed',false);
end;
$$;
revoke all on function app.admit_campaign_creation(uuid,jsonb,jsonb) from public,anon;
grant execute on function app.admit_campaign_creation(uuid,jsonb,jsonb) to authenticated;

/** Record fresh evidence on an approved draft before a separate retry or recovery confirmation is
 * shown. The revision advances so admission binds exactly this evidence. Nothing is queued. */
create function app.record_campaign_creation_review(p_org uuid,p_request jsonb,p_validation jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare d public.campaign_drafts%rowtype; v_now timestamptz:=clock_timestamp();
begin
  if auth.uid() is null or not app.has_org_role(p_org,array['owner','admin']) then
    return jsonb_build_object('reason','authorization_refused');
  end if;
  perform 1 from public.org_members where org_id=p_org and user_id=auth.uid() and role in ('owner','admin') for share;
  select * into d from public.campaign_drafts where org_id=p_org and profile_id=(p_request->>'profileId')::uuid
    and id=(p_request->>'draftId')::uuid and created_by=auth.uid() for update;
  if not found then return jsonb_build_object('reason','not_found'); end if;
  if d.plan->>'fingerprint' is distinct from p_request->>'planFingerprint' then return jsonb_build_object('reason','stale_fingerprint'); end if;
  if d.revision is distinct from (p_request->>'expectedRevision')::integer then return jsonb_build_object('reason','stale_revision'); end if;
  if d.status<>'approved' or d.validation is null then return jsonb_build_object('reason','draft_not_validated'); end if;
  if not exists(select 1 from public.campaign_creation_batches b where b.org_id=d.org_id and b.profile_id=d.profile_id
    and b.id=(p_request->>'parentBatchId')::uuid and b.draft_id=d.id and b.artifact->'plan'->>'fingerprint'=d.plan->>'fingerprint') then
    return jsonb_build_object('reason','retry_not_allowed');
  end if;
  if p_validation is null or jsonb_typeof(p_validation)<>'object' or jsonb_typeof(p_validation->'checks')<>'array'
    or p_validation->>'planFingerprint' is distinct from d.plan->>'fingerprint'
    or p_validation->>'recipeFingerprint' is distinct from d.validation->>'recipeFingerprint' then
    return jsonb_build_object('reason','draft_not_validated');
  end if;
  -- Only evidence checked in this request may be displayed as current (a few seconds of web/database clock skew allowed).
  if (p_validation->>'checkedAt')::timestamptz>v_now+interval '5 seconds' or (p_validation->>'checkedAt')::timestamptz<v_now-interval '1 minute' then
    return jsonb_build_object('reason','freshness_not_current');
  end if;
  update public.campaign_drafts set validation=p_validation,revision=revision+1 where id=d.id and org_id=d.org_id;
  return jsonb_build_object('revision',d.revision+1);
end;
$$;
revoke all on function app.record_campaign_creation_review(uuid,jsonb,jsonb) from public,anon;
grant execute on function app.record_campaign_creation_review(uuid,jsonb,jsonb) to authenticated;

/** Custody may be retried; the durable provider intent may not. */
create function app.claim_campaign_creation(p_claimant uuid,p_profiles uuid[])
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_batch uuid; v_lease uuid:=gen_random_uuid();
begin
  perform app.assert_service_role('claim_campaign_creation');
  select o.batch_id into v_batch from public.campaign_creation_outbox o join public.campaign_creation_batches b on b.id=o.batch_id
    where o.completed_at is null and o.available_at<=clock_timestamp() and (o.lease_until is null or o.lease_until<=clock_timestamp())
      and b.profile_id=any(p_profiles) order by o.available_at,b.admitted_at,o.batch_id for update of o skip locked limit 1;
  if v_batch is null then return null; end if;
  update public.campaign_creation_outbox set claimant_id=p_claimant,lease_id=v_lease,lease_until=clock_timestamp()+interval '120 seconds' where batch_id=v_batch;
  return jsonb_build_object('batchId',v_batch,'leaseId',v_lease);
end;
$$;

create function app.reserve_campaign_creation(p_batch uuid,p_lease uuid,p_node uuid,p_intent jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare b public.campaign_creation_batches%rowtype; n public.campaign_creation_batch_nodes%rowtype;
  v_gate jsonb; v_now timestamptz:=clock_timestamp(); v_artifact jsonb; v_parent jsonb;
begin
  perform app.assert_service_role('reserve_campaign_creation');
  -- The parent lock serializes reservation against an organization purge.
  perform 1 from public.orgs o join public.campaign_creation_batches frozen on frozen.org_id=o.id
    where frozen.id=p_batch for key share of o;
  if not found then return jsonb_build_object('kind','stale'); end if;
  perform 1 from public.campaign_creation_outbox where batch_id=p_batch and lease_id=p_lease and lease_until>v_now for update;
  if not found then return jsonb_build_object('kind','stale'); end if;
  select * into b from public.campaign_creation_batches where id=p_batch;
  select * into n from public.campaign_creation_batch_nodes where batch_id=p_batch and node_id=p_node for update;
  if not found then raise exception 'Creation node unavailable'; end if;
  if n.intent is not null then return jsonb_build_object('kind','already_reserved'); end if;
  if n.refusal is not null then return jsonb_build_object('kind','refused'); end if;
  if n.observation->>'observation' in ('observed','conflict','uncertain','ambiguous_readback') then return jsonb_build_object('kind','refused'); end if;
  if b.parent_batch_id is not null and (n.observation is null or n.observation->>'mode'<>'identity'
    or n.observation->>'observation'<>'not_found' or (n.observation->>'complete')::boolean is not true
    or n.observation->>'requestDigest' is distinct from p_intent->>'requestDigest'
    or (n.observation->>'observedAt')::timestamptz<v_now-interval '30 seconds'
    or (n.observation->>'startedAt')::timestamptz<b.admitted_at) then return jsonb_build_object('kind','pending'); end if;
  if exists(select 1 from public.campaign_creation_batch_nodes prev where prev.batch_id=p_batch and prev.ordinal<n.ordinal
    and coalesce(prev.observation->>'observation','')<>'observed' and coalesce(prev.result->>'outcome','')<>'authoritative_rejected'
    and prev.refusal is null) then return jsonb_build_object('kind','pending'); end if;
  select value into v_artifact from jsonb_array_elements(b.artifact->'plan'->'nodes') where value->>'nodeId'=p_node::text;
  if exists(select 1 from jsonb_array_elements_text(v_artifact->'dependsOn') dep
    join public.campaign_creation_batch_nodes parent on parent.batch_id=p_batch and parent.node_id::text=dep.value
    where parent.result->>'outcome'='authoritative_rejected' or parent.refusal is not null or parent.observation->>'observation'='conflict') then
    update public.campaign_creation_batch_nodes set refusal='dependency_failed' where batch_id=p_batch and node_id=p_node;
    return jsonb_build_object('kind','refused');
  end if;
  perform 1 from public.sp_write_environment_gate_head for update;
  perform 1 from public.sp_write_profile_grant_heads where org_id=b.org_id and profile_id=b.profile_id for share;
  perform 1 from public.ad_profiles p join public.ads_connections c on c.id=p.connection_id and c.org_id=p.org_id
    where p.org_id=b.org_id and p.id=b.profile_id for share of p,c;
  perform 1 from public.org_members where org_id=b.org_id and user_id=b.actor_id and role in ('owner','admin') for share;
  if not found then v_gate:=jsonb_build_object('reason','authorization_refused');
  else v_gate:=app.campaign_creation_gate(b.org_id,b.profile_id,b.artifact->'plan'->'providerScope'); end if;
  if v_gate->>'reason' is not null or v_gate->>'environmentGateVersion' is distinct from b.artifact->>'environmentGateVersion'
    or v_gate->>'profileGrantVersion' is distinct from b.artifact->>'profileGrantVersion' or v_now>=(b.artifact->>'expiresAt')::timestamptz then
    update public.campaign_creation_batch_nodes set refusal=case when v_now>=(b.artifact->>'expiresAt')::timestamptz then 'expired' else 'gate_closed' end
      where batch_id=p_batch and intent is null and refusal is null and coalesce(observation->>'observation','')<>'observed';
    return jsonb_build_object('kind','refused');
  end if;
  -- Recheck the selected product identity at reservation, including after a delayed claim.
  if exists(select 1 from jsonb_array_elements(b.artifact->'plan'->'nodes') product
    where product->>'kind'='eligibility.require_product' and not exists(select 1 from public.product_ads a
      where a.org_id=b.org_id and a.profile_id=b.profile_id and a.asin=product->'payload'->>'asin'
        and a.sku is not distinct from product->'payload'->>'sku' and a.deleted_at is null
        and a.state<>'archived' and a.synced_at is not null and a.synced_at<=v_now)) then
    update public.campaign_creation_batch_nodes set refusal='dependency_failed'
      where batch_id=p_batch and intent is null and refusal is null and coalesce(observation->>'observation','')<>'observed';
    return jsonb_build_object('kind','refused');
  end if;
  -- Share the environment's one unresolved-call capacity with the existing writer.
  if exists(select 1 from public.campaign_creation_batch_nodes active where active.intent is not null
      and coalesce(active.result->>'outcome','')<>'authoritative_rejected'
      and coalesce(active.observation->>'observation','') not in ('observed','conflict','uncertain','ambiguous_readback'))
    or exists(select 1 from public.sp_write_provider_call_intents i
      left join public.sp_write_provider_results r on r.intent_id=i.intent_id where r.intent_id is null) then
    return jsonb_build_object('kind','pending');
  end if;
  -- A retry or later node must still agree with the latest synchronized parents.
  -- This read-only mode never reconstructs a missing mirror from old evidence.
  for v_parent in
    select jsonb_build_object('nodeId',prior.node_id,'providerEntityId',prior.observation->>'providerEntityId',
      'observedAt',prior.observation->>'observedAt') from public.campaign_creation_batch_nodes prior
      where prior.batch_id=p_batch and prior.observation->>'observation'='observed'
    union all select value from jsonb_array_elements(coalesce(b.artifact->'lineage'->'inheritedResources','[]'::jsonb))
  loop
    if app.mirror_campaign_creation(p_batch,(v_parent->>'nodeId')::uuid,v_parent,false)<>'observed' then
      update public.campaign_creation_batch_nodes set refusal='dependency_failed'
        where batch_id=p_batch and intent is null and refusal is null and coalesce(observation->>'observation','')<>'observed';
      return jsonb_build_object('kind','refused');
    end if;
  end loop;
  if p_intent->>'requestDigest' !~ '^[a-f0-9]{64}$' or p_intent->>'nodeRequestDigest' !~ '^[a-f0-9]{64}$'
    or (p_intent->>'id')::uuid is null then raise exception 'Invalid creation intent'; end if;
  p_intent:=p_intent||jsonb_build_object('reservedAt',app.sp_write_instant(v_now),'deadline',app.sp_write_instant(least(v_now+interval '35 seconds',(b.artifact->>'expiresAt')::timestamptz)));
  if b.parent_batch_id is not null then
    p_intent:=p_intent||jsonb_build_object('preflightObservationId',n.observation->>'id','deadline',
      app.sp_write_instant(least((p_intent->>'deadline')::timestamptz,(n.observation->>'observedAt')::timestamptz+interval '30 seconds')));
  end if;
  update public.campaign_creation_batch_nodes set intent=p_intent where batch_id=p_batch and node_id=p_node;
  return jsonb_build_object('kind','dispatch_once','intent',p_intent);
end;
$$;

create function app.record_campaign_creation_result(p_batch uuid,p_node uuid,p_result jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare n public.campaign_creation_batch_nodes%rowtype; b public.campaign_creation_batches%rowtype;
begin
  perform app.assert_service_role('record_campaign_creation_result');
  select * into n from public.campaign_creation_batch_nodes where batch_id=p_batch and node_id=p_node for update;
  select * into b from public.campaign_creation_batches where id=p_batch;
  if n.intent is null or p_result->>'executionId' is distinct from p_batch::text or p_result->>'planId' is distinct from b.artifact->'plan'->>'id'
    or p_result->>'nodeId' is distinct from p_node::text or p_result->>'providerCallId' is distinct from n.intent->>'id'
    or p_result->>'nodeFingerprint' is distinct from n.node_fingerprint or p_result->>'requestDigest' is distinct from n.intent->>'requestDigest'
    or p_result->>'nodeRequestDigest' is distinct from n.intent->>'nodeRequestDigest' then raise exception 'Creation result correlation failed'; end if;
  if n.result is not null and n.result<>p_result then raise exception 'Creation result is immutable'; end if;
  update public.campaign_creation_batch_nodes set result=p_result where batch_id=p_batch and node_id=p_node and result is null;
end;
$$;

create function app.observe_campaign_creation(p_batch uuid,p_node uuid,p_observation jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare n public.campaign_creation_batch_nodes%rowtype; b public.campaign_creation_batches%rowtype;
  previous public.campaign_creation_observations%rowtype; v_raw jsonb:=p_observation; v_now timestamptz:=clock_timestamp();
begin
  perform app.assert_service_role('observe_campaign_creation');
  select * into n from public.campaign_creation_batch_nodes where batch_id=p_batch and node_id=p_node for update;
  if not found then raise exception 'Creation observation node unavailable'; end if;
  select * into b from public.campaign_creation_batches where id=p_batch;
  if (p_observation->>'id')::uuid is null or p_observation->>'identityFingerprint' !~ '^[a-f0-9]{64}$'
    or p_observation->>'requestDigest' !~ '^[a-f0-9]{64}$'
    or (n.intent is null and b.parent_batch_id is null)
    or (n.intent is not null and n.intent->>'requestDigest' is distinct from p_observation->>'requestDigest')
    or (n.result->>'outcome'='succeeded' and n.result->>'providerEntityId' is distinct from p_observation->>'providerEntityId')
    or (coalesce(n.result->>'outcome','')<>'succeeded' and p_observation->>'mode'<>'identity')
    or (p_observation->>'startedAt')::timestamptz>v_now
    or (n.intent is null and (p_observation->>'startedAt')::timestamptz<b.admitted_at)
    or (n.intent is not null and coalesce(n.result->>'outcome','')<>'succeeded'
      and (p_observation->>'startedAt')::timestamptz<(n.intent->>'deadline')::timestamptz)
    or p_observation->>'observation'='uncertain' then raise exception 'Creation observation correlation failed'; end if;
  select * into previous from public.campaign_creation_observations
    where batch_id=p_batch and node_id=p_node and artifact->>'id'=p_observation->>'id';
  if found then
    if previous.provider_artifact is distinct from v_raw then raise exception 'Creation observation replay changed'; end if;
    return;
  end if;
  p_observation:=p_observation||jsonb_build_object('observedAt',app.sp_write_instant(v_now));
  if n.intent is not null and p_observation->>'observation'='not_found'
    and (p_observation->>'complete')::boolean and (p_observation->'accounting'->>'matched')::int=0
    and exists(select 1 from public.campaign_creation_observations earlier where earlier.batch_id=p_batch and earlier.node_id=p_node
      and earlier.recorded_at<=v_now-interval '60 seconds' and earlier.artifact->>'observation'='not_found'
      and (earlier.artifact->>'complete')::boolean and (earlier.artifact->'accounting'->>'matched')::int=0
      and earlier.artifact->>'identityFingerprint'=p_observation->>'identityFingerprint'
      and (n.result->>'outcome'='succeeded' or (earlier.artifact->>'startedAt')::timestamptz>=(n.intent->>'deadline')::timestamptz)
      and earlier.artifact->>'requestDigest'=p_observation->>'requestDigest') then
    p_observation:=p_observation||jsonb_build_object('observation','uncertain','reason',
      'No resource matched the exact identity in two complete observations at least 60 seconds apart. The original create outcome remains uncertain.');
  end if;
  if coalesce(n.observation->>'observation','') not in ('observed','conflict','uncertain','ambiguous_readback')
    and p_observation->>'observation'='observed' then
    p_observation:=jsonb_set(p_observation,'{observation}',to_jsonb(app.mirror_campaign_creation(p_batch,p_node,p_observation)));
    if p_observation->>'observation'='conflict' then
      p_observation:=p_observation||jsonb_build_object('reason','The synchronized resource differs from the approved paused configuration.');
    end if;
  end if;
  insert into public.campaign_creation_observations(org_id,profile_id,batch_id,node_id,recorded_at,artifact,provider_artifact)
    values(n.org_id,n.profile_id,p_batch,p_node,v_now,p_observation,v_raw);
  -- Terminal projections never reopen dispatch. Late reads remain append-only evidence.
  if coalesce(n.observation->>'observation','') not in ('observed','conflict','uncertain','ambiguous_readback') then
    update public.campaign_creation_batch_nodes set observation=p_observation where batch_id=p_batch and node_id=p_node;
  end if;
end;
$$;

create function app.settle_campaign_creation(p_batch uuid,p_lease uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare v_count integer;
begin
  perform app.assert_service_role('settle_campaign_creation');
  if exists(select 1 from public.campaign_creation_batch_nodes n where n.batch_id=p_batch
    and n.observation->>'observation' in ('uncertain','ambiguous_readback','conflict')) then
    update public.campaign_creation_batch_nodes set refusal='dependency_failed' where batch_id=p_batch
      and intent is null and refusal is null and coalesce(observation->>'observation','')<>'observed';
  end if;
  loop
    update public.campaign_creation_batch_nodes child set refusal='dependency_failed'
      from public.campaign_creation_batches b, lateral jsonb_array_elements(b.artifact->'plan'->'nodes') node
      where b.id=p_batch and child.batch_id=b.id and node->>'nodeId'=child.node_id::text
        and child.intent is null and child.refusal is null and exists(
          select 1 from jsonb_array_elements_text(node->'dependsOn') dep
          join public.campaign_creation_batch_nodes parent on parent.batch_id=p_batch and parent.node_id::text=dep.value
          where parent.refusal is not null or parent.result->>'outcome'='authoritative_rejected' or parent.observation->>'observation'='conflict');
    get diagnostics v_count=row_count;
    exit when v_count=0;
  end loop;
  update public.campaign_creation_outbox set lease_until=null,lease_id=null,claimant_id=null,
    available_at=coalesce((select min(greatest(clock_timestamp()+interval '2 seconds',
      case when n.observation->>'observation'='not_found' and n.intent is not null
        and n.intent->>'preflightObservationId' is distinct from n.observation->>'id'
        then (n.observation->>'observedAt')::timestamptz+interval '60 seconds'
        when n.intent is not null and coalesce(n.result->>'outcome','')<>'succeeded' then (n.intent->>'deadline')::timestamptz
        else clock_timestamp() end)) from public.campaign_creation_batch_nodes n where n.batch_id=p_batch
          and n.refusal is null and coalesce(n.result->>'outcome','')<>'authoritative_rejected'
          and coalesce(n.observation->>'observation','') not in ('observed','conflict','uncertain','ambiguous_readback')),clock_timestamp()),
    completed_at=case when not exists(select 1 from public.campaign_creation_batch_nodes n where n.batch_id=p_batch
      and n.refusal is null and coalesce(n.result->>'outcome','')<>'authoritative_rejected'
      and coalesce(n.observation->>'observation','') not in ('observed','conflict','uncertain','ambiguous_readback')) then clock_timestamp() else null end
    where batch_id=p_batch and lease_id=p_lease;
end;
$$;
revoke all on function app.claim_campaign_creation(uuid,uuid[]),app.reserve_campaign_creation(uuid,uuid,uuid,jsonb),
  app.record_campaign_creation_result(uuid,uuid,jsonb),app.observe_campaign_creation(uuid,uuid,jsonb),app.settle_campaign_creation(uuid,uuid) from public,anon,authenticated;
grant execute on function app.claim_campaign_creation(uuid,uuid[]),app.reserve_campaign_creation(uuid,uuid,uuid,jsonb),
  app.record_campaign_creation_result(uuid,uuid,jsonb),app.observe_campaign_creation(uuid,uuid,jsonb),app.settle_campaign_creation(uuid,uuid) to service_role;

create function app.campaign_creation_parent_identity(p_batch uuid,p_node text)
returns text language sql stable security definer set search_path=pg_catalog,public,app,pg_temp as $$
  select identity from (
    select n.observation->>'providerEntityId' as identity from public.campaign_creation_batch_nodes n
      where n.batch_id=p_batch and n.node_id::text=p_node and n.observation->>'observation'='observed'
    union all
    select r->>'providerEntityId' from public.campaign_creation_batches b,
      lateral jsonb_array_elements(coalesce(b.artifact->'lineage'->'inheritedResources','[]'::jsonb)) r
      where b.id=p_batch and r->>'nodeId'=p_node
  ) identities;
$$;

/** Exact readback populates the grid mirror. A different existing value is a conflict, never overwritten. */
create function app.mirror_campaign_creation(p_batch uuid,p_node uuid,p_observation jsonb,p_write boolean default true)
returns text language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
declare b public.campaign_creation_batches%rowtype; node jsonb; payload jsonb; parent jsonb; product jsonb;
  v_campaign_id text; v_group_id text; entity_id text:=p_observation->>'providerEntityId'; matching boolean:=false;
  observed_at timestamptz:=(p_observation->>'observedAt')::timestamptz;
begin
  perform app.assert_service_role('mirror_campaign_creation');
  select * into b from public.campaign_creation_batches where id=p_batch;
  select value into node from jsonb_array_elements(b.artifact->'plan'->'nodes') where value->>'nodeId'=p_node::text;
  payload:=node->'payload';
  if node->>'kind'='campaign.create' then
    if p_write then
    insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type,
      targeting_type,bidding_strategy,placement_bidding,start_date,end_date,synced_at)
      values(b.org_id,b.profile_id,entity_id,'SP',payload->>'name','paused',(payload->'budget'->>'amount')::numeric,'daily',
        (payload->'settings'->>'targetingType')::public.targeting_type,(payload->'settings'->>'biddingStrategy')::public.bidding_strategy,
        payload->'settings'->'placementBidding',(payload->'schedule'->>'startDate')::date,(payload->'schedule'->>'endDate')::date,observed_at)
      on conflict(profile_id,amazon_id) do nothing;
    end if;
    select c.org_id=b.org_id and c.state='paused' and c.name=payload->>'name' and c.budget_amount=(payload->'budget'->>'amount')::numeric
      and c.deleted_at is null and c.ad_product='SP' and c.budget_type='daily'
      and c.targeting_type::text=payload->'settings'->>'targetingType'
      and c.bidding_strategy::text=payload->'settings'->>'biddingStrategy'
      and c.placement_bidding=payload->'settings'->'placementBidding'
      and c.start_date is not distinct from (payload->'schedule'->>'startDate')::date
      and c.end_date is not distinct from (payload->'schedule'->>'endDate')::date
      into matching from public.campaigns c where c.profile_id=b.profile_id and c.amazon_id=entity_id;
  elsif node->>'kind'='ad_group.create' then
    v_campaign_id:=app.campaign_creation_parent_identity(p_batch,payload->'campaign'->>'nodeId');
    if v_campaign_id is null then return 'pending'; end if;
    if p_write then
    insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,default_bid,synced_at)
      values(b.org_id,b.profile_id,entity_id,'SP',payload->>'name','paused',v_campaign_id,(payload->>'defaultBid')::numeric,observed_at)
      on conflict(profile_id,amazon_id) do nothing;
    end if;
    select g.org_id=b.org_id and g.state='paused' and g.name=payload->>'name' and g.campaign_id=v_campaign_id and g.default_bid=(payload->>'defaultBid')::numeric
      and g.deleted_at is null and g.ad_product='SP'
      into matching from public.ad_groups g where g.profile_id=b.profile_id and g.amazon_id=entity_id;
  elsif node->>'kind' in ('ad.create','target.create') then
    select value into parent from jsonb_array_elements(b.artifact->'plan'->'nodes') where value->>'nodeId'=coalesce(payload->'adGroup'->>'nodeId',payload->'parent'->>'nodeId');
    v_group_id:=app.campaign_creation_parent_identity(p_batch,parent->>'nodeId');
    v_campaign_id:=app.campaign_creation_parent_identity(p_batch,parent->'payload'->'campaign'->>'nodeId');
    if v_campaign_id is null or v_group_id is null then return 'pending'; end if;
    if node->>'kind'='ad.create' then
      select value->'payload' into product from jsonb_array_elements(b.artifact->'plan'->'nodes') where value->>'nodeId'=payload->'product'->>'nodeId';
      if p_write then
      insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin,sku,synced_at)
        values(b.org_id,b.profile_id,entity_id,'SP','paused',v_campaign_id,v_group_id,product->>'asin',product->>'sku',observed_at)
        on conflict(profile_id,amazon_id) do nothing;
      end if;
      select a.org_id=b.org_id and a.state='paused' and a.campaign_id=v_campaign_id and a.ad_group_id=v_group_id and a.asin=product->>'asin'
        and a.deleted_at is null and a.ad_product='SP'
        and a.sku is not distinct from product->>'sku' into matching from public.product_ads a where a.profile_id=b.profile_id and a.amazon_id=entity_id;
    elsif payload->>'targetType'='keyword' and payload->>'polarity'='positive' then
      if p_write then
      perform set_config('app.keyword_bid_read_started_at',app.keyword_mirror_instant(observed_at),true);
      insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at,bid_observed_at)
        values(b.org_id,b.profile_id,entity_id,'SP','paused',v_campaign_id,v_group_id,payload->>'text',(payload->>'matchType')::public.match_type,(payload->>'bid')::numeric,observed_at,observed_at)
        on conflict(profile_id,amazon_id) do nothing;
      end if;
      select k.org_id=b.org_id and k.state='paused' and k.campaign_id=v_campaign_id and k.ad_group_id=v_group_id and k.keyword_text=payload->>'text'
        and k.deleted_at is null and k.ad_product='SP'
        and k.match_type::text=payload->>'matchType' and k.bid is not distinct from (payload->>'bid')::numeric into matching
        from public.keywords k where k.profile_id=b.profile_id and k.amazon_id=entity_id;
    end if;
  end if;
  return case when matching then 'observed' else 'conflict' end;
end;
$$;
revoke all on function app.campaign_creation_parent_identity(uuid,text),app.mirror_campaign_creation(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
grant execute on function app.campaign_creation_parent_identity(uuid,text),app.mirror_campaign_creation(uuid,uuid,jsonb,boolean) to service_role;

-- The legacy writer takes the same environment-head lock before inserting its intent.
-- This additive guard keeps capacity symmetric without rewriting its execution path.
create function app.guard_creation_call_capacity()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
begin
  perform 1 from public.sp_write_environment_gate_head for update;
  if exists(select 1 from public.campaign_creation_batch_nodes n where n.intent is not null
    and coalesce(n.result->>'outcome','')<>'authoritative_rejected'
    and coalesce(n.observation->>'observation','') not in ('observed','conflict','uncertain','ambiguous_readback')) then
    raise exception 'Campaign creation has an unresolved provider call' using errcode='55000';
  end if;
  return new;
end;
$$;
create trigger sp_write_creation_capacity before insert on public.sp_write_provider_call_intents
  for each row execute function app.guard_creation_call_capacity();

create function app.guard_creation_purge()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,app,pg_temp as $$
begin
  if exists(select 1 from public.campaign_creation_batch_nodes n where n.org_id=old.id and n.intent is not null
    and coalesce(n.result->>'outcome','')<>'authoritative_rejected'
    and coalesce(n.observation->>'observation','') not in ('observed','conflict')) then
    raise exception 'Organization has unresolved campaign creation' using errcode='55000';
  end if;
  return old;
end;
$$;
create trigger orgs_block_unresolved_creation_purge before delete on public.orgs
  for each row execute function app.guard_creation_purge();
revoke all on function app.guard_creation_call_capacity(),app.guard_creation_purge() from public,anon,authenticated,service_role;

/** Additive queue projection; provider attempts and adopted resources remain separate facts. */
create function app.campaign_creation_batch_state(p_batch uuid)
returns text language sql stable set search_path=pg_catalog,public,app,pg_temp as $$
  with counts as (select count(*) as total,
    count(*) filter(where intent is not null) as attempted,
    count(*) filter(where result->>'outcome'='succeeded' or observation->>'observation'='observed') as succeeded,
    count(*) filter(where result->>'outcome'='authoritative_rejected') as failed,
    count(*) filter(where observation->>'observation'='observed') as observed,
    count(*) filter(where refusal in ('gate_closed','expired')) as refused,
    count(*) filter(where observation->>'observation' in ('uncertain','ambiguous_readback','conflict')) as attention,
    count(*) filter(where intent is null and refusal is null and coalesce(observation->>'observation','') not in ('observed','uncertain','ambiguous_readback','conflict')) as pending,
    count(*) filter(where intent is not null and coalesce(result->>'outcome','')<>'authoritative_rejected'
      and coalesce(observation->>'observation','') not in ('observed','uncertain','ambiguous_readback','conflict')) as unresolved
    from public.campaign_creation_batch_nodes where batch_id=p_batch)
  select case when pending=0 and unresolved=0 and attention>0 then 'needs_attention'
    when attempted=0 and pending=total then 'admitted' when pending>0 then 'attempted'
    when unresolved>0 then case when succeeded=total then 'succeeded' else 'awaiting_observation' end
    when observed=total then 'observed' when succeeded>0 then 'partial_failed'
    when failed>0 then 'failed' when refused>0 then 'refused' else 'blocked' end from counts;
$$;
revoke all on function app.campaign_creation_batch_state(uuid) from public,anon;
grant execute on function app.campaign_creation_batch_state(uuid) to authenticated,service_role;
