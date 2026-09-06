-- Correct WP-196's owner-before-ACL installation on managed PostgreSQL.
-- Preserve the applied migration and its historical bundle pins. This additive
-- repair is a separately reviewed scope, outside the ten-file write window.
-- Run the complete file in one transaction, as the migration session principal.

set local lock_timeout = '5s';
select pg_advisory_xact_lock(
  pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0)
);
set local statement_timeout = '30s';
set local search_path = pg_catalog, pg_temp;

create temporary table recommendation_acl_repair_before on commit drop as
select current_user::text as operator_name,
       coalesce((
         select jsonb_agg(to_jsonb(m) order by m.roleid, m.member, m.grantor)
           from pg_catalog.pg_auth_members m
          where m.roleid in ('openspell_recommendation_executor'::regrole,
                             'openspell_recommendation_worker'::regrole)
             or m.member in ('openspell_recommendation_executor'::regrole,
                             'openspell_recommendation_worker'::regrole)
       ), '[]'::jsonb) as memberships,
       coalesce((
         select jsonb_agg(to_jsonb(p) - 'proacl' order by p.oid)
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname in (
            'claim_recommendation_jobs_fenced', 'defer_recommendation_job_fenced',
            'fail_recommendation_run_fenced', 'finish_recommendation_job_fenced',
            'read_recommendation_inputs_fenced', 'resume_recommendation_jobs_fenced',
            'start_recommendation_run_fenced', 'succeed_recommendation_run_fenced'
          )
       ), '[]'::jsonb) as functions;

create function app.repair_recommendation_acl_preflight()
returns void language plpgsql
as $preflight$
declare
  v_expected oid[] := array[
    to_regprocedure('public.claim_recommendation_jobs_fenced(text,text,integer)')::oid,
    to_regprocedure('public.defer_recommendation_job_fenced(uuid,text,uuid,text,interval)')::oid,
    to_regprocedure('public.fail_recommendation_run_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid,text)')::oid,
    to_regprocedure('public.finish_recommendation_job_fenced(uuid,text,uuid,text,public.sync_job_status,text,jsonb,interval)')::oid,
    to_regprocedure('public.read_recommendation_inputs_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid,date,date)')::oid,
    to_regprocedure('public.resume_recommendation_jobs_fenced(text,text)')::oid,
    to_regprocedure('public.start_recommendation_run_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid)')::oid,
    to_regprocedure('public.succeed_recommendation_run_fenced(uuid,text,uuid,text,uuid,uuid,uuid,uuid,jsonb)')::oid
  ];
begin
  if current_user <> session_user then
    raise exception 'ACL repair requires the original migration session role';
  end if;
  if array_position(v_expected, null) is not null
     or (select jsonb_array_length(functions)
           from pg_temp.recommendation_acl_repair_before) <> 8
     or (select count(*) from pg_catalog.pg_proc p
          where p.oid = any(v_expected)
            and p.proowner = 'openspell_recommendation_executor'::regrole
            and p.prosecdef) <> 8 then
    raise exception 'ACL repair requires exactly the eight executor-owned fenced signatures';
  end if;
  if (select count(*) from pg_catalog.pg_roles
       where rolname in ('openspell_recommendation_executor', 'openspell_recommendation_worker')
         and not (rolcanlogin or rolinherit or rolsuper or rolcreatedb or rolcreaterole
                  or rolreplication or rolbypassrls)) <> 2 then
    raise exception 'ACL repair refuses unsafe recommendation role attributes';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members m
     where m.member in ('openspell_recommendation_executor'::regrole,
                        'openspell_recommendation_worker'::regrole)
        or (m.roleid in ('openspell_recommendation_executor'::regrole,
                        'openspell_recommendation_worker'::regrole)
            and (m.member <> current_user::regrole or m.inherit_option or m.set_option))
  ) then
    raise exception 'ACL repair refuses unexpected recommendation role membership';
  end if;
  if exists (
    select 1 from pg_catalog.pg_auth_members m
     where m.roleid = 'openspell_recommendation_executor'::regrole
       and m.member = current_user::regrole and m.grantor = current_user::regrole
  ) then
    raise exception 'ACL repair refuses to replace a pre-existing self-granted membership';
  end if;
  if not (select rolsuper from pg_catalog.pg_roles where rolname = current_user)
     and not exists (
       select 1 from pg_catalog.pg_auth_members m
        where m.roleid = 'openspell_recommendation_executor'::regrole
          and m.member = current_user::regrole and m.admin_option
     ) then
    raise exception 'ACL repair needs existing executor ADMIN authority or a superuser';
  end if;
  if not has_schema_privilege('openspell_recommendation_worker', 'public', 'USAGE') then
    raise exception 'ACL repair requires the existing worker schema grant';
  end if;

  -- ADMIN can grant SET authority without granting inherited privileges. Keep
  -- the platform's ADMIN-only edge untouched; remove only our own edge below.
  execute format(
    'grant openspell_recommendation_executor to %I with inherit false, set true granted by %I',
    current_user, current_user
  );
