set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
-- Timeline records operator observations; this migration grants no Amazon write authority.
create table public.timeline_events (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, name text not null check(length(trim(name)) between 1 and 200),
  kind text not null check(kind in ('promotion','market','listing','supply')),
  start_on date not null, end_on date, scope_text text not null check(length(scope_text)<=2000),
  note text not null check(length(note)<=20000), created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(), supersedes_id uuid unique,
  unique(org_id,profile_id,id),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  foreign key(org_id,profile_id,supersedes_id) references public.timeline_events(org_id,profile_id,id) on delete cascade,
  check(end_on is null or end_on>=start_on), check(supersedes_id is distinct from id)
);
create index timeline_events_window on public.timeline_events(org_id,profile_id,start_on);
alter table public.timeline_events enable row level security;
create policy tenant_read on public.timeline_events for select to authenticated using(app.is_org_member(org_id));
create policy timeline_insert on public.timeline_events for insert to authenticated with check(
  app.has_org_role(org_id,array['owner','admin','analyst']) and created_by=auth.uid());
revoke all on public.timeline_events from anon, authenticated;
grant select,insert on public.timeline_events to authenticated;
grant all on public.timeline_events to service_role;

create table public.timeline_evidence_settings (
  profile_id uuid primary key, org_id uuid not null references public.orgs(id) on delete cascade,
  min_days integer check(min_days>0), min_clicks numeric check(min_clicks>=0),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade
);
alter table public.timeline_evidence_settings enable row level security;
create policy tenant_read on public.timeline_evidence_settings for select to authenticated using(app.is_org_member(org_id));
create policy timeline_settings_insert on public.timeline_evidence_settings for insert to authenticated with check(app.has_org_role(org_id,array['owner','admin','analyst']));
create policy timeline_settings_update on public.timeline_evidence_settings for update to authenticated using(app.has_org_role(org_id,array['owner','admin','analyst'])) with check(app.has_org_role(org_id,array['owner','admin','analyst']));
revoke all on public.timeline_evidence_settings from anon;
grant select,insert,update on public.timeline_evidence_settings to authenticated;
grant all on public.timeline_evidence_settings to service_role;

create function app.timeline_refuse_rewrite() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  -- Preserve the repository's guarded whole-organisation purge contract.
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  raise exception 'Timeline evidence is append-only' using errcode='23514';
end;
$$;
create trigger timeline_events_immutable before update or delete on public.timeline_events for each row execute function app.timeline_refuse_rewrite();
create trigger experiment_events_immutable before update or delete on public.experiment_events for each row execute function app.timeline_refuse_rewrite();

create function app.timeline_experiment_evidence_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  if tg_op='DELETE' then raise exception 'Experiment evidence is append-only' using errcode='23514'; end if;
  if tg_op='INSERT' then
    if new.status not in ('planned','running') or new.result_note is not null then
      raise exception 'An experiment is born planned or running without a result' using errcode='23514';
    end if;
    return new;
  end if;
  if new.hypothesis is distinct from old.hypothesis then
    raise exception 'The hypothesis is immutable after creation' using errcode='23514';
  end if;
  if new.result_note is distinct from old.result_note and
    (old.result_note is not null or new.status<>'analyzed' or old.status<>'ended' or nullif(trim(new.result_note),'') is null) then
    raise exception 'The result is written once at analysis' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger experiments_evidence_immutable before insert or update or delete on public.experiments for each row execute function app.timeline_experiment_evidence_guard();
