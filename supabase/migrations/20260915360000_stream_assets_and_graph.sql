set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- WP-313: inert evidence stores. No subscriptions, source enablement or schedules.
alter type public.sync_job_type add value if not exists 'marketing_stream.extensions.project';

create table public.marketing_stream_extension_bindings (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, dataset_id text not null, subscription_id text not null,
  destination_arn text not null, enabled boolean not null default false,
  confirmed boolean not null default false, capability_verified boolean not null default false,
  binding jsonb not null, primary key(profile_id,dataset_id,subscription_id),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(dataset_id in ('sponsored-ads-campaign-diagnostics-recommendations','sp-budget-recommendations',
    'ads-campaign-management-campaigns','ads-campaign-management-adgroups','ads-campaign-management-ads',
    'ads-campaign-management-targets','sb-clickstream','sb-rich-media'))
);
-- Infrastructure receipt: unmatched deliveries have no inferred tenant and no browser grant.
create table public.marketing_stream_extension_receipts (
  delivery_id text primary key, body_fingerprint text not null, received_at timestamptz not null,
  receipt jsonb not null, dead_lettered_at timestamptz,
  expires_at timestamptz not null,
  check(expires_at > received_at and expires_at <= received_at + interval '95 days')
);
create index marketing_stream_extension_receipts_retention on public.marketing_stream_extension_receipts(expires_at);
create table public.marketing_stream_extension_events (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, identity text not null, dataset_id text not null,
  entity_key text not null, event_time timestamptz not null, revision bigint not null check(revision>=0),
  payload_fingerprint text not null, event jsonb not null, received_at timestamptz not null,
  expires_at timestamptz not null, primary key(org_id,profile_id,identity),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(expires_at > received_at and expires_at <= received_at + interval '95 days')
);
create index marketing_stream_extension_events_current on public.marketing_stream_extension_events(org_id,profile_id,dataset_id,entity_key,event_time desc,revision desc);
create index marketing_stream_extension_events_retention on public.marketing_stream_extension_events(expires_at);
create table public.marketing_stream_extension_projections (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, identity text not null, status text not null default 'pending',
  attempts integer not null default 0 check(attempts between 0 and 8), retry_after timestamptz,
  reason text, last_attempt_key text, primary key(org_id,profile_id,identity),
  foreign key(org_id,profile_id,identity) references public.marketing_stream_extension_events(org_id,profile_id,identity) on delete cascade,
  check(status in ('pending','projected','blocked','retrying'))
);
create index marketing_stream_extension_projection_retry on public.marketing_stream_extension_projections(status,retry_after);

