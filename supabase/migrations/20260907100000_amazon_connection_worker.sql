-- Single-use exchange custody and resumable, counted discovery. Only the
-- worker can execute these commands; no public command returns a credential.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create unique index amazon_connection_lease_identity on app.amazon_connection_operations(lease_id)
  where lease_id is not null;

create function app.amazon_connection_binding_current(p_operation app.amazon_connection_operations)
returns boolean language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  perform 1 from public.ads_connections c where c.id = p_operation.connection_id
    and c.org_id = p_operation.org_id and c.credential_generation = p_operation.credential_generation
    and c.status = 'active' and c.vault_secret_id is not null for share;
  return found;
end;
$$;

create function app.claim_amazon_connection(p_lease_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_candidate record; v_operation app.amazon_connection_operations;
  v_code text; v_secret_id uuid; v_kind text;
begin
  perform app.assert_service_role('claim_amazon_connection');
  if p_lease_id is null then raise exception 'Invalid connection claim' using errcode = '22023'; end if;
  if exists (select 1 from app.amazon_connection_operations where lease_id = p_lease_id) then return null; end if;
  for v_candidate in select id,org_id from app.amazon_connection_operations
    where state in ('awaiting_consent','queued','exchanging','discovering')
      and (state = 'queued'
        or (state = 'awaiting_consent' and expires_at <= clock_timestamp())
        or (state = 'exchanging' and lease_expires_at <= clock_timestamp())
        or (state = 'discovering' and (lease_id is null or lease_expires_at <= clock_timestamp()))
        or not exists (select 1 from public.org_members m
          where m.org_id = amazon_connection_operations.org_id
            and m.user_id = amazon_connection_operations.initiated_by
            and m.created_at = amazon_connection_operations.membership_created_at and m.role in ('owner','admin')))
    order by updated_at,id limit 20
  loop
    if not pg_try_advisory_xact_lock(hashtextextended('org-members:' || v_candidate.org_id::text, 0)) then continue; end if;
    v_operation := app.reconcile_amazon_connection_operation(v_candidate.id);
    if v_operation.state = 'queued' then
      select decrypted_secret into v_code from vault.decrypted_secrets where id = v_operation.code_secret_id;
      if v_code is null or length(v_code) = 0 then
        perform app.finish_amazon_connection_operation(v_operation.id, 'reconnect_required', 'exchange_uncertain');
        continue;
      end if;
      v_secret_id := v_operation.code_secret_id;
      update app.amazon_connection_operations set state = 'exchanging', code_secret_id = null,
        lease_id = p_lease_id, lease_expires_at = clock_timestamp() + interval '90 seconds',
        updated_at = clock_timestamp() where id = v_operation.id returning * into strict v_operation;
      delete from vault.secrets where id = v_secret_id;
      v_kind := 'exchange';
    elsif v_operation.state = 'discovering'
      and (v_operation.lease_id is null or v_operation.lease_expires_at <= clock_timestamp()) then
      if not app.amazon_connection_binding_current(v_operation) then
        perform app.finish_amazon_connection_operation(v_operation.id, 'refused', 'authority_changed');
        continue;
      end if;
      update app.amazon_connection_operations set lease_id = p_lease_id,
        lease_expires_at = clock_timestamp() + interval '3 minutes', updated_at = clock_timestamp(),
        regions = (select jsonb_agg(case when r->>'state' = 'running'
          then jsonb_set(r, '{state}', '"pending"') else r end order by n)
          from jsonb_array_elements(regions) with ordinality as input(r,n))
        where id = v_operation.id returning * into strict v_operation;
      v_kind := 'discover';
    else continue;
    end if;
    insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
      values (v_operation.org_id, 'service', 'connection-worker', 'amazon.connection_claimed',
        'amazon_connection_operation', v_operation.id::text, jsonb_build_object('kind', v_kind), 'worker');
    return jsonb_build_object('kind', v_kind, 'leaseId', p_lease_id,
      'leaseExpiresAt', v_operation.lease_expires_at, 'operation', app.amazon_connection_view(v_operation),
      'installation', jsonb_build_object('clientId', v_operation.client_id,
        'redirectUri', v_operation.redirect_uri, 'scope', v_operation.scope))
      || case when v_kind = 'exchange' then jsonb_build_object('code', v_code)
        else jsonb_build_object('binding', jsonb_build_object('orgId', v_operation.org_id,
          'connectionId', v_operation.connection_id, 'generation', v_operation.credential_generation::text)) end;
  end loop;
  return null;
end;
$$;

create function app.attach_amazon_connection_grant(p_operation_id uuid, p_lease_id uuid, p_refresh_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations; v_connection_id uuid; v_generation bigint;
begin
  perform app.assert_service_role('attach_amazon_connection_grant');
  v_operation := app.reconcile_amazon_connection_operation(p_operation_id);
  -- A lost COMMIT acknowledgment is reconciled here without storing a second
  -- credential. A later claim owns discovery independently of consent expiry.
  if v_operation.state <> 'exchanging' then return app.amazon_connection_view(v_operation); end if;
  if p_lease_id is null or v_operation.lease_id is distinct from p_lease_id then
    raise exception 'Connection custody changed' using errcode = '42501';
  end if;
  if p_refresh_token is null or length(p_refresh_token) not between 1 and 65536 then
    raise exception 'Invalid connection credential' using errcode = '22023';
  end if;
  insert into public.ads_connections(org_id,label,lwa_client_id,scope,connected_by,status)
    values (v_operation.org_id, 'Amazon Ads', v_operation.client_id, v_operation.scope, v_operation.initiated_by, 'pending')
    on conflict (org_id,label) do update set lwa_client_id = excluded.lwa_client_id,
      scope = excluded.scope, connected_by = excluded.connected_by, connected_at = clock_timestamp(), last_error = null
    returning id into strict v_connection_id;
  perform public.store_ads_refresh_token(v_connection_id, p_refresh_token);
  select credential_generation into strict v_generation from public.ads_connections where id = v_connection_id;
  update app.amazon_connection_operations set state = 'discovering', connection_id = v_connection_id,
    credential_generation = v_generation, lease_id = null, lease_expires_at = null, updated_at = clock_timestamp()
    where id = p_operation_id returning * into strict v_operation;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, source)
    values (v_operation.org_id, 'service', 'connection-worker', 'amazon.grant_attached',
      'amazon_connection_operation', v_operation.id::text, 'worker');
  return app.amazon_connection_view(v_operation);
end;
$$;

create function app.fail_amazon_connection_exchange(p_operation_id uuid, p_lease_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  perform app.assert_service_role('fail_amazon_connection_exchange');
  v_operation := app.reconcile_amazon_connection_operation(p_operation_id);
  -- In particular, a late failure acknowledgment cannot overwrite an attached
  -- refresh credential after its successful attachment response was lost.
  if v_operation.state <> 'exchanging' then return app.amazon_connection_view(v_operation); end if;
  if p_lease_id is null or v_operation.lease_id is distinct from p_lease_id then
    raise exception 'Connection custody changed' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('exchange_refused','exchange_uncertain','installation_changed') then
    raise exception 'Invalid exchange outcome' using errcode = '22023';
  end if;
  return app.amazon_connection_view(app.finish_amazon_connection_operation(p_operation_id, 'reconnect_required', p_reason));
end;
$$;

create function app.read_amazon_connection_worker(p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  perform app.assert_service_role('read_amazon_connection_worker');
  -- Lock behind any attaching transaction before reconciling a lost response.
  v_operation := app.lock_amazon_connection_operation(p_operation_id);
  return app.amazon_connection_view(v_operation);
end;
$$;

revoke all on function app.amazon_connection_binding_current(app.amazon_connection_operations),
  app.claim_amazon_connection(uuid), app.attach_amazon_connection_grant(uuid,uuid,text),
  app.fail_amazon_connection_exchange(uuid,uuid,text), app.read_amazon_connection_worker(uuid)
  from public, anon, authenticated, service_role;
grant execute on function app.claim_amazon_connection(uuid), app.attach_amazon_connection_grant(uuid,uuid,text),
  app.fail_amazon_connection_exchange(uuid,uuid,text), app.read_amazon_connection_worker(uuid) to service_role;

create function app.lock_amazon_connection_discovery(p_operation_id uuid, p_lease_id uuid)
returns app.amazon_connection_operations language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  v_operation := app.reconcile_amazon_connection_operation(p_operation_id);
  if v_operation.state <> 'discovering' then return v_operation; end if;
  if p_lease_id is null or v_operation.lease_id is distinct from p_lease_id
    or v_operation.lease_expires_at <= clock_timestamp() then
    raise exception 'Connection custody changed' using errcode = '42501';
  end if;
  if not app.amazon_connection_binding_current(v_operation) then
    return app.finish_amazon_connection_operation(p_operation_id, 'refused', 'authority_changed');
  end if;
  return v_operation;
end;
$$;

create function app.start_amazon_connection_region(p_operation_id uuid, p_lease_id uuid, p_region public.ads_region)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  perform app.assert_service_role('start_amazon_connection_region');
  v_operation := app.lock_amazon_connection_discovery(p_operation_id, p_lease_id);
  if v_operation.state <> 'discovering' then return app.amazon_connection_view(v_operation); end if;
  if p_region is null then raise exception 'Invalid discovery region' using errcode = '22023'; end if;
  update app.amazon_connection_operations set lease_expires_at = clock_timestamp() + interval '3 minutes',
    updated_at = clock_timestamp(), regions = (select jsonb_agg(case
      when r->>'region' = p_region::text and r->>'state' = 'pending' then jsonb_set(r, '{state}', '"running"')
      else r end order by n) from jsonb_array_elements(regions) with ordinality as input(r,n))
    where id = p_operation_id returning * into strict v_operation;
  return app.amazon_connection_view(v_operation);
end;
$$;

create function app.fail_amazon_connection_discovery(p_operation_id uuid, p_lease_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  perform app.assert_service_role('fail_amazon_connection_discovery');
  v_operation := app.lock_amazon_connection_discovery(p_operation_id, p_lease_id);
  if v_operation.state <> 'discovering' then return app.amazon_connection_view(v_operation); end if;
  return app.amazon_connection_view(app.finish_amazon_connection_operation(
    p_operation_id, 'reconnect_required', 'installation_changed'));
end;
$$;

create function app.record_amazon_connection_region(
  p_operation_id uuid, p_lease_id uuid, p_region public.ads_region, p_input jsonb, p_failure text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations; v_receipt text; v_region jsonb;
  v_received integer; v_parsed integer := 0; v_rejected integer := 0;
  v_upserted integer := 0; v_created integer := 0; v_settled integer; v_completed integer; v_written integer;
  v_has_refusals boolean; v_state text; v_reason text;
begin
  perform app.assert_service_role('record_amazon_connection_region');
  v_operation := app.lock_amazon_connection_discovery(p_operation_id, p_lease_id);
  if p_region is null or (p_failure is not null and p_failure not in
      ('access_refused','request_failed','invalid_response','persistence_failed'))
    or (p_input is null and p_failure is null) then
    raise exception 'Invalid discovery result' using errcode = '22023';
  end if;
  v_receipt := encode(sha256(convert_to(jsonb_build_object('input',p_input,'failure',p_failure)::text,'UTF8')), 'hex');
  if v_operation.region_receipts ? p_region::text then
    if v_operation.region_receipts->>p_region::text <> v_receipt then
      raise exception 'Discovery result identity already used' using errcode = '22023';
    end if;
    return app.amazon_connection_view(v_operation);
  end if;
  -- Settled receipts still bind the original input after the final region ends
  -- discovery. Terminal status is not permission to reuse a receipt differently.
  if v_operation.state <> 'discovering' then return app.amazon_connection_view(v_operation); end if;
  if p_input is not null then
    if jsonb_typeof(p_input) is distinct from 'object'
      or (p_input - array['region','received','profiles','rejected']) <> '{}'::jsonb
      or not (p_input ?& array['region','received','profiles','rejected'])
      or p_input->>'region' is distinct from p_region::text
      or jsonb_typeof(p_input->'profiles') is distinct from 'array'
      or jsonb_typeof(p_input->'received') is distinct from 'number'
      or jsonb_typeof(p_input->'rejected') is distinct from 'number'
      or p_input->>'received' !~ '^[0-9]+$' or p_input->>'rejected' !~ '^[0-9]+$' then
      raise exception 'Invalid counted discovery input' using errcode = '22023';
    end if;
    v_received := (p_input->>'received')::integer; v_rejected := (p_input->>'rejected')::integer;
    v_parsed := jsonb_array_length(p_input->'profiles');
    if v_parsed > 10000 or v_received <> v_parsed + v_rejected
      or (select count(distinct r->>'profileId') from jsonb_array_elements(p_input->'profiles') r) <> v_parsed
      or exists (select 1 from jsonb_array_elements(p_input->'profiles') r where
        jsonb_typeof(r) is distinct from 'object' or jsonb_typeof(r->'profileId') is distinct from 'string'
        or length(coalesce(r->>'profileId','')) = 0 or r->>'region' is distinct from p_region::text
        or coalesce(r->>'countryCode','') !~ '^[A-Z]{2}$' or coalesce(r->>'currencyCode','') !~ '^[A-Z]{3}$'
        or not exists (select 1 from pg_timezone_names where name = r->>'timezone')
        or (r->>'accountType' is not null and r->>'accountType' not in ('seller','vendor','agency'))) then
      raise exception 'Discovery rows or counts do not reconcile' using errcode = '22023';
    end if;
  end if;
  if p_failure is null then
    -- A provider identity must not silently move existing entity history to a
    -- different region/currency/marketplace during reconnect.
    if exists (select 1 from public.ad_profiles p join jsonb_array_elements(p_input->'profiles') r
      on p.amazon_profile_id = r->>'profileId' where p.org_id = v_operation.org_id
        and (p.region <> p_region or p.country_code <> r->>'countryCode' or p.currency_code <> r->>'currencyCode')) then
      raise exception 'Discovered profile identity changed' using errcode = '22023';
    end if;
    with written as (
      insert into public.ad_profiles(org_id,connection_id,amazon_profile_id,region,country_code,
        currency_code,timezone,account_type,account_name,amazon_account_id)
      select v_operation.org_id,v_operation.connection_id,p."profileId",p_region,p."countryCode",
        p."currencyCode",p.timezone,p."accountType"::public.profile_account_type,p."accountName",p."amazonAccountId"
      from jsonb_to_recordset(p_input->'profiles') as p("profileId" text,"countryCode" text,
        "currencyCode" text,timezone text,"accountType" text,"accountName" text,"amazonAccountId" text)
      on conflict (org_id,amazon_profile_id) do update set connection_id = excluded.connection_id,
        timezone = case when ad_profiles.timezone_locked then ad_profiles.timezone else excluded.timezone end,
        account_type = excluded.account_type, account_name = excluded.account_name, amazon_account_id = excluded.amazon_account_id
      returning (xmax = 0) as created
    ) select count(*)::integer, count(*) filter (where created)::integer into v_upserted,v_created from written;
    if v_upserted <> v_parsed then raise exception 'Discovery write count mismatch' using errcode = '22023'; end if;
  end if;
  v_region := jsonb_build_object('region',p_region::text,'state',case when p_failure is null then 'completed' else 'failed' end,
    'received',v_received,'parsed',v_parsed,'rejected',v_rejected,'upserted',v_upserted,'created',v_created,'reason',p_failure);
  update app.amazon_connection_operations set regions = (select jsonb_agg(case
      when r->>'region' = p_region::text then v_region else r end order by n)
      from jsonb_array_elements(regions) with ordinality as input(r,n)),
    region_receipts = region_receipts || jsonb_build_object(p_region::text,v_receipt),
    updated_at = clock_timestamp(), lease_expires_at = clock_timestamp() + interval '3 minutes'
    where id = p_operation_id returning * into strict v_operation;
  select count(*) filter (where r->>'state' in ('completed','failed'))::integer,
    count(*) filter (where r->>'state' = 'completed')::integer,
    sum((r->>'upserted')::integer)::integer, bool_or(r->>'state' = 'failed' or (r->>'rejected')::integer > 0)
    into v_settled,v_completed,v_written,v_has_refusals from jsonb_array_elements(v_operation.regions) r;
  if v_settled = 3 then
    v_state := case when v_completed = 0 then 'reconnect_required' when v_has_refusals then 'partial'
      when v_written = 0 then 'empty' else 'completed' end;
    v_reason := case when v_completed = 0 then 'discovery_failed' when v_has_refusals then 'discovery_incomplete'
      when v_written = 0 then 'no_profiles' else null end;
    update app.amazon_connection_operations set state = v_state, reason = v_reason,
      lease_id = null, lease_expires_at = null, updated_at = clock_timestamp()
      where id = p_operation_id returning * into strict v_operation;
  end if;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (v_operation.org_id,'service','connection-worker','amazon.discovery_recorded','amazon_connection_operation',
      p_operation_id::text,v_region,'worker');
  return app.amazon_connection_view(v_operation);
end;
$$;

revoke all on function app.lock_amazon_connection_discovery(uuid,uuid),
  app.fail_amazon_connection_discovery(uuid,uuid),
  app.start_amazon_connection_region(uuid,uuid,public.ads_region),
  app.record_amazon_connection_region(uuid,uuid,public.ads_region,jsonb,text)
  from public, anon, authenticated, service_role;
grant execute on function app.fail_amazon_connection_discovery(uuid,uuid),
  app.start_amazon_connection_region(uuid,uuid,public.ads_region),
  app.record_amazon_connection_region(uuid,uuid,public.ads_region,jsonb,text) to service_role;
