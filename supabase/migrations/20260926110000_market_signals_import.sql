-- WP-331: Arcana imports wizards-ai's `market-signals/2` export instead of
-- calling Keepa itself. Observations and price events gain a marketplace and a
-- writer; signals land in `insights` with their tag marks beside them.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- ---------------------------------------------------------------------------
-- Keepa observations: marketplace, writer and offer count
-- ---------------------------------------------------------------------------

-- `buy_box_price` already exists (20260827150400); only the offer count is new.
alter table public.keepa_bsr_observations
  add column marketplace text,
  add column source text not null default 'arcana',
  add column offer_count integer;

-- Every existing row was written by keepa.sync for one profile, but the table
-- never recorded which. An organisation whose profiles share one country gets
-- that country; any other organisation gets its first profile's country (by
-- creation time, then id). Both cases are the first profile's country. An
-- organisation without profiles keeps null.
update public.keepa_bsr_observations o
   set marketplace = origin.marketplace
  from (
    select distinct on (p.org_id) p.org_id, upper(p.country_code) as marketplace
      from public.ad_profiles p
     order by p.org_id, p.created_at, p.id
  ) origin
 where origin.org_id = o.org_id and o.marketplace is null;

alter table public.keepa_bsr_observations
  add constraint keepa_bsr_observations_marketplace_format
    check (marketplace is null or marketplace ~ '^[A-Z]{2}$'),
  add constraint keepa_bsr_observations_source_format
    check (source ~ '^[a-z][a-z0-9-]{0,39}$'),
  add constraint keepa_bsr_observations_offer_count_range
    check (offer_count is null or offer_count >= 0);

-- The same ASIN is a different listing in each marketplace.
drop index public.keepa_bsr_observations_key;
create unique index keepa_bsr_observations_key
  on public.keepa_bsr_observations (org_id, marketplace, asin, category, observed_at) nulls not distinct;
-- Market position and Home read by ASIN without a marketplace.
create index keepa_bsr_observations_asin_idx
  on public.keepa_bsr_observations (org_id, asin, category, observed_at);

alter table public.competitor_price_events
  add column source text not null default 'arcana',
  add constraint competitor_price_events_source_format
    check (source ~ '^[a-z][a-z0-9-]{0,39}$');

-- ---------------------------------------------------------------------------
-- wizards-ai profile keys to Arcana profiles
-- ---------------------------------------------------------------------------

create table public.market_signals_profile_map (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_key text not null
    check (length(profile_key) between 1 and 200 and profile_key = btrim(profile_key)),
  profile_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_signals_profile_map_key unique (org_id, profile_key),
  constraint market_signals_profile_map_profile_fkey
    foreign key (org_id, profile_id) references public.ad_profiles (org_id, id) on delete cascade
);
create index market_signals_profile_map_profile_idx on public.market_signals_profile_map (profile_id);

create trigger market_signals_profile_map_touch before update on public.market_signals_profile_map
  for each row execute function app.touch_updated_at();

select app.install_tenant_rls('public.market_signals_profile_map', array['owner', 'admin']);

-- ---------------------------------------------------------------------------
-- Signal tag marks: append-only deltas, folded by a view
-- ---------------------------------------------------------------------------

-- Marks must stay inside their insight's organisation.
alter table public.insights
  add constraint insights_org_identity_unique unique (org_id, id);

create table public.insight_tag_marks (
  -- The exporter's uuid5 of (signal, path, op, time): stable under replay.
  id uuid primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  insight_id uuid not null,
  tag_id uuid not null,
  path text not null check (path ~ '^signal/[a-z_]+/[^/]+$'),
  op text not null check (op in ('add', 'remove')),
  at timestamptz not null,
  source text not null check (source in ('rule', 'label', 'jev', 'human')),
  -- `shadow` marks are measurement only; readers must not show them as facts.
  stage text not null check (stage in ('live', 'shadow')),
  rules jsonb,
  -- wizards-ai's organisation-free tag id, uuid5 of the path, for traceability.
  source_tag_id text,
  created_at timestamptz not null default now(),
  constraint insight_tag_marks_insight_fkey
    foreign key (org_id, insight_id) references public.insights (org_id, id) on delete cascade,
  constraint insight_tag_marks_tag_fkey
    foreign key (org_id, tag_id) references public.tags (org_id, id) on delete cascade
);
create index insight_tag_marks_insight_idx on public.insight_tag_marks (insight_id, tag_id, at desc);
create index insight_tag_marks_tag_idx on public.insight_tag_marks (org_id, tag_id);

-- Corrections are new marks. Rows leave only with their insight, tag or organisation.
create function app.insight_tag_marks_append_only() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then return old; end if;
  raise exception 'Insight tag marks are append-only' using errcode = '23514';
end;
$$;
create trigger insight_tag_marks_append_only before update or delete on public.insight_tag_marks
  for each row execute function app.insight_tag_marks_append_only();
create trigger insight_tag_marks_no_truncate before truncate on public.insight_tag_marks
  for each statement execute function app.insight_tag_marks_append_only();
revoke all on function app.insight_tag_marks_append_only() from public, anon, authenticated;

select app.install_tenant_rls('public.insight_tag_marks', array['owner', 'admin', 'analyst']);

-- The tags each insight carries now: the latest mark per (insight, tag) is an
-- add. A remove at the same instant as an add wins.
create view public.insight_tags_current
with (security_invoker = true)
as
select latest.org_id, latest.insight_id, latest.tag_id, latest.path, latest.stage,
       latest.source, latest.source_tag_id, latest.at as added_at
  from (
    select distinct on (m.insight_id, m.tag_id) m.*
      from public.insight_tag_marks m
     order by m.insight_id, m.tag_id, m.at desc, (m.op = 'remove') desc, m.id desc
  ) latest
 where latest.op = 'add';

revoke all on public.insight_tags_current from public, anon, authenticated, service_role;
grant select on public.insight_tags_current to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Import position: the last batch taken from each file, per organisation
-- ---------------------------------------------------------------------------

create table public.market_signals_import_state (
  org_id uuid not null references public.orgs (id) on delete cascade,
  file_name text not null check (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.ndjson$'),
  -- Bytes of the file accounted for by the last read that took every batch.
  file_bytes bigint not null check (file_bytes >= 0),
  -- Null until a batch of this file lands for the organisation.
  last_generated_at timestamptz,
  last_state_generated_at timestamptz,
  batches_imported integer not null default 0 check (batches_imported >= 0),
  observations bigint not null default 0 check (observations >= 0),
  change_points bigint not null default 0 check (change_points >= 0),
  signals bigint not null default 0 check (signals >= 0),
  tag_marks bigint not null default 0 check (tag_marks >= 0),
  invalid_records bigint not null default 0 check (invalid_records >= 0),
  -- Invalid lines outside any batch seen in this file so far; re-reads add only new ones.
  orphan_lines bigint not null default 0 check (orphan_lines >= 0),
  unmapped_signals bigint not null default 0 check (unmapped_signals >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, file_name)
);

create trigger market_signals_import_state_touch before update on public.market_signals_import_state
  for each row execute function app.touch_updated_at();

-- Members read the position; only the worker (service role) writes it.
select app.install_tenant_rls('public.market_signals_import_state');