end;
$preflight$;
select app.repair_recommendation_acl_preflight();
drop function app.repair_recommendation_acl_preflight();

create function app.repair_recommendation_acl_apply()
returns void language plpgsql
as $repair$
declare
  v_function record;
  v_count integer := 0;
begin
  for v_function in
    select p.oid::regprocedure as signature
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'claim_recommendation_jobs_fenced', 'defer_recommendation_job_fenced',
       'fail_recommendation_run_fenced', 'finish_recommendation_job_fenced',
       'read_recommendation_inputs_fenced', 'resume_recommendation_jobs_fenced',
       'start_recommendation_run_fenced', 'succeed_recommendation_run_fenced'
     )
  loop
    execute format('grant execute on function %s to openspell_recommendation_worker',
                   v_function.signature);
    execute format('revoke all on function %s from public, anon, authenticated, service_role',
                   v_function.signature);
    v_count := v_count + 1;
  end loop;
  if v_count <> 8 then
    raise exception 'ACL repair function count changed';
  end if;
end;
$repair$;
revoke all on function app.repair_recommendation_acl_apply()
  from public, anon, authenticated, service_role;
grant execute on function app.repair_recommendation_acl_apply()
  to openspell_recommendation_executor;
set local role openspell_recommendation_executor;
select app.repair_recommendation_acl_apply();
reset role;
drop function app.repair_recommendation_acl_apply();
revoke openspell_recommendation_executor from current_user granted by current_user;

create function app.repair_recommendation_acl_postflight()
returns void language plpgsql
as $postflight$
declare
  v_before record;
  v_memberships jsonb;
  v_functions jsonb;
  v_valid integer;
begin
  select * into strict v_before from pg_temp.recommendation_acl_repair_before;
  select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid, m.member, m.grantor), '[]'::jsonb)
    into v_memberships from pg_catalog.pg_auth_members m
   where m.roleid in ('openspell_recommendation_executor'::regrole,
                      'openspell_recommendation_worker'::regrole)
      or m.member in ('openspell_recommendation_executor'::regrole,
                      'openspell_recommendation_worker'::regrole);
  select jsonb_agg(to_jsonb(p) - 'proacl' order by p.oid),
         count(*) filter (
           where has_function_privilege('openspell_recommendation_worker', p.oid, 'EXECUTE')
             and not has_function_privilege('anon', p.oid, 'EXECUTE')
             and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
             and not has_function_privilege('service_role', p.oid, 'EXECUTE')
             and exists (
               select 1 from aclexplode(p.proacl) a
                where a.grantee = 'openspell_recommendation_worker'::regrole
                  and a.grantor = p.proowner and a.privilege_type = 'EXECUTE'
                  and not a.is_grantable
             )
             and not exists (
               select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee not in (p.proowner, 'openspell_recommendation_worker'::regrole)
                   or a.grantor <> p.proowner or a.privilege_type <> 'EXECUTE' or a.is_grantable
             )
         ) into v_functions, v_valid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'claim_recommendation_jobs_fenced', 'defer_recommendation_job_fenced',
     'fail_recommendation_run_fenced', 'finish_recommendation_job_fenced',
     'read_recommendation_inputs_fenced', 'resume_recommendation_jobs_fenced',
     'start_recommendation_run_fenced', 'succeed_recommendation_run_fenced'
   );
  if current_user <> v_before.operator_name or v_memberships <> v_before.memberships
     or v_functions is distinct from v_before.functions or v_valid <> 8 then
    raise exception 'ACL repair postflight failed; transaction must roll back';
  end if;
end;
$postflight$;
select app.repair_recommendation_acl_postflight();
drop function app.repair_recommendation_acl_postflight();

select 8 as verified_fenced_functions, true as explicit_worker_grants,
       true as ambient_execute_revoked, true as original_memberships_restored;
