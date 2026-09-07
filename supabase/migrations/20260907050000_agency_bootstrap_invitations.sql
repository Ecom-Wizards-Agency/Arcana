-- Installation provisioning and first-owner acceptance are separate from team
-- invitations. This migration creates no agency, user, membership or setting.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Row locking canonical Auth identity needs SELECT plus UPDATE on at least one
-- column. Refuse before DDL if the migration/function owner cannot perform it.
-- Installation may grant UPDATE(id) to its migration owner; never grant it to
-- product roles. This migration does not alter platform-owned Auth privileges.
create function pg_temp.bootstrap_auth_privilege_preflight()
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
select pg_temp.bootstrap_auth_privilege_preflight();
drop function pg_temp.bootstrap_auth_privilege_preflight();

create table app.agency_bootstrap_invitations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  org_id uuid not null unique references public.orgs(id) on delete cascade,
  requested_name text not null,
  requested_slug text not null,
  owner_email text not null check (owner_email = lower(btrim(owner_email))),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  token_prefix text not null check (token_prefix ~ '^[A-Za-z0-9_-]{12}$'),
  generation integer not null default 1 check (generation > 0),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days'),
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (accepted_at is not null or accepted_by is null)
);
alter table app.agency_bootstrap_invitations enable row level security;
-- No direct table access, even for organization owners or the service role.
revoke all on app.agency_bootstrap_invitations from public, anon, authenticated, service_role;
create trigger agency_bootstrap_touch before update on app.agency_bootstrap_invitations
  for each row execute function app.touch_updated_at();

create function app.bootstrap_invitation_state(p_invite app.agency_bootstrap_invitations)
returns text language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  select case when p_invite.accepted_at is not null then 'accepted'
              when p_invite.revoked_at is not null then 'revoked'
              when p_invite.expires_at <= clock_timestamp() then 'expired'
              else 'pending' end;
$$;

create function app.bootstrap_provision_receipt(
  p_invite app.agency_bootstrap_invitations, p_outcome text, p_token_hash text
) returns jsonb language sql volatile
set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object(
    'requestId', p_invite.request_id, 'orgId', p_invite.org_id,
    'invitationId', p_invite.id, 'generation', p_invite.generation,
    'state', app.bootstrap_invitation_state(p_invite), 'outcome', p_outcome,
    'tokenMatches', p_invite.token_hash = p_token_hash
  );
$$;

create function app.provision_agency(
  p_request_id uuid, p_name text, p_slug text, p_email text,
  p_token_hash text, p_token_prefix text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_invite app.agency_bootstrap_invitations; v_org_id uuid;
begin
  perform app.assert_service_role('provision_agency');
  if p_request_id is null or p_name is null or p_name <> btrim(p_name)
     or length(p_name) not between 1 and 120
     or p_slug is null or length(p_slug) not between 2 and 63
     or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     or p_email is null or p_email <> lower(btrim(p_email))
     or length(p_email) > 320 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_token_prefix is null or p_token_prefix !~ '^[A-Za-z0-9_-]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid agency provisioning request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agency-provision:' || p_request_id::text, 0));
  select * into v_invite from app.agency_bootstrap_invitations
   where request_id = p_request_id for update;
  if found then
    if v_invite.requested_name <> p_name or v_invite.requested_slug <> p_slug
       or v_invite.owner_email <> p_email then
      raise exception using errcode = '22023', message = 'Provisioning request identity already used';
    end if;
    -- A retry never rotates the token. Lost raw tokens require explicit reissue.
    return app.bootstrap_provision_receipt(v_invite, 'existing', p_token_hash);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agency-slug:' || p_slug, 0));
  if exists (select 1 from public.orgs where slug = p_slug) then
    raise exception using errcode = '23505', message = 'Agency slug already exists';
  end if;
  insert into public.orgs(name, slug) values (p_name, p_slug) returning id into v_org_id;
  insert into app.agency_bootstrap_invitations
    (request_id, org_id, requested_name, requested_slug, owner_email, token_hash, token_prefix)
    values (p_request_id, v_org_id, p_name, p_slug, p_email, p_token_hash, p_token_prefix)
    returning * into v_invite;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (v_org_id, 'service', session_user::text, 'agency.provisioned', 'bootstrap_invitation',
      v_invite.id::text, jsonb_build_object('requestId', p_request_id, 'generation', 1), 'operator');
  return app.bootstrap_provision_receipt(v_invite, 'created', p_token_hash);
