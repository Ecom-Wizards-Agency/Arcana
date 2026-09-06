create type public.experiment_type as enum (
  'bid_push', 'creative', 'listing_content', 'price', 'placement', 'other'
);
comment on type public.experiment_type is
  'What kind of change the test is. bid_push/placement are ads levers; creative/listing_content/price are catalog levers whose ad-facts move only indirectly.';

create type public.experiment_metric as enum ('acos', 'cvr', 'ctr', 'sales', 'share');
comment on type public.experiment_metric is
  'The metric the experiment is trying to move. The comparison view leads with it.';

create type public.experiment_status as enum (
  'planned', 'running', 'ended', 'analyzed', 'aborted'
);
comment on type public.experiment_status is
  'planned -> running -> ended -> analyzed, or aborted from anywhere. end_at is null while running; the comparison view has no after-window until it is set.';

create table public.experiments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  profile_id uuid not null references public.ad_profiles (id) on delete cascade,
  name text not null,
  hypothesis text not null default '',
  type public.experiment_type not null,
  scope jsonb not null default '{}'::jsonb,
  metric_focus public.experiment_metric not null,
  start_at timestamptz not null default now(),
  end_at timestamptz,
  status public.experiment_status not null default 'planned',
  result_note text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  constraint experiments_name_length check (char_length(btrim(name)) between 1 and 200),
  constraint experiments_hypothesis_length check (char_length(hypothesis) <= 20000),
  constraint experiments_result_note_length check (result_note is null or char_length(result_note) <= 20000),
  constraint experiments_window_order check (end_at is null or end_at >= start_at)
);
comment on table public.experiments is
  'Deliberate tests, tracked as first-class records so their windows shade every chart and their outcomes are measurable in the facts. Org-scoped.';

alter table public.experiments add constraint experiments_id_org_key unique (id, org_id);

create index experiments_org_status_idx on public.experiments (org_id, status, start_at desc);
create index experiments_profile_window_idx on public.experiments (profile_id, start_at desc);
create index experiments_created_by_idx on public.experiments (created_by);

create trigger experiments_touch before update on public.experiments
  for each row execute function app.touch_updated_at();

create or replace function app.experiment_touch_status_changed()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  return new;
end;
$$;

create trigger experiments_status_changed before update on public.experiments
  for each row execute function app.experiment_touch_status_changed();

create or replace function app.experiment_guard_update()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if app.is_service_role() then return new; end if;
  if app.has_org_role(new.org_id, array['owner', 'admin']) then return new; end if;
  if new.org_id is distinct from old.org_id
     or new.profile_id is distinct from old.profile_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'only an owner or admin may move an experiment between profiles, tenants or authors'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
comment on function app.experiment_guard_update() is
  'Column-level authorization for experiments: RLS decides who may write a row, this decides what they may change.';

create trigger experiments_guard before update on public.experiments
  for each row execute function app.experiment_guard_update();

alter table public.experiments enable row level security;

create policy tenant_read on public.experiments for select to authenticated
  using (app.is_org_member(org_id));
create policy experiments_insert_own on public.experiments for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid());
create policy experiments_admin_update on public.experiments for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']))
  with check (app.has_org_role(org_id, array['owner', 'admin']));
create policy experiments_creator_update on public.experiments for update to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid())
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid());
create policy experiments_admin_delete on public.experiments for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin']));
create policy experiments_creator_delete on public.experiments for delete to authenticated
  using (app.has_org_role(org_id, array['owner', 'admin', 'analyst']) and created_by = auth.uid());

revoke all on public.experiments from anon;
grant select, insert, update, delete on public.experiments to authenticated;
grant all on public.experiments to service_role;

create table public.experiment_events (
  id bigint generated always as identity primary key,
  experiment_id uuid not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  from_status public.experiment_status,
  to_status public.experiment_status not null,
  note text,
  actor_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint experiment_events_note_length check (note is null or char_length(note) <= 20000),
  constraint experiment_events_experiment_fkey foreign key (experiment_id, org_id)
    references public.experiments (id, org_id) on delete cascade
);
comment on table public.experiment_events is
  'Append-only log of an experiment''s status transitions, so the detail page can show a timeline of who moved it when.';

create index experiment_events_experiment_idx on public.experiment_events (org_id, experiment_id, created_at);

alter table public.experiment_events enable row level security;

create policy tenant_read on public.experiment_events for select to authenticated
  using (app.is_org_member(org_id));
create policy experiment_events_insert on public.experiment_events for insert to authenticated
  with check (app.has_org_role(org_id, array['owner', 'admin', 'analyst']));

revoke all on public.experiment_events from anon;
grant select, insert on public.experiment_events to authenticated;
grant all on public.experiment_events to service_role;;
