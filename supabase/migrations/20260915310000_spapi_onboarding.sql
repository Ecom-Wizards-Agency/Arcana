-- SP consent admission and atomic, disabled profile binding. No source enablement.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

alter table public.spapi_profile_bindings alter column enabled set default false;
alter table public.spapi_connections add column credential_generation bigint not null default 0;
alter table app.spapi_connection_operations
  add column expected_selling_partner_id text,
  add column selling_partner_id text,
  add column reserved_connection_id uuid not null default gen_random_uuid(),
  add column target_generation bigint,
  add column attached_bindings integer not null default 0 check (attached_bindings between 0 and 50);

-- Old unconsumed operations have no selected association. They cannot be upgraded
-- into authority. Existing connections and bindings retain their current state.
delete from vault.secrets where id in (select code_secret_id from app.spapi_connection_operations
  where state in ('awaiting_consent','queued','exchanging'));
update app.spapi_connection_operations set state = 'reconnect_required', reason = 'not_configured',
  code_secret_id = null, updated_at = clock_timestamp()
  where state in ('awaiting_consent','queued','exchanging');

-- Every store/rotation and direct revocation touches one of these columns. Even
-- an in-place Vault rotation invalidates a pending reconnect's generation.
create function app.advance_spapi_credential_generation() returns trigger
language plpgsql set search_path = pg_catalog, public, pg_temp as $$
begin
  new.credential_generation := old.credential_generation + 1;
  return new;
end;
$$;
create trigger spapi_credential_generation before update of vault_secret_id,status,credential_generation
  on public.spapi_connections for each row execute function app.advance_spapi_credential_generation();

-- Public marketplace routing data. Region alone cannot distinguish DE from UK.
create function app.spapi_marketplace_for_country(p_country text) returns text
language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp as $$
  select case upper(p_country)
    when 'CA' then 'A2EUQ1WTGCTBG2' when 'US' then 'ATVPDKIKX0DER'
    when 'MX' then 'A1AM78C64UM0Y8' when 'BR' then 'A2Q3Y263D00KWC'
    when 'IE' then 'A28R8C7NBKEWEA' when 'ES' then 'A1RKKUPIHCS9HS'
    when 'GB' then 'A1F83G8C2ARO7P' when 'UK' then 'A1F83G8C2ARO7P'
    when 'FR' then 'A13V1IB3VIYZZH' when 'BE' then 'AMEN7PMS3EDWL'
    when 'NL' then 'A1805IZSGTT6HS' when 'DE' then 'A1PA6795UKMFR9'
    when 'IT' then 'APJ6JRA9NG5V4' when 'SE' then 'A2NODRKZP88ZB9'
    when 'ZA' then 'AE08WJ6YKNBMC' when 'PL' then 'A1C3SOZRARQ6R3'
    when 'EG' then 'ARBP9OOSHTCHU' when 'TR' then 'A33AVAJ2PDY3EV'
    when 'SA' then 'A17E79C6D8DWNP' when 'AE' then 'A2VIGQ35RCS4UG'
    when 'IN' then 'A21TJRUUN4KGV' when 'SG' then 'A19VAU5U5O7RUS'
    when 'AU' then 'A39IBJ37TRP1C6' when 'JP' then 'A1VC38T7YXB528'
    else null end;
$$;

create or replace function app.spapi_connection_view(p_operation app.spapi_connection_operations)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select jsonb_build_object('operationId',p_operation.id,'orgId',p_operation.org_id,
    'connectionId',p_operation.connection_id,'state',p_operation.state,'reason',p_operation.reason,
    'requestedBindings',coalesce(jsonb_array_length(p_operation.installation->'bindings'),0),
    'attachedBindings',p_operation.attached_bindings,
    'createdAt',p_operation.created_at,'updatedAt',p_operation.updated_at);
$$;

