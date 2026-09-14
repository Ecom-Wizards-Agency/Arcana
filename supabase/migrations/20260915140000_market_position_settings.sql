-- Profile-local display preference; no Amazon writes or delivery cadence.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
create table public.market_position_settings (
  profile_id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  threshold_percent double precision not null default 15,
  updated_at timestamptz not null default now(),
  constraint market_position_settings_threshold_check check (threshold_percent >= 0 and threshold_percent <= 100),
  constraint market_position_settings_org_profile_fkey foreign key (org_id, profile_id)
    references public.ad_profiles(org_id, id) on delete cascade
);
select app.install_tenant_rls('public.market_position_settings', array['owner', 'admin', 'analyst']);
