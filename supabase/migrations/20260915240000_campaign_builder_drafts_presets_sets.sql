set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table public.campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','validated','blocked','approved')),
  revision integer not null default 1 check (revision > 0),
  plan jsonb not null,
  recipe jsonb not null,
  rationale jsonb not null check (jsonb_typeof(rationale) = 'array'),
  validation jsonb,
  updated_at timestamptz not null default now(),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check (plan->>'orgId' = org_id::text and plan->>'profileId' = profile_id::text),
  check ((status = 'draft') = (validation is null)),
  check (validation is null or validation->>'planFingerprint' = plan->>'fingerprint')
);
select app.install_tenant_rls('public.campaign_drafts', array['owner','admin','analyst']);
create policy campaign_drafts_actor on public.campaign_drafts as restrictive for all to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid() and status <> 'approved');
create index campaign_drafts_actor_profile on public.campaign_drafts(org_id,created_by,profile_id,updated_at desc);
create trigger campaign_drafts_updated_at before update on public.campaign_drafts for each row execute function app.touch_updated_at();

create table public.naming_presets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  naming jsonb not null check (jsonb_typeof(naming) = 'object'),
  created_by uuid not null references auth.users(id),
  unique (org_id,name)
);
select app.install_tenant_rls('public.naming_presets', array['owner','admin','analyst']);
create policy naming_presets_creator on public.naming_presets as restrictive for insert to authenticated with check (created_by = auth.uid());

create table public.keyword_sets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  keywords jsonb not null check (jsonb_typeof(keywords) = 'array' and jsonb_array_length(keywords) > 0),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  unique (org_id,profile_id,name)
);
select app.install_tenant_rls('public.keyword_sets', array['owner','admin','analyst']);
