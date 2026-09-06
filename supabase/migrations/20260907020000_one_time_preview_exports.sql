set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- One-time runs are reviewable. Their observation policy does not yet support
-- the export lifecycle; prevent entry until that separately verified workflow lands.
create function app.guard_one_time_preview_export()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if tg_table_name = 'recommendations' then
    if tg_op = 'UPDATE' then
      if (new.org_id, new.profile_id, new.run_id) is distinct from (old.org_id, old.profile_id, old.run_id)
        and exists (
          select 1 from public.recommendation_runs run
           where run.scope_version = 2 and (
             (run.org_id = old.org_id and run.profile_id = old.profile_id and run.id = old.run_id)
             or (run.org_id = new.org_id and run.profile_id = new.profile_id and run.id = new.run_id)
           )
        ) then
        raise exception 'One-time preview recommendation provenance is immutable.' using errcode = '23514';
      end if;
    end if;
    if (new.status in ('exported', 'applied') or new.export_batch_id is not null) and exists (
      select 1 from public.recommendation_runs run
       where run.org_id = new.org_id and run.profile_id = new.profile_id and run.id = new.run_id and run.scope_version = 2
    ) then
      raise exception 'One-time preview export awaits observation support.' using errcode = '23514';
    end if;
  elsif new.recommendation_id is not null and exists (
    select 1 from public.recommendations recommendation
    join public.recommendation_runs run on run.id = recommendation.run_id
      and run.org_id = recommendation.org_id and run.profile_id = recommendation.profile_id
    where recommendation.org_id = new.org_id and recommendation.profile_id = new.profile_id
      and recommendation.id = new.recommendation_id and run.scope_version = 2
  ) then
    raise exception 'One-time preview export awaits observation support.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_one_time_preview_export() from public;
create trigger recommendations_one_time_export_guard
  before insert or update on public.recommendations
  for each row execute function app.guard_one_time_preview_export();
create trigger apply_rows_one_time_export_guard
  before insert or update of org_id, profile_id, recommendation_id on public.apply_rows
  for each row execute function app.guard_one_time_preview_export();
