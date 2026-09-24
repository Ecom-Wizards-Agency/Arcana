set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
create table public.own_listing_observations (
  id text primary key, org_id uuid not null, profile_id uuid not null, marketplace text not null,
  asin text not null, field text not null, observed_at timestamptz not null, collected_at timestamptz not null,
  observation jsonb not null,
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(observed_at<=collected_at), check(jsonb_typeof(observation)='object')
);
create index own_listing_scope on public.own_listing_observations(org_id,profile_id,asin,field,observed_at);
create table public.own_listing_changes (
  id text primary key references public.own_listing_observations(id) on delete cascade,
  org_id uuid not null, profile_id uuid not null, marketplace text not null, asin text not null,
  observed_at timestamptz not null, change jsonb not null,
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(jsonb_typeof(change)='object')
);
create index own_listing_change_scope on public.own_listing_changes(org_id,profile_id,observed_at);
create table public.collector_export_references (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, profile_id uuid not null,
  marketplace text not null, family text not null check(family in ('listing','prompts')),
  enabled boolean not null default false, object_key text not null,
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  unique(org_id,profile_id,id), unique(profile_id,family,object_key)
);
create table public.collector_import_receipts (
  id text primary key, org_id uuid not null, profile_id uuid not null, marketplace text not null,
  reference_id uuid not null, fingerprint text not null check(fingerprint ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz not null, collected_at timestamptz not null, receipt jsonb not null,
  foreign key(org_id,profile_id,reference_id) references public.collector_export_references(org_id,profile_id,id) on delete cascade,
  unique(reference_id,fingerprint), check(observed_at<=collected_at)
);
select app.install_tenant_rls('public.own_listing_observations');
select app.install_tenant_rls('public.own_listing_changes');
select app.install_tenant_rls('public.collector_export_references');
select app.install_tenant_rls('public.collector_import_receipts');
revoke insert,update,delete on public.own_listing_observations,public.own_listing_changes,public.collector_export_references,public.collector_import_receipts from authenticated;
create trigger own_listing_guard before insert or update or delete on public.own_listing_observations for each row execute function app.guard_own_collector_observation();
create trigger own_listing_change_guard before insert or update or delete on public.own_listing_changes for each row execute function app.guard_own_collector_observation();
create trigger collector_receipt_guard before insert or update or delete on public.collector_import_receipts for each row execute function app.guard_own_collector_observation();

create trigger own_listing_no_truncate before truncate on public.own_listing_observations for each statement execute function app.guard_own_collector_observation();
create trigger own_listing_change_no_truncate before truncate on public.own_listing_changes for each statement execute function app.guard_own_collector_observation();
create trigger collector_receipt_no_truncate before truncate on public.collector_import_receipts for each statement execute function app.guard_own_collector_observation();
