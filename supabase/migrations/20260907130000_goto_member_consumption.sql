-- Shared-link navigation may count a visit for any current member, including a
-- viewer, without granting that viewer general link-editing authority.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function app.consume_goto_link(p_org_id uuid, p_token text)
returns uuid
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_id uuid; v_expires_at timestamptz; v_now timestamptz;
begin
  -- Hold current membership through the update and the caller's authenticated
  -- read. Removal either wins this lock or waits for this visit to settle.
  perform m.user_id from public.org_members m
   where m.org_id = p_org_id and m.user_id = auth.uid() for share;
  if not found then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;

  select g.id, g.expires_at into v_id, v_expires_at
    from public.goto_links g
   where g.org_id = p_org_id and g.token = p_token for update;
  if not found then return null; end if;
  -- Evaluate expiry after contention, never using transaction-start time.
  v_now := clock_timestamp();
  if v_expires_at is not null and v_expires_at <= v_now then return null; end if;
  update public.goto_links
     set uses = uses + 1, last_used_at = v_now
   where id = v_id and org_id = p_org_id and token = p_token;
  return v_id;
end;
$$;

revoke all on function app.consume_goto_link(uuid, text) from public, anon, service_role;
grant execute on function app.consume_goto_link(uuid, text) to authenticated;
