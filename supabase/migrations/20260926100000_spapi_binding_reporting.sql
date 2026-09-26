-- Operator-controlled weekly SP-API reporting per profile binding.
-- Reporting stays disabled on every existing binding; this migration enables nothing.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

-- Set only by the trigger below. Bindings enabled before this column existed keep
-- a null start: the date was never recorded and is not inferred.
alter table public.spapi_profile_bindings add column enabled_at timestamptz;
alter table public.spapi_profile_bindings add constraint spapi_profile_bindings_enabled_at_state
  check (enabled or enabled_at is null);

create function app.stamp_spapi_binding_enabled_at() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.enabled_at := case when new.enabled then clock_timestamp() end;
  elsif new.enabled is distinct from old.enabled then
    new.enabled_at := case when new.enabled then clock_timestamp() end;
  else
    new.enabled_at := old.enabled_at;
  end if;
  return new;
end;
$$;
create trigger spapi_profile_bindings_enabled_at before insert or update
  on public.spapi_profile_bindings for each row execute function app.stamp_spapi_binding_enabled_at();

create function app.spapi_binding_view(p_binding uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('bindingId',b.id,'connectionId',b.connection_id,'profileId',b.profile_id,
    'profileName',left(coalesce(nullif(btrim(p.account_name),''),p.amazon_profile_id),512),'marketplaceId',b.marketplace_id,
    'enabled',b.enabled,'enabledAt',b.enabled_at,'profileSyncEnabled',p.sync_enabled)
    from public.spapi_profile_bindings b
    join public.ad_profiles p on p.id = b.profile_id and p.org_id = b.org_id
   where b.id = p_binding;
$$;

-- Owner or admin only, under the shared manager lock. Unknown or foreign scope
-- returns null. Only a state change writes the binding and one audit row.
create function app.set_spapi_binding_reporting(p_org uuid,p_connection uuid,p_binding uuid,p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v public.spapi_profile_bindings;
begin
  if p_org is null or p_connection is null or p_binding is null or p_enabled is null then
    raise exception 'Invalid reporting change' using errcode = '22023'; end if;
  perform app.lock_org_manager(p_org);
  select * into v from public.spapi_profile_bindings
   where id = p_binding and org_id = p_org and connection_id = p_connection for update;
  if not found then return null; end if;
  if v.enabled = p_enabled then return app.spapi_binding_view(v.id); end if;
  if p_enabled and not exists(select 1 from public.spapi_connections c
    where c.id = v.connection_id and c.org_id = p_org and c.status = 'active' and c.vault_secret_id is not null
      and nullif(btrim(c.selling_partner_id),'') is not null and v.marketplace_id = any(c.marketplace_ids)) then
    raise exception 'Reconnect the seller account before enabling reporting' using errcode = '55000'; end if;
  update public.spapi_profile_bindings set enabled = p_enabled where id = v.id;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(p_org,'user',auth.uid()::text,
      case when p_enabled then 'spapi.binding_reporting_enabled' else 'spapi.binding_reporting_disabled' end,
      'spapi_profile_binding',v.id::text,
      jsonb_build_object('connectionId',v.connection_id,'marketplaceId',v.marketplace_id,'enabled',p_enabled),'web');
  return app.spapi_binding_view(v.id);
end;
$$;

revoke all on function app.stamp_spapi_binding_enabled_at(),app.spapi_binding_view(uuid),
  app.set_spapi_binding_reporting(uuid,uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function app.set_spapi_binding_reporting(uuid,uuid,uuid,boolean) to authenticated;
