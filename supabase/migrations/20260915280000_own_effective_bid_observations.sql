set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
alter type public.sync_job_type add value if not exists 'own_bids.collect';
alter type public.sync_job_type add value if not exists 'own_listings.collect';
alter type public.sync_job_type add value if not exists 'prompts.collect';

create table public.own_effective_bid_observations (
  id text primary key,
  org_id uuid not null,
  profile_id uuid not null,
  marketplace text not null,
  target_id text not null,
  observed_at timestamptz not null,
  collected_at timestamptz not null,
  observation jsonb not null,
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check (observed_at <= collected_at),
  check (jsonb_typeof(observation)='object')
);
create index own_effective_bid_scope on public.own_effective_bid_observations(org_id,profile_id,target_id,observed_at);
select app.install_tenant_rls('public.own_effective_bid_observations');
revoke insert,update,delete on public.own_effective_bid_observations from authenticated;

create function app.guard_own_collector_observation() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op <> 'INSERT' then
    if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
    raise exception 'Collector evidence is immutable';
  end if;
  if not exists(select 1 from public.ad_profiles where org_id=new.org_id and id=new.profile_id and country_code=new.marketplace) then
    raise exception 'Collector marketplace does not match profile';
  end if;
  return new;
end $$;
revoke all on function app.guard_own_collector_observation() from public,anon,authenticated;
create trigger own_effective_bid_guard before insert or update or delete on public.own_effective_bid_observations
  for each row execute function app.guard_own_collector_observation();

create trigger own_effective_bid_no_truncate before truncate on public.own_effective_bid_observations for each statement execute function app.guard_own_collector_observation();