-- The synchronized seller account identity and exact country/region association
-- are prerequisites. Unknown or vendor identities fail closed. This is selected
-- association evidence, not proof that an LWA token grants marketplace access.
create function app.spapi_selection_seller(p_org uuid,p_installation jsonb) returns text
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v_seller text; v_count integer; v_expected integer;
begin
  if jsonb_typeof(p_installation->'bindings') is distinct from 'array' then
    raise exception 'Invalid SP-API selection' using errcode = '22023'; end if;
  v_expected := jsonb_array_length(p_installation->'bindings');
  if v_expected not between 1 and 50 or exists (
    select 1 from jsonb_array_elements(p_installation->'bindings') b
    where jsonb_typeof(b) <> 'object' or (select count(*) from jsonb_object_keys(b)) <> 2
      or not (b ? 'profileId' and b ? 'marketplaceId')) then
    raise exception 'Invalid SP-API selection' using errcode = '22023'; end if;
  if (select count(distinct (b->>'profileId')::uuid) from jsonb_array_elements(p_installation->'bindings') b) <> v_expected then
    raise exception 'Duplicate SP-API profiles' using errcode = '22023'; end if;
  perform p.id from public.ad_profiles p join jsonb_array_elements(p_installation->'bindings') b
    on p.id = (b->>'profileId')::uuid and p.org_id = p_org order by p.id for share of p;
  select count(*),min(p.amazon_account_id) into v_count,v_seller
    from public.ad_profiles p join jsonb_array_elements(p_installation->'bindings') b
      on p.id = (b->>'profileId')::uuid and p.org_id = p_org
    where p.account_type = 'seller' and p.amazon_account_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$'
      and app.spapi_marketplace_for_country(p.country_code) = b->>'marketplaceId'
      and app.spapi_region_for_marketplace(b->>'marketplaceId') = p.region
      and p.region::text = p_installation->>'region';
  if v_count <> v_expected or exists (select 1 from public.ad_profiles p
    join jsonb_array_elements(p_installation->'bindings') b on p.id = (b->>'profileId')::uuid
    where p.org_id = p_org and p.amazon_account_id is distinct from v_seller) then
    raise exception 'SP-API profile association refused' using errcode = '42501'; end if;
  return v_seller;
end;
$$;

create or replace function app.begin_spapi_connection(p_org uuid,p_request uuid,p_nonce text,p_installation jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_open uuid; v_membership timestamptz;
  v_target public.spapi_connections; v_seller text; v_markets text[];
begin
  perform app.lock_org_manager(p_org);
  if p_request is null or p_nonce is null or p_nonce !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_installation) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_installation)) <> 6
    or length(coalesce(p_installation->>'clientId','')) not between 1 and 256
    or length(coalesce(p_installation->>'applicationId','')) not between 1 and 256
    or length(coalesce(p_installation->>'label','')) not between 1 and 256
    or coalesce(p_installation->>'region','') not in ('NA','EU','FE')
    or length(coalesce(p_installation->>'redirectUri','')) not between 1 and 2048
    or not (coalesce(p_installation->>'redirectUri','') ~ '^https://[^/@#[:space:]]+/[^#[:space:]]*$'
      or coalesce(p_installation->>'redirectUri','') ~ ('^http://' || '(localhost|127\.0\.0\.1|' || '\[::1\])(:[0-9]+)?/' || '[^#[:space:]]*$')) then
    raise exception 'Invalid SP-API installation' using errcode = '22023'; end if;
  select created_at into strict v_membership from public.org_members where org_id = p_org and user_id = auth.uid();
  for v_open in select id from app.spapi_connection_operations where org_id = p_org
    and state in ('awaiting_consent','queued','exchanging') loop perform app.lock_spapi_connection(v_open); end loop;
  select * into v from app.spapi_connection_operations where org_id = p_org and request_id = p_request;
  if found then
    if v.initiated_by <> auth.uid() or v.membership_created_at <> v_membership
      or v.nonce_hash <> p_nonce or v.installation <> p_installation then
      raise exception 'Connection request identity already used' using errcode = '22023'; end if;
    return app.spapi_connection_view(v);
  end if;
  v_seller := app.spapi_selection_seller(p_org,p_installation);
  select array_agg(distinct b->>'marketplaceId' order by b->>'marketplaceId') into v_markets
    from jsonb_array_elements(p_installation->'bindings') b;
  select * into v_target from public.spapi_connections where org_id = p_org and label = p_installation->>'label' for update;
  if found and (v_target.selling_partner_id is distinct from v_seller
    or (select array_agg(m order by m) from unnest(v_target.marketplace_ids) m) <> v_markets) then
    raise exception 'Reconnect scope must match the existing connection' using errcode = '42501'; end if;
  if exists(select 1 from public.spapi_profile_bindings b where b.connection_id = v_target.id
    and not exists(select 1 from jsonb_array_elements(p_installation->'bindings') s where (s->>'profileId')::uuid = b.profile_id)) then
    raise exception 'Reconnect must include every existing profile binding' using errcode = '42501'; end if;
  if exists (select 1 from public.spapi_profile_bindings b
    join jsonb_array_elements(p_installation->'bindings') s on b.profile_id = (s->>'profileId')::uuid
    where b.org_id <> p_org or b.connection_id is distinct from v_target.id or b.marketplace_id <> s->>'marketplaceId') then
    raise exception 'Profile already belongs to another connection' using errcode = '42501'; end if;
  insert into app.spapi_connection_operations(org_id,request_id,initiated_by,membership_created_at,nonce_hash,
    installation,target_connection_id,target_generation,expected_selling_partner_id)
    values(p_org,p_request,auth.uid(),v_membership,p_nonce,p_installation,v_target.id,v_target.credential_generation,v_seller) returning * into v;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
    values(p_org,'user',auth.uid()::text,'spapi.connection_started','spapi_connection_operation',v.id::text,'web');
  return app.spapi_connection_view(v);
