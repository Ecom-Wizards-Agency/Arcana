create table public.bid_series_daily (
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  date date not null,
  campaign_id text not null,
  ad_group_id text not null,
  target_id text not null,
  is_keyword boolean not null,
  suggested_bid_low numeric(12, 4),
  suggested_bid_median numeric(12, 4),
  suggested_bid_high numeric(12, 4),
  bid numeric(12, 4),
  cpc numeric(12, 4),
  max_potential_cpc numeric(12, 4),
  modifier_components jsonb not null default '[]'::jsonb,
  loaded_at timestamptz not null default now(),
  primary key (profile_id, date, campaign_id, ad_group_id, target_id)
) partition by range (date);

comment on table public.bid_series_daily is
  'Per-target daily bid corridor: Amazon suggested-bid low/median/high, the bid in force, realized CPC, and max-potential CPC with its modifier components. Market evidence synced daily, not an engine output.';

create index bid_series_daily_date_brin on public.bid_series_daily using brin (date);
create index bid_series_daily_profile_date on public.bid_series_daily (profile_id, date);
create index bid_series_daily_org_date on public.bid_series_daily (org_id, date);
create index bid_series_daily_target on public.bid_series_daily (profile_id, target_id, date);

select app.install_tenant_rls('public.bid_series_daily');

insert into app.fact_partitions
  (table_name, date_column, retention_months, rollup_source, rollup_dimensions, rollup_metrics)
values
  ('bid_series_daily', 'date', 26, null, array[]::text[], array[]::text[]);

select app.ensure_fact_partitions(current_date, 2);;
