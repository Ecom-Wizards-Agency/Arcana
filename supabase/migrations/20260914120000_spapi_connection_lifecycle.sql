-- SP consent needs its own one-use operation ledger; a refresh-token pointer
-- cannot also hold an authorization code. Existing authority helpers are reused.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table app.spapi_connection_operations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  request_id uuid not null,
  initiated_by uuid not null,
  membership_created_at timestamptz not null,
  nonce_hash text not null,
  installation jsonb not null,
  state text not null default 'awaiting_consent' check (state in
    ('awaiting_consent','queued','exchanging','completed','reconnect_required','cancelled')),
  reason text check (reason in ('not_configured','exchange_uncertain','exchange_refused','authority_changed','expired','operator_cancelled')),
  code_hash text,
  code_secret_id uuid,
  lease_id uuid unique,
  connection_id uuid references public.spapi_connections(id),
  target_connection_id uuid references public.spapi_connections(id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '15 minutes',
  unique (org_id, request_id),
  check ((state = 'queued') = (code_secret_id is not null))
);
alter table app.spapi_connection_operations enable row level security;
revoke all on app.spapi_connection_operations from public, anon, authenticated, service_role;
create unique index spapi_connection_one_open on app.spapi_connection_operations(org_id)
  where state in ('awaiting_consent','queued','exchanging');

create function app.spapi_connection_view(p_operation app.spapi_connection_operations)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('operationId', p_operation.id, 'orgId', p_operation.org_id,
    'connectionId', p_operation.connection_id, 'state', p_operation.state, 'reason', p_operation.reason,
    'createdAt', p_operation.created_at, 'updatedAt', p_operation.updated_at);
$$;

-- Lock order matches membership commands. No caller receives this internal helper.
create function app.lock_spapi_connection(p_id uuid)
returns app.spapi_connection_operations language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare v_org uuid; v app.spapi_connection_operations; v_reason text;
begin
  select org_id into v_org from app.spapi_connection_operations where id = p_id;
  if not found then raise exception 'Resource not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || v_org::text, 0));
  select * into strict v from app.spapi_connection_operations where id = p_id for update;
  if v.state in ('awaiting_consent','queued','exchanging') then
    if not exists (select 1 from public.org_members m where m.org_id = v.org_id
      and m.user_id = v.initiated_by and m.created_at = v.membership_created_at and m.role in ('owner','admin')) then
      v_reason := 'authority_changed';
    elsif v.expires_at <= clock_timestamp() then
      v_reason := case when v.state = 'exchanging' then 'exchange_uncertain' else 'expired' end;
    end if;
    if v_reason is not null then
      delete from vault.secrets where id = v.code_secret_id;
      update app.spapi_connection_operations set state = 'reconnect_required', reason = v_reason,
        code_secret_id = null, updated_at = clock_timestamp() where id = p_id returning * into v;
    end if;
  end if;
  return v;
end;
$$;