end;
$$;

-- Remove the old callback signature so callers cannot omit returned identity.
drop function app.submit_spapi_connection(uuid,uuid,text,text);
create function app.submit_spapi_connection(p_org uuid,p_id uuid,p_nonce text,p_code text,p_seller text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_secret uuid; v_hash text;
begin
  perform app.lock_org_manager(p_org);
  select * into v from app.spapi_connection_operations where id = p_id and org_id = p_org;
  if not found or v.initiated_by <> auth.uid() or v.nonce_hash is distinct from p_nonce then
    raise exception 'Resource not found' using errcode = '42501'; end if;
  v := app.lock_spapi_connection(p_id);
  if p_code is null or length(p_code) not between 1 and 8192 or p_seller is null
    or p_seller is distinct from v.expected_selling_partner_id then
    raise exception 'Invalid SP-API consent' using errcode = '22023'; end if;
  v_hash := encode(sha256(convert_to(p_code,'UTF8')),'hex');
  if v.code_hash is not null then
    if v.code_hash <> v_hash or v.selling_partner_id is distinct from p_seller then
      raise exception 'Consent already submitted' using errcode = '22023'; end if;
    return app.spapi_connection_view(v);
  end if;
  if v.state <> 'awaiting_consent' then return app.spapi_connection_view(v); end if;
  if app.spapi_selection_seller(p_org,v.installation) is distinct from p_seller then
    raise exception 'SP-API association changed' using errcode = '42501'; end if;
  v_secret := vault.create_secret('pending','openspell:spapi-consent:' || p_id::text,'One-use SP-API consent');
  perform vault.update_secret(v_secret,p_code);
  update app.spapi_connection_operations set state = 'queued',code_hash = v_hash,code_secret_id = v_secret,
    selling_partner_id = p_seller,expires_at = clock_timestamp() + interval '4 minutes',updated_at = clock_timestamp()
    where id = p_id returning * into v;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
    values(p_org,'user',auth.uid()::text,'spapi.consent_submitted','spapi_connection_operation',p_id::text,'web');
  return app.spapi_connection_view(v);
end;
$$;

create or replace function app.claim_spapi_connection(p_lease uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_candidate record; v_code text; v_secret uuid;
begin
  perform app.assert_service_role('claim_spapi_connection');
  if p_lease is null then raise exception 'Invalid claim' using errcode = '22023'; end if;
  if exists(select 1 from app.spapi_connection_operations where lease_id = p_lease) then return null; end if;
  for v_candidate in select id,org_id from app.spapi_connection_operations
    where state in ('awaiting_consent','queued','exchanging') and (state = 'queued' or expires_at <= clock_timestamp()
      or not exists(select 1 from public.org_members m where m.org_id = spapi_connection_operations.org_id
        and m.user_id = spapi_connection_operations.initiated_by and m.created_at = spapi_connection_operations.membership_created_at
        and m.role in ('owner','admin'))) order by created_at,id limit 20 loop
    if not pg_try_advisory_xact_lock(hashtextextended('org-members:' || v_candidate.org_id::text,0)) then continue; end if;
    v := app.lock_spapi_connection(v_candidate.id);
    if v.state <> 'queued' then continue; end if;
    if v.target_connection_id is not null and not exists(select 1 from public.spapi_connections c
      where c.id = v.target_connection_id and c.org_id = v.org_id and c.credential_generation = v.target_generation) then
      delete from vault.secrets where id = v.code_secret_id;
      update app.spapi_connection_operations set state = 'reconnect_required',reason = 'authority_changed',
        code_secret_id = null,updated_at = clock_timestamp() where id = v.id;
      continue;
    end if;
    select decrypted_secret into strict v_code from vault.decrypted_secrets where id = v.code_secret_id;
    v_secret := v.code_secret_id;
    update app.spapi_connection_operations set state = 'exchanging',code_secret_id = null,lease_id = p_lease,
      expires_at = clock_timestamp() + interval '90 seconds',updated_at = clock_timestamp() where id = v.id returning * into v;
    delete from vault.secrets where id = v_secret;
    insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,source)
      values(v.org_id,'service','connection-worker','spapi.connection_claimed','spapi_connection_operation',v.id::text,'worker');
    return jsonb_build_object('operation',app.spapi_connection_view(v),'leaseId',p_lease,
      'installation',v.installation,'sellingPartnerId',v.selling_partner_id,'code',v_code);
  end loop;
  return null;
end;
$$;

-- Holds authority through the caller's metadata writes and final settlement.
create function app.prepare_spapi_attachment(p_id uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; c public.spapi_connections; v_expected uuid;
begin
  perform app.assert_service_role('prepare_spapi_attachment');
  v := app.lock_spapi_connection(p_id);
  if v.state <> 'exchanging' then return null; end if;
  if p_lease is null or v.lease_id is distinct from p_lease then
    raise exception 'Connection custody changed' using errcode = '42501'; end if;
  v_expected := coalesce(v.target_connection_id,v.reserved_connection_id);
  select * into c from public.spapi_connections where org_id = v.org_id and label = v.installation->>'label' for update;
  if (found and (c.id <> v_expected or (v.target_connection_id is null and (c.credential_generation <> 0 or c.status <> 'pending'))))
    or (v.target_connection_id is not null and (c.id is distinct from v.target_connection_id
      or c.credential_generation is distinct from v.target_generation)) then
    raise exception 'Connection authority changed' using errcode = '42501'; end if;
  if app.spapi_selection_seller(v.org_id,v.installation) is distinct from v.selling_partner_id then
    raise exception 'SP-API association changed' using errcode = '42501'; end if;
  if exists(select 1 from public.spapi_profile_bindings b where b.connection_id = v_expected
    and not exists(select 1 from jsonb_array_elements(v.installation->'bindings') s where (s->>'profileId')::uuid = b.profile_id)) then
    raise exception 'Reconnect binding scope changed' using errcode = '42501'; end if;
  if exists(select 1 from public.spapi_profile_bindings b
    join jsonb_array_elements(v.installation->'bindings') s on b.profile_id = (s->>'profileId')::uuid
    where b.org_id <> v.org_id or b.connection_id <> v_expected or b.marketplace_id <> s->>'marketplaceId') then
    raise exception 'Profile connection changed' using errcode = '42501'; end if;
  return jsonb_build_object('operation',app.spapi_connection_view(v),'installation',v.installation,
    'sellingPartnerId',v.selling_partner_id,'targetConnectionId',v_expected);
end;
$$;

-- The former attachment RPC now only records failures. Old workers fail closed.
create or replace function app.settle_spapi_connection(p_id uuid,p_lease uuid,p_refresh text,p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations;
begin
  perform app.assert_service_role('settle_spapi_connection');
  v := app.lock_spapi_connection(p_id);
  if v.state <> 'exchanging' then return app.spapi_connection_view(v); end if;
  if p_lease is null or v.lease_id is distinct from p_lease then
    raise exception 'Connection custody changed' using errcode = '42501'; end if;
  if p_reason is null or p_reason not in ('not_configured','exchange_uncertain','exchange_refused') or p_refresh is not null then
    raise exception 'Invalid connection outcome' using errcode = '22023'; end if;
  update app.spapi_connection_operations set state = 'reconnect_required',reason = p_reason,updated_at = clock_timestamp()
    where id = p_id returning * into v;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(v.org_id,'service','connection-worker','spapi.connection_settled','spapi_connection_operation',v.id::text,
      jsonb_build_object('state',v.state,'reason',v.reason),'worker');
  return app.spapi_connection_view(v);
end;
$$;

create function app.finish_spapi_attachment(p_id uuid,p_lease uuid,p_connection uuid,p_refresh text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v app.spapi_connection_operations; v_context jsonb; v_count integer; v_markets text[];
begin
  perform app.assert_service_role('finish_spapi_attachment');
  v_context := app.prepare_spapi_attachment(p_id,p_lease);
  -- Throw, do not return a terminal state: preceding metadata writes must roll back.
  if v_context is null or p_connection is distinct from (v_context->>'targetConnectionId')::uuid then
    raise exception 'Attachment authority changed' using errcode = '42501'; end if;
  select * into strict v from app.spapi_connection_operations where id = p_id;
  select array_agg(distinct s->>'marketplaceId' order by s->>'marketplaceId') into v_markets
    from jsonb_array_elements(v.installation->'bindings') s;
  if not exists(select 1 from public.spapi_connections c where c.id = p_connection and c.org_id = v.org_id
    and c.label = v.installation->>'label' and c.selling_partner_id = v.selling_partner_id
    and (select array_agg(m order by m) from unnest(c.marketplace_ids) m) = v_markets) then
    raise exception 'Connection metadata does not reconcile' using errcode = '42501'; end if;
  select count(distinct b.profile_id) into v_count from public.spapi_profile_bindings b
    join jsonb_array_elements(v.installation->'bindings') s on b.profile_id = (s->>'profileId')::uuid
    where b.org_id = v.org_id and b.connection_id = p_connection and b.marketplace_id = s->>'marketplaceId' and not b.enabled;
  if v_count <> jsonb_array_length(v.installation->'bindings') then
    raise exception 'Connection binding counts do not reconcile' using errcode = '42501'; end if;
  if p_refresh is null or length(p_refresh) not between 1 and 65536 then
    raise exception 'Invalid credential' using errcode = '22023'; end if;
  perform public.store_spapi_refresh_token(p_connection,p_refresh);
  if v.expires_at <= clock_timestamp() then raise exception 'Attachment expired' using errcode = '42501'; end if;
  update app.spapi_connection_operations set state = 'completed',connection_id = p_connection,
    attached_bindings = v_count,updated_at = clock_timestamp() where id = p_id returning * into v;
  insert into public.audit_log(org_id,actor_type,actor_id,action,target_type,target_id,payload,source)
    values(v.org_id,'service','connection-worker','spapi.connection_settled','spapi_connection_operation',v.id::text,
      jsonb_build_object('state',v.state,'bindings',v_count),'worker');
  return app.spapi_connection_view(v);
end;
$$;

create function app.latest_spapi_connection(p_org uuid) returns jsonb
language sql stable security definer set search_path = pg_catalog, public, pg_temp as $$
  select app.spapi_connection_view(o) from app.spapi_connection_operations o
  where o.org_id = p_org and app.has_org_role(p_org,array['owner','admin','analyst','viewer'])
  order by o.created_at desc,o.id desc limit 1;
$$;

revoke all on function app.advance_spapi_credential_generation(),app.spapi_selection_seller(uuid,jsonb),
  app.prepare_spapi_attachment(uuid,uuid),app.finish_spapi_attachment(uuid,uuid,uuid,text),
  app.submit_spapi_connection(uuid,uuid,text,text,text),app.latest_spapi_connection(uuid)
  from public,anon,authenticated,service_role;
grant execute on function app.prepare_spapi_attachment(uuid,uuid),app.finish_spapi_attachment(uuid,uuid,uuid,text) to service_role;
grant execute on function app.submit_spapi_connection(uuid,uuid,text,text,text),app.latest_spapi_connection(uuid) to authenticated;
