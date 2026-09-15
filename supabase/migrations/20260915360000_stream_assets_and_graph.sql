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
  reason text, primary key(org_id,profile_id,identity),
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