create function app.begin_spapi_connection(p_org uuid, p_request uuid, p_nonce text, p_installation jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_open uuid; v_membership timestamptz; v_target uuid;
begin
  perform app.lock_org_manager(p_org);
  if p_request is null or p_nonce is null or p_nonce !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_installation) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_installation)) <> 5
    or length(coalesce(p_installation->>'clientId','')) not between 1 and 256
    or length(coalesce(p_installation->>'label','')) not between 1 and 256
    or length(coalesce(p_installation->>'sellingPartnerId','')) not between 1 and 256
    or length(coalesce(p_installation->>'redirectUri','')) not between 1 and 2048
    or not (coalesce(p_installation->>'redirectUri','') ~ '^https://[^/@#[:space:]]+/[^#[:space:]]*$'
      or coalesce(p_installation->>'redirectUri','') ~ ('^http://(localhost|127\.0\.0\.1|\[::1\])'
        || '(:[0-9]+)?/[^#[:space:]]*$'))
    or jsonb_typeof(p_installation->'marketplaceIds') is distinct from 'array' then
    raise exception 'Invalid SP-API installation' using errcode = '22023';
  end if;
  if jsonb_array_length(p_installation->'marketplaceIds') not between 1 and 50
    or exists (select 1 from jsonb_array_elements(p_installation->'marketplaceIds') x
      where jsonb_typeof(x) <> 'string' or length(x #>> '{}') not between 1 and 64)
    or (select count(distinct x) from jsonb_array_elements(p_installation->'marketplaceIds') x)
      <> jsonb_array_length(p_installation->'marketplaceIds') then
    raise exception 'Invalid SP-API marketplaces' using errcode = '22023';
  end if;
  select created_at into strict v_membership from public.org_members where org_id = p_org and user_id = auth.uid();
  for v_open in select id from app.spapi_connection_operations where org_id = p_org
    and state in ('awaiting_consent','queued','exchanging') loop perform app.lock_spapi_connection(v_open); end loop;
  select * into v from app.spapi_connection_operations where org_id = p_org and request_id = p_request;
  if found then
    if v.initiated_by <> auth.uid() or v.membership_created_at <> v_membership
      or v.nonce_hash <> p_nonce or v.installation <> p_installation then
      raise exception 'Connection request identity already used' using errcode = '22023';
    end if;
    return app.spapi_connection_view(v);
  end if;
  select id into v_target from public.spapi_connections where org_id = p_org and label = p_installation->>'label';
  insert into app.spapi_connection_operations(org_id,request_id,initiated_by,membership_created_at,nonce_hash,installation,target_connection_id)
    values (p_org,p_request,auth.uid(),v_membership,p_nonce,p_installation,v_target) returning * into v;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
    values (p_org,'user',auth.uid()::text,'spapi.connection_started','spapi_connection_operation',v.id::text,'web');
  return app.spapi_connection_view(v);
end;
$$;

create function app.submit_spapi_connection(p_org uuid, p_id uuid, p_nonce text, p_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_secret uuid; v_hash text;
begin
  perform app.lock_org_manager(p_org);
  select * into v from app.spapi_connection_operations where id = p_id and org_id = p_org;
  if not found or v.initiated_by <> auth.uid() or v.nonce_hash is distinct from p_nonce then
    raise exception 'Resource not found' using errcode = '42501';
  end if;
  v := app.lock_spapi_connection(p_id);
  if p_code is null or length(p_code) not between 1 and 8192 then raise exception 'Invalid consent' using errcode = '22023'; end if;
  v_hash := encode(sha256(convert_to(p_code,'UTF8')),'hex');
  if v.code_hash is not null then
    if v.code_hash <> v_hash then raise exception 'Consent already submitted' using errcode = '22023'; end if;
    return app.spapi_connection_view(v);
  end if;
  if v.state <> 'awaiting_consent' then return app.spapi_connection_view(v); end if;
  v_secret := vault.create_secret('pending','openspell:spapi-consent:' || p_id::text,'One-use SP-API consent');
  perform vault.update_secret(v_secret,p_code);
  update app.spapi_connection_operations set state = 'queued', code_hash = v_hash, code_secret_id = v_secret,
    expires_at = clock_timestamp() + interval '4 minutes', updated_at = clock_timestamp() where id = p_id returning * into v;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
    values (p_org,'user',auth.uid()::text,'spapi.consent_submitted','spapi_connection_operation',p_id::text,'web');
  return app.spapi_connection_view(v);
end;
$$;

create function app.read_spapi_connection(p_org uuid,p_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select app.spapi_connection_view(o) from app.spapi_connection_operations o where o.id = p_id and o.org_id = p_org
    and app.has_org_role(p_org,array['owner','admin','analyst','viewer']);
$$;

create function app.cancel_spapi_connection(p_org uuid,p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations;
begin
  perform app.lock_org_manager(p_org);
  if not exists (select 1 from app.spapi_connection_operations where id = p_id and org_id = p_org) then
    raise exception 'Resource not found' using errcode = '42501'; end if;
  v := app.lock_spapi_connection(p_id);
  if v.state in ('awaiting_consent','queued','exchanging') then
    delete from vault.secrets where id = v.code_secret_id;
    update app.spapi_connection_operations set state = 'cancelled', reason = 'operator_cancelled', code_secret_id = null,
      updated_at = clock_timestamp() where id = p_id returning * into v;
    insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
      values (p_org,'user',auth.uid()::text,'spapi.connection_cancelled','spapi_connection_operation',p_id::text,'web');
  end if;
  return app.spapi_connection_view(v);
end;
$$;

create function app.claim_spapi_connection(p_lease uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_candidate record; v_code text; v_secret uuid;
begin
  perform app.assert_service_role('claim_spapi_connection');
  if p_lease is null then raise exception 'Invalid claim' using errcode = '22023'; end if;
  if exists (select 1 from app.spapi_connection_operations where lease_id = p_lease) then return null; end if;
  for v_candidate in select id,org_id from app.spapi_connection_operations
    where state in ('awaiting_consent','queued','exchanging')
      and (state = 'queued' or expires_at <= clock_timestamp() or not exists (
        select 1 from public.org_members m where m.org_id = spapi_connection_operations.org_id
          and m.user_id = spapi_connection_operations.initiated_by
          and m.created_at = spapi_connection_operations.membership_created_at and m.role in ('owner','admin')))
    order by created_at,id limit 20 loop
    if not pg_try_advisory_xact_lock(hashtextextended('org-members:' || v_candidate.org_id::text,0)) then continue; end if;
    v := app.lock_spapi_connection(v_candidate.id);
    if v.state <> 'queued' then continue; end if;
    select decrypted_secret into strict v_code from vault.decrypted_secrets where id = v.code_secret_id;
    v_secret := v.code_secret_id;
    update app.spapi_connection_operations set state = 'exchanging', code_secret_id = null, lease_id = p_lease,
      expires_at = clock_timestamp() + interval '90 seconds', updated_at = clock_timestamp() where id = v.id returning * into v;
    delete from vault.secrets where id = v_secret;
    insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
      values (v.org_id,'service','connection-worker','spapi.connection_claimed','spapi_connection_operation',v.id::text,'worker');
    return jsonb_build_object('operation',app.spapi_connection_view(v),'leaseId',p_lease,'installation',v.installation,'code',v_code);
  end loop;
  return null;
end;
$$;

-- Vault 0.3.1 inserts before encrypting. Insert only a placeholder, then update
-- through Vault encryption, preserving the existing service-only custody guard.
create or replace function public.store_spapi_refresh_token(
  p_connection_id uuid,
  p_token text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, vault, pg_temp
as $$
declare
  v_secret_id uuid;
  v_org_id uuid;
  v_name text;
begin
  perform app.assert_service_role('store_spapi_refresh_token');

  if p_token is null or length(p_token) = 0 then
    raise exception 'refusing to store an empty SP-API credential' using errcode = '22023';
  end if;

  select c.org_id, c.vault_secret_id into v_org_id, v_secret_id
    from public.spapi_connections c
   where c.id = p_connection_id
   for update;

  if v_org_id is null then
    raise exception 'no such SP-API connection' using errcode = '22023';
  end if;

  v_name := 'wizard-ads:spapi-connection:' || p_connection_id::text;
  if v_secret_id is null then
    v_secret_id := vault.create_secret('pending', v_name, 'Amazon SP-API LWA refresh credential');
  end if;
  perform vault.update_secret(v_secret_id, p_token);

  update public.spapi_connections
     set vault_secret_id = v_secret_id,
         status = 'active',
         connected_at = coalesce(connected_at, now()),
         last_error = null
   where id = p_connection_id;

  return v_secret_id;
end;
$$;

create function app.settle_spapi_connection(p_id uuid,p_lease uuid,p_refresh text,p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_connection uuid;
begin
  perform app.assert_service_role('settle_spapi_connection');
  v := app.lock_spapi_connection(p_id);
  if v.state <> 'exchanging' then return app.spapi_connection_view(v); end if;
  if p_lease is null or v.lease_id is distinct from p_lease then raise exception 'Connection custody changed' using errcode = '42501'; end if;
  if p_reason is not null then
    if p_reason not in ('not_configured','exchange_uncertain','exchange_refused') or p_refresh is not null then
      raise exception 'Invalid outcome' using errcode = '22023'; end if;
    update app.spapi_connection_operations set state = 'reconnect_required', reason = p_reason,
      updated_at = clock_timestamp() where id = p_id returning * into v;
  else
    if p_refresh is null or length(p_refresh) not between 1 and 65536 then raise exception 'Invalid credential' using errcode = '22023'; end if;
    insert into public.spapi_connections(org_id,label,selling_partner_id,marketplace_ids,status)
      values (v.org_id,v.installation->>'label',v.installation->>'sellingPartnerId',
        array(select jsonb_array_elements_text(v.installation->'marketplaceIds')),'pending')
      on conflict (org_id,label) do update set selling_partner_id = excluded.selling_partner_id,
        marketplace_ids = excluded.marketplace_ids returning id into strict v_connection;
    perform public.store_spapi_refresh_token(v_connection,p_refresh);
    update app.spapi_connection_operations set state = 'completed', connection_id = v_connection,
      updated_at = clock_timestamp() where id = p_id returning * into v;
  end if;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values (v.org_id,'service','connection-worker','spapi.connection_settled','spapi_connection_operation',v.id::text,
      jsonb_build_object('state',v.state,'reason',v.reason),'worker');
  return app.spapi_connection_view(v);
end;
$$;

create function app.read_spapi_connection_worker(p_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform app.assert_service_role('read_spapi_connection_worker');
  return app.spapi_connection_view(app.lock_spapi_connection(p_id));
end;
$$;

-- Shared operator metadata/revocation boundary; never returns a secret or pointer.
create function app.provider_connection_health(p_org uuid,p_provider text,p_id uuid,p_revoke boolean default false)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_secret uuid; v_state text; v_has boolean; v_open uuid; v_label text;
begin
  if p_provider not in ('amazon_ads','amazon_spapi') or p_provider is null or p_revoke is null then
    raise exception 'Invalid connection provider' using errcode = '22023'; end if;
  if p_revoke then perform app.lock_org_manager(p_org);
  elsif not app.has_org_role(p_org,array['owner','admin','analyst','viewer']) then return null; end if;
  if p_provider = 'amazon_ads' then
    select vault_secret_id,status::text into v_secret,v_state from public.ads_connections where id = p_id and org_id = p_org for update;
    if not found then return null; end if;
    if p_revoke then
      for v_open in select id from app.amazon_connection_operations where org_id = p_org
        and state in ('awaiting_consent','queued','exchanging','discovering') loop
        perform app.cancel_amazon_connection(p_org,v_open);
      end loop;
      update public.ads_connections set vault_secret_id = null, status = 'revoked', credential_generation = credential_generation + 1
        where id = p_id and status <> 'revoked';
    end if;
  else
    select vault_secret_id,status::text,label into v_secret,v_state,v_label from public.spapi_connections where id = p_id and org_id = p_org for update;
    if not found then return null; end if;
    if p_revoke then
      -- Cancel pending reconnects too, so an in-flight exchange cannot undo revocation.
      for v_open in select id from app.spapi_connection_operations where org_id = p_org
        and (target_connection_id = p_id or installation->>'label' = v_label)
        and state in ('awaiting_consent','queued','exchanging') loop
        perform app.cancel_spapi_connection(p_org,v_open);
      end loop;
      update public.spapi_connections set status = 'revoked' where id = p_id;
    end if;
  end if;
  v_has := v_secret is not null and v_state = 'active';
  if p_revoke then
    if p_provider = 'amazon_ads' then delete from vault.secrets where id = v_secret; end if;
    v_state := 'revoked'; v_has := false;
    insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
      values (p_org,'user',auth.uid()::text,'provider.connection_revoked','connection',p_id::text,jsonb_build_object('provider',p_provider),'web');
  end if;
  return jsonb_build_object('connectionId',p_id,'state',v_state,'hasCredential',v_has);
end;
$$;

revoke all on function app.spapi_connection_view(app.spapi_connection_operations),app.lock_spapi_connection(uuid),
  app.begin_spapi_connection(uuid,uuid,text,jsonb),app.submit_spapi_connection(uuid,uuid,text,text),
  app.read_spapi_connection(uuid,uuid),app.cancel_spapi_connection(uuid,uuid),app.claim_spapi_connection(uuid),
  app.settle_spapi_connection(uuid,uuid,text,text),app.read_spapi_connection_worker(uuid),
  app.provider_connection_health(uuid,text,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function app.begin_spapi_connection(uuid,uuid,text,jsonb),app.submit_spapi_connection(uuid,uuid,text,text),
  app.read_spapi_connection(uuid,uuid),app.cancel_spapi_connection(uuid,uuid),
  app.provider_connection_health(uuid,text,uuid,boolean) to authenticated;
grant execute on function app.claim_spapi_connection(uuid),app.settle_spapi_connection(uuid,uuid,text,text),
  app.read_spapi_connection_worker(uuid) to service_role;

-- Custody cleanup follows admitted revocation and cannot revoke an active connection.
create function app.clean_revoked_spapi_credential(p_org uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
begin
  perform app.assert_service_role('clean_revoked_spapi_credential');
  perform 1 from public.spapi_connections where org_id = p_org and id = p_id and status = 'revoked' for update;
  if not found then return false; end if;
  perform public.revoke_spapi_refresh_token(p_id);
  return true;
end;
$$;
revoke all on function app.clean_revoked_spapi_credential(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function app.clean_revoked_spapi_credential(uuid,uuid) to service_role;
