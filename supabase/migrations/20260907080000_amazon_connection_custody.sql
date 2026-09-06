-- Connection identity and credential pointers belong to worker-owned commands.
-- Tenant settings remain editable through the existing role policies.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));
lock table public.ads_connections, public.ad_profiles, public.integration_connections in share row exclusive mode;

-- Generic integrations must not alias an Ads (or another tenant's) Vault
-- credential. Preserve permitted metadata edits; protect custody and identity.
create function app.guard_integration_credential_identity()
returns trigger language plpgsql set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if (tg_op = 'INSERT' and new.vault_secret_id is not null)
     or (tg_op = 'UPDATE' and (new.vault_secret_id is distinct from old.vault_secret_id
       or new.id is distinct from old.id or new.org_id is distinct from old.org_id
       or new.provider is distinct from old.provider)) then
    if current_user in ('anon', 'authenticated') then
      raise exception 'Integration credential identity is worker-owned' using errcode = '42501';
    end if;
    perform app.assert_service_role('integration credential identity');
  end if;
  return new;
end;
$$;
revoke all on function app.guard_integration_credential_identity() from public, anon, authenticated, service_role;
create trigger integration_connections_credential_identity
  before insert or update on public.integration_connections
  for each row execute function app.guard_integration_credential_identity();

alter table public.ads_connections
  add column credential_generation bigint not null default 0
    check (credential_generation >= 0),
  add constraint ads_connections_org_identity_unique unique (org_id, id);
update public.ads_connections set credential_generation = 1 where vault_secret_id is not null;

-- Keep the original single-column SET NULL action for compatibility. This
-- additional constraint rejects every cross-organization attachment, including
-- privileged application mistakes. Neither constraint clears org_id on delete.
alter table public.ad_profiles
  add constraint ad_profiles_org_connection_fkey
  foreign key (org_id, connection_id) references public.ads_connections (org_id, id)
  on delete set null (connection_id);

revoke insert, update, delete on public.ads_connections from authenticated;
revoke insert, update, delete on public.ad_profiles from authenticated;
drop policy tenant_insert on public.ads_connections;
drop policy tenant_update on public.ads_connections;
drop policy tenant_delete on public.ads_connections;
drop policy tenant_insert on public.ad_profiles;
drop policy tenant_delete on public.ad_profiles;
grant update (target_acos, target_total_acos, goal_lens, monthly_budget,
  sync_enabled, timezone, timezone_locked, preferred_sync_hour)
  on public.ad_profiles to authenticated;

create function app.guard_profile_schedule_edit()
returns trigger language plpgsql set search_path = pg_catalog, public, app, pg_temp
as $$
begin
  if current_user = 'authenticated'
     and (new.sync_enabled is distinct from old.sync_enabled
       or new.timezone is distinct from old.timezone
       or new.timezone_locked is distinct from old.timezone_locked
       or new.preferred_sync_hour is distinct from old.preferred_sync_hour)
     and not app.has_org_role(old.org_id, array['owner', 'admin']) then
    raise exception 'Profile synchronization settings require current organization management'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_profile_schedule_edit() from public, anon, authenticated, service_role;
create trigger ad_profiles_schedule_authority before update on public.ad_profiles
  for each row execute function app.guard_profile_schedule_edit();

-- Generation changes also cover legacy service credential stores/revocations.
-- The counter cannot be reset by a supplied replacement value.
create function app.advance_ads_credential_generation()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp
as $$
begin
  if new.vault_secret_id is distinct from old.vault_secret_id
     or new.status is distinct from old.status
     or new.credential_generation is distinct from old.credential_generation then
    new.credential_generation := old.credential_generation + 1;
  end if;
  return new;
end;
$$;
revoke all on function app.advance_ads_credential_generation() from public, anon, authenticated, service_role;
create trigger ads_connections_credential_generation before update on public.ads_connections
  for each row execute function app.advance_ads_credential_generation();

create or replace function public.store_ads_refresh_token(p_connection_id uuid, p_token text)
returns uuid language plpgsql security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare v_secret_id uuid; v_org_id uuid; v_name text;
begin
  perform app.assert_service_role('store_ads_refresh_token');
  if p_token is null or length(p_token) = 0 then
    raise exception 'refusing to store an empty token' using errcode = '22023';
  end if;
  select c.org_id, c.vault_secret_id into v_org_id, v_secret_id
    from public.ads_connections c where c.id = p_connection_id for update;
  if v_org_id is null then
    raise exception 'No such ads connection' using errcode = '22023';
  end if;
  v_name := 'wizard-ads:ads-connection:' || p_connection_id::text;
  if v_secret_id is null then
    v_secret_id := vault.create_secret(p_token, v_name, 'Amazon Ads LWA refresh credential');
  else
    perform vault.update_secret(v_secret_id, p_token);
  end if;
  update public.ads_connections
     set vault_secret_id = v_secret_id, status = 'active',
         credential_generation = credential_generation + 1,
         connected_at = coalesce(connected_at, now()), last_error = null
   where id = p_connection_id;
  return v_secret_id;
end;
$$;

create or replace function public.revoke_ads_refresh_token(p_connection_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare v_secret_id uuid;
begin
  perform app.assert_service_role('revoke_ads_refresh_token');
  select c.vault_secret_id into v_secret_id from public.ads_connections c
   where c.id = p_connection_id for update;
  if not found then return false; end if;
  update public.ads_connections
     set vault_secret_id = null, status = 'revoked',
         credential_generation = credential_generation + 1
   where id = p_connection_id;
  if v_secret_id is null then return false; end if;
  delete from vault.secrets where id = v_secret_id;
  return true;
end;
$$;

/** Return a value only for the same organization and fresh cache generation. */
create function public.get_ads_refresh_token_for_generation(
  p_org_id uuid, p_connection_id uuid, p_generation bigint
)
returns text language plpgsql security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare v_secret_id uuid; v_value text;
begin
  perform app.assert_service_role('get_ads_refresh_token_for_generation');
  select c.vault_secret_id into v_secret_id from public.ads_connections c
   where c.id = p_connection_id and c.org_id = p_org_id
     and c.credential_generation = p_generation and c.status = 'active'
     and c.vault_secret_id is not null for share;
  if not found then return null; end if;
  select s.decrypted_secret into v_value from vault.decrypted_secrets s where s.id = v_secret_id;
  return v_value;
end;
$$;
revoke all on function public.get_ads_refresh_token_for_generation(uuid, uuid, bigint)
  from public, anon, authenticated;
grant execute on function public.get_ads_refresh_token_for_generation(uuid, uuid, bigint) to service_role;

-- A table-level revoke does not erase older column or inherited grants.
create function pg_temp.verify_ads_attachment_fence()
returns void language plpgsql set search_path = pg_catalog, pg_temp
as $$
declare v_column text;
begin
  if has_table_privilege('authenticated', 'public.ads_connections', 'INSERT,UPDATE,DELETE')
     or has_any_column_privilege('authenticated', 'public.ads_connections', 'INSERT,UPDATE')
     or has_table_privilege('authenticated', 'public.ad_profiles', 'INSERT,DELETE')
     or has_any_column_privilege('authenticated', 'public.ad_profiles', 'INSERT') then
    raise exception 'Direct authenticated connection identity authority remains' using errcode = '42501';
  end if;
  foreach v_column in array array['id','org_id','connection_id','amazon_profile_id','region',
    'country_code','currency_code','account_type','account_name','amazon_account_id'] loop
    if has_column_privilege('authenticated', 'public.ad_profiles', v_column, 'UPDATE') then
      raise exception 'Direct authenticated profile identity authority remains' using errcode = '42501';
    end if;
  end loop;
end;
$$;
select pg_temp.verify_ads_attachment_fence();
drop function pg_temp.verify_ads_attachment_fence();
