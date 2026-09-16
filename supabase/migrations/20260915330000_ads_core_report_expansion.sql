set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- WP-310: candidate report families remain off until separately evidenced activation.
alter type public.report_type add value if not exists 'spAdvertisedProduct';
alter type public.report_type add value if not exists 'spPurchasedProduct';
alter type public.report_type add value if not exists 'sbPurchasedProduct';
alter type public.report_type add value if not exists 'sdPurchasedProduct';
alter type public.report_type add value if not exists 'sbTargeting';
alter type public.report_type add value if not exists 'sbSearchTerm';
alter type public.report_type add value if not exists 'sbCampaignPlacement';
alter type public.report_type add value if not exists 'sbAdGroup';
alter type public.report_type add value if not exists 'sdAdGroup';
alter type public.report_type add value if not exists 'sdAdGroupMatchedTarget';
alter type public.report_type add value if not exists 'sdTargeting';
alter type public.report_type add value if not exists 'sdTargetingMatchedTarget';
alter type public.report_type add value if not exists 'sdAdvertisedProduct';
alter type public.report_type add value if not exists 'sdCampaignsMatchedTarget';
alter type public.report_type add value if not exists 'spGrossAndInvalids';
alter type public.report_type add value if not exists 'sbGrossAndInvalids';
alter type public.report_type add value if not exists 'sdGrossAndInvalids';

alter type public.report_type add value if not exists 'spCampaignMetrics';
alter type public.report_type add value if not exists 'spTargetMetrics';
alter type public.report_type add value if not exists 'spQueryMetrics';
alter type public.report_type add value if not exists 'spPlacementMetrics';
alter type public.report_type add value if not exists 'sbCampaignMetrics';
alter type public.report_type add value if not exists 'sdCampaignMetrics';
alter type public.report_type add value if not exists 'sbAdMetrics';

alter table public.report_requests add column family_configuration jsonb;

create table public.report_family_capabilities (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null references public.ad_profiles(id) on delete cascade,
  family text not null,
  enabled boolean not null default false,
  status text not null default 'unassessed' check (status in ('unassessed','eligible','unsupported')),
  marketplace text not null,
  recovery_gate_evidence text,
  sb_multi_ad_groups_enabled boolean,
  multi_touch_evidence text,
  observed_at timestamptz,
  primary key (org_id, profile_id, family),
  check (not enabled or (status = 'eligible' and recovery_gate_evidence is not null and observed_at is not null))
);

