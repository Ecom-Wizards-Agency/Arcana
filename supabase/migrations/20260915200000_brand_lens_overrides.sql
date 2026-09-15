set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
create table public.brand_lens_overrides (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, normalized_keyword text not null check(length(btrim(normalized_keyword))>0),
  bucket text not null check(bucket in ('branded','competitor','generic')),
  decision text not null check(decision in ('kept','confirmed','changed')),
  decided_by uuid not null references auth.users(id), decided_at timestamptz not null default now(),
  primary key(org_id,profile_id,normalized_keyword),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
alter table public.brand_lens_overrides enable row level security;
create policy tenant_read on public.brand_lens_overrides for select to authenticated using(app.is_org_member(org_id));
create policy editor_insert on public.brand_lens_overrides for insert to authenticated with check(app.has_org_role(org_id,array['owner','admin','analyst']) and decided_by=auth.uid());
create policy editor_update on public.brand_lens_overrides for update to authenticated using(app.has_org_role(org_id,array['owner','admin','analyst'])) with check(app.has_org_role(org_id,array['owner','admin','analyst']) and decided_by=auth.uid());
create policy editor_delete on public.brand_lens_overrides for delete to authenticated using(app.has_org_role(org_id,array['owner','admin','analyst']));
revoke all on public.brand_lens_overrides from anon;
grant select,insert,update,delete on public.brand_lens_overrides to authenticated;
grant all on public.brand_lens_overrides to service_role;
