set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- WP-250: named views belong to an agency; profile NULL means reusable across profiles.
create table public.grid_views (
  org_id uuid not null references public.orgs(id) on delete cascade,
  id text not null,
  profile_id uuid,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  view jsonb not null check (jsonb_typeof(view) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, id),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id, id) on delete cascade
);
select app.install_tenant_rls('public.grid_views', array['owner', 'admin', 'analyst']);
-- Restrictive policies combine with tenant/editor policies installed above.
create policy grid_views_owner_insert on public.grid_views as restrictive for insert
  to authenticated with check (owner_id = auth.uid());
create policy grid_views_owner_update on public.grid_views as restrictive for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy grid_views_owner_delete on public.grid_views as restrictive for delete
  to authenticated using (owner_id = auth.uid());
create trigger grid_views_updated_at before update on public.grid_views
  for each row execute function app.touch_updated_at();

-- WP-257, packages/db/scripts/measure-read-path.REPORT.md: authenticated latest
-- bid-series DISTINCT ON sorted 180,001 rows with an external-merge sort.
create index bid_series_daily_org_profile_target_latest on public.bid_series_daily
  (org_id, profile_id, target_id, date desc, loaded_at desc);
