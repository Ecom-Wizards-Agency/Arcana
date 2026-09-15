-- Replace service-owned provisional acceptance with one verified-user command.
-- Existing invitations retain their token and expiry. No Auth user is created.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create function pg_temp.team_auth_privilege_preflight()
returns void language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if not has_column_privilege(current_user, 'auth.users', 'id', 'SELECT')
     or not has_column_privilege(current_user, 'auth.users', 'email', 'SELECT')
     or not has_column_privilege(current_user, 'auth.users', 'email_confirmed_at', 'SELECT')
     or not has_any_column_privilege(current_user, 'auth.users', 'UPDATE') then
    raise exception using errcode = '42501',
      message = 'Migration owner needs canonical Auth identity SELECT and row-lock permission (UPDATE on id is sufficient)';
  end if;
end;
$$;
select pg_temp.team_auth_privilege_preflight();
drop function pg_temp.team_auth_privilege_preflight();

create function public.inspect_team_invitation(p_token_hash text)
returns jsonb language sql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('agencyName', o.name, 'email', i.email, 'role', i.role::text,
    'state', case when i.accepted_at is not null then 'accepted'
                  when i.revoked_at is not null then 'revoked'
                  when i.expires_at <= clock_timestamp() then 'expired'
                  else 'pending' end)
    from public.org_invitations i join public.orgs o on o.id = i.org_id
   where p_token_hash ~ '^[a-f0-9]{64}$' and i.token_hash = p_token_hash and i.role <> 'owner';
$$;

create function app.team_invitation_delivery_context(p_org_id uuid, p_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_invite public.org_invitations;
begin
  perform app.lock_org_manager(p_org_id);
  select * into v_invite from public.org_invitations
   where org_id = p_org_id and token_hash = p_token_hash for share;
  if not found or v_invite.accepted_at is not null or v_invite.revoked_at is not null
     or v_invite.expires_at <= clock_timestamp() or v_invite.role = 'owner' then
    raise exception using errcode = '42501', message = 'Invitation unavailable for delivery';
  end if;
  return jsonb_build_object('invitationId', v_invite.id, 'email', v_invite.email);
end;
$$;

create function app.accept_team_invitation(p_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_invite public.org_invitations; v_org_id uuid; v_issuer_role public.org_role;
  v_user_id uuid := auth.uid(); v_email text; v_confirmed_at timestamptz;
begin
  if v_user_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  select org_id into v_org_id from public.org_invitations where token_hash = p_token_hash;
  if not found then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || v_org_id::text, 0));
  select * into v_invite from public.org_invitations where token_hash = p_token_hash for update;
  if not found or v_invite.role = 'owner' then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  select lower(btrim(email)),email_confirmed_at into v_email,v_confirmed_at
    from auth.users where id = v_user_id for share;
  if not found or v_email is null or v_email <> lower(btrim(v_invite.email)) or v_confirmed_at is null then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  if v_invite.accepted_at is not null then
    -- Historical completed invitations may replay only for their original,
    -- still-present member. A provisional claim never grants membership.
    if v_invite.accepted_by is distinct from v_user_id or not exists (
      select 1 from public.org_members where org_id = v_org_id and user_id = v_user_id
    ) then
      raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
    end if;
    return jsonb_build_object('orgId', v_org_id, 'invitationId', v_invite.id, 'outcome', 'already_accepted');
  end if;
  select role into v_issuer_role from public.org_members
   where org_id = v_org_id and user_id = v_invite.invited_by for share;
  if v_issuer_role is null or v_issuer_role not in ('owner', 'admin')
     or v_invite.revoked_at is not null or v_invite.expires_at <= clock_timestamp()
     or exists (select 1 from public.org_members where org_id = v_org_id and user_id = v_user_id) then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  insert into public.org_members(org_id,user_id,role) values (v_org_id,v_user_id,v_invite.role);
  update public.org_invitations set accepted_by = v_user_id, accepted_at = clock_timestamp() where id = v_invite.id;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values (v_org_id,'user',v_user_id::text,'invitation.accepted','invitation',v_invite.id::text,
      jsonb_build_object('role',v_invite.role::text),'web');
  return jsonb_build_object('orgId', v_org_id, 'invitationId', v_invite.id, 'outcome', 'accepted');
end;
$$;

revoke all on function public.inspect_team_invitation(text) from public, anon, authenticated, service_role;
revoke all on function app.team_invitation_delivery_context(uuid,text) from public, anon, authenticated, service_role;
revoke all on function app.accept_team_invitation(text) from public, anon, authenticated, service_role;
grant execute on function public.inspect_team_invitation(text) to anon, authenticated;
grant execute on function app.team_invitation_delivery_context(uuid,text) to authenticated;
grant execute on function app.accept_team_invitation(text) to authenticated;
