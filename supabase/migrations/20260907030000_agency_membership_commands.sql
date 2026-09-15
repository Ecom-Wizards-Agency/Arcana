-- Agency member administration: current identity, atomic role checks and audit.
-- No organization or owner is provisioned by this migration.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Shared lock order for member changes and invitations: organization advisory
-- lock, acting membership FOR SHARE, then target row. FOR SHARE also blocks a
-- concurrent role downgrade; FOR KEY SHARE would only protect the row identity.
create function app.lock_org_manager(p_org_id uuid)
returns public.org_role
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_role public.org_role;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || p_org_id::text, 0));
  select role into v_role from public.org_members
   where org_id = p_org_id and user_id = auth.uid() for share;
  if v_role is null or v_role not in ('owner', 'admin') then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  return v_role;
end;
$$;

create function app.list_org_members(p_org_id uuid)
returns table(user_id uuid, email text, role text, created_at timestamptz, updated_at timestamptz)
language sql stable security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select m.user_id, u.email::text, m.role::text, m.created_at, m.updated_at
    from public.org_members m join auth.users u on u.id = m.user_id
   where m.org_id = p_org_id
     and app.has_org_role(p_org_id, array['owner', 'admin'])
   order by lower(u.email) nulls last, m.created_at, m.user_id;
$$;

create function app.issue_team_invitation(
  p_org_id uuid, p_email text, p_role public.org_role, p_token_hash text, p_token_prefix text
) returns uuid
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_email text := lower(btrim(p_email)); v_id uuid;
begin
  perform app.lock_org_manager(p_org_id);
  if p_role is null or p_role = 'owner' then
    raise exception using errcode = '22023', message = 'Invitations may grant admin, analyst, or viewer access.';
  end if;
  if v_email is null or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_token_prefix is null or p_token_prefix !~ '^[A-Za-z0-9_-]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid invitation.';
  end if;
  if exists (
    select 1 from public.org_members m join auth.users u on u.id = m.user_id
     where m.org_id = p_org_id and lower(u.email) = v_email
  ) then
    raise exception using errcode = '23505', message = 'That address is already a member.';
  end if;
  if exists (
    select 1 from public.org_invitations where org_id = p_org_id and email = v_email
      and accepted_at is null and revoked_at is null and expires_at > now()
  ) then
    raise exception using errcode = '23505', message = 'That address already has a pending invitation.';
  end if;
  insert into public.org_invitations
    (org_id, email, role, token_hash, token_prefix, invited_by, expires_at)
  values (p_org_id, v_email, p_role, p_token_hash, p_token_prefix, auth.uid(), now() + interval '7 days')
  returning id into strict v_id;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
  values (p_org_id, 'user', auth.uid()::text, 'invitation.created', 'org_invitation', v_id::text,
    jsonb_build_object('email', v_email, 'role', p_role::text), 'web');
  return v_id;
end;
$$;

create function app.revoke_team_invitation(p_org_id uuid, p_invitation_id uuid)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_id uuid;
begin
  perform app.lock_org_manager(p_org_id);
  update public.org_invitations set revoked_at = now()
   where org_id = p_org_id and id = p_invitation_id and accepted_at is null
     and revoked_at is null and expires_at > now()
   returning id into v_id;
  if v_id is null then return false; end if;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, source)
  values (p_org_id, 'user', auth.uid()::text, 'invitation.revoked', 'org_invitation', v_id::text, 'web');
  return true;
end;
$$;

create function app.change_org_member_role(p_org_id uuid, p_user_id uuid, p_role public.org_role)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_actor_role public.org_role; v_old_role public.org_role;
begin
  v_actor_role := app.lock_org_manager(p_org_id);
  if p_role is null then raise exception using errcode = '22023', message = 'Invalid role.'; end if;
  select role into v_old_role from public.org_members
   where org_id = p_org_id and user_id = p_user_id for update;
  if v_old_role is null then return 0; end if;
  if (v_old_role = 'owner' or p_role = 'owner') and v_actor_role <> 'owner' then
    raise exception using errcode = '42501', message = 'Only an owner can change agency ownership.';
  end if;
  if v_old_role = p_role then return 0; end if;
  if v_old_role = 'owner' and not exists (
    select 1 from public.org_members where org_id = p_org_id and user_id <> p_user_id and role = 'owner'
  ) then return 0; end if;
  update public.org_members set role = p_role where org_id = p_org_id and user_id = p_user_id;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
  values (p_org_id, 'user', auth.uid()::text, 'member.role_changed', 'org_member', p_user_id::text,
    jsonb_build_object('from', v_old_role::text, 'to', p_role::text), 'web');
  return 1;
end;
$$;

create function app.remove_org_member(p_org_id uuid, p_user_id uuid)
returns integer
language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_actor_role public.org_role; v_old_role public.org_role;
begin
  v_actor_role := app.lock_org_manager(p_org_id);
  if p_user_id = auth.uid() then return 0; end if;
  select role into v_old_role from public.org_members
   where org_id = p_org_id and user_id = p_user_id for update;
  if v_old_role is null then return 0; end if;
  if v_old_role = 'owner' and v_actor_role <> 'owner' then
    raise exception using errcode = '42501', message = 'Only an owner can change agency ownership.';
  end if;
  if v_old_role = 'owner' and not exists (
    select 1 from public.org_members where org_id = p_org_id and user_id <> p_user_id and role = 'owner'
  ) then return 0; end if;
  delete from public.org_members where org_id = p_org_id and user_id = p_user_id;
  insert into public.audit_log
    (org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
  values (p_org_id, 'user', auth.uid()::text, 'member.removed', 'org_member', p_user_id::text,
    jsonb_build_object('role', v_old_role::text), 'web');
  return 1;
end;
$$;

-- Browser callers cannot bypass owner restrictions, final-owner protection,
-- current manager checks or audit by writing the underlying tables directly.
-- Existing service-owned invitation acceptance is migrated separately.
revoke insert, update, delete on public.org_members, public.org_invitations from authenticated;
drop policy org_members_insert on public.org_members;
drop policy org_members_update on public.org_members;
drop policy org_members_delete on public.org_members;
drop policy org_invitations_insert on public.org_invitations;
drop policy org_invitations_update on public.org_invitations;
drop policy org_invitations_delete on public.org_invitations;
revoke all on function app.lock_org_manager(uuid) from public, anon, authenticated, service_role;
revoke all on function app.list_org_members(uuid) from public, anon, authenticated, service_role;
revoke all on function app.issue_team_invitation(uuid,text,public.org_role,text,text) from public, anon, authenticated, service_role;
revoke all on function app.revoke_team_invitation(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function app.change_org_member_role(uuid,uuid,public.org_role) from public, anon, authenticated, service_role;
revoke all on function app.remove_org_member(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function app.list_org_members(uuid) to authenticated;
grant execute on function app.issue_team_invitation(uuid,text,public.org_role,text,text) to authenticated;
grant execute on function app.revoke_team_invitation(uuid,uuid) to authenticated;
grant execute on function app.change_org_member_role(uuid,uuid,public.org_role) to authenticated;
grant execute on function app.remove_org_member(uuid,uuid) to authenticated;
