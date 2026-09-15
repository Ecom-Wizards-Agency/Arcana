-- A competitor link may reference only a profile in its own organization.
-- Preserve nullable profile scope and existing cascade behavior. Invalid legacy
-- rows refuse the migration atomically; no tenant data is silently repaired.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.competitor_links
  add constraint competitor_links_org_profile_fkey
  foreign key (org_id, profile_id)
  references public.ad_profiles (org_id, id)
  on delete cascade;
