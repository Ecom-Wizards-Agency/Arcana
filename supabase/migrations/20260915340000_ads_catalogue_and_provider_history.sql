set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter type public.sync_job_type add value if not exists 'ads.product_metadata.sync';
alter type public.sync_job_type add value if not exists 'ads.product_eligibility.sync';
alter type public.sync_job_type add value if not exists 'ads.validation_configurations.sync';
alter type public.sync_job_type add value if not exists 'ads.change_history.sync';

create table public.ads_catalogue_source_settings (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  marketplace_id text not null,
  family text not null check (family in ('product_metadata','product_eligibility','validation_configurations','change_history')),
  enabled boolean not null default false,
  reporting_recovery_verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (profile_id, marketplace_id, family),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade
);

create table public.ads_catalogue_source_receipts (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, marketplace_id text not null, family text not null,
  selector_key text not null, window_start timestamptz not null, window_end timestamptz not null,
  acquired_at timestamptz not null, completed_at timestamptz not null default now(), counts jsonb not null,
  page_count integer not null check(page_count>=0), final_cursor text,
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  unique(org_id,profile_id,id),
  unique(profile_id, marketplace_id, family, selector_key, window_start, window_end, acquired_at)
);

create table public.ads_catalogue_source_checkpoints (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  marketplace_id text not null, family text not null, selector_key text not null,
  covered_from timestamptz, covered_through timestamptz, source_observed_at timestamptz,
  receipt_id uuid, cursor text,
  cursor_failure text check(cursor_failure is null or length(cursor_failure)<=240), updated_at timestamptz not null default now(),
  primary key(profile_id,marketplace_id,family,selector_key),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,profile_id,receipt_id) references public.ads_catalogue_source_receipts(org_id,profile_id,id)
);

create table public.ads_product_metadata_snapshots (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, marketplace_id text not null, asin text not null, sku text,
  ad_product public.ad_product not null, acquired_at timestamptz not null, retrieved_at timestamptz not null,
  provider_observed_at timestamptz, contract_version text not null, snapshot jsonb not null,
  payload_digest text not null check(payload_digest ~ '^[a-f0-9]{64}$'), receipt_id uuid not null,
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,profile_id,receipt_id) references public.ads_catalogue_source_receipts(org_id,profile_id,id)
);
create unique index ads_product_metadata_snapshot_identity on public.ads_product_metadata_snapshots(profile_id,marketplace_id,asin,coalesce(sku,''),ad_product,acquired_at,payload_digest);
create index ads_product_metadata_current_read on public.ads_product_metadata_snapshots(org_id,profile_id,marketplace_id,asin,ad_product,acquired_at desc,retrieved_at desc);

create table public.ads_product_eligibility_snapshots (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, marketplace_id text not null, asin text not null, sku text,
  ad_product public.ad_product not null, verdict text not null check(verdict in ('eligible','eligible_with_warning','ineligible','unknown')),
  reasons jsonb not null, acquired_at timestamptz not null, retrieved_at timestamptz not null,
  provider_observed_at timestamptz, contract_version text not null, payload_digest text not null check(payload_digest ~ '^[a-f0-9]{64}$'),
  receipt_id uuid not null,
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,profile_id,receipt_id) references public.ads_catalogue_source_receipts(org_id,profile_id,id)
);
create unique index ads_product_eligibility_snapshot_identity on public.ads_product_eligibility_snapshots(profile_id,marketplace_id,asin,coalesce(sku,''),ad_product,acquired_at,payload_digest);
create index ads_product_eligibility_current_read on public.ads_product_eligibility_snapshots(org_id,profile_id,marketplace_id,asin,ad_product,acquired_at desc,retrieved_at desc);

create table public.ads_validation_configurations (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, marketplace_id text not null, resource text not null check(resource in ('campaigns','targeting_clauses')),
  country_code text not null, entity_type text not null check(entity_type in ('SELLER','VENDOR')),
  ad_product public.ad_product not null, provider_version text, content_digest text not null check(content_digest ~ '^[a-f0-9]{64}$'),
  configuration jsonb not null, acquired_at timestamptz not null, retrieved_at timestamptz not null,
  receipt_id uuid not null,
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,profile_id,receipt_id) references public.ads_catalogue_source_receipts(org_id,profile_id,id),
  unique(profile_id,marketplace_id,resource,country_code,entity_type,ad_product,content_digest)
);
create index ads_validation_configurations_current_read on public.ads_validation_configurations(org_id,profile_id,marketplace_id,resource,country_code,entity_type,ad_product,acquired_at desc);

create table public.amazon_change_events (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, marketplace_id text not null, source_namespace text not null,
  source_event_key text not null check(source_event_key ~ '^[a-f0-9]{64}$'), identity_quality text not null check(identity_quality='derived'),
  payload_digest text not null check(payload_digest ~ '^[a-f0-9]{64}$'), entity_type text not null, entity_id text not null,
  change_type text not null, occurred_at timestamptz not null, retrieved_at timestamptz not null,
  sanitized_payload jsonb not null, receipt_id uuid not null,
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,profile_id,receipt_id) references public.ads_catalogue_source_receipts(org_id,profile_id,id),
  unique(org_id,profile_id,id),
  unique(profile_id,marketplace_id,source_namespace,source_event_key,payload_digest)
);
create index amazon_change_events_timeline_read on public.amazon_change_events(org_id,profile_id,occurred_at desc,id desc);
create index amazon_change_events_resolution_read on public.amazon_change_events(org_id,profile_id,entity_type,entity_id);

create table public.amazon_change_event_resolutions (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, event_id uuid not null,
  resolved_entity_type public.entity_type not null, resolved_amazon_id text not null, resolved_at timestamptz not null default now(),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,profile_id,event_id) references public.amazon_change_events(org_id,profile_id,id) on delete cascade,
  unique(event_id,resolved_entity_type,resolved_amazon_id)
);

select app.install_tenant_rls('public.ads_catalogue_source_settings');
select app.install_tenant_rls('public.ads_catalogue_source_receipts');
select app.install_tenant_rls('public.ads_catalogue_source_checkpoints');
select app.install_tenant_rls('public.ads_product_metadata_snapshots');
select app.install_tenant_rls('public.ads_product_eligibility_snapshots');
select app.install_tenant_rls('public.ads_validation_configurations');
select app.install_tenant_rls('public.amazon_change_events');
select app.install_tenant_rls('public.amazon_change_event_resolutions');

create function public.reject_ads_catalogue_evidence_mutation() returns trigger language plpgsql set search_path=pg_catalog,public,pg_temp as $$
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  raise exception 'catalogue evidence is append-only' using errcode='23514';
end $$;
create trigger ads_product_metadata_append_only before update or delete on public.ads_product_metadata_snapshots for each row execute function public.reject_ads_catalogue_evidence_mutation();
create trigger ads_product_eligibility_append_only before update or delete on public.ads_product_eligibility_snapshots for each row execute function public.reject_ads_catalogue_evidence_mutation();
create trigger ads_validation_configurations_append_only before update or delete on public.ads_validation_configurations for each row execute function public.reject_ads_catalogue_evidence_mutation();
create trigger amazon_change_events_append_only before update or delete on public.amazon_change_events for each row execute function public.reject_ads_catalogue_evidence_mutation();
revoke all on function public.reject_ads_catalogue_evidence_mutation() from public,anon,authenticated;
