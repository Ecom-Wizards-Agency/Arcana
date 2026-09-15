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
