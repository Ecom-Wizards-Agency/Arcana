-- Preserve all-member feedback participation while holding current authority.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.lock_feedback_member(p_org_id uuid)
returns public.org_role
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_role public.org_role;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-members:' || p_org_id::text, 0));
  select member.role into v_role from public.org_members as member
   where member.org_id = p_org_id and member.user_id = auth.uid() for share;
  if v_role is null then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  return v_role;
end;
$$;
revoke all on function app.lock_feedback_member(uuid) from public, anon, service_role;
grant execute on function app.lock_feedback_member(uuid) to authenticated;

-- Keep legacy default-new inserts. Product feature requests enter as planned;
-- this addition grants neither bug triage nor any new UPDATE/DELETE permission.
alter policy feedback_insert_own on public.feedback_items
  with check (
    app.is_org_member(org_id)
    and author_id = auth.uid()
    and (status = 'new' or (type = 'feature' and status = 'planned'))
    and admin_note is null
  );
