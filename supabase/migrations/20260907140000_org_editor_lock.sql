-- Current editor authority for one authenticated application transaction.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.lock_org_editor(p_org_id uuid)
returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_role public.org_role;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  -- Match member administration's lock order. Hold both locks until the
  -- caller's whole transaction ends, including tag hierarchy/count changes.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-members:' || p_org_id::text, 0));
  select member.role into v_role from public.org_members as member
   where member.org_id = p_org_id and member.user_id = auth.uid() for share;
  if v_role is null or v_role not in ('owner', 'admin', 'analyst') then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
end;
$$;

revoke all on function app.lock_org_editor(uuid) from public, anon, service_role;
grant execute on function app.lock_org_editor(uuid) to authenticated;
