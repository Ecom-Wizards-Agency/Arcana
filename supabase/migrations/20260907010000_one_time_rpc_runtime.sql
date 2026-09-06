set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Managed migration principals can administer this role without inheriting its
-- function ownership. Borrow only our own grantor edge for this transaction and
-- verify the original authority is restored before the migration can complete.
create temporary table one_time_runtime_ownership_before on commit drop as
select current_user::text as operator_name,
       coalesce((select jsonb_agg(to_jsonb(m) order by m.roleid, m.member, m.grantor)
         from pg_catalog.pg_auth_members m
        where m.roleid = 'openspell_recommendation_executor'::regrole
           or m.member = 'openspell_recommendation_executor'::regrole), '[]'::jsonb) as memberships,
       (select jsonb_agg(jsonb_build_object('oid', n.oid, 'acl', n.nspacl) order by n.oid)
          from pg_catalog.pg_namespace n where n.nspname in ('public', 'app')) as schema_acls;

create function pg_temp.one_time_runtime_ownership_preflight()
returns void language plpgsql set search_path = pg_catalog, pg_temp as $ownership_preflight$
begin
  if exists (select 1 from pg_catalog.pg_auth_members m
    where m.roleid = 'openspell_recommendation_executor'::regrole
      and m.member = current_user::regrole and m.grantor = current_user::regrole) then
    raise exception 'one-time migration refuses an existing self-granted ownership edge';
  end if;
  if pg_catalog.has_schema_privilege('openspell_recommendation_executor', 'public', 'CREATE') then
    raise exception 'one-time migration refuses unexpected executor schema creation authority';
  end if;
end;
$ownership_preflight$;
select pg_temp.one_time_runtime_ownership_preflight();
drop function pg_temp.one_time_runtime_ownership_preflight();
grant openspell_recommendation_executor to current_user
  with inherit true, set true granted by current_user;
grant create on schema public to openspell_recommendation_executor;

