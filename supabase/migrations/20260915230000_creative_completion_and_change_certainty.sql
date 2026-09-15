set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Completion columns already exist. Retain actual daily observations so a
-- sparse change ledger never masquerades as complete observation history.
create table public.creative_entity_observations (
  org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null,
  entity_type public.entity_type not null,
  amazon_id text not null,
  observed_at timestamptz not null,
  observation_field text not null,
  snapshot jsonb not null,
  primary key (profile_id, entity_type, amazon_id, observed_at, observation_field),
  foreign key (org_id, profile_id) references public.ad_profiles(org_id, id) on delete cascade
);
select app.install_tenant_rls('public.creative_entity_observations');
revoke insert, update, delete on public.creative_entity_observations from authenticated;

create function app.capture_creative_entity_observation()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
declare item jsonb; at_time timestamptz; control_time timestamptz; entity_kind public.entity_type;
begin
  entity_kind := case tg_table_name when 'campaigns' then 'campaign' when 'ad_groups' then 'ad_group'
    when 'keywords' then 'keyword' else 'target' end;
  -- OLD preserves the last successful observation even when that sync emitted
  -- no diff. NEW records the current read. Field-specific reads remain scoped.
  for item in select value from jsonb_array_elements(case when tg_op='UPDATE'
    then jsonb_build_array(to_jsonb(old),to_jsonb(new)) else jsonb_build_array(to_jsonb(new)) end)
  loop
    at_time := (item->>'synced_at')::timestamptz;
    if at_time is not null then
      insert into public.creative_entity_observations(org_id,profile_id,entity_type,amazon_id,observed_at,observation_field,snapshot)
      values((item->>'org_id')::uuid,(item->>'profile_id')::uuid,entity_kind,item->>'amazon_id',at_time,'entity',
        jsonb_build_object('bid',item->'bid','defaultBid',item->'default_bid','placementBidding',item->'placement_bidding'))
      on conflict do nothing;
    end if;
    control_time := coalesce((item->>'bid_observed_at')::timestamptz,(item->>'bidding_observed_at')::timestamptz);
    if control_time is not null then
      insert into public.creative_entity_observations(org_id,profile_id,entity_type,amazon_id,observed_at,observation_field,snapshot)
      values((item->>'org_id')::uuid,(item->>'profile_id')::uuid,entity_kind,item->>'amazon_id',control_time,
        case when entity_kind='campaign' then 'placementBidding' else 'bid' end,
        jsonb_build_object('bid',item->'bid','defaultBid',item->'default_bid','placementBidding',item->'placement_bidding'))
      on conflict do nothing;
    end if;
  end loop;
  return new;
end $$;
revoke all on function app.capture_creative_entity_observation() from public, anon, authenticated;
-- AFTER avoids recording a rejected ON CONFLICT candidate; OLD still carries
-- the previous observation after a successful update.
create trigger creative_observe_campaign after insert or update on public.campaigns
  for each row execute function app.capture_creative_entity_observation();
create trigger creative_observe_ad_group after insert or update on public.ad_groups
  for each row execute function app.capture_creative_entity_observation();
create trigger creative_observe_keyword after insert or update on public.keywords
  for each row execute function app.capture_creative_entity_observation();
create trigger creative_observe_target after insert or update on public.targets
  for each row execute function app.capture_creative_entity_observation();

alter table public.entity_changes add column certainty jsonb;

create function app.creative_change_certainty(p_org uuid,p_profile uuid,p_type public.entity_type,p_id text,
  p_field text,p_old jsonb,p_new jsonb,p_observed timestamptz)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, public, app as $$
declare current_at timestamptz; prior_at timestamptz; prior_matches boolean; current_found boolean; zone text; width_days integer; label text;
begin
  if p_field='entity' and (p_old is null or p_old='null'::jsonb) then
    return jsonb_build_object('kind','first','from',null,'to',to_char(p_observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'widthDays',null);
  end if;
  -- Generic ad-group sync records its diff after the mirror write, using a
  -- separate database timestamp. Pick the latest observation at/before that
  -- record time first, then validate its value. Never search past a mismatch.
  select o.observed_at,o.snapshot->p_field is not distinct from coalesce(p_new,'null'::jsonb)
    into current_at,current_found from public.creative_entity_observations o
    where o.org_id=p_org and o.profile_id=p_profile and o.entity_type=p_type and o.amazon_id=p_id
      and o.observed_at<=p_observed and o.observation_field in ('entity',p_field)
    order by o.observed_at desc,(o.observation_field=p_field) desc limit 1;
  -- The preceding observation must itself carry the old value. Selecting an
  -- older matching value could skip an intervening change and invent a bracket.
  select o.observed_at,o.snapshot->p_field is not distinct from coalesce(p_old,'null'::jsonb)
    into prior_at,prior_matches from public.creative_entity_observations o
    where o.org_id=p_org and o.profile_id=p_profile and o.entity_type=p_type and o.amazon_id=p_id
      and o.observed_at<current_at and o.observation_field in ('entity',p_field)
    order by o.observed_at desc,(o.observation_field=p_field) desc limit 1;
  select timezone into zone from public.ad_profiles where org_id=p_org and id=p_profile;
  -- Retain the record-time upper bound. This permits a seconds-later diff but
  -- cannot turn an old, stale observation pair into an exact change today.
  width_days := (p_observed at time zone coalesce(zone,'UTC'))::date-(prior_at at time zone coalesce(zone,'UTC'))::date;
  label := case when current_found and prior_matches and prior_at is not null and width_days between 0 and 1 then 'exact' else 'window' end;
  return jsonb_build_object('kind',label,
    'from',case when prior_at is null then null else to_char(prior_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'to',to_char(p_observed at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'widthDays',width_days);
end $$;
revoke all on function app.creative_change_certainty(uuid,uuid,public.entity_type,text,text,jsonb,jsonb,timestamptz) from public,anon,authenticated;

-- Historical diffs have no retained daily ledger. The same rule leaves their
-- missing brackets explicit instead of treating a preceding diff as a read.
update public.entity_changes set certainty=app.creative_change_certainty(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,observed_at);
alter table public.entity_changes alter column certainty set not null;
alter table public.entity_changes add constraint entity_changes_certainty_shape check (
  certainty->>'kind' in ('exact','window','first') and certainty ?& array['kind','from','to','widthDays']
);
create function app.freeze_creative_change_certainty()
returns trigger language plpgsql security definer set search_path = pg_catalog, public, app as $$
begin
  if tg_op='INSERT' then
    new.certainty := app.creative_change_certainty(new.org_id,new.profile_id,new.entity_type,new.amazon_id,new.field,new.old_value,new.new_value,new.observed_at);
  elsif new.certainty is distinct from old.certainty then
    raise exception 'Recorded change certainty is immutable' using errcode='23514';
  end if;
  return new;
end $$;
revoke all on function app.freeze_creative_change_certainty() from public,anon,authenticated;
create trigger creative_record_change_certainty before insert or update on public.entity_changes
  for each row execute function app.freeze_creative_change_certainty();

comment on column public.entity_changes.certainty is
  'Recorded once. Exact requires matching observations on the same or consecutive profile calendar dates; gaps are windows. Missing historical boundaries stay null.';
