-- Current member/invitation writes use the verified SECURITY DEFINER commands.
-- Retained older web builds must not claim invitations or add members through
-- their service-role table grants after those commands have been installed.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

revoke insert, update, delete on public.org_members, public.org_invitations from service_role;

-- Refuse PUBLIC/inherited authority that survives revocation. Check effective
-- table and column permissions rather than only the direct table ACL. Do not
-- widen this migration into unrelated grants or report a fence that cannot hold.
create function pg_temp.verify_membership_service_fence()
returns void language plpgsql set search_path = pg_catalog, pg_temp
as $$
declare v_relation regclass;
begin
  foreach v_relation in array array['public.org_members'::regclass, 'public.org_invitations'::regclass] loop
    if has_table_privilege('service_role', v_relation, 'INSERT,UPDATE,DELETE')
       or has_any_column_privilege('service_role', v_relation, 'INSERT,UPDATE') then
      raise exception using errcode = '42501',
        message = 'Service-role membership write authority remains; review inherited, PUBLIC, column grants and ownership';
    end if;
  end loop;
end;
$$;
select pg_temp.verify_membership_service_fence();
drop function pg_temp.verify_membership_service_fence();

-- Database owners and credentials with separate inherited authority remain
-- infrastructure operators. This does not constrain them, retire old deployment
-- URLs, or prove a hosted web credential actually runs with service_role rights.