-- One-time producers require a compatible, available fenced worker. This migration
-- does not activate the lane, alter its authorized revision, or enable schedules.
create table app.recommendation_runtime_state (
  singleton boolean primary key default true check (singleton),
  worker_id text not null check (worker_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  revision text not null check (revision ~ '^[0-9a-f]{40}$'),
  authority_epoch bigint not null,
  execution_versions integer[] not null,
  ready boolean not null,
  observed_at timestamptz not null
);
revoke all on app.recommendation_runtime_state from public, anon, authenticated, service_role;
grant select, insert, update on app.recommendation_runtime_state to openspell_recommendation_executor;

create function public.report_recommendation_runtime(
  p_worker_id text, p_revision text, p_execution_versions integer[], p_ready boolean
)
returns void language plpgsql security definer
set search_path = pg_catalog, app as $$
declare v_authority record;
begin
  perform app.assert_recommendation_worker('report_recommendation_runtime');
  if p_worker_id is null or p_worker_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$' or p_ready is null
     or p_execution_versions is null or cardinality(p_execution_versions) not between 1 and 2
     or array_position(p_execution_versions, null) is not null
     or not (p_execution_versions <@ array[1,2]) then
    raise exception 'invalid recommendation runtime report' using errcode = '22023';
  end if;
  select * into strict v_authority from app.recommendation_authority_snapshot();
  if v_authority.protocol <> 'fenced' or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation runtime revision is not authorized' using errcode = '55000';
  end if;
  insert into app.recommendation_runtime_state
    (singleton, worker_id, revision, authority_epoch, execution_versions, ready, observed_at)
  values (true, p_worker_id, p_revision, v_authority.epoch, p_execution_versions, p_ready, clock_timestamp())
  on conflict (singleton) do update set worker_id = excluded.worker_id, revision = excluded.revision,
    authority_epoch = excluded.authority_epoch, execution_versions = excluded.execution_versions,
    ready = excluded.ready, observed_at = excluded.observed_at;
end;
$$;
alter function public.report_recommendation_runtime(text,text,integer[],boolean) owner to openspell_recommendation_executor;
revoke all on function public.report_recommendation_runtime(text,text,integer[],boolean) from public, anon, authenticated, service_role;
grant execute on function public.report_recommendation_runtime(text,text,integer[],boolean) to openspell_recommendation_worker;

create function public.get_one_time_recommendation_readiness(p_expected_revision text)
returns table (ready boolean, reason text)
language plpgsql stable security definer set search_path = pg_catalog, app as $$
declare
  v_authority app.recommendation_claim_authority;
  v_runtime app.recommendation_runtime_state;
begin
  select * into v_authority from app.recommendation_claim_authority where singleton;
  if not found or v_authority.protocol <> 'fenced' then
    return query select false, 'worker_not_activated'::text; return;
  end if;
  if v_authority.admission <> 'scoped' then
    return query select false, 'admission_paused'::text; return;
  end if;
  if p_expected_revision is null or v_authority.authorized_revision is distinct from p_expected_revision then
    return query select false, 'revision_mismatch'::text; return;
  end if;
  select * into v_runtime from app.recommendation_runtime_state where singleton;
  if not found or v_runtime.revision <> v_authority.authorized_revision
     or v_runtime.authority_epoch <> v_authority.epoch then
    return query select false, 'worker_unavailable'::text; return;
  end if;
  if not (2 = any(v_runtime.execution_versions)) then
    return query select false, 'execution_unsupported'::text; return;
  end if;
  if not v_runtime.ready or v_runtime.observed_at < statement_timestamp() - interval '60 seconds' then
    return query select false, 'worker_unavailable'::text; return;
  end if;
  return query select true, null::text;
end;
$$;
-- Keep this coarse read function under the migration owner, as with the existing
-- authority readers. The executor receives no direct authority-table privilege.
revoke all on function public.get_one_time_recommendation_readiness(text) from public, anon, authenticated;
grant execute on function public.get_one_time_recommendation_readiness(text) to service_role, openspell_recommendation_executor;

create function app.one_time_recommendation_worker_ready(p_worker_id text, p_revision text)
returns boolean language sql stable security invoker set search_path = pg_catalog, app as $$
  select coalesce((select readiness.ready and runtime.worker_id = p_worker_id
    from public.get_one_time_recommendation_readiness(p_revision) readiness
    cross join app.recommendation_runtime_state runtime where runtime.singleton), false);
$$;
revoke all on function app.one_time_recommendation_worker_ready(text,text) from public;
grant execute on function app.one_time_recommendation_worker_ready(text,text) to openspell_recommendation_executor;

create function app.guard_one_time_recommendation_admission()
returns trigger language plpgsql security definer set search_path = pg_catalog, app as $$
declare v_revision text; v_readiness record;
begin
  if new.job_type <> 'recommendations.run' or new.payload -> 'executionVersion' is distinct from '2'::jsonb then return new; end if;
  select authorized_revision into v_revision from app.recommendation_claim_authority where singleton for share;
  select * into v_readiness from public.get_one_time_recommendation_readiness(v_revision);
  if v_readiness.ready is distinct from true then
    raise exception 'one-time recommendation unavailable: %', v_readiness.reason using errcode = '55000';
  end if;
  return new;
end;
$$;
-- The admission trigger keeps the same owner boundary as the existing authority guards.
revoke all on function app.guard_one_time_recommendation_admission() from public;
create trigger sync_jobs_one_time_admission before insert on public.sync_jobs
  for each row execute function app.guard_one_time_recommendation_admission();
create constraint trigger sync_jobs_one_time_admission_validate after insert on public.sync_jobs
  deferrable initially deferred for each row execute function app.guard_one_time_recommendation_admission();

-- Only new claims use runtime availability. Expiry must not invalidate an
-- existing claim's resume, input reads, completion, observation, or settlement.
create or replace function public.claim_recommendation_jobs_fenced(
  p_worker_id text,
  p_revision text,
  p_limit integer
)
returns table (
  id uuid,
  org_id uuid,
  profile_id uuid,
  job_type text,
  payload jsonb,
  attempts integer,
  max_attempts integer,
  dedupe_key text,
  claimed_by text,
  claim_token uuid
)
language plpgsql
security definer
set search_path = pg_catalog, public, app, pg_temp
as $$
declare
  v_authority record;
  v_active integer;
begin
  perform app.assert_recommendation_worker('claim_recommendation_jobs_fenced');
  if p_worker_id is null or pg_catalog.btrim(p_worker_id) = ''
     or pg_catalog.length(p_worker_id) > 128
     or p_revision is null or p_revision !~ '^[0-9a-f]{40}$'
     or p_limit is distinct from 1 then
    raise exception 'recommendation claim identity, revision or limit is invalid'
      using errcode = '22023';
  end if;
  select * into v_authority from app.recommendation_authority_claim_snapshot();
  if v_authority.protocol <> 'fenced'
     or v_authority.authorized_revision is distinct from p_revision then
    raise exception 'recommendation fenced claim authority does not match this worker'
      using errcode = '55000';
  end if;
  if v_authority.admission <> 'scoped' then
    return;
  end if;
  select pg_catalog.count(*)::integer into v_active
    from public.sync_jobs job
   where job.job_type = 'recommendations.run'
     and (job.status = 'running' or job.claim_token is not null);
  if v_active <> 0 then
    return;
  end if;

  return query
  update public.sync_jobs job
     set status = 'running', claimed_by = p_worker_id, claimed_at = now(),
         claim_token = pg_catalog.gen_random_uuid(),
         started_at = coalesce(job.started_at, now()), attempts = job.attempts + 1,
         updated_at = now()
   where job.id = (
     select candidate.id
       from public.sync_jobs candidate
      where candidate.job_type = 'recommendations.run'
        and candidate.status = 'queued'
        and candidate.claim_token is null
        and candidate.run_after <= now()
        and app.recommendation_job_scope_is_current(candidate.id)
        and (candidate.payload -> 'executionVersion' is distinct from '2'::jsonb
          or app.one_time_recommendation_worker_ready(p_worker_id, p_revision))
      order by candidate.priority desc, candidate.run_after, candidate.created_at
      limit 1 for update skip locked
   )
  returning job.id, job.org_id, job.profile_id, job.job_type::text, job.payload,
            job.attempts, job.max_attempts, job.dedupe_key, job.claimed_by,
            job.claim_token;
end;
$$;

revoke create on schema public from openspell_recommendation_executor;
revoke openspell_recommendation_executor from current_user granted by current_user;

create function pg_temp.one_time_runtime_ownership_postflight()
returns void language plpgsql set search_path = pg_catalog, pg_temp as $ownership_postflight$
declare v_before record; v_memberships jsonb; v_schema_acls jsonb;
begin
  select * into strict v_before from pg_temp.one_time_runtime_ownership_before;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid, m.member, m.grantor), '[]'::jsonb)
    into v_memberships from pg_catalog.pg_auth_members m
   where m.roleid = 'openspell_recommendation_executor'::regrole
      or m.member = 'openspell_recommendation_executor'::regrole;
  select jsonb_agg(jsonb_build_object('oid', n.oid, 'acl', n.nspacl) order by n.oid)
    into v_schema_acls from pg_catalog.pg_namespace n where n.nspname in ('public', 'app');
  if current_user <> v_before.operator_name or v_memberships is distinct from v_before.memberships
     or v_schema_acls is distinct from v_before.schema_acls then
    raise exception 'one-time migration ownership authority was not restored';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_proc p
     where p.oid = 'public.report_recommendation_runtime(text,text,integer[],boolean)'::regprocedure
       and p.proowner = 'openspell_recommendation_executor'::regrole
       and pg_catalog.has_function_privilege('openspell_recommendation_worker', p.oid, 'EXECUTE')
       and not exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
         where acl.grantee not in (p.proowner, 'openspell_recommendation_worker'::regrole)
            or acl.grantor <> p.proowner or acl.privilege_type <> 'EXECUTE' or acl.is_grantable)
  ) then
    raise exception 'one-time runtime reporter ACL does not match the worker-only contract';
  end if;
end;
$ownership_postflight$;
select pg_temp.one_time_runtime_ownership_postflight();
drop function pg_temp.one_time_runtime_ownership_postflight();
