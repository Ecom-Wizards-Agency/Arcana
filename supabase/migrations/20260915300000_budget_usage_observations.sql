set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter type public.sync_job_type add value if not exists 'budget_usage.collect';
alter type public.sync_job_type add value if not exists 'budget_usage.stream';

create table public.budget_usage_settings (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid primary key,
  config jsonb not null default '{"apiEnabled":false,"streamEnabled":false,"maxAgeSeconds":null,"nearLimitPercent":null,"allowFreshStreamFallback":false,"maxCampaigns":1000,"pageSize":100,"cadenceMinutes":60}'::jsonb,
  updated_at timestamptz not null default now(),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check (jsonb_typeof(config)='object'),
  check (coalesce(jsonb_typeof(config->'apiEnabled'),'boolean')='boolean' and coalesce(jsonb_typeof(config->'streamEnabled'),'boolean')='boolean'),
  check (not config ? 'maxCampaigns' or (config->>'maxCampaigns')::integer between 1 and 100000),
  check (not config ? 'pageSize' or (config->>'pageSize')::integer between 1 and 1000),
  check (not config ? 'cadenceMinutes' or (config->>'cadenceMinutes')::integer between 1 and 10080),
  check (config->>'maxAgeSeconds' is null or (config->>'maxAgeSeconds')::integer > 0),
  check (config->>'nearLimitPercent' is null or (config->>'nearLimitPercent')::numeric >= 0)
);

create table public.budget_usage_runs (
  id uuid primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  source text not null check (source in ('amazon_ads_api','amazon_marketing_stream')),
  received_at timestamptz not null,
  input jsonb not null,
  counts jsonb not null,
  unique (org_id,profile_id,id),
  unique (org_id,profile_id,id,source),
  foreign key (org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check ((input->'scope'->>'orgId'=org_id::text and input->'scope'->>'profileId'=profile_id::text and input->>'source'=source and input->>'runId'=id::text) is true),
  check (counts ?& array['selected','requested','returned','failed','sourceRows','parsedRows','refusedRows','loadedRows','existingRows','verifiedLoadedRows']),
  check ((jsonb_array_length(input->'selected')=(counts->>'selected')::integer and jsonb_array_length(input->'observations')=(counts->>'returned')::integer and jsonb_array_length(input->'failures')=(counts->>'failed')::integer) is true),
  check (((counts->>'selected')::integer=(counts->>'requested')::integer and (counts->>'requested')::integer=(counts->>'returned')::integer+(counts->>'failed')::integer) is true),
  check (((counts->>'sourceRows')::integer=(counts->>'parsedRows')::integer+(counts->>'refusedRows')::integer) is true),
  check (((counts->>'loadedRows')::integer=(counts->>'verifiedLoadedRows')::integer) is true),
  check (((counts->>'selected')::integer>=0 and (counts->>'requested')::integer>=0 and (counts->>'returned')::integer>=0 and (counts->>'failed')::integer>=0 and (counts->>'sourceRows')::integer>=0 and (counts->>'parsedRows')::integer>=0 and (counts->>'refusedRows')::integer>=0 and (counts->>'loadedRows')::integer>=0 and (counts->>'existingRows')::integer between 0 and (counts->>'loadedRows')::integer and (counts->>'verifiedLoadedRows')::integer>=0) is true)
);
create index budget_usage_runs_latest_idx on public.budget_usage_runs(org_id,profile_id,source,received_at desc);

create table public.budget_usage_observations (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  ad_product public.ad_product not null,
  campaign_id text not null check (btrim(campaign_id)<>''),
  source_identity text not null check (btrim(source_identity)<>''),
  provider_updated_at timestamptz not null,
  received_at timestamptz not null,
  run_id uuid not null,
  source text not null default 'amazon_ads_api' check (source='amazon_ads_api'),
  observation jsonb not null,
  primary key(org_id,profile_id,ad_product,campaign_id,source_identity),
  unique(org_id,profile_id,ad_product,campaign_id,provider_updated_at),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key(org_id,profile_id,run_id,source) references public.budget_usage_runs(org_id,profile_id,id,source) on delete cascade,
  check ((observation->>'source'='amazon_ads_api') is true),
  check ((observation->>'orgId'=org_id::text and observation->>'profileId'=profile_id::text and observation->>'adProduct'=ad_product::text and observation->>'campaignId'=campaign_id and observation->>'sourceIdentity'=source_identity) is true),
  check (((observation->>'providerUpdatedAt')::timestamptz=provider_updated_at and (observation->>'receivedAt')::timestamptz=received_at) is true),
  check (observation->>'usagePercent' is null or (observation->>'usagePercent')::numeric >= 0)
);
create index budget_usage_observations_latest_idx on public.budget_usage_observations(org_id,profile_id,ad_product,campaign_id,provider_updated_at desc);

create function app.reject_budget_usage_update() returns trigger language plpgsql set search_path=pg_catalog as $$
begin raise exception 'Budget usage observations and runs are immutable'; end $$;
create trigger budget_usage_observations_immutable before update on public.budget_usage_observations for each row execute function app.reject_budget_usage_update();
create trigger budget_usage_runs_immutable before update on public.budget_usage_runs for each row execute function app.reject_budget_usage_update();
revoke all on function app.reject_budget_usage_update() from public,anon,authenticated;
select app.install_tenant_rls('public.budget_usage_settings');
select app.install_tenant_rls('public.budget_usage_runs');
select app.install_tenant_rls('public.budget_usage_observations');
revoke insert,update,delete on public.budget_usage_settings,public.budget_usage_runs,public.budget_usage_observations from authenticated;