end;
$$;

create function app.reissue_bootstrap_invitation(
  p_request_id uuid, p_expected_generation integer, p_token_hash text, p_token_prefix text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_invite app.agency_bootstrap_invitations; v_org_id uuid;
begin
  perform app.assert_service_role('reissue_bootstrap_invitation');
  if p_request_id is null or p_expected_generation is null
     or p_expected_generation not between 1 and 2147483646
     or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_token_prefix is null or p_token_prefix !~ '^[A-Za-z0-9_-]{12}$' then
    raise exception using errcode = '22023', message = 'Invalid invitation reissue';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agency-provision:' || p_request_id::text, 0));
  select org_id into v_org_id from app.agency_bootstrap_invitations where request_id = p_request_id;
  if not found then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || v_org_id::text, 0));
  select * into v_invite from app.agency_bootstrap_invitations where request_id = p_request_id for update;
  if v_invite.accepted_at is not null
     or exists (select 1 from public.org_members where org_id = v_org_id) then
    raise exception using errcode = '22023', message = 'Agency ownership already established';
  end if;
  if v_invite.generation = p_expected_generation + 1 and v_invite.token_hash = p_token_hash
     and v_invite.token_prefix = p_token_prefix and v_invite.revoked_at is null then
    return app.bootstrap_provision_receipt(v_invite, 'existing', p_token_hash);
  end if;
  if v_invite.generation <> p_expected_generation or v_invite.token_hash = p_token_hash then
    raise exception using errcode = '22023', message = 'Invitation generation changed or token reused';
  end if;
  update app.agency_bootstrap_invitations set token_hash = p_token_hash, token_prefix = p_token_prefix,
      generation = generation + 1, expires_at = clock_timestamp() + interval '7 days', revoked_at = null
    where id = v_invite.id returning * into v_invite;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (v_org_id, 'service', session_user::text, 'agency.invitation_reissued', 'bootstrap_invitation',
      v_invite.id::text, jsonb_build_object('generation', v_invite.generation), 'operator');
  return app.bootstrap_provision_receipt(v_invite, 'reissued', p_token_hash);
end;
$$;

create function app.revoke_bootstrap_invitation(p_request_id uuid, p_expected_generation integer)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_invite app.agency_bootstrap_invitations; v_org_id uuid;
begin
  perform app.assert_service_role('revoke_bootstrap_invitation');
  if p_request_id is null or p_expected_generation is null or p_expected_generation < 1 then
    raise exception using errcode = '22023', message = 'Invalid invitation revocation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('agency-provision:' || p_request_id::text, 0));
  select org_id into v_org_id from app.agency_bootstrap_invitations where request_id = p_request_id;
  if not found then
    raise exception using errcode = '42501', message = 'Resource not found';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || v_org_id::text, 0));
  select * into v_invite from app.agency_bootstrap_invitations where request_id = p_request_id for update;
  if v_invite.generation <> p_expected_generation then
    raise exception using errcode = '22023', message = 'Invitation generation changed';
  end if;
  if v_invite.revoked_at is not null or v_invite.accepted_at is not null then return false; end if;
  update app.agency_bootstrap_invitations set revoked_at = clock_timestamp() where id = v_invite.id;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (v_org_id, 'service', session_user::text, 'agency.invitation_revoked', 'bootstrap_invitation',
      v_invite.id::text, jsonb_build_object('generation', v_invite.generation), 'operator');
  return true;
end;
$$;