create table public.asset_library_versions (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  asset_id text not null, version text not null, fingerprint text not null,
  observation jsonb not null, observed_at timestamptz not null,
  primary key(org_id,profile_id,asset_id,version),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
create table public.asset_library_observations (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  identity text not null, asset_id text not null, asset_version text not null, observation jsonb not null,
  observed_at timestamptz not null, expires_at timestamptz not null,
  primary key(org_id,profile_id,identity),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key(org_id,profile_id,asset_id,asset_version) references public.asset_library_versions(org_id,profile_id,asset_id,version) on delete cascade,
  check(expires_at > observed_at and expires_at <= observed_at + interval '95 days')
);
create index asset_library_observation_lookup on public.asset_library_observations(org_id,profile_id,asset_id,asset_version,observed_at desc);
create index asset_library_observation_retention on public.asset_library_observations(expires_at);
create table public.asset_moderation_observations (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  identity text not null, asset_id text, asset_version text, observation jsonb not null,
  observed_at timestamptz not null, expires_at timestamptz not null,
  primary key(org_id,profile_id,identity),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key(org_id,profile_id,asset_id,asset_version) references public.asset_library_versions(org_id,profile_id,asset_id,version) on delete cascade,
  check((asset_id is null) = (asset_version is null)),
  check(expires_at > observed_at and expires_at <= observed_at + interval '95 days')
);
create index asset_moderation_lookup on public.asset_moderation_observations(org_id,profile_id,asset_id,asset_version,observed_at desc);
create index asset_moderation_retention on public.asset_moderation_observations(expires_at);
create table public.provider_graph_observations (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  identity text not null, entity_key text not null, observation jsonb not null,
  source_event_at timestamptz not null, observed_at timestamptz not null, expires_at timestamptz not null,
  primary key(org_id,profile_id,identity),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(expires_at > observed_at and expires_at <= observed_at + interval '95 days')
);
create index provider_graph_current on public.provider_graph_observations(org_id,profile_id,entity_key,source_event_at desc);
create index provider_graph_retention on public.provider_graph_observations(expires_at);
create table public.provider_entity_associations (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  identity text not null, association jsonb not null, resolution text not null default 'unresolved',
  observed_at timestamptz not null, expires_at timestamptz not null,
  primary key(org_id,profile_id,identity),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(resolution in ('unresolved','resolved','tombstoned','conflict')),
  check(expires_at > observed_at and expires_at <= observed_at + interval '95 days')
);
create index provider_association_resolution on public.provider_entity_associations(org_id,profile_id,resolution);
create index provider_association_retention on public.provider_entity_associations(expires_at);

create function app.wp313_immutable_evidence() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new is distinct from old then raise exception 'Provider evidence is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function app.wp313_immutable_evidence() from public,anon,authenticated;
create trigger stream_extension_immutable before update on public.marketing_stream_extension_events for each row execute function app.wp313_immutable_evidence();
create trigger asset_version_immutable before update on public.asset_library_versions for each row execute function app.wp313_immutable_evidence();
create trigger asset_library_observation_immutable before update on public.asset_library_observations for each row execute function app.wp313_immutable_evidence();
create trigger asset_moderation_immutable before update on public.asset_moderation_observations for each row execute function app.wp313_immutable_evidence();
create trigger provider_graph_immutable before update on public.provider_graph_observations for each row execute function app.wp313_immutable_evidence();

alter table public.marketing_stream_extension_bindings enable row level security;
create policy tenant_read on public.marketing_stream_extension_bindings for select to authenticated using (app.is_org_member(org_id));
revoke all on public.marketing_stream_extension_bindings from anon,authenticated;
grant select on public.marketing_stream_extension_bindings to authenticated;
grant all on public.marketing_stream_extension_bindings to service_role;
alter table public.marketing_stream_extension_events enable row level security;
create policy tenant_read on public.marketing_stream_extension_events for select to authenticated using (app.is_org_member(org_id));
revoke all on public.marketing_stream_extension_events from anon,authenticated;
grant select on public.marketing_stream_extension_events to authenticated;
grant all on public.marketing_stream_extension_events to service_role;
alter table public.marketing_stream_extension_projections enable row level security;
create policy tenant_read on public.marketing_stream_extension_projections for select to authenticated using (app.is_org_member(org_id));
revoke all on public.marketing_stream_extension_projections from anon,authenticated;
grant select on public.marketing_stream_extension_projections to authenticated;
grant all on public.marketing_stream_extension_projections to service_role;
alter table public.asset_library_versions enable row level security;
create policy tenant_read on public.asset_library_versions for select to authenticated using (app.is_org_member(org_id));
revoke all on public.asset_library_versions from anon,authenticated;
grant select on public.asset_library_versions to authenticated;
grant all on public.asset_library_versions to service_role;
alter table public.asset_library_observations enable row level security;
create policy tenant_read on public.asset_library_observations for select to authenticated using (app.is_org_member(org_id));
revoke all on public.asset_library_observations from anon,authenticated;
grant select on public.asset_library_observations to authenticated;
grant all on public.asset_library_observations to service_role;
alter table public.asset_moderation_observations enable row level security;
create policy tenant_read on public.asset_moderation_observations for select to authenticated using (app.is_org_member(org_id));
revoke all on public.asset_moderation_observations from anon,authenticated;
grant select on public.asset_moderation_observations to authenticated;
grant all on public.asset_moderation_observations to service_role;
alter table public.provider_graph_observations enable row level security;
create policy tenant_read on public.provider_graph_observations for select to authenticated using (app.is_org_member(org_id));
revoke all on public.provider_graph_observations from anon,authenticated;
grant select on public.provider_graph_observations to authenticated;
grant all on public.provider_graph_observations to service_role;
alter table public.provider_entity_associations enable row level security;
create policy tenant_read on public.provider_entity_associations for select to authenticated using (app.is_org_member(org_id));
revoke all on public.provider_entity_associations from anon,authenticated;
grant select on public.provider_entity_associations to authenticated;
grant all on public.provider_entity_associations to service_role;
alter table public.marketing_stream_extension_receipts enable row level security;
revoke all on public.marketing_stream_extension_receipts from public,anon,authenticated;
grant all on public.marketing_stream_extension_receipts to service_role;

-- Retention is explicit and operator invoked; no automatic cadence is installed.
create function app.prune_wp313_evidence(p_before timestamptz) returns bigint language plpgsql
security definer set search_path=pg_catalog,public,app as $$
declare total bigint:=0; n bigint; t text; begin
  if p_before > now() then raise exception 'Retention cutoff cannot be in the future'; end if;
  foreach t in array array['marketing_stream_extension_receipts','marketing_stream_extension_events',
    'asset_library_observations','asset_moderation_observations','provider_graph_observations','provider_entity_associations'] loop
    execute format('delete from public.%I where expires_at <= $1',t) using p_before;
    get diagnostics n=row_count; total:=total+n;
  end loop;
  return total;
end $$;
revoke all on function app.prune_wp313_evidence(timestamptz) from public,anon,authenticated;
grant execute on function app.prune_wp313_evidence(timestamptz) to service_role;
comment on table public.asset_library_versions is 'Immutable provider versions and authenticated profile ownership. Processing and spec checks confer no moderation permission; retained while owned.';
comment on table public.provider_entity_associations is 'Partial inventories never delete absent edges. Only explicit provider tombstones retire an association. Resolution rechecks both endpoints.';

-- Asset effects have their own exact-input authority, independent of campaign writes.
create table public.asset_registration_authorities (
  id uuid primary key, org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, actor_id uuid not null references auth.users(id) on delete cascade,
  enabled boolean not null default false, request jsonb not null, expires_at timestamptz not null,
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
create table public.asset_registration_intents (
  id uuid primary key, org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, actor_id uuid not null references auth.users(id) on delete cascade,
  authority_id uuid not null unique references public.asset_registration_authorities(id),
  request jsonb not null, status text not null default 'admitted'
    check(status in ('admitted','attempting','uncertain','accepted','refused')),
  outcome jsonb, attempted_at timestamptz, observed_at timestamptz,
  search_job_id uuid unique references public.sync_jobs(id), created_at timestamptz not null default now(),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
alter table public.asset_registration_authorities enable row level security;
alter table public.asset_registration_intents enable row level security;
create policy tenant_read on public.asset_registration_intents for select to authenticated using(app.is_org_member(org_id));
revoke all on public.asset_registration_authorities,public.asset_registration_intents from public,anon,authenticated;
grant select on public.asset_registration_intents to authenticated;
grant all on public.asset_registration_authorities,public.asset_registration_intents to service_role;
create index asset_registration_reconciliation on public.asset_registration_intents(status,attempted_at);

create function app.admit_asset_registration(p_org uuid,p_request jsonb)
returns text language plpgsql security definer set search_path=pg_catalog,public,app as $$
declare a public.asset_registration_authorities; i public.asset_registration_intents; p public.ad_profiles; member_role text;
begin
  select role::text into member_role from public.org_members where org_id=p_org and user_id=auth.uid() for share;
  if member_role is null or member_role not in ('owner','admin','analyst') then return 'unauthorized_actor'; end if;
  select * into a from public.asset_registration_authorities where id=(p_request->>'authorityId')::uuid for update;
  if not found then return 'authority_missing'; end if;
  if a.org_id<>p_org or a.actor_id<>auth.uid() or a.profile_id<>(p_request->>'profileId')::uuid then return 'scope_mismatch'; end if;
  if not a.enabled then return 'disabled'; end if;
  if a.expires_at<=now() then return 'authority_expired'; end if;
  if a.request<>p_request then return 'manifest_mismatch'; end if;
  if (p_request #>> '{registration,assetType}'='VIDEO') is distinct from
     (p_request #>> '{manifest,contentType}'='video/mp4') then return 'invalid_media'; end if;
  select * into p from public.ad_profiles where org_id=p_org and id=a.profile_id for share;
  if not found or p.amazon_profile_id<>p_request #>> '{scope,amazonProfileId}' or p.region::text<>p_request #>> '{scope,region}' then return 'scope_mismatch'; end if;
  select * into i from public.asset_registration_intents where authority_id=a.id;
  if found then
    if i.request<>p_request then return 'intent_conflict'; end if;
    if i.status in ('attempting','uncertain') then return 'outcome_uncertain'; end if;
    return null;
  end if;
  if exists(select 1 from public.asset_registration_intents where id=(p_request->>'id')::uuid) then return 'intent_conflict'; end if;
  insert into public.asset_registration_intents(id,org_id,profile_id,actor_id,authority_id,request)
    values((p_request->>'id')::uuid,p_org,a.profile_id,auth.uid(),a.id,p_request);
  return null;
end $$;
revoke all on function app.admit_asset_registration(uuid,jsonb) from public,anon;
grant execute on function app.admit_asset_registration(uuid,jsonb) to authenticated;

create function app.wp313_asset_intent_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if (new.id,new.org_id,new.profile_id,new.actor_id,new.authority_id,new.request,new.created_at)
    is distinct from (old.id,old.org_id,old.profile_id,old.actor_id,old.authority_id,old.request,old.created_at)
    then raise exception 'Asset intent identity is immutable' using errcode='23514'; end if;
  if old.status in ('accepted','refused') and new is distinct from old
    then raise exception 'Asset outcome is immutable' using errcode='23514'; end if;
  return new;
end $$;
revoke all on function app.wp313_asset_intent_immutable() from public,anon,authenticated;
create trigger asset_intent_immutable before update on public.asset_registration_intents
  for each row execute function app.wp313_asset_intent_immutable();

-- Tenant counters use only receipt scope established by a verified delivery binding.
alter table public.marketing_stream_extension_receipts add column org_id uuid, add column profile_id uuid, add column dataset_id text;
alter table public.marketing_stream_extension_receipts add foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
create index stream_extension_receipt_scope on public.marketing_stream_extension_receipts(org_id,profile_id,dataset_id);
create function app.stream_extension_receipt_counts(p_org uuid,p_profile uuid)
returns table(dataset_id text,duplicates integer,rejected integer,dead_lettered integer)
language sql stable security definer set search_path=pg_catalog,public,app as $$
  select r.dataset_id,sum((r.receipt #>> '{counts,deduplicated}')::int)::int,
    sum((r.receipt #>> '{counts,rejected}')::int)::int,sum((r.receipt #>> '{counts,deadLettered}')::int)::int
  from public.marketing_stream_extension_receipts r where r.org_id=p_org and r.profile_id=p_profile
    and (app.is_org_member(p_org) or current_setting('role',true) in ('service_role','none'))
  group by r.dataset_id
$$;
revoke all on function app.stream_extension_receipt_counts(uuid,uuid) from public,anon;
grant execute on function app.stream_extension_receipt_counts(uuid,uuid) to authenticated,service_role;
-- Only service custody may read these private relations. Browser roles have no
-- relation privilege or applicable policy; the scoped function exposes aggregates.
create policy service_read on public.asset_registration_authorities for select to service_role using(true);
create policy service_read on public.marketing_stream_extension_receipts for select to service_role using(true);
