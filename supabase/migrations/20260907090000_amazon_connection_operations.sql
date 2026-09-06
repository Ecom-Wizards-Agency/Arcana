-- Organization-scoped consent exists before an advertiser profile does.
-- Ordinary users can submit only their own verified consent; credentials and
-- internal custody columns are never readable through the product role.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(pg_catalog.hashtextextended('wizard-ads:schema-ddl:v1', 0));

create table app.amazon_connection_operations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  org_id uuid not null references public.orgs(id) on delete cascade,
  initiated_by uuid not null,
  membership_created_at timestamptz not null,
  nonce_hash text not null check (nonce_hash ~ '^[a-f0-9]{64}$'),
  client_id text not null check (length(client_id) between 1 and 256),
  redirect_uri text not null check (length(redirect_uri) between 1 and 2048),
  scope text not null check (length(scope) between 1 and 256),
  state text not null default 'awaiting_consent' check (state in (
    'awaiting_consent','queued','exchanging','discovering','completed','partial',
    'empty','reconnect_required','refused','cancelled')),
  reason text check (reason in ('consent_expired','code_expired','exchange_refused',
    'exchange_uncertain','authority_changed','installation_changed','discovery_failed',
    'discovery_incomplete','no_profiles','operator_cancelled')),
  connection_id uuid,
  credential_generation bigint check (credential_generation > 0),
  code_secret_id uuid,
  code_hash text check (code_hash ~ '^[a-f0-9]{64}$'),
  code_expires_at timestamptz,
  lease_id uuid,
  lease_expires_at timestamptz,
  regions jsonb not null default '[
    {"region":"NA","state":"pending","received":null,"parsed":0,"rejected":0,"upserted":0,"created":0,"reason":null},
    {"region":"EU","state":"pending","received":null,"parsed":0,"rejected":0,"upserted":0,"created":0,"reason":null},
    {"region":"FE","state":"pending","received":null,"parsed":0,"rejected":0,"upserted":0,"created":0,"reason":null}
  ]'::jsonb check (jsonb_typeof(regions) = 'array' and jsonb_array_length(regions) = 3),
  region_receipts jsonb not null default '{}'::jsonb check (jsonb_typeof(region_receipts) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '15 minutes'),
  updated_at timestamptz not null default clock_timestamp(),
  unique (org_id, request_id),
  foreign key (org_id, connection_id) references public.ads_connections(org_id, id),
  check ((connection_id is null) = (credential_generation is null)),
  check ((code_secret_id is not null) = (state = 'queued')),
  check ((lease_id is null) = (lease_expires_at is null)),
  check (lease_id is null or state in ('exchanging','discovering')),
  check (state not in ('awaiting_consent','queued','exchanging') or connection_id is null),
  check (state not in ('discovering','completed','partial','empty') or connection_id is not null)
);
create unique index amazon_connection_one_open_org on app.amazon_connection_operations(org_id)
  where state in ('awaiting_consent','queued','exchanging','discovering');
create index amazon_connection_pending on app.amazon_connection_operations(updated_at, id)
  where state in ('awaiting_consent','queued','exchanging','discovering');
alter table app.amazon_connection_operations enable row level security;
revoke all on app.amazon_connection_operations from public, anon, authenticated, service_role;

create function app.delete_amazon_consent_custody()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if old.code_secret_id is not null then delete from vault.secrets where id = old.code_secret_id; end if;
  return old;
end;
$$;
revoke all on function app.delete_amazon_consent_custody() from public, anon, authenticated, service_role;
create trigger amazon_consent_delete_custody after delete on app.amazon_connection_operations
  for each row execute function app.delete_amazon_consent_custody();

/** Explicit projection: no nonce, code, Vault pointer, lease or provider response. */
create function app.amazon_connection_view(p_operation app.amazon_connection_operations)
returns jsonb language sql stable set search_path = pg_catalog, pg_temp
as $$
  select jsonb_build_object('version', 1, 'operationId', p_operation.id,
    'orgId', p_operation.org_id, 'connectionId', p_operation.connection_id,
    'state', p_operation.state, 'reason', p_operation.reason,
    'createdAt', p_operation.created_at, 'expiresAt', coalesce(p_operation.code_expires_at, p_operation.expires_at),
    'updatedAt', p_operation.updated_at, 'regions', p_operation.regions);
$$;

-- All lifecycle commands share the membership-management lock order. A missing
-- issuer is a reason to settle custody, not a prerequisite for cleanup authority.
create function app.lock_amazon_connection_operation(p_operation_id uuid)
returns app.amazon_connection_operations language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  select * into v_operation from app.amazon_connection_operations where id = p_operation_id;
  if not found then raise exception 'Resource not found' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('org-members:' || v_operation.org_id::text, 0));
  perform 1 from public.org_members where org_id = v_operation.org_id
    and user_id = v_operation.initiated_by for share;
  select * into strict v_operation from app.amazon_connection_operations where id = p_operation_id for update;
  return v_operation;