create function app.bootstrap_delivery_context(p_request_id uuid, p_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_invite app.agency_bootstrap_invitations;
begin
  perform app.assert_service_role('bootstrap_delivery_context');
  select * into v_invite from app.agency_bootstrap_invitations
   where request_id = p_request_id and token_hash = p_token_hash;
  if not found or app.bootstrap_invitation_state(v_invite) <> 'pending' then
    raise exception using errcode = '42501', message = 'Invitation unavailable for delivery';
  end if;
  return jsonb_build_object('requestId', v_invite.request_id, 'generation', v_invite.generation,
    'ownerEmail', v_invite.owner_email);
end;
$$;

-- The sole anonymous capability takes the unguessable token digest. Keeping it
-- in public avoids granting anonymous schema access to other app functions.
create function public.inspect_agency_bootstrap_invitation(p_token_hash text)
returns jsonb language sql volatile security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object('agencyName', i.requested_name, 'ownerEmail', i.owner_email,
    'generation', i.generation, 'state', app.bootstrap_invitation_state(i))
    from app.agency_bootstrap_invitations i
   where p_token_hash ~ '^[a-f0-9]{64}$' and i.token_hash = p_token_hash;
$$;

create function app.accept_bootstrap_invitation(p_token_hash text)
returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_invite app.agency_bootstrap_invitations; v_org_id uuid;
  v_user_id uuid := auth.uid(); v_email text; v_confirmed_at timestamptz;
begin
  if v_user_id is null or p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  select org_id into v_org_id from app.agency_bootstrap_invitations where token_hash = p_token_hash;
  if not found then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || v_org_id::text, 0));
  select * into v_invite from app.agency_bootstrap_invitations where token_hash = p_token_hash for update;
  if not found then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  -- Read the canonical Auth record, never editable metadata or a stale JWT
  -- email. FOR SHARE serializes even a non-key email/confirmation update.
  select lower(btrim(email)), email_confirmed_at into v_email, v_confirmed_at
    from auth.users where id = v_user_id for share;
  if not found or v_email is null or v_email <> v_invite.owner_email or v_confirmed_at is null then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  if v_invite.accepted_at is not null then
    if v_invite.accepted_by is distinct from v_user_id or not exists (
      select 1 from public.org_members where org_id = v_org_id and user_id = v_user_id
    ) then
      raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
    end if;
    return jsonb_build_object('orgId', v_org_id, 'invitationId', v_invite.id,
      'generation', v_invite.generation, 'outcome', 'already_accepted');
  end if;
  if v_invite.revoked_at is not null or v_invite.expires_at <= clock_timestamp()
     or exists (select 1 from public.org_members where org_id = v_org_id) then
    raise exception using errcode = '42501', message = 'Invitation unavailable for this account';
  end if;
  insert into public.org_members(org_id, user_id, role) values (v_org_id, v_user_id, 'owner');
  update app.agency_bootstrap_invitations set accepted_by = v_user_id, accepted_at = clock_timestamp()
    where id = v_invite.id;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (v_org_id, 'user', v_user_id::text, 'agency.owner_accepted', 'bootstrap_invitation',
      v_invite.id::text, jsonb_build_object('generation', v_invite.generation), 'web');
  return jsonb_build_object('orgId', v_org_id, 'invitationId', v_invite.id,
    'generation', v_invite.generation, 'outcome', 'accepted');
end;
$$;

revoke all on function app.bootstrap_invitation_state(app.agency_bootstrap_invitations) from public, anon, authenticated, service_role;
revoke all on function app.bootstrap_provision_receipt(app.agency_bootstrap_invitations,text,text) from public, anon, authenticated, service_role;
revoke all on function app.provision_agency(uuid,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function app.reissue_bootstrap_invitation(uuid,integer,text,text) from public, anon, authenticated, service_role;
revoke all on function app.revoke_bootstrap_invitation(uuid,integer) from public, anon, authenticated, service_role;
revoke all on function public.inspect_agency_bootstrap_invitation(text) from public, anon, authenticated, service_role;
revoke all on function app.accept_bootstrap_invitation(text) from public, anon, authenticated, service_role;
revoke all on function app.bootstrap_delivery_context(uuid,text) from public, anon, authenticated, service_role;
grant execute on function app.provision_agency(uuid,text,text,text,text,text) to service_role;
grant execute on function app.reissue_bootstrap_invitation(uuid,integer,text,text) to service_role;
grant execute on function app.revoke_bootstrap_invitation(uuid,integer) to service_role;
grant execute on function app.bootstrap_delivery_context(uuid,text) to service_role;
grant execute on function public.inspect_agency_bootstrap_invitation(text) to anon, authenticated;
grant execute on function app.accept_bootstrap_invitation(text) to authenticated;
