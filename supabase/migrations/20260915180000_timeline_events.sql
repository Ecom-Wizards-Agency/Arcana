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

-- The database owns the lifecycle, including writes made outside the application.
-- Match EXPERIMENT_TRANSITIONS: forward analysis plus cancellation; never reopen.
create function app.timeline_experiment_evidence_guard() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if tg_op='DELETE' and pg_trigger_depth()>1 and not exists(select 1 from public.orgs where id=old.org_id) then return old; end if;
  if tg_op='DELETE' then raise exception 'Experiment evidence is append-only' using errcode='23514'; end if;
  if tg_op='INSERT' then
    if new.status not in ('planned','running') or new.result_note is not null then
      raise exception 'An experiment is born planned or running without a result' using errcode='23514';
    end if;
    if auth.uid() is not null then
      if new.created_by is distinct from auth.uid() then
        raise exception 'The experiment creator must match the authenticated actor' using errcode='42501';
      end if;
      new.created_at := now();
    end if;
    new.status_changed_at := new.created_at;
    return new;
  end if;
  if new.hypothesis is distinct from old.hypothesis then raise exception 'The hypothesis is immutable after creation' using errcode='23514'; end if;
  if new.status is distinct from old.status and not (
    (old.status='planned' and new.status in ('running','aborted')) or
    (old.status='running' and new.status in ('ended','aborted')) or
    (old.status='ended' and new.status in ('analyzed','aborted')) or
    (old.status='analyzed' and new.status='aborted')
  ) then
    raise exception 'Invalid experiment status transition: % -> %', old.status, new.status using errcode='23514';
  end if;
  -- A scheduled end may be supplied at creation. Thereafter it can only be
  -- recorded when closing the experiment; changing a closed window is refused.
  if new.end_at is distinct from old.end_at and not (
    old.status in ('planned','running') and new.status in ('ended','aborted')
  ) then raise exception 'The experiment end is recorded only when closing' using errcode='23514'; end if;
  if new.status is distinct from old.status and new.status in ('ended','aborted') then
    new.end_at := coalesce(new.end_at, greatest(now(),new.start_at));
  end if;
  if new.status in ('ended','analyzed','aborted') and new.end_at is null then
    raise exception 'A closed experiment requires an end date' using errcode='23514';
  end if;
  if new.result_note is distinct from old.result_note and
    (old.result_note is not null or new.status<>'analyzed' or old.status<>'ended' or nullif(btrim(new.result_note),'') is null) then
    raise exception 'The result is written once at analysis' using errcode='23514';
  end if;
  if new.status='analyzed' and nullif(btrim(new.result_note),'') is null then
    raise exception 'Analysis requires a result written with the status change' using errcode='23514';
  end if;
  new.status_changed_at := case when new.status is distinct from old.status then now() else old.status_changed_at end;
  return new;
end;
$$;
create trigger experiments_evidence_immutable before insert or update or delete on public.experiments for each row execute function app.timeline_experiment_evidence_guard();

alter table public.experiment_events add column system_actor jsonb;
-- Existing user and historical entries keep their original attribution.
alter table public.experiment_events add constraint experiment_events_one_actor
  check (system_actor is null or actor_id is null);

-- Authenticated callers cannot append invented transitions. The AFTER trigger
-- alone appends the real OLD/NEW pair, under the same statement/transaction.
revoke insert on public.experiment_events from authenticated;
drop policy experiment_events_insert on public.experiment_events;
create function app.timeline_experiment_append_status() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_actor uuid := auth.uid();
  v_note text;
  v_system_actor jsonb;
  v_job uuid;
begin
  if tg_op='UPDATE' and new.status is not distinct from old.status then return new; end if;
  -- Only trusted database callers may supply an actor when no JWT exists.
  -- A custom note/actor setting can never override an authenticated identity.
  if v_actor is null and current_setting('role',true)='authenticated' then
    raise exception 'An experiment status change requires an authenticated actor' using errcode='42501';
  end if;
  if tg_op='INSERT' then
    v_actor := coalesce(v_actor,new.created_by);
    v_note := 'Created';
  else
    v_actor := coalesce(v_actor,nullif(current_setting('app.experiment_actor',true),'')::uuid);
    v_note := nullif(current_setting('app.experiment_note',true),'');
  end if;
  if v_actor is null then
    -- Never infer a system identity from a user-supplied role or a made-up id.
    -- The service role must identify an existing job for this exact scope.
    if current_setting('role',true) in ('authenticated','anon') or not app.is_service_role() then
      raise exception 'Only the service role may record a system experiment actor' using errcode='42501';
    end if;
    v_job := nullif(current_setting('app.experiment_job',true),'')::uuid;
    select jsonb_build_object('role','service_role','jobId',job.id,'jobType',job.job_type::text)
      into v_system_actor from public.sync_jobs job
      where job.id=v_job and job.org_id=new.org_id and job.profile_id=new.profile_id;
    if v_system_actor is null then
      raise exception 'An experiment status change requires a user actor or a scoped system job' using errcode='23514';
    end if;
  end if;
  insert into public.experiment_events(experiment_id,org_id,from_status,to_status,note,actor_id,system_actor,created_at)
    values(new.id,new.org_id,case when tg_op='UPDATE' then old.status else null end,new.status,v_note,v_actor,v_system_actor,new.status_changed_at);
  return new;
end;
$$;
revoke all on function app.timeline_experiment_append_status() from public,anon,authenticated;
create trigger experiments_append_status after insert or update on public.experiments for each row execute function app.timeline_experiment_append_status();

-- Invoker privileges preserve experiment RLS. Settings are scoped to this call
-- and restored, even when several commands share the application's transaction.
-- No status, date or result invariants live here: direct SQL uses the same guard.
create function app.transition_timeline_experiment(
  p_org uuid, p_id uuid, p_status public.experiment_status, p_note text,
  p_result text, p_result_provided boolean, p_actor uuid, p_job uuid default null
) returns uuid language plpgsql set search_path=pg_catalog as $$
declare
  v_id uuid;
  v_note text := current_setting('app.experiment_note',true);
  v_actor text := current_setting('app.experiment_actor',true);
  v_job text := current_setting('app.experiment_job',true);
begin
  perform set_config('app.experiment_note',coalesce(p_note,''),true);
  perform set_config('app.experiment_actor',coalesce(p_actor::text,''),true);
  perform set_config('app.experiment_job',coalesce(p_job::text,''),true);
  update public.experiments set status=p_status,
    result_note=case when p_result_provided then p_result else result_note end
    where org_id=p_org and id=p_id returning id into v_id;
  perform set_config('app.experiment_note',coalesce(v_note,''),true);
  perform set_config('app.experiment_actor',coalesce(v_actor,''),true);
  perform set_config('app.experiment_job',coalesce(v_job,''),true);
  return v_id;
end;
$$;
revoke all on function app.transition_timeline_experiment(uuid,uuid,public.experiment_status,text,text,boolean,uuid,uuid) from public,anon;
grant execute on function app.transition_timeline_experiment(uuid,uuid,public.experiment_status,text,text,boolean,uuid,uuid) to authenticated,service_role;
