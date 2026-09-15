set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Manual observations only. No Amazon execution authority or collection cadence.
create table public.sponsored_prompts (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, ad_product text not null check(ad_product in ('SP','SB')),
  campaign_id text not null, ad_group_id text not null, prompt_text text not null check(length(btrim(prompt_text)) between 1 and 2000),
  normalized_prompt text not null, first_seen_at timestamptz not null, last_seen_at timestamptz not null,
  current_status text not null check(current_status in ('live','paused')),
  unique(org_id,profile_id,id), unique(profile_id,campaign_id,ad_group_id,normalized_prompt),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check(first_seen_at<=last_seen_at)
);
create table public.sponsored_prompt_observations (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, prompt_id uuid not null, observed_at timestamptz not null,
  status text not null check(status in ('live','paused')),
  interval_start timestamptz not null, interval_end timestamptz not null,
  spend numeric(18,4) check(spend>=0), clicks bigint check(clicks>=0), sales numeric(18,4) check(sales>=0), orders bigint check(orders>=0),
  unique(prompt_id,observed_at),
  foreign key(org_id,profile_id,prompt_id) references public.sponsored_prompts(org_id,profile_id,id) on delete cascade,
  check(interval_start<interval_end and interval_end<=observed_at)
);
create index sponsored_prompt_observations_scope on public.sponsored_prompt_observations(org_id,profile_id,observed_at);
create table public.sponsored_prompt_visits (
  org_id uuid not null references public.orgs(id) on delete cascade, profile_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade, last_visited_at timestamptz not null,
  primary key(org_id,profile_id,user_id),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
select app.install_tenant_rls('public.sponsored_prompts',array['owner','admin','analyst']);
select app.install_tenant_rls('public.sponsored_prompt_observations',array['owner','admin','analyst']);
select app.install_tenant_rls('public.sponsored_prompt_visits',null);
drop policy tenant_read on public.sponsored_prompt_visits;
create policy own_visit_read on public.sponsored_prompt_visits for select to authenticated using(app.is_org_member(org_id) and user_id=auth.uid());
create policy own_visit_insert on public.sponsored_prompt_visits for insert to authenticated with check(app.has_org_role(org_id,array['owner','admin','analyst']) and user_id=auth.uid());
create policy own_visit_update on public.sponsored_prompt_visits for update to authenticated using(app.has_org_role(org_id,array['owner','admin','analyst']) and user_id=auth.uid()) with check(app.has_org_role(org_id,array['owner','admin','analyst']) and user_id=auth.uid());
grant insert,update on public.sponsored_prompt_visits to authenticated;
revoke delete on public.sponsored_prompts from authenticated;
revoke update,delete on public.sponsored_prompt_observations from authenticated;
drop policy tenant_delete on public.sponsored_prompts;
drop policy tenant_update on public.sponsored_prompt_observations;
drop policy tenant_delete on public.sponsored_prompt_observations;

create function app.sponsored_prompt_identity_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.normalized_prompt<>lower(regexp_replace(btrim(new.prompt_text),'\s+',' ','g')) then
    raise exception 'Prompt normalization mismatch' using errcode='23514';
  end if;
  if tg_op='UPDATE' and (new.org_id,new.profile_id,new.ad_product,new.campaign_id,new.ad_group_id,new.normalized_prompt)
    is distinct from (old.org_id,old.profile_id,old.ad_product,old.campaign_id,old.ad_group_id,old.normalized_prompt) then
    raise exception 'Prompt identity is immutable' using errcode='23514';
  end if;
  if tg_op='UPDATE' and pg_trigger_depth()=1 and (new.first_seen_at,new.last_seen_at,new.current_status)
    is distinct from (old.first_seen_at,old.last_seen_at,old.current_status) then
    raise exception 'Prompt status comes from observations' using errcode='23514';
  end if;
  if not exists(select 1 from public.campaigns c join public.ad_groups g
      on g.org_id=c.org_id and g.profile_id=c.profile_id and g.campaign_id=c.amazon_id and g.ad_product=c.ad_product
    where c.org_id=new.org_id and c.profile_id=new.profile_id and c.amazon_id=new.campaign_id
      and c.ad_product::text=new.ad_product and g.amazon_id=new.ad_group_id) then
    raise exception 'Prompt campaign or ad group not found' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger sponsored_prompt_identity_guard before insert or update on public.sponsored_prompts for each row execute function app.sponsored_prompt_identity_guard();

create function app.sponsored_prompt_observation_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op<>'INSERT' then
    if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
    raise exception 'Prompt observations are append-only' using errcode='23514';
  end if;
  perform 1 from public.sponsored_prompts where id=new.prompt_id and org_id=new.org_id and profile_id=new.profile_id for update;
  if not found then raise exception 'Prompt not found' using errcode='23514'; end if;
  if new.observed_at>statement_timestamp() then raise exception 'Future prompt observation' using errcode='23514'; end if;
  if exists(select 1 from public.sponsored_prompt_observations o where o.prompt_id=new.prompt_id
    and tstzrange(o.interval_start,o.interval_end,'[)') && tstzrange(new.interval_start,new.interval_end,'[)')) then
    raise exception 'Prompt metric intervals overlap' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger sponsored_prompt_observation_guard before insert or update or delete on public.sponsored_prompt_observations for each row execute function app.sponsored_prompt_observation_guard();
create function app.sponsored_prompt_refuse_truncate() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception 'Prompt observations are append-only' using errcode='23514';
end;
$$;
create trigger sponsored_prompt_observations_no_truncate before truncate on public.sponsored_prompt_observations for each statement execute function app.sponsored_prompt_refuse_truncate();
create function app.sponsored_prompt_observed() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  update public.sponsored_prompts set first_seen_at=least(first_seen_at,new.observed_at),
    current_status=case when new.observed_at>=last_seen_at then new.status else current_status end,
    last_seen_at=greatest(last_seen_at,new.observed_at) where id=new.prompt_id and org_id=new.org_id and profile_id=new.profile_id;
  return new;
end;
$$;
create trigger sponsored_prompt_observed after insert on public.sponsored_prompt_observations for each row execute function app.sponsored_prompt_observed();
create function app.sponsored_prompt_visit_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.last_visited_at>statement_timestamp() then raise exception 'Future visit marker' using errcode='23514'; end if;
  if tg_op='UPDATE' then
    if (new.org_id,new.profile_id,new.user_id) is distinct from (old.org_id,old.profile_id,old.user_id) then raise exception 'Visit identity is immutable' using errcode='23514'; end if;
    new.last_visited_at:=greatest(new.last_visited_at,old.last_visited_at);
  end if;
  return new;
end;
$$;
create trigger sponsored_prompt_visit_guard before insert or update on public.sponsored_prompt_visits for each row execute function app.sponsored_prompt_visit_guard();
revoke all on function app.sponsored_prompt_identity_guard(),app.sponsored_prompt_observation_guard(),app.sponsored_prompt_observed(),app.sponsored_prompt_visit_guard(),app.sponsored_prompt_refuse_truncate() from public,anon,authenticated;