create table public.report_family_attempts (
  report_request_id uuid primary key references public.report_requests(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null references public.ad_profiles(id) on delete cascade,
  configuration jsonb not null,
  canonical_sha256 text not null default repeat('0',64) check (canonical_sha256 ~ '^[0-9a-f]{64}$'),
  source_rows bigint not null check (source_rows >= 0),
  parsed_rows bigint not null check (parsed_rows >= 0),
  refused_rows bigint not null check (refused_rows >= 0),
  duplicate_rows bigint not null check (duplicate_rows >= 0),
  canonical_rows bigint not null check (canonical_rows >= 0),
  staged_rows bigint not null default 0 check (staged_rows >= 0),
  promoted_rows bigint not null default 0 check (promoted_rows >= 0),
  verified_rows bigint not null check (verified_rows >= 0),
  refusals jsonb not null,
  observed_at timestamptz not null,
  check (source_rows = parsed_rows + refused_rows),
  check (staged_rows = canonical_rows),
  check (promoted_rows = verified_rows and promoted_rows <= staged_rows),
  check (parsed_rows = canonical_rows + duplicate_rows)
);

create table public.report_family_watermarks (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null references public.ad_profiles(id) on delete cascade,
  family text not null, variant text not null,
  period_start date not null, period_end date not null,
  report_request_id uuid references public.report_requests(id) on delete set null,
  requested_at timestamptz not null, observed_at timestamptz not null,
  canonical_rows bigint not null check (canonical_rows >= 0),
  primary key (org_id, profile_id, family, variant, period_start, period_end)
);

create table public.fact_advertised_product_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_advertised_product_daily (org_id,profile_id,family,date);
create index on public.fact_advertised_product_daily using gin(dimensions);

create table public.fact_purchased_product_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_purchased_product_daily (org_id,profile_id,family,date);
create index on public.fact_purchased_product_daily using gin(dimensions);

create table public.fact_sb_target_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_sb_target_daily (org_id,profile_id,family,date);
create index on public.fact_sb_target_daily using gin(dimensions);

create table public.fact_sb_search_term_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_sb_search_term_daily (org_id,profile_id,family,date);
create index on public.fact_sb_search_term_daily using gin(dimensions);

create table public.fact_sb_placement_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_sb_placement_daily (org_id,profile_id,family,date);
create index on public.fact_sb_placement_daily using gin(dimensions);

create table public.fact_ad_group_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_ad_group_daily (org_id,profile_id,family,date);
create index on public.fact_ad_group_daily using gin(dimensions);

create table public.fact_sd_target_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_sd_target_daily (org_id,profile_id,family,date);
create index on public.fact_sd_target_daily using gin(dimensions);

create table public.fact_sd_matched_target_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_sd_matched_target_daily (org_id,profile_id,family,date);
create index on public.fact_sd_matched_target_daily using gin(dimensions);

create table public.fact_traffic_quality_daily (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_traffic_quality_daily (org_id,profile_id,family,date);
create index on public.fact_traffic_quality_daily using gin(dimensions);

create table public.fact_ads_report_periodic (
      org_id uuid not null references public.orgs(id) on delete cascade,
      profile_id uuid not null references public.ad_profiles(id) on delete cascade,
      date date not null, period_end date not null,
      family text not null, variant text not null, ad_product text not null check (ad_product in ('SP','SB','SD')),
      dimensions jsonb not null check (jsonb_typeof(dimensions) = 'object'),
      identity_dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(identity_dimensions) = 'object'),
      identity_hash text generated always as (md5(identity_dimensions::text)) stored,
      row_data jsonb not null check (jsonb_typeof(row_data) = 'object'),
      report_request_id uuid references public.report_requests(id) on delete set null,
      source text not null default 'amazon_reporting_v3',
      observed_at timestamptz not null, loaded_at timestamptz not null default now(),
      primary key (org_id, profile_id, date, period_end, family, variant, identity_hash),
      check (period_end >= date)
    ) partition by range (date);
create index on public.fact_ads_report_periodic (org_id,profile_id,family,date);
create index on public.fact_ads_report_periodic using gin(dimensions);
alter table public.fact_advertised_product_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_advertised_product_daily enable row level security;
create policy tenant_read on public.fact_advertised_product_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_advertised_product_daily to authenticated;
grant all on public.fact_advertised_product_daily to service_role;

alter table public.fact_purchased_product_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_purchased_product_daily enable row level security;
create policy tenant_read on public.fact_purchased_product_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_purchased_product_daily to authenticated;
grant all on public.fact_purchased_product_daily to service_role;

alter table public.fact_sb_target_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_sb_target_daily enable row level security;
create policy tenant_read on public.fact_sb_target_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_sb_target_daily to authenticated;
grant all on public.fact_sb_target_daily to service_role;

alter table public.fact_sb_search_term_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_sb_search_term_daily enable row level security;
create policy tenant_read on public.fact_sb_search_term_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_sb_search_term_daily to authenticated;
grant all on public.fact_sb_search_term_daily to service_role;

alter table public.fact_sb_placement_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_sb_placement_daily enable row level security;
create policy tenant_read on public.fact_sb_placement_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_sb_placement_daily to authenticated;
grant all on public.fact_sb_placement_daily to service_role;

alter table public.fact_ad_group_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_ad_group_daily enable row level security;
create policy tenant_read on public.fact_ad_group_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_ad_group_daily to authenticated;
grant all on public.fact_ad_group_daily to service_role;

alter table public.fact_sd_target_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_sd_target_daily enable row level security;
create policy tenant_read on public.fact_sd_target_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_sd_target_daily to authenticated;
grant all on public.fact_sd_target_daily to service_role;

alter table public.fact_sd_matched_target_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_sd_matched_target_daily enable row level security;
create policy tenant_read on public.fact_sd_matched_target_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_sd_matched_target_daily to authenticated;
grant all on public.fact_sd_matched_target_daily to service_role;

alter table public.fact_traffic_quality_daily add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_traffic_quality_daily enable row level security;
create policy tenant_read on public.fact_traffic_quality_daily for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_traffic_quality_daily to authenticated;
grant all on public.fact_traffic_quality_daily to service_role;

alter table public.fact_ads_report_periodic add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.fact_ads_report_periodic enable row level security;
create policy tenant_read on public.fact_ads_report_periodic for select to authenticated using (app.is_org_member(org_id));
grant select on public.fact_ads_report_periodic to authenticated;
grant all on public.fact_ads_report_periodic to service_role;

alter table public.report_family_capabilities add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.report_family_capabilities enable row level security;
create policy tenant_read on public.report_family_capabilities for select to authenticated using (app.is_org_member(org_id));
grant select on public.report_family_capabilities to authenticated;
grant all on public.report_family_capabilities to service_role;

alter table public.report_family_attempts add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.report_family_attempts enable row level security;
create policy tenant_read on public.report_family_attempts for select to authenticated using (app.is_org_member(org_id));
grant select on public.report_family_attempts to authenticated;
grant all on public.report_family_attempts to service_role;

alter table public.report_family_watermarks add foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade;
alter table public.report_family_watermarks enable row level security;
create policy tenant_read on public.report_family_watermarks for select to authenticated using (app.is_org_member(org_id));
grant select on public.report_family_watermarks to authenticated;
grant all on public.report_family_watermarks to service_role;


alter table public.report_family_capabilities add column approved_configurations jsonb not null default '[]'::jsonb check (jsonb_typeof(approved_configurations)='array');

create index report_family_attempts_scope on public.report_family_attempts(org_id,profile_id,(configuration->>'family'),observed_at desc);
create unique index report_requests_core_tenant_identity on public.report_requests(org_id,profile_id,id);
alter table public.fact_advertised_product_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_purchased_product_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_sb_target_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_sb_search_term_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_sb_placement_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_ad_group_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_sd_target_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_sd_matched_target_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_traffic_quality_daily add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.fact_ads_report_periodic add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.report_family_watermarks add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete set null (report_request_id);
alter table public.report_family_attempts add foreign key (org_id,profile_id,report_request_id) references public.report_requests(org_id,profile_id,id) on delete cascade;
