set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
alter type public.sync_job_type add value if not exists 'retail.report.request';
alter type public.sync_job_type add value if not exists 'aba.report.request';
alter type public.sync_job_type add value if not exists 'catalogue.report.request';

-- Source activation is separate from consent/binding. No scopes are seeded.
create table public.spapi_report_sources (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, connection_id uuid not null,
  family text not null check (family in ('retail','aba','catalogue')),
  enabled boolean not null default false, schedule_enabled boolean not null default false,
  policy_accepted boolean not null default false,
  provider_policy jsonb generated always as (
    case family
      when 'retail' then '{"documentRetentionDays":90,"period":"DAY","lookbackCalendarYears":2,"modelVersion":"3659f96867bfc669aca7a524c2f95744ff0e4478"}'::jsonb
      when 'aba' then '{"documentRetentionDays":90,"period":"WEEK","lookbackCalendarYears":null,"modelVersion":"3659f96867bfc669aca7a524c2f95744ff0e4478"}'::jsonb
      else '{"documentRetentionDays":90,"period":"OBSERVATION","lookbackCalendarYears":null,"modelVersion":"3659f96867bfc669aca7a524c2f95744ff0e4478"}'::jsonb end
  ) stored,
  restatement_days integer not null default 0 check (restatement_days between 0 and 30),
  next_run_at timestamptz not null default now(),
  primary key (org_id,profile_id,family),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key (org_id,connection_id) references public.spapi_connections(org_id,id) on delete cascade
);
select app.install_tenant_rls('public.spapi_report_sources');

create table public.spapi_report_runs (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, family text not null check (family in ('retail','aba','catalogue')),
  request_id text not null, revision integer not null check (revision >= 0),
  checkpoint jsonb not null,
  primary key (org_id,profile_id,family,request_id),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
select app.install_tenant_rls('public.spapi_report_runs');

-- Immutable source receipts preserve original observation time and parsed identities.
-- Provenance deletion is refused while evidence remains; deleting the whole tenant
-- still cascades. Removing one Ads profile must not erase shared seller totals.
create table public.spapi_report_receipts (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, family text not null check (family in ('retail','aba','catalogue')),
  request_id text not null, selling_partner_id text not null, marketplace_id text not null,
  start_date date not null, end_date date not null check (end_date >= start_date),
  observed_at timestamptz not null, report jsonb not null,
  primary key (org_id,profile_id,family,request_id),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete no action deferrable initially deferred
);
create index spapi_report_receipts_scope on public.spapi_report_receipts
  (org_id,selling_partner_id,marketplace_id,family,start_date,end_date,observed_at desc);
create unique index spapi_report_receipts_provider_document on public.spapi_report_receipts
  (org_id,selling_partner_id,marketplace_id,family,(report->>'reportId'),(report->>'documentId'));
select app.install_tenant_rls('public.spapi_report_receipts');

create table public.fact_retail_sales_traffic_daily (
  org_id uuid not null references public.orgs(id) on delete cascade,
  selling_partner_id text not null, marketplace_id text not null, date date not null,
  row_key text not null, profile_id uuid not null, connection_id uuid not null,
  grain text not null check (grain in ('total','child')),
  observed_at timestamptz not null, report_request_id text not null, payload jsonb not null,
  primary key (org_id,selling_partner_id,marketplace_id,date,row_key),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete no action deferrable initially deferred,
  foreign key (org_id,connection_id) references public.spapi_connections(org_id,id) on delete no action deferrable initially deferred
) partition by range (date);
create index fact_retail_scope_date on public.fact_retail_sales_traffic_daily(org_id,selling_partner_id,marketplace_id,date);
select app.install_tenant_rls('public.fact_retail_sales_traffic_daily');

create table public.fact_aba_search_terms_periodic (
  org_id uuid not null references public.orgs(id) on delete cascade,
  selling_partner_id text not null, marketplace_id text not null, date date not null,
  row_key text not null, profile_id uuid not null, connection_id uuid not null,
  grain text not null check (grain in ('query','slot')),
  observed_at timestamptz not null, report_request_id text not null, payload jsonb not null,
  primary key (org_id,selling_partner_id,marketplace_id,date,row_key),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete no action deferrable initially deferred,
  foreign key (org_id,connection_id) references public.spapi_connections(org_id,id) on delete no action deferrable initially deferred
) partition by range (date);
create index fact_aba_scope_date on public.fact_aba_search_terms_periodic(org_id,selling_partner_id,marketplace_id,date);
select app.install_tenant_rls('public.fact_aba_search_terms_periodic');

-- Adapter-owned immutable reports; a later collector integration can consume these receipts.
-- This table does not replace or alter another collector's listing history.
create table public.spapi_listing_observations (
  org_id uuid not null references public.orgs(id) on delete cascade,
  selling_partner_id text not null, marketplace_id text not null, date date not null,
  row_key text not null, profile_id uuid not null, connection_id uuid not null,
  grain text not null check (grain = 'listing'),
  observed_at timestamptz not null, report_request_id text not null, payload jsonb not null,
  primary key (org_id,profile_id,report_request_id,row_key),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete no action deferrable initially deferred,
  foreign key (org_id,connection_id) references public.spapi_connections(org_id,id) on delete no action deferrable initially deferred
);
create index spapi_listing_scope_date on public.spapi_listing_observations(org_id,selling_partner_id,marketplace_id,date,observed_at);
select app.install_tenant_rls('public.spapi_listing_observations');

create function app.spapi_immutable_receipt() returns trigger language plpgsql set search_path = pg_catalog as $$
begin raise exception 'SP-API observations are immutable' using errcode='23514'; end;
$$;
revoke all on function app.spapi_immutable_receipt() from public,anon,authenticated;
create trigger spapi_receipt_immutable before update on public.spapi_report_receipts for each row execute function app.spapi_immutable_receipt();
create trigger spapi_listing_immutable before update on public.spapi_listing_observations for each row execute function app.spapi_immutable_receipt();

insert into app.fact_partitions(table_name,date_column,retention_months,rollup_source,rollup_dimensions,rollup_metrics)
values ('fact_retail_sales_traffic_daily','date',26,null,array[]::text[],array[]::text[]),
       ('fact_aba_search_terms_periodic','date',26,null,array[]::text[],array[]::text[]);
select app.ensure_fact_partitions(current_date,2);
