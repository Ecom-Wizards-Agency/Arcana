set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
create function app.valid_dayparting_modifiers(value jsonb) returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare day jsonb; cell jsonb;
begin
  if jsonb_typeof(value)<>'array' or jsonb_array_length(value)<>7 then return false; end if;
  for day in select * from jsonb_array_elements(value) loop
    if jsonb_typeof(day)<>'array' or jsonb_array_length(day)<>24 then return false; end if;
    for cell in select * from jsonb_array_elements(day) loop
      if jsonb_typeof(cell)<>'number' or (cell::text)::numeric<>trunc((cell::text)::numeric) or (cell::text)::numeric not between -99 and 300 then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;
create table public.dayparting_schedules (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references public.orgs(id) on delete cascade,
  profile_id uuid not null, name text not null check(length(btrim(name)) between 1 and 200), timezone text not null,
  modifiers jsonb not null check(app.valid_dayparting_modifiers(modifiers)),
  status text not null default 'draft' check(status in ('draft','reviewed','enabled','paused')),
  reviewed_by uuid references auth.users(id), reviewed_at timestamptz, review_record jsonb,
  enabled_at timestamptz, paused_at timestamptz, source_proposal_id uuid references public.dayparting_schedule_proposals(id),
  next_run_at timestamptz, cadence_limits jsonb, profile_kill_switch boolean,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(org_id,profile_id,id),
  foreign key(org_id,profile_id) references public.ad_profiles(org_id,id) on delete cascade,
  check((status='draft' and reviewed_by is null and reviewed_at is null and review_record is null) or
    (status<>'draft' and reviewed_by is not null and reviewed_at is not null and review_record is not null))
);
create table public.dayparting_schedule_campaigns (
  org_id uuid not null, profile_id uuid not null, schedule_id uuid not null, campaign_id text not null,
  active boolean not null default false,
  primary key(schedule_id,campaign_id),
  foreign key(org_id,profile_id,schedule_id) references public.dayparting_schedules(org_id,profile_id,id) on delete cascade,
  foreign key(profile_id,campaign_id) references public.campaigns(profile_id,amazon_id) on delete cascade
);
create unique index dayparting_one_active_campaign on public.dayparting_schedule_campaigns(profile_id,campaign_id) where active;
alter table public.dayparting_schedules enable row level security;
alter table public.dayparting_schedule_campaigns enable row level security;
create policy tenant_read on public.dayparting_schedules for select to authenticated using(app.is_org_member(org_id));
create policy editor_insert on public.dayparting_schedules for insert to authenticated with check(app.has_org_role(org_id,array['owner','admin','analyst']) and status='draft');
create policy editor_update on public.dayparting_schedules for update to authenticated using(app.has_org_role(org_id,array['owner','admin','analyst']) and status in ('draft','reviewed')) with check(app.has_org_role(org_id,array['owner','admin','analyst']) and status in ('draft','reviewed'));
create policy tenant_read on public.dayparting_schedule_campaigns for select to authenticated using(app.is_org_member(org_id));
create policy editor_insert on public.dayparting_schedule_campaigns for insert to authenticated with check(app.has_org_role(org_id,array['owner','admin','analyst']) and not active and exists(select 1 from public.dayparting_schedules s where s.id=schedule_id and s.status='draft'));
create policy editor_delete on public.dayparting_schedule_campaigns for delete to authenticated using(app.has_org_role(org_id,array['owner','admin','analyst']) and not active and exists(select 1 from public.dayparting_schedules s where s.id=schedule_id and s.status='draft'));
revoke all on public.dayparting_schedules,public.dayparting_schedule_campaigns from anon,authenticated;
grant select,insert,update on public.dayparting_schedules to authenticated;
grant select,insert,delete on public.dayparting_schedule_campaigns to authenticated;
grant all on public.dayparting_schedules,public.dayparting_schedule_campaigns to service_role;

create function app.guard_dayparting_schedule() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if auth.uid() is not null or current_setting('role',true)='authenticated' then
    if new.status not in ('draft','reviewed') or new.enabled_at is not null or new.paused_at is not null or
       new.next_run_at is not null or new.cadence_limits is not null or new.profile_kill_switch is not null then
      raise exception 'Scheduled writes are not available yet' using errcode='42501';
    end if;
    if tg_op='UPDATE' and old.status not in ('draft','reviewed') then raise exception 'Execution-owned schedule' using errcode='42501'; end if;
    if new.status='reviewed' then
      if new.reviewed_by is distinct from auth.uid() or new.review_record->>'reviewedBy' is distinct from auth.uid()::text then
        raise exception 'Review actor mismatch' using errcode='42501';
      end if;
      if tg_op='UPDATE' and (new.modifiers is distinct from old.modifiers or new.timezone is distinct from old.timezone or new.name is distinct from old.name) then
        raise exception 'Save an edited schedule as draft before review' using errcode='23514';
      end if;
    end if;
  end if;
  if new.timezone is distinct from (select timezone from public.ad_profiles where id=new.profile_id and org_id=new.org_id) then raise exception 'Schedule timezone must match profile' using errcode='23514'; end if;
  if new.source_proposal_id is not null and not exists(select 1 from public.dayparting_schedule_proposals where id=new.source_proposal_id and profile_id=new.profile_id and org_id=new.org_id) then raise exception 'Proposal scope mismatch' using errcode='23514'; end if;
  new.updated_at := date_trunc('milliseconds',clock_timestamp());
  return new;
end;
$$;
create trigger dayparting_schedule_guard before insert or update on public.dayparting_schedules for each row execute function app.guard_dayparting_schedule();
create function app.sync_dayparting_active_assignments() returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  update public.dayparting_schedule_campaigns set active=(new.status='enabled') where schedule_id=new.id;
  return new;
end;
$$;
create trigger dayparting_active_assignments after update of status on public.dayparting_schedules for each row when (old.status is distinct from new.status) execute function app.sync_dayparting_active_assignments();
create function app.guard_dayparting_assignment() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  new.active := (select status='enabled' from public.dayparting_schedules where id=new.schedule_id);
  return new;
end;
$$;
create trigger dayparting_assignment_guard before insert or update on public.dayparting_schedule_campaigns for each row execute function app.guard_dayparting_assignment();

revoke all on function app.sync_dayparting_active_assignments() from public,anon,authenticated;
