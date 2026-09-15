set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- A header distinguishes a successful empty refresh from a library never read.
create table public.asset_library_snapshots (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  observed_at timestamptz not null,
  source_rows integer not null check (source_rows >= 0),
  persisted_rows integer not null check (persisted_rows = source_rows),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  unique(org_id,profile_id,id)
);
select app.install_tenant_rls('public.asset_library_snapshots');
create index asset_library_snapshots_latest on public.asset_library_snapshots(org_id,profile_id,observed_at desc,id);
create table public.asset_library_assets (
  org_id uuid not null,
  profile_id uuid not null,
  snapshot_id uuid not null,
  amazon_asset_id text not null,
  version text not null,
  kind text not null,
  name text,
  duration_seconds numeric,
  thumbnail_url text,
  thumbnail_expires_at timestamptz,
  used_in_campaign_ids text[] not null,
  observation jsonb not null,
  observed_at timestamptz not null,
  primary key(org_id,profile_id,snapshot_id,amazon_asset_id,version),
  foreign key(org_id,profile_id,snapshot_id) references public.asset_library_snapshots(org_id,profile_id,id) on delete cascade,
  check(duration_seconds is null or duration_seconds >= 0)
);
select app.install_tenant_rls('public.asset_library_assets');

alter type public.sync_job_type add value if not exists 'asset-library.search';

-- Refresh admits only a read job. The profile lock serializes concurrent clicks.
create function app.request_asset_library_refresh(p_org uuid, p_profile uuid)
returns table(job_id uuid, enqueued integer, already_queued integer)
language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare v_job uuid;
begin
  perform app.lock_org_editor(p_org);
  perform 1 from public.ad_profiles where org_id=p_org and id=p_profile for update;
  if not found then raise exception 'Resource not found' using errcode='42501'; end if;
  select id into v_job from public.sync_jobs where org_id=p_org and profile_id=p_profile
    and job_type::text='asset-library.search' and status in ('queued','running') order by created_at limit 1;
  if v_job is not null then return query select v_job,0,1; return; end if;
  insert into public.sync_jobs(org_id,profile_id,job_type,payload)
    values(p_org,p_profile,'asset-library.search',jsonb_build_object('type','asset-library.search','orgId',p_org,'profileId',p_profile)) returning id into v_job;
  return query select v_job,1,0;
end $$;
revoke all on function app.request_asset_library_refresh(uuid,uuid) from public,anon;
grant execute on function app.request_asset_library_refresh(uuid,uuid) to authenticated;