end;
$$;

create function app.finish_amazon_connection_operation(p_operation_id uuid, p_state text, p_reason text)
returns app.amazon_connection_operations language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations; v_secret_id uuid;
begin
  v_operation := app.lock_amazon_connection_operation(p_operation_id);
  if v_operation.state not in ('awaiting_consent','queued','exchanging','discovering') then
    return v_operation;
  end if;
  if p_state is null or p_reason is null or not ((p_state = 'refused' and p_reason = 'authority_changed')
    or (p_state = 'cancelled' and p_reason = 'operator_cancelled')
    or (p_state = 'reconnect_required' and p_reason in ('consent_expired','code_expired',
      'exchange_refused','exchange_uncertain','installation_changed','discovery_failed'))) then
    raise exception 'Invalid connection outcome' using errcode = '22023';
  end if;
  v_secret_id := v_operation.code_secret_id;
  update app.amazon_connection_operations set state = p_state, reason = p_reason,
    code_secret_id = null, lease_id = null, lease_expires_at = null, updated_at = clock_timestamp()
    where id = p_operation_id returning * into strict v_operation;
  if v_secret_id is not null then delete from vault.secrets where id = v_secret_id; end if;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, payload, source)
    values (v_operation.org_id, 'service', 'connection-operation', 'amazon.connection_settled',
      'amazon_connection_operation', v_operation.id::text,
      jsonb_build_object('state', p_state, 'reason', p_reason), 'worker');
  return v_operation;
end;
$$;

create function app.reconcile_amazon_connection_operation(p_operation_id uuid)
returns app.amazon_connection_operations language plpgsql security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations; v_reason text;
begin
  v_operation := app.lock_amazon_connection_operation(p_operation_id);
  if v_operation.state not in ('awaiting_consent','queued','exchanging','discovering') then return v_operation; end if;
  if not exists (select 1 from public.org_members where org_id = v_operation.org_id
    and user_id = v_operation.initiated_by and created_at = v_operation.membership_created_at
    and role in ('owner','admin')) then
    return app.finish_amazon_connection_operation(p_operation_id, 'refused', 'authority_changed');
  end if;
  v_reason := case
    when v_operation.state = 'awaiting_consent' and v_operation.expires_at <= clock_timestamp() then 'consent_expired'
    when v_operation.state = 'queued' and v_operation.code_expires_at <= clock_timestamp() then 'code_expired'
    when v_operation.state = 'exchanging' and v_operation.lease_expires_at <= clock_timestamp() then 'exchange_uncertain'
    when v_operation.state = 'discovering' and v_operation.created_at + interval '1 day' <= clock_timestamp() then 'discovery_failed'
    else null end;
  if v_reason is not null then
    return app.finish_amazon_connection_operation(p_operation_id, 'reconnect_required', v_reason);
  end if;
  return v_operation;
end;
$$;

create function app.begin_amazon_connection(
  p_org_id uuid, p_request_id uuid, p_nonce_hash text, p_client_id text, p_redirect_uri text, p_scope text
) returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations; v_open_id uuid; v_membership_created_at timestamptz;
begin
  perform app.lock_org_manager(p_org_id);
  if p_request_id is null or p_nonce_hash is null or p_nonce_hash !~ '^[a-f0-9]{64}$'
    or p_client_id is null or length(p_client_id) not between 1 and 256
    or p_redirect_uri is null or length(p_redirect_uri) not between 1 and 2048
    or not (p_redirect_uri ~ '^https://[^/@#[:space:]]+/[^#[:space:]]*$'
      or p_redirect_uri ~ ('^http://(localhost|127\.0\.0\.1|\[::1\])'
        || '(:[0-9]+)?/[^#[:space:]]*$'))
    or p_scope is null or length(p_scope) not between 1 and 256 then
    raise exception 'Invalid connection request' using errcode = '22023';
  end if;
  select created_at into strict v_membership_created_at from public.org_members
    where org_id = p_org_id and user_id = auth.uid();
  select id into v_open_id from app.amazon_connection_operations where org_id = p_org_id
    and state in ('awaiting_consent','queued','exchanging','discovering');
  if found then perform app.reconcile_amazon_connection_operation(v_open_id); end if;
  select * into v_operation from app.amazon_connection_operations where org_id = p_org_id and request_id = p_request_id;
  if found then
    if v_operation.initiated_by <> auth.uid() or v_operation.membership_created_at <> v_membership_created_at
      or v_operation.nonce_hash <> p_nonce_hash or v_operation.client_id <> p_client_id
      or v_operation.redirect_uri <> p_redirect_uri or v_operation.scope <> p_scope then
      raise exception 'Connection request identity already used' using errcode = '22023';
    end if;
    return app.amazon_connection_view(v_operation);
  end if;
  if exists (select 1 from app.amazon_connection_operations where org_id = p_org_id
    and state in ('awaiting_consent','queued','exchanging','discovering')) then
    raise exception 'Another Amazon connection is in progress' using errcode = '23505';
  end if;
  insert into app.amazon_connection_operations(org_id, request_id, initiated_by, membership_created_at,
    nonce_hash, client_id, redirect_uri, scope)
    values (p_org_id, p_request_id, auth.uid(), v_membership_created_at, p_nonce_hash, p_client_id, p_redirect_uri, p_scope)
    returning * into strict v_operation;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, source)
    values (p_org_id, 'user', auth.uid()::text, 'amazon.connection_started',
      'amazon_connection_operation', v_operation.id::text, 'web');
  return app.amazon_connection_view(v_operation);
end;
$$;

create function app.submit_amazon_connection(p_org_id uuid, p_operation_id uuid, p_nonce_hash text, p_code text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations; v_hash text; v_secret_id uuid;
begin
  perform app.lock_org_manager(p_org_id);
  select * into v_operation from app.amazon_connection_operations where org_id = p_org_id and id = p_operation_id;
  if not found or v_operation.initiated_by <> auth.uid() or p_nonce_hash is distinct from v_operation.nonce_hash then
    raise exception 'Resource not found' using errcode = '42501';
  end if;
  v_operation := app.reconcile_amazon_connection_operation(p_operation_id);
  if p_code is null or length(p_code) not between 1 and 8192 then
    raise exception 'Invalid consent code' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(p_code, 'UTF8')), 'hex');
  if v_operation.code_hash is not null then
    if v_operation.code_hash <> v_hash then raise exception 'Consent code already submitted' using errcode = '22023'; end if;
    return app.amazon_connection_view(v_operation);
  end if;
  if v_operation.state <> 'awaiting_consent' then return app.amazon_connection_view(v_operation); end if;
  -- Vault 0.3.1 create_secret inserts before encrypting. A non-secret placeholder
  -- followed by update_secret keeps the code out of that intermediate row/WAL.
  v_secret_id := vault.create_secret('pending', 'openspell:amazon-consent:' || p_operation_id::text,
    'Short-lived Amazon consent; consumed once by the connection worker');
  perform vault.update_secret(v_secret_id, p_code);
  update app.amazon_connection_operations set state = 'queued', code_secret_id = v_secret_id,
    code_hash = v_hash, code_expires_at = clock_timestamp() + interval '4 minutes', updated_at = clock_timestamp()
    where id = p_operation_id returning * into strict v_operation;
  insert into public.audit_log(org_id, actor_type, actor_id, action, target_type, target_id, source)
    values (p_org_id, 'user', auth.uid()::text, 'amazon.consent_submitted',
      'amazon_connection_operation', v_operation.id::text, 'web');
  return app.amazon_connection_view(v_operation);
end;
$$;

create function app.cancel_amazon_connection(p_org_id uuid, p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_operation app.amazon_connection_operations;
begin
  perform app.lock_org_manager(p_org_id);
  if not exists (select 1 from app.amazon_connection_operations where org_id = p_org_id and id = p_operation_id) then
    raise exception 'Resource not found' using errcode = '42501';
  end if;
  v_operation := app.finish_amazon_connection_operation(p_operation_id, 'cancelled', 'operator_cancelled');
  return app.amazon_connection_view(v_operation);
end;
$$;

create function app.read_amazon_connection(p_org_id uuid, p_operation_id uuid)
returns jsonb language sql stable security definer set search_path = pg_catalog, public, pg_temp
as $$
  select app.amazon_connection_view(o) from app.amazon_connection_operations o
    where o.org_id = p_org_id and o.id = p_operation_id
      and app.has_org_role(p_org_id, array['owner','admin','analyst','viewer']);
$$;

revoke all on function app.amazon_connection_view(app.amazon_connection_operations),
  app.lock_amazon_connection_operation(uuid), app.finish_amazon_connection_operation(uuid,text,text),
  app.reconcile_amazon_connection_operation(uuid), app.begin_amazon_connection(uuid,uuid,text,text,text,text),
  app.submit_amazon_connection(uuid,uuid,text,text), app.cancel_amazon_connection(uuid,uuid),
  app.read_amazon_connection(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function app.begin_amazon_connection(uuid,uuid,text,text,text,text),
  app.submit_amazon_connection(uuid,uuid,text,text), app.cancel_amazon_connection(uuid,uuid),
  app.read_amazon_connection(uuid,uuid) to authenticated;
